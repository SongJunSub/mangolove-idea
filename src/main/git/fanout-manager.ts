import type {
  Ack,
  FanoutLane,
  FanoutLaneStatusEvent,
  FanoutRun,
  FanoutStartRequest,
  FanoutStartResult,
  FanoutSelectRequest,
  MergeResult,
} from '../../shared/types';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { MergeRunner } from './merge-runner';
import { slugModel, assertSafeModel, type LaneRunResult } from './fanout-run';

/** Max parallel lanes (LOCKED). A start with more models is rejected. */
export const MAX_LANES = 4;

/** Where FanoutManager publishes FANOUT_STATUS (injected, so tests spy). */
export interface FanoutEmitter {
  emitLaneStatus(e: FanoutLaneStatusEvent): void;
}

/** A live lane process handle the manager can kill on abort. */
export interface LaneProc {
  kill(): void;
}

/**
 * Runner FACTORY seam: starts ONE lane and calls onDone when it finishes. The
 * production factory (register-ipc) wraps runLane; tests inject a fake that edits
 * a file + records argv. Returning a LaneProc lets abort() kill running lanes.
 */
export type LaneRunner = (deps: {
  readonly agentCommand: string;
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly skipPermissions: boolean;
  readonly onDone: (r: LaneRunResult) => void;
}) => LaneProc;

/**
 * The few git ops the manager runs directly: commit a lane's edits (so its branch
 * HEAD carries them before select() merges) and force-delete a discarded lane
 * branch. A cwd-bound simple-git instance satisfies this structurally.
 */
export interface LaneGit {
  add(files: string[]): Promise<unknown>;
  diff(options: string[]): Promise<string>;
  commit(message: string): Promise<unknown>;
  branch(options: string[]): Promise<unknown>;
}

/** Builds a git bound to a cwd (a lane worktree for commits, repoRoot for branch -D). */
export type GitFactory = (cwd: string) => LaneGit;

/** Constructor deps — all injectable for windowless unit tests on a temp repo. */
export interface FanoutManagerDeps {
  readonly worktrees: WorktreeManager;
  readonly merge: MergeRunner;
  /** Resolves the base branch (settings.baseBranch ?? 'main') at start time. */
  readonly resolveBase: () => Promise<string>;
  readonly laneRunner: LaneRunner;
  readonly agentCommand: string;
  readonly emitter: FanoutEmitter;
  /** Generates the short run id (slug-safe). */
  readonly genId: () => string;
  /** Builds a cwd-bound git: commits a lane's edits, force-deletes a discarded branch. */
  readonly gitFactory: GitFactory;
  /** Primary repo root — the cwd for `git branch -D` (a worktree cannot delete its own branch). */
  readonly repoRoot: string;
}

/** Mutable per-lane book-keeping (the public FanoutLane is a readonly snapshot). */
interface LaneState {
  laneId: string;
  model: string;
  worktreeId: string;
  branch: string;
  status: FanoutLane['status'];
  exitCode?: number | null;
  stdoutTail?: string;
  error?: string;
  proc?: LaneProc;
}

const STDOUT_TAIL_BYTES = 2_000;

/**
 * Orchestrates ONE active multimodel fan-out run (MVP). start() creates one
 * worktree per model off the base branch (reusing WorktreeManager) and spawns a
 * headless lane in each cwd via the injected laneRunner, tracking per-lane status
 * (queued -> running -> done|failed) and emitting FANOUT_STATUS. select() merges
 * the winner (MergeRunner) + removes the other lane worktrees; abort() kills running
 * lanes + removes ALL lane worktrees. Constructor-injected so it is unit-testable
 * with a fake agent runner + a real WorktreeManager/MergeRunner on a temp repo.
 */
export class FanoutManager {
  private readonly deps: FanoutManagerDeps;
  private run: {
    id: string;
    prompt: string;
    base: string;
    skipPermissions: boolean;
    lanes: LaneState[];
  } | null = null;

  constructor(deps: FanoutManagerDeps) {
    this.deps = deps;
  }

  /** Starts the fan-out. Rejects if a run is active or models is out of [1, MAX_LANES]. */
  async start(req: FanoutStartRequest): Promise<FanoutStartResult> {
    if (this.run !== null) {
      throw new Error('a fan-out run is already active; abort it before starting another');
    }
    if (req.models.length < 1) {
      throw new Error('fan-out needs at least one model');
    }
    if (req.models.length > MAX_LANES) {
      throw new Error(`fan-out supports at most ${MAX_LANES} models`);
    }
    for (const m of req.models) assertSafeModel(m);

    const base = await this.deps.resolveBase();
    const id = this.deps.genId();
    const lanes: LaneState[] = [];

    // Create every worktree FIRST (sequential — git worktree add mutates the same
    // repo index). A creation failure rejects the whole start and rolls back any
    // worktrees already created, so a failed start never leaves orphans.
    for (const model of req.models) {
      const laneId = slugModel(model);
      const branch = `fanout/${id}/${laneId}`;
      const dir = `.worktrees/fanout-${id}-${laneId}`;
      try {
        const wt = await this.deps.worktrees.create({
          baseBranch: base,
          newBranch: branch,
          path: dir,
        });
        lanes.push({ laneId, model, worktreeId: wt.id, branch, status: 'queued' });
      } catch (error) {
        await this.rollback(lanes);
        const raw = error instanceof Error ? error.message : String(error);
        throw new Error(`fan-out worktree create failed for ${model}: ${raw}`);
      }
    }

    this.run = { id, prompt: req.prompt, base, skipPermissions: req.skipPermissions, lanes };

    // Spawn every lane in PARALLEL (each in its own worktree cwd — isolated).
    for (const lane of lanes) {
      this.startLane(lane);
    }

    return { id, lanes: lanes.map(toLane) };
  }

  /** Current run snapshot, or null when none is active. */
  get(): FanoutRun | null {
    if (this.run === null) return null;
    return {
      id: this.run.id,
      prompt: this.run.prompt,
      base: this.run.base,
      skipPermissions: this.run.skipPermissions,
      lanes: this.run.lanes.map(toLane),
    };
  }

  /** Merge the winning lane into base + discard the rest. Implemented in Task 4. */
  async select(req: FanoutSelectRequest): Promise<MergeResult> {
    return this.doSelect(req);
  }

  /** Kill running lanes + remove every lane worktree. Implemented in Task 4. */
  async abort(): Promise<Ack> {
    return this.doAbort();
  }

  /** Spawns one lane via the injected runner and wires its terminal status. */
  private startLane(lane: LaneState): void {
    if (this.run === null) return;
    lane.status = 'running';
    this.emit(lane);
    lane.proc = this.deps.laneRunner({
      agentCommand: this.deps.agentCommand,
      prompt: this.run.prompt,
      model: lane.model,
      cwd: lane.worktreeId,
      skipPermissions: this.run.skipPermissions,
      onDone: (r) => {
        void this.onLaneDone(lane, r);
      },
    });
  }

  /**
   * Records a lane's terminal result. On exit 0 it COMMITS the lane's working-tree
   * edits (a headless `claude -p` leaves them uncommitted) so the branch HEAD carries
   * them for select()'s merge — status flips to 'done' only AFTER the commit, so a
   * waiter that sees 'done' can safely merge. A non-zero exit (or a commit failure)
   * marks the lane 'failed'. Emits the final status.
   */
  private async onLaneDone(lane: LaneState, r: LaneRunResult): Promise<void> {
    lane.exitCode = r.code;
    lane.stdoutTail = r.stdout.slice(-STDOUT_TAIL_BYTES);
    lane.proc = undefined;
    if (r.code === 0) {
      try {
        await this.commitLane(lane);
        lane.status = 'done';
      } catch (error) {
        lane.status = 'failed';
        lane.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      lane.status = 'failed';
      lane.error = r.stderr.slice(-STDOUT_TAIL_BYTES) || `lane exited with code ${String(r.code)}`;
    }
    this.emit(lane);
  }

  /**
   * Stages + commits the lane worktree's edits so its branch HEAD advances past base.
   * If the lane made NO edits (claude answered without editing), staging is empty and
   * we skip the commit — the branch stays at base and select() merges nothing, which
   * is correct. Each lane commits in its OWN worktree cwd, so parallel commits do not
   * contend on one index.
   */
  private async commitLane(lane: LaneState): Promise<void> {
    const g = this.deps.gitFactory(lane.worktreeId);
    await g.add(['-A']);
    const staged = await g.diff(['--cached', '--name-only']);
    if (staged.trim().length > 0) {
      await g.commit(`fanout: ${lane.model} lane`);
    }
  }

  /**
   * Force-deletes a discarded lane branch from the PRIMARY repo (a worktree cannot
   * delete its own checked-out branch — so the caller MUST remove the worktree
   * first). Best-effort: -D because the branch is an unmerged throwaway, and a leak
   * is non-fatal. The winner branch is deleted by MergeRunner (cleanup:true), so this
   * only runs for losers/aborts.
   */
  private async deleteBranch(branch: string): Promise<void> {
    try {
      await this.deps.gitFactory(this.deps.repoRoot).branch(['-D', branch]);
    } catch {
      // best-effort: an unmerged throwaway branch; leaking it is non-fatal.
    }
  }

  /** Removes any already-created worktrees during a failed start (best-effort). */
  private async rollback(lanes: LaneState[]): Promise<void> {
    for (const lane of lanes) {
      try {
        await this.deps.worktrees.remove({ worktreeId: lane.worktreeId, force: true });
      } catch {
        // best-effort cleanup of a partial start — ignore.
      }
    }
  }

  private emit(lane: LaneState): void {
    if (this.run === null) return;
    this.deps.emitter.emitLaneStatus({ id: this.run.id, lane: toLane(lane) });
  }

  // ── select/abort bodies ─────────────────────────────────────────────────────
  /**
   * Merges the winning lane's branch into base via MergeRunner (runVerifyHook:false,
   * cleanup:true — the winner's worktree + branch are removed on success, reusing
   * MergeRunner's conflict/safe-abort path verbatim). On a clean merge, the OTHER
   * lane worktrees are removed and the run is cleared. A conflict/failed result keeps
   * the run (the renderer surfaces it via the returned MergeResult) so the user can
   * retry/abort — we do NOT clean up the losers until the winner truly merged.
   */
  protected async doSelect(req: FanoutSelectRequest): Promise<MergeResult> {
    if (this.run === null) throw new Error('no active fan-out run');
    const winner = this.run.lanes.find((l) => l.laneId === req.laneId);
    if (!winner) throw new Error(`unknown lane ${req.laneId}`);

    const result = await this.deps.merge.run({
      worktreeId: winner.worktreeId,
      targetBranch: this.run.base,
      runVerifyHook: false,
      cleanup: true,
    });

    if (result.status !== 'merged') return result; // keep run; renderer shows conflict/failed

    // Remove every OTHER lane's worktree THEN its branch (the winner's worktree+branch
    // were cleaned by MergeRunner). Worktree-remove must precede branch -D.
    for (const lane of this.run.lanes) {
      if (lane.laneId === winner.laneId) continue;
      try {
        await this.deps.worktrees.remove({ worktreeId: lane.worktreeId, force: true });
      } catch {
        // best-effort: a removal failure does not undo a successful merge.
      }
      await this.deleteBranch(lane.branch);
    }
    this.run = null;
    return result;
  }

  /**
   * Kills any still-running lane processes, then removes EVERY lane worktree
   * (force, so an in-flight edit does not block removal), and clears the run. Never
   * merges. Best-effort per worktree so one failure does not strand the rest.
   */
  protected async doAbort(): Promise<Ack> {
    if (this.run === null) return { ok: true };
    for (const lane of this.run.lanes) {
      try {
        lane.proc?.kill();
      } catch {
        // best-effort kill — continue to worktree removal regardless.
      }
    }
    for (const lane of this.run.lanes) {
      try {
        await this.deps.worktrees.remove({ worktreeId: lane.worktreeId, force: true });
      } catch {
        // best-effort: keep removing the remaining lanes.
      }
      await this.deleteBranch(lane.branch); // none merged → force-delete every lane branch
    }
    this.run = null;
    return { ok: true };
  }
}

/** Projects mutable LaneState to the readonly public FanoutLane snapshot. */
function toLane(s: LaneState): FanoutLane {
  return {
    laneId: s.laneId,
    model: s.model,
    worktreeId: s.worktreeId,
    branch: s.branch,
    status: s.status,
    exitCode: s.exitCode,
    stdoutTail: s.stdoutTail,
    error: s.error,
  };
}
