import type { SimpleGit } from 'simple-git';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConflictedFile,
  ConflictFileVersions,
  ConflictResolveRequest,
  ConflictContinueRequest,
  ConflictAbortRequest,
  MergeResult,
} from '../../shared/types';
import type { WorktreeManager } from '../managers/worktree-manager';

/**
 * True iff `content` still carries git conflict markers — a line that is exactly seven
 * `<` (begin) or seven `>` (end) optionally followed by a label. We anchor ONLY on the
 * begin/end markers (which never occur in normal text), NOT the `=======` separator, so
 * a markdown setext-H1 underline (`=======`) can't false-positive: a real unresolved
 * conflict ALWAYS still has its begin/end markers. git itself does not block committing
 * these (only `git diff --check` warns), so this guards the manual-resolution path.
 */
export function hasConflictMarkers(content: string): boolean {
  return content.split('\n').some((line) => /^<{7}( |$)/.test(line) || /^>{7}( |$)/.test(line));
}

/** Constructor dependencies — injectable so the resolver is unit-testable on a temp repo. */
export interface ConflictResolverDeps {
  /** SimpleGit bound to the PRIMARY repo root (where MERGE_HEAD + the conflict live). */
  readonly git: SimpleGit;
  /** Used only by continue(cleanup) to remove the merged worktree (remove BEFORE branch -d). */
  readonly worktrees: WorktreeManager;
  /**
   * Called with the worktreeId AFTER continue(cleanup) successfully removes its
   * worktree. continue() bypasses the WORKTREE_REMOVE handler, so the IPC wiring uses
   * this to drop side state keyed by worktreeId (scrollback) that would otherwise leak.
   * Optional => no-op.
   */
  readonly onWorktreeRemoved?: (worktreeId: string) => void;
}

/**
 * Resolves an in-progress merge conflict in the PRIMARY tree. STATELESS: every call
 * recomputes truth from MERGE_HEAD + git.status(), so it survives the SETTINGS_SET
 * cache-clear and even an app restart. NEVER auto-continues — continue() is the only
 * path that creates the merge commit and runs only on explicit user action.
 */
export class ConflictResolver {
  private readonly git: SimpleGit;
  private readonly worktrees: WorktreeManager;
  private readonly onWorktreeRemoved?: (worktreeId: string) => void;

  constructor(deps: ConflictResolverDeps) {
    this.git = deps.git;
    this.worktrees = deps.worktrees;
    this.onWorktreeRemoved = deps.onWorktreeRemoved;
  }

  /** True while a merge is paused (`.git/MERGE_HEAD` present). */
  async inProgress(): Promise<boolean> {
    return (await this.mergeHeadSha()) !== null;
  }

  /**
   * The id (path) of the worktree whose branch is the SECOND PARENT of the
   * in-progress merge (i.e. the one being merged INTO the target), or null when
   * no merge is paused. The merge is `git merge <feature>` run in the primary
   * tree, so `MERGE_HEAD` is the tip of that feature branch — we match it against
   * each NON-PRIMARY worktree's branch tip. This is the ONLY honest source of
   * "which worktree does the single global MERGE_HEAD belong to"; the renderer
   * uses it so a paused merge is never mis-attributed to whatever worktree happens
   * to be selected (a primary selection, or an unrelated feature worktree).
   */
  async inProgressWorktreeId(): Promise<string | null> {
    const mergeHead = await this.mergeHeadSha();
    if (mergeHead === null) return null;
    const trees = await this.worktrees.list();
    for (const tree of trees) {
      if (tree.isPrimary || tree.branch === '(detached)') continue;
      const tip = await this.revParseOrNull(tree.branch);
      if (tip !== null && tip === mergeHead) return tree.id;
    }
    return null; // MERGE_HEAD present but no managed worktree's branch matches it.
  }

  /** SHA of MERGE_HEAD, or null when no merge is in progress. */
  private async mergeHeadSha(): Promise<string | null> {
    // NB: do NOT pass `-q`. With `-q`, git still exits non-zero when MERGE_HEAD
    // is absent but SUPPRESSES stderr, and simple-git only rejects a raw task
    // when stderr is non-empty — so `-q` would RESOLVE with '' and look as if a
    // merge were in progress in every state. Without `-q`, rev-parse writes
    // "fatal: Needed a single revision" to stderr -> simple-git rejects -> catch.
    return this.revParseOrNull('MERGE_HEAD');
  }

  /** `git rev-parse --verify <ref>` -> trimmed SHA, or null when the ref is absent. */
  private async revParseOrNull(ref: string): Promise<string | null> {
    try {
      return (await this.git.raw(['rev-parse', '--verify', ref])).trim();
    } catch {
      return null;
    }
  }

  /** Conflicted paths with porcelain code + which index stages are present. */
  async list(): Promise<ConflictedFile[]> {
    const status = await this.git.status();
    const paths = status.conflicted;
    if (paths.length === 0) return [];
    // `git ls-files -u` lists one row per present stage: "<mode> <sha> <stage>\t<path>".
    const lsOut = await this.git.raw(['ls-files', '-u']);
    const stagesByPath = new Map<string, Set<number>>();
    for (const line of lsOut.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const stage = Number(meta[meta.length - 1]);
      const p = line.slice(tab + 1);
      const set = stagesByPath.get(p) ?? new Set<number>();
      set.add(stage);
      stagesByPath.set(p, set);
    }
    return paths.map((path) => {
      const stages = stagesByPath.get(path) ?? new Set<number>();
      const hasBase = stages.has(1);
      const hasOurs = stages.has(2);
      const hasTheirs = stages.has(3);
      return { path, code: codeFor(hasBase, hasOurs, hasTheirs), hasOurs, hasTheirs };
    });
  }

  /** base/:1, ours/:2 (target), theirs/:3 (feature) blobs + the working-tree marker text. */
  async read(path: string): Promise<ConflictFileVersions> {
    this.assertSafeRef(path);
    const files = await this.list();
    const entry = files.find((f) => f.path === path);
    const hasOurs = entry?.hasOurs ?? false;
    const hasTheirs = entry?.hasTheirs ?? false;
    const base = await this.showOrEmpty(`:1:${path}`);
    const ours = await this.showOrEmpty(`:2:${path}`);
    const theirs = await this.showOrEmpty(`:3:${path}`);
    // Working-tree text (with the raw <<<<<<< ======= >>>>>>> markers) lives ONLY on
    // disk — a conflicted file has no stage-0 index entry, so `git show :0:path`
    // would always error. Read it straight from the file.
    const working = await this.readWorking(path);
    return {
      path,
      code: entry?.code ?? 'UU',
      base,
      ours,
      theirs,
      working,
      hasOurs,
      hasTheirs,
    };
  }

  /** Resolve ONE file. Never creates a commit. */
  async resolve(req: Pick<ConflictResolveRequest, 'path' | 'choice' | 'content'>): Promise<void> {
    this.assertSafeRef(req.path);
    switch (req.choice) {
      case 'ours':
        await this.git.raw(['checkout', '--ours', '--', req.path]);
        await this.git.add(req.path);
        break;
      case 'theirs':
        await this.git.raw(['checkout', '--theirs', '--', req.path]);
        await this.git.add(req.path);
        break;
      case 'manual':
        // Block staging a half-resolved edit: leftover markers would commit a broken
        // merge (git's index would treat the file as resolved). git never checks this.
        if (hasConflictMarkers(req.content ?? '')) throw conflictMarkerError(req.path);
        writeFileSync(join(await this.repoRoot(), req.path), req.content ?? '');
        await this.git.add(req.path);
        break;
      case 'keep':
        // "Keep" stages the working-tree file AS-IS; reject it too if the user kept a
        // file that still has unresolved markers (e.g. a UU they never actually edited).
        if (hasConflictMarkers(await this.readWorking(req.path)))
          throw conflictMarkerError(req.path);
        await this.git.add(req.path);
        break;
      case 'remove':
        await this.git.raw(['rm', '-f', '--', req.path]);
        break;
      default: {
        const never: never = req.choice;
        throw new Error(`unknown resolve choice: ${String(never)}`);
      }
    }
  }

  /**
   * Create the merge commit. REJECTED (no commit) while any conflict remains.
   * Uses `git commit --no-edit` (the prepared MERGE_MSG) — NEVER `merge --continue`,
   * which opens an interactive editor and hangs. cleanup (worktree remove THEN
   * branch -d) is non-fatal and runs only after the commit succeeds + no MERGE_HEAD.
   */
  async continue(req: ConflictContinueRequest): Promise<MergeResult> {
    const remaining = await this.list();
    if (remaining.length > 0) {
      return {
        worktreeId: req.worktreeId,
        merged: false,
        cleanedUp: false,
        status: 'conflict',
        conflicted: remaining.map((f) => f.path),
      };
    }
    if (!(await this.inProgress())) {
      return {
        worktreeId: req.worktreeId,
        merged: false,
        cleanedUp: false,
        status: 'failed',
        error: 'no merge in progress',
      };
    }
    await this.git.raw(['commit', '--no-edit']);

    let cleanedUp = false;
    if (req.cleanup) {
      const feature = await this.featureBranch(req.worktreeId);
      try {
        // Order matters: remove the worktree FIRST, then delete the branch —
        // `git branch -d` refuses a branch still held by a worktree.
        await this.worktrees.remove({ worktreeId: req.worktreeId });
        // Drop scrollback etc. (bypasses WORKTREE_REMOVE). GUARDED: a non-essential
        // disposable-cache write failure must never skip `branch -d` or flip cleanedUp.
        try {
          this.onWorktreeRemoved?.(req.worktreeId);
        } catch {
          /* non-essential — the SCROLLBACK_MAX_ENTRIES cap bounds growth anyway */
        }
        if (feature && feature !== req.targetBranch) await this.git.branch(['-d', feature]);
        cleanedUp = true;
      } catch {
        cleanedUp = false; // non-fatal: the merge commit already exists.
      }
    }
    return { worktreeId: req.worktreeId, merged: true, cleanedUp, status: 'merged' };
  }

  /** `git merge --abort`: restore the target branch, drop MERGE_HEAD. */
  async abort(req: ConflictAbortRequest): Promise<MergeResult> {
    await this.git.raw(['merge', '--abort']);
    return {
      worktreeId: req.worktreeId,
      merged: false,
      cleanedUp: false,
      status: 'failed',
      error: 'merge aborted',
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Absolute path of the primary repo's working tree. */
  private async repoRoot(): Promise<string> {
    return (await this.git.raw(['rev-parse', '--show-toplevel'])).trim();
  }

  /** Reads the working-tree file (with conflict markers); '' if it was removed. */
  private async readWorking(path: string): Promise<string> {
    try {
      const { readFileSync } = await import('node:fs');
      return readFileSync(join(await this.repoRoot(), path), 'utf8');
    } catch {
      return '';
    }
  }

  /** Maps worktreeId -> feature branch via the worktree listing (for cleanup). */
  private async featureBranch(worktreeId: string): Promise<string | undefined> {
    const trees = await this.worktrees.list();
    return trees.find((t) => t.id === worktreeId)?.branch;
  }

  /**
   * `git show <spec>`; returns '' when the path is absent at that ref OR the index
   * stage does not exist (modify/delete & add/add lack some of :1/:2/:3).
   */
  private async showOrEmpty(spec: string): Promise<string> {
    try {
      return await this.git.show([spec]);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/does not exist|exists on disk, but not in|no such path|not at stage \d/i.test(raw)) {
        return '';
      }
      throw error;
    }
  }

  /** Reject a path git could misparse as an OPTION (leading '-'). */
  private assertSafeRef(path: string): void {
    if (path.startsWith('-')) throw new Error(`invalid path: ${path}`);
  }
}

/** A clear, actionable error for a resolution that still has conflict markers. */
function conflictMarkerError(path: string): Error {
  return new Error(
    `unresolved conflict markers remain in ${path} — remove the <<<<<<< / ======= / >>>>>>> markers before resolving`,
  );
}

/** Derives a porcelain-ish XY code from which stages are present. */
function codeFor(hasBase: boolean, hasOurs: boolean, hasTheirs: boolean): string {
  if (hasOurs && hasTheirs) return hasBase ? 'UU' : 'AA';
  if (hasTheirs && !hasOurs) return 'DU'; // ours deleted, theirs modified
  if (hasOurs && !hasTheirs) return 'UD'; // theirs deleted, ours modified
  return 'DD';
}
