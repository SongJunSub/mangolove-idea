import type { SimpleGit } from 'simple-git';
import type { MergeProgressEvent, MergeResult, MergeRequest, MergeStage } from '../../shared/types';
import type { ProcessRunner } from '../proc/process-runner';
import type { WorktreeManager } from '../managers/worktree-manager';

/** Where MergeRunner publishes MERGE_PROGRESS (injected, so tests spy). */
export interface MergeEmitter {
  emitProgress(e: MergeProgressEvent): void;
}

/** Constructor dependencies — all injectable for windowless unit tests. */
export interface MergeRunnerDeps {
  /** SimpleGit bound to the PRIMARY repo root (where targetBranch is checked out). */
  readonly git: SimpleGit;
  /** Resolves worktreeId -> branch/path and performs worktree cleanup. */
  readonly worktrees: WorktreeManager;
  /** Runs the verify command; success = exit code 0. */
  readonly verifyRunner: ProcessRunner;
  readonly emitter: MergeEmitter;
  /** Verify command line; default `process.env.MANGO_VERIFY_CMD ?? 'true'`. */
  readonly verifyCommand?: string;
}

/**
 * Runs the MangoLove merge flow for ONE worktree: verify hook -> merge feature
 * into target (in the primary tree) -> optional cleanup (remove worktree + delete
 * branch). Emits MERGE_PROGRESS per stage through the injected emitter and never
 * leaves the repo mid-conflict (aborts on conflict). All git access is the same
 * simple-git surface WorktreeManager uses, so it is unit-testable on a temp repo.
 */
export class MergeRunner {
  private readonly git: SimpleGit;
  private readonly worktrees: WorktreeManager;
  private readonly verifyRunner: ProcessRunner;
  private readonly emitter: MergeEmitter;
  private readonly verifyCommand: string;

  constructor(deps: MergeRunnerDeps) {
    this.git = deps.git;
    this.worktrees = deps.worktrees;
    this.verifyRunner = deps.verifyRunner;
    this.emitter = deps.emitter;
    this.verifyCommand = deps.verifyCommand ?? process.env.MANGO_VERIFY_CMD ?? 'true';
  }

  /** Executes verify -> merge -> cleanup, emitting progress for each stage. */
  async run(req: MergeRequest): Promise<MergeResult> {
    const { worktreeId, targetBranch } = req;

    // Resolve worktreeId -> feature branch + path via the worktree listing.
    const trees = await this.worktrees.list();
    const feature = trees.find((t) => t.id === worktreeId);
    if (!feature) return this.fail(worktreeId, 'merge', `unknown worktree ${worktreeId}`);
    if (feature.isPrimary) {
      return this.fail(worktreeId, 'merge', 'cannot merge the primary worktree');
    }
    // WorktreeManager reports a detached-HEAD worktree's branch as the literal
    // '(detached)'; merging/deleting that bogus ref errors opaquely — guard early.
    if (feature.branch === '(detached)') {
      return this.fail(worktreeId, 'merge', 'cannot merge a detached-HEAD worktree (no branch)');
    }
    if (feature.branch === targetBranch) {
      return this.fail(
        worktreeId,
        'merge',
        `feature and target are the same branch (${targetBranch})`,
      );
    }
    const featureBranch = feature.branch;

    // ── verify ──────────────────────────────────────────────────────────────
    if (req.runVerifyHook) {
      const ok = await this.runVerify(feature.path);
      if (!ok) {
        return this.fail(worktreeId, 'verify', `verify hook failed: ${this.verifyCommand}`);
      }
      this.emit(worktreeId, 'verify', true, 'verify passed');
    }

    // ── re-surface an in-progress merge ───────────────────────────────────────
    // If MERGE_HEAD already exists (a prior run paused on a conflict, possibly
    // across an app restart), do NOT re-run from the top (the conflicted tree would
    // trip the dirty-tree gate with a confusing 'uncommitted changes'). Re-report it.
    if (await this.inProgress()) {
      const conflicted = (await this.git.status()).conflicted;
      this.emit(worktreeId, 'conflict', false, `resume merge: ${conflicted.length} conflict(s)`);
      return { worktreeId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
    }

    // ── merge ───────────────────────────────────────────────────────────────
    // Safety: the primary tree must be clean of TRACKED changes. Untracked paths
    // (notably the `.worktrees/` dir) are ignored — they are always 'not_added'.
    const status = await this.git.status();
    const trackedDirty =
      status.modified.length +
      status.staged.length +
      status.created.length +
      status.deleted.length +
      status.renamed.length +
      status.conflicted.length;
    if (trackedDirty > 0) {
      return this.fail(
        worktreeId,
        'merge',
        'primary worktree has uncommitted changes; commit or stash first',
      );
    }

    try {
      await this.git.checkout(targetBranch);
      await this.git.merge(['--no-edit', featureBranch]);
    } catch (error) {
      // Branch by Abstraction: a TRUE conflict (confirmed via status().conflicted,
      // NOT the brittle /conflict/i message) PAUSES the merge in progress for the
      // resolution UI. Any other throw keeps the original safe-abort path verbatim.
      const conflicted = (await this.git.status()).conflicted;
      if (conflicted.length > 0) {
        this.emit(
          worktreeId,
          'conflict',
          false,
          `merge conflict: ${conflicted.length} file(s) need resolution`,
        );
        return { worktreeId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
      }
      // Non-conflict failure: abort so the repo is never left mid-merge.
      try {
        await this.git.raw(['merge', '--abort']);
      } catch {
        // best-effort; if there was nothing to abort git errors — ignore.
      }
      const raw = error instanceof Error ? error.message : String(error);
      const msg = raw.replace(/^fatal:\s*/i, '').trim();
      return this.fail(worktreeId, 'merge', msg);
    }
    this.emit(worktreeId, 'merge', true, `merged ${featureBranch} into ${targetBranch}`);

    // ── cleanup (non-fatal: the merge already succeeded) ──────────────────────
    let cleanedUp = false;
    let cleanupFailed = false;
    if (req.cleanup) {
      const result = await this.cleanupWorktree(worktreeId, featureBranch);
      cleanedUp = result.cleanedUp;
      cleanupFailed = result.failed;
      this.emit(worktreeId, 'cleanup', !cleanupFailed, result.message);
    }

    // The final `done` must not mask a failed cleanup: a requested-but-failed
    // cleanup reports ok:false so the UI's stage line surfaces it (merged stands).
    const doneMessage = cleanedUp
      ? 'merged + cleaned up'
      : cleanupFailed
        ? 'merged, but cleanup failed'
        : 'merged';
    this.emit(worktreeId, 'done', !cleanupFailed, doneMessage);
    return { worktreeId, merged: true, cleanedUp, status: 'merged' };
  }

  /** True while a merge is paused in the primary tree (`.git/MERGE_HEAD` present). */
  private async inProgress(): Promise<boolean> {
    try {
      // No `-q` — see ConflictResolver.inProgress(): `-q` suppresses stderr so
      // simple-git resolves instead of throwing, making this always true.
      await this.git.raw(['rev-parse', '--verify', 'MERGE_HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Shared cleanup: remove the worktree FIRST, then delete the branch (order is
   * load-bearing — `git branch -d` refuses a branch still held by a worktree).
   * Non-fatal: returns the outcome so callers (happy-path merge AND a user-driven
   * post-resolution continue) can report ok:false without flipping merged:false.
   */
  async cleanupWorktree(
    worktreeId: string,
    featureBranch: string,
  ): Promise<{ cleanedUp: boolean; failed: boolean; message: string }> {
    try {
      await this.worktrees.remove({ worktreeId });
      await this.git.branch(['-d', featureBranch]);
      return { cleanedUp: true, failed: false, message: `removed ${featureBranch}` };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      return { cleanedUp: false, failed: true, message: `cleanup failed: ${raw}` };
    }
  }

  /** Runs the verify command in `cwd`; resolves true iff exit code === 0. */
  private runVerify(cwd: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = this.verifyRunner.spawn(this.verifyCommand, { cwd });
      proc.onExit((e) => resolve(e.code === 0));
    });
  }

  private emit(worktreeId: string, stage: MergeStage, ok: boolean, message: string): void {
    this.emitter.emitProgress({ worktreeId, stage, ok, message });
  }

  /** Emits a failed stage and returns a non-merged MergeResult. */
  private fail(worktreeId: string, stage: MergeStage, error: string): MergeResult {
    this.emit(worktreeId, stage, false, error);
    return { worktreeId, merged: false, cleanedUp: false, status: 'failed', error };
  }
}
