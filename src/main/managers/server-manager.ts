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

/** Where ServerManager publishes the single-server state (injected for tests). */
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
  /** Global command override (env seam for the smoke); request override wins. */
  readonly commandOverride?: string;
}

/** Internal bookkeeping for the ONE running child. */
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
 * Owns AT MOST ONE local server (contract §6.5). start() detects + spawns the
 * detected/overridden command in the worktree cwd, pipes stdout/stderr into the
 * LogStore, and publishes ServerStatus via the injected emitter. A second start
 * replaces the running server (the product runs exactly one server). Mirrors the
 * Plan-2 identity discriminator so a replaced child's late exit never flips the
 * new run's state. dispose() is the before-quit kill-sweep hook.
 */
export class ServerManager {
  private readonly runner: ProcessRunner;
  private readonly logStore: LogStore;
  private readonly emitter: ServerEmitter;
  private readonly detect: (dir: string) => DetectedRunner;
  private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  private readonly commandOverride?: string;
  private current: RunningServer | null = null;
  /** Last process snapshot (so status()/stop() report something when idle). */
  private last: ServerProcess = STOPPED_IDLE;

  constructor(deps: ServerManagerDeps) {
    this.runner = deps.runner;
    this.logStore = deps.logStore;
    this.emitter = deps.emitter;
    this.detect = deps.detect ?? detectRunner;
    this.resolvePath = deps.resolvePath;
    this.commandOverride = deps.commandOverride;
  }

  /** Starts (replacing any running server) the detected/overridden command. */
  async start(req: StartServerRequest): Promise<ServerStatus> {
    this.replaceCurrent(); // stop any existing server first (one at a time)
    this.logStore.reset();

    const cwd = await this.resolvePath(req.worktreeId);
    if (!cwd) {
      return this.crash(req.worktreeId, 'unknown', undefined, `unknown worktree ${req.worktreeId}`);
    }

    const detected = this.detect(cwd);
    const command = req.commandOverride ?? this.commandOverride ?? detected.command;
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
    this.current = server;

    proc.onStdout((chunk) => this.logStore.append('stdout', chunk));
    proc.onStderr((chunk) => this.logStore.append('stderr', chunk));
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

  /** Stops the running server (idempotent). */
  async stop(_req: StopServerRequest): Promise<ServerStatus> {
    const server = this.current;
    if (!server) return { process: this.last };
    server.stopping = true;
    this.current = null;
    this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'stopping',
      pid: server.proc.pid,
      command: server.command,
      startedAt: server.startedAt,
    });
    server.proc.kill();
    this.logStore.flush();
    return this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'stopped',
      command: server.command,
      exitCode: null,
    });
  }

  /** Current single-server snapshot. */
  status(): ServerStatus {
    return { process: this.last };
  }

  /** Kills the running child (before-quit sweep). */
  killAll(): void {
    const server = this.current;
    this.current = null;
    if (server) server.proc.kill();
  }

  /** Alias for killAll for a future disposer. */
  dispose(): void {
    this.killAll();
  }

  /** Stops the current server (used by start's replace), unmapping BEFORE kill. */
  private replaceCurrent(): void {
    const server = this.current;
    if (!server) return;
    this.current = null; // unmap first so its exit is recognized as stale
    server.stopping = true;
    server.proc.kill();
  }

  private handleExit(server: RunningServer, code: number | null, _signal: string | null): void {
    // Stale-exit guard: only the CURRENT server may flip state. A replaced child
    // (this.current already advanced) is swallowed — Plan 2's identity lesson.
    if (this.current !== server) return;
    this.current = null;
    this.logStore.flush();
    // Clean stop = we asked it to stop (kill) OR it exited 0; anything else is a crash.
    const stoppedCleanly = server.stopping || code === 0;
    this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: stoppedCleanly ? 'stopped' : 'crashed',
      command: server.command,
      exitCode: code,
    });
  }

  private crash(
    worktreeId: string,
    kind: ServerKind,
    pid: number | undefined,
    message: string,
  ): ServerStatus {
    this.logStore.append('stderr', `[mango] ${message}\n`);
    this.logStore.flush();
    return this.emitState({ worktreeId, kind, state: 'crashed', pid, exitCode: null });
  }

  /** Records + publishes a state, returning the ServerStatus for invoke replies. */
  private emitState(partial: {
    worktreeId: string | null;
    kind: ServerKind;
    state: ServerState;
    pid?: number;
    command?: string;
    startedAt?: number;
    exitCode?: number | null;
  }): ServerStatus {
    this.last = { ...partial };
    const status: ServerStatus = { process: this.last };
    this.emitter.emitState(status);
    return status;
  }
}

/** The idle/stopped snapshot reported before any server has run. */
const STOPPED_IDLE: ServerProcess = { worktreeId: null, kind: 'unknown', state: 'stopped' };
