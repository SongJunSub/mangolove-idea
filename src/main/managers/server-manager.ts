import type {
  ServerKind,
  ServerState,
  ServerProcess,
  ServerStatus,
  StartServerRequest,
  StopServerRequest,
} from '../../shared/types';
import type { IProcLike, ProcessRunner } from '../proc/process-runner';
import { detectRunner, type DetectedRunner } from '../util/detect-runner';
import type { LogStore } from './log-store';

/** Where ServerManager publishes one worktree's server state (injected for tests). */
export interface ServerEmitter {
  emitState(status: ServerStatus): void;
}

/** Constructor dependencies — all injectable for windowless unit tests. */
export interface ServerManagerDeps {
  readonly runner: ProcessRunner;
  readonly logStore: LogStore;
  readonly emitter: ServerEmitter;
  /** Worktree dir detection; default detectRunner. Injectable for tests. */
  readonly detect?: (dir: string) => DetectedRunner;
  /** Resolves worktreeId -> absolute cwd (undefined if not a managed worktree). */
  readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  /** Global command override from the main-side env seam (MANGO_SERVER_CMD). */
  readonly commandOverride?: string;
  /**
   * Fired when the LAST live server child goes away (stop or natural exit), i.e.
   * the manager transitions from busy -> idle ACROSS ALL worktrees. register-ipc
   * uses this to perform a settings edit that was DEFERRED while busy: clearing
   * ctx.serverManager so the next start rebuilds with the new serverCommand.
   * Optional => no-op. Mirrors SessionManager.notifyIfIdle (fires only at 0 live).
   */
  readonly onIdle?: () => void;
}

/** Internal per-worktree bookkeeping for ONE running child. */
interface RunningServer {
  readonly proc: IProcLike;
  readonly worktreeId: string;
  readonly kind: ServerKind;
  readonly command: string;
  readonly startedAt: number;
  /** True once we requested stop (so a following exit reads as 'stopped'). */
  stopping: boolean;
}

/**
 * Owns ONE local server PER worktree, CONCURRENTLY (V2 parallel servers). Mirrors
 * SessionManager: a Map<worktreeId, RunningServer>, a scoped replace that UNMAPS
 * before kill so a replaced child's late exit reads as stale, killAll/dispose that
 * iterate ALL live children, and an onIdle that fires only when the LAST live
 * server (across worktrees) goes away. start() detects + spawns the
 * detected/overridden command in the worktree cwd, pipes stdout/stderr into that
 * worktree's LogStore partition, and publishes ServerStatus via the injected
 * emitter. Command source stays hardened (override or detection, never a renderer
 * field). NO port injection — relies on dev-server auto-increment + per-worktree
 * log detection of the actual printed port (D4 known limitation: a runner that
 * does NOT auto-increment needs a user-set per-worktree PORT).
 */
export class ServerManager {
  private readonly runner: ProcessRunner;
  private readonly logStore: LogStore;
  private readonly emitter: ServerEmitter;
  private readonly detect: (dir: string) => DetectedRunner;
  private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  private readonly commandOverride?: string;
  private readonly onIdle?: () => void;
  /** Live children, keyed by worktreeId (true concurrency). */
  private readonly servers = new Map<string, RunningServer>();
  /** Last process snapshot PER worktree (so status()/stop() report when idle). */
  private readonly last = new Map<string, ServerProcess>();

  constructor(deps: ServerManagerDeps) {
    this.runner = deps.runner;
    this.logStore = deps.logStore;
    this.emitter = deps.emitter;
    this.detect = deps.detect ?? detectRunner;
    this.resolvePath = deps.resolvePath;
    this.commandOverride = deps.commandOverride;
    this.onIdle = deps.onIdle;
  }

  /** Starts (replacing only THIS worktree's server) the detected/overridden command. */
  async start(req: StartServerRequest): Promise<ServerStatus> {
    this.replace(req.worktreeId); // stop only this worktree's existing server
    this.logStore.reset(req.worktreeId); // reset only this worktree's log ring

    const cwd = await this.resolvePath(req.worktreeId);
    if (!cwd) {
      return this.crash(req.worktreeId, 'unknown', undefined, `unknown worktree ${req.worktreeId}`);
    }

    const detected = this.detect(cwd);
    // Command source (hardened): main-side env seam (operator-controlled) OR
    // auto-detection — never a renderer-supplied request field.
    const command = this.commandOverride ?? detected.command;
    if (!command) {
      return this.crash(req.worktreeId, detected.kind, undefined, 'no runnable server detected');
    }

    this.emitState({
      worktreeId: req.worktreeId,
      kind: detected.kind,
      state: 'starting',
      command,
    });

    const proc = this.runner.spawn(command, { cwd });
    const server: RunningServer = {
      proc,
      worktreeId: req.worktreeId,
      kind: detected.kind,
      command,
      startedAt: Date.now(),
      stopping: false,
    };
    this.servers.set(req.worktreeId, server);

    proc.onStdout((chunk) => this.logStore.append(server.worktreeId, 'stdout', chunk));
    proc.onStderr((chunk) => this.logStore.append(server.worktreeId, 'stderr', chunk));
    proc.onExit((e) => this.handleExit(server, e.code, e.signal));

    return this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'running',
      pid: proc.pid,
      command: server.command,
      startedAt: server.startedAt,
    });
  }

  /** Stops one worktree's server (idempotent). */
  async stop(req: StopServerRequest): Promise<ServerStatus> {
    // StopServerRequest.worktreeId is the TRANSIENT optional shim (Task 1, tightened
    // to required in Task 6). When absent there is no per-worktree target, so report a
    // stopped snapshot (mirrors the old singular fallback) rather than guessing.
    const worktreeId = req.worktreeId;
    if (worktreeId === undefined) return { process: STOPPED_IDLE };
    const server = this.servers.get(worktreeId);
    if (!server) return this.status(worktreeId);
    server.stopping = true;
    this.servers.delete(worktreeId);
    this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'stopping',
      pid: server.proc.pid,
      command: server.command,
      startedAt: server.startedAt,
    });
    server.proc.kill();
    this.logStore.flush(server.worktreeId);
    const status = this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'stopped',
      command: server.command,
      exitCode: null,
    });
    // busy -> idle only when this was the LAST live server (mirror notifyIfIdle).
    this.notifyIfServerIdle();
    return status;
  }

  /** Snapshot for ONE worktree (its last emitted state, or a stopped default). */
  status(worktreeId: string): ServerStatus {
    return { process: this.last.get(worktreeId) ?? stoppedFor(worktreeId) };
  }

  /** Every known worktree's snapshot, keyed by worktreeId (mount rehydrate, D2). */
  statusAll(): Record<string, ServerStatus> {
    const out: Record<string, ServerStatus> = {};
    for (const [worktreeId, process] of this.last) {
      out[worktreeId] = { process };
    }
    return out;
  }

  /** Worktrees with a LIVE server child (used by the live-apply guard). */
  liveServerWorktreeIds(): string[] {
    return [...this.servers.keys()];
  }

  /** True iff ANY worktree has a live server child. */
  hasAnyLiveServer(): boolean {
    return this.servers.size > 0;
  }

  /** Kills EVERY running child (before-quit sweep). */
  killAll(): void {
    for (const server of this.servers.values()) {
      server.stopping = true;
      server.proc.kill();
    }
    this.servers.clear();
  }

  /** Alias for killAll for the disposer. */
  dispose(): void {
    this.killAll();
  }

  /** Stops one worktree's server (used by start's replace), UNMAPPING before kill. */
  private replace(worktreeId: string): void {
    const server = this.servers.get(worktreeId);
    if (!server) return;
    this.servers.delete(worktreeId); // unmap first so its exit is recognized as stale
    server.stopping = true;
    server.proc.kill();
  }

  private handleExit(server: RunningServer, code: number | null, _signal: string | null): void {
    // Stale-exit guard (identity, mirror SessionManager): only the CURRENT mapped
    // server for this worktree may flip state. A replaced child (already unmapped)
    // is swallowed.
    if (this.servers.get(server.worktreeId) !== server) return;
    this.servers.delete(server.worktreeId);
    this.logStore.flush(server.worktreeId);
    // Clean stop = we asked it to stop (kill) OR it exited 0; anything else is a crash.
    const stoppedCleanly = server.stopping || code === 0;
    this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: stoppedCleanly ? 'stopped' : 'crashed',
      command: server.command,
      exitCode: code,
    });
    this.notifyIfServerIdle();
  }

  /** Fires onIdle exactly when the LAST live server (any worktree) has gone away. */
  private notifyIfServerIdle(): void {
    if (this.liveServerWorktreeIds().length === 0) this.onIdle?.();
  }

  private crash(
    worktreeId: string,
    kind: ServerKind,
    pid: number | undefined,
    message: string,
  ): ServerStatus {
    this.logStore.append(worktreeId, 'stderr', `[mango] ${message}\n`);
    this.logStore.flush(worktreeId);
    return this.emitState({ worktreeId, kind, state: 'crashed', pid, exitCode: null });
  }

  /** Records + publishes one worktree's state, returning its ServerStatus. */
  private emitState(partial: {
    worktreeId: string;
    kind: ServerKind;
    state: ServerState;
    pid?: number;
    command?: string;
    startedAt?: number;
    exitCode?: number | null;
  }): ServerStatus {
    const process: ServerProcess = { ...partial };
    this.last.set(partial.worktreeId, process);
    const status: ServerStatus = { process };
    this.emitter.emitState(status);
    return status;
  }
}

/** A stopped snapshot for a worktree that has never run a server. */
function stoppedFor(worktreeId: string): ServerProcess {
  return { worktreeId, kind: 'unknown', state: 'stopped' };
}

/**
 * Stopped snapshot returned by stop() when the request carries no worktreeId (the
 * transient optional shim — Task 1). worktreeId:null marks "no per-worktree target".
 */
const STOPPED_IDLE: ServerProcess = { worktreeId: null, kind: 'unknown', state: 'stopped' };
