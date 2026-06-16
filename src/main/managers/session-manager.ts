import type { Ack, AgentSession, AgentStatus } from '../../shared/types';
import type { IPtyLike, PtyExitEvent, PtyFactory } from '../pty/pty-factory';

/** Plan-2 spawn input (mirrors SpawnSessionRequest minus transport concerns). */
export interface SpawnArgs {
  readonly worktreeId: string;
  readonly continueSession: boolean;
  readonly cols: number;
  readonly rows: number;
}

/** Where SessionManager publishes main->renderer events (injected, so tests spy). */
export interface SessionEmitter {
  emitOutput(e: { worktreeId: string; data: string }): void;
  emitExit(e: { worktreeId: string; exitCode: number; signal?: number }): void;
  emitStatus(s: AgentSession): void;
}

/** Constructor dependencies — all injectable for windowless unit tests. */
export interface SessionManagerDeps {
  readonly factory: PtyFactory;
  readonly emitter: SessionEmitter;
  /** Binary to spawn; default 'claude'. Injectable so smokes use a harmless cmd. */
  readonly command?: string;
  /** Resolves worktreeId -> absolute cwd, or undefined if not a managed worktree. */
  readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
}

/** Internal per-worktree bookkeeping. */
interface Session {
  readonly pty: IPtyLike;
  status: AgentStatus;
  readonly continued: boolean;
  /** Guards against double exit emission (kill then natural exit). */
  exited: boolean;
}

/**
 * Owns one node-pty per worktree running `claude`. Lifecycle + status bookkeeping
 * only; the PTY itself is created by the injected PtyFactory so tests pass a fake.
 * Emits OUTPUT/EXIT/STATUS through the injected SessionEmitter. Plan 5 calls
 * killAll() from the before-quit sweep.
 */
export class SessionManager {
  private readonly factory: PtyFactory;
  private readonly emitter: SessionEmitter;
  private readonly command: string;
  private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  private readonly sessions = new Map<string, Session>();

  constructor(deps: SessionManagerDeps) {
    this.factory = deps.factory;
    this.emitter = deps.emitter;
    this.command = deps.command ?? 'claude';
    this.resolvePath = deps.resolvePath;
  }

  /** Spawns (or replaces) the PTY for a worktree and returns its AgentSession. */
  async spawn(args: SpawnArgs): Promise<AgentSession> {
    const { worktreeId, continueSession, cols, rows } = args;

    // Replace-on-respawn: UNMAP the old session BEFORE killing it, so its exit
    // (synchronous from the fake, asynchronous from real node-pty) is recognized
    // as a stale handle in handleExit and does NOT emit a spurious SESSION_EXIT
    // for the worktree being respawned.
    const existing = this.sessions.get(worktreeId);
    this.sessions.delete(worktreeId);
    if (existing && !existing.exited) {
      existing.exited = true;
      existing.pty.kill();
    }

    this.emitStatus(worktreeId, 'starting', undefined, continueSession);

    const cwd = await this.resolvePath(worktreeId);
    if (!cwd) {
      const errored = this.buildSession(worktreeId, 'error', undefined, continueSession);
      this.emitter.emitStatus(errored);
      return errored;
    }

    const ptyArgs = continueSession ? ['--continue'] : [];
    const pty = this.factory.spawn(this.command, ptyArgs, { cwd, cols, rows });

    const session: Session = { pty, status: 'running', continued: continueSession, exited: false };
    this.sessions.set(worktreeId, session);

    pty.onData((data) => this.emitter.emitOutput({ worktreeId, data }));
    pty.onExit((e) => this.handleExit(worktreeId, session, e));

    const running = this.buildSession(worktreeId, 'running', pty.pid, continueSession);
    this.emitter.emitStatus(running);
    return running;
  }

  /** Writes raw input to a worktree's PTY (no-op if none). */
  write(req: { worktreeId: string; data: string }): void {
    const s = this.sessions.get(req.worktreeId);
    if (s && !s.exited) s.pty.write(req.data);
  }

  /** Resizes a worktree's PTY (no-op if none). */
  resize(req: { worktreeId: string; cols: number; rows: number }): void {
    const s = this.sessions.get(req.worktreeId);
    if (s && !s.exited) s.pty.resize(req.cols, req.rows);
  }

  /** Kills a worktree's PTY. Returns ok:false if there was no session. */
  kill(worktreeId: string): Ack {
    const s = this.sessions.get(worktreeId);
    if (!s) return { ok: false, error: `no session for ${worktreeId}` };
    if (!s.exited) {
      s.exited = true;
      s.pty.kill();
    }
    return { ok: true };
  }

  /** Current AgentSession snapshot for a worktree, if any. */
  snapshot(worktreeId: string): AgentSession | undefined {
    const s = this.sessions.get(worktreeId);
    if (!s) return undefined;
    return this.buildSession(worktreeId, s.status, s.pty.pid, s.continued);
  }

  /** Kills every live PTY (Plan 5 before-quit sweep calls this). */
  killAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.exited) {
        s.exited = true;
        s.pty.kill();
      }
    }
  }

  /** Alias for killAll so a future disposer can call either. */
  dispose(): void {
    this.killAll();
    this.sessions.clear();
  }

  private handleExit(worktreeId: string, session: Session, e: PtyExitEvent): void {
    // Ignore exits from a PTY that is no longer the current session for this
    // worktree — i.e. it was replaced by a respawn. Identity (not map presence)
    // is the discriminator, so this holds whether the exit arrives synchronously
    // (fake kill) or asynchronously (real node-pty arriving after the new spawn).
    if (this.sessions.get(worktreeId) !== session) return;
    session.status = 'exited';
    session.exited = true;
    this.emitter.emitExit({ worktreeId, exitCode: e.exitCode, signal: e.signal });
    this.emitStatus(worktreeId, 'exited', undefined, session.continued);
  }

  private emitStatus(
    worktreeId: string,
    status: AgentStatus,
    pid: number | undefined,
    continued: boolean,
  ): void {
    this.emitter.emitStatus(this.buildSession(worktreeId, status, pid, continued));
  }

  private buildSession(
    worktreeId: string,
    status: AgentStatus,
    pid: number | undefined,
    continued: boolean,
  ): AgentSession {
    // hasActiveTurn: honest false for Plan 2 — real turn detection is Plan 5.
    return { worktreeId, pid, status, hasActiveTurn: false, continued };
  }
}
