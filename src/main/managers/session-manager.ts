import type { Ack, AgentSession, AgentStatus, SessionRecord } from '../../shared/types';
import type { IPtyLike, PtyExitEvent, PtyFactory } from '../pty/pty-factory';
import { DirectLauncher, type AgentLauncher, type LaunchMode } from '../pty/agent-launcher';

/**
 * A turn is "active" iff the PTY emitted output within the last ACTIVE_TURN_MS.
 * Output-activity heuristic (NOT TUI-string parsing): during a turn claude streams
 * tokens/tool output continuously; when idle it is quiet. Version-independent.
 * 1500 ms tolerates the gap between streamed tokens while collapsing to "idle"
 * within ~1.5 s of the turn ending.
 */
const ACTIVE_TURN_MS = 1500;

/** Plan-2 spawn input (mirrors SpawnSessionRequest minus transport concerns). */
export interface SpawnArgs {
  readonly worktreeId: string;
  readonly continueSession: boolean;
  readonly cols: number;
  readonly rows: number;
}

/** Structural port for the SessionStore (Plan 5) — only what SessionManager calls. */
export interface SessionRecordSink {
  upsert(record: SessionRecord): void;
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
  /**
   * Decides the launch argv per spawn (Branch by Abstraction seam for b-full).
   * Optional => a DirectLauncher is derived from `command`, preserving the exact
   * pre-b-full behavior. Phase 2 injects an AbducoLauncher for detached sessions.
   */
  readonly launcher?: AgentLauncher;
  /** Resolves worktreeId -> absolute cwd, or undefined if not a managed worktree. */
  readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  /** Resolves worktreeId -> branch name for the persisted SessionRecord (Plan 5). */
  readonly resolveBranch?: (worktreeId: string) => Promise<string | undefined>;
  /** Persists hadActiveSession on successful spawn (Plan 5). Optional => no-op. */
  readonly store?: SessionRecordSink;
  /** Clock for SessionRecord.updatedAt; default Date.now (Plan 5). */
  readonly clock?: () => number;
  /**
   * Fired when the LAST live PTY goes away (kill or natural exit), i.e. the
   * manager transitions from busy -> idle. register-ipc uses this to perform a
   * settings edit that was DEFERRED while busy: clearing ctx.sessionManager so
   * the next spawn rebuilds with the new agentCommand. Optional => no-op.
   */
  readonly onIdle?: () => void;
}

/** Internal per-worktree bookkeeping. */
interface Session {
  readonly pty: IPtyLike;
  status: AgentStatus;
  readonly continued: boolean;
  /** Guards against double exit emission (kill then natural exit). */
  exited: boolean;
  /**
   * Epoch ms (via injected clock) of the most recent PTY output. Initialized to
   * spawn time so a still-loading session counts as an active turn until it goes
   * quiet. Drives hasActiveTurn (output-activity heuristic, V2 C).
   */
  lastOutputAt: number;
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
  private readonly launcher: AgentLauncher;
  private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  private readonly resolveBranch?: (worktreeId: string) => Promise<string | undefined>;
  private readonly store?: SessionRecordSink;
  private readonly clock: () => number;
  private readonly onIdle?: () => void;
  private readonly sessions = new Map<string, Session>();

  constructor(deps: SessionManagerDeps) {
    this.factory = deps.factory;
    this.emitter = deps.emitter;
    this.command = deps.command ?? 'claude';
    // Default to a DirectLauncher built from `command` so an un-injected launcher
    // reproduces the exact pre-b-full argv (file: command, args: --continue|[]).
    this.launcher = deps.launcher ?? new DirectLauncher(this.command);
    this.resolvePath = deps.resolvePath;
    this.resolveBranch = deps.resolveBranch;
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.onIdle = deps.onIdle;
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

    // 3-way reopen decision (b-full) — taken HERE in main, never in the renderer,
    // because only main can observe OS-level detached-session liveness (a renderer
    // round-trip would be a TOCTOU window). The renderer's continueSession is an
    // INTENT signal; main overrides it to 'attach' when a live background session
    // exists. DirectLauncher exposes no isLiveDetached, so the b-lite path keeps
    // exactly its fresh|continue behavior.
    let mode: LaunchMode = continueSession ? 'continue' : 'fresh';
    if (this.launcher.isLiveDetached && (await this.launcher.isLiveDetached(worktreeId))) {
      mode = 'attach';
    }
    const { file, args: ptyArgs } = this.launcher.resolveLaunch({ worktreeId, cwd, mode });
    const pty = this.factory.spawn(file, ptyArgs, { cwd, cols, rows });

    const session: Session = {
      pty,
      status: 'running',
      continued: continueSession,
      exited: false,
      // Count a just-spawned (still-loading, no-output-yet) session as active until
      // it goes quiet for ACTIVE_TURN_MS — better to warn than silently kill spin-up.
      lastOutputAt: this.clock(),
    };
    this.sessions.set(worktreeId, session);

    pty.onData((data) => {
      // Stamp every output byte: this is the whole turn-detection signal.
      session.lastOutputAt = this.clock();
      this.emitter.emitOutput({ worktreeId, data });
    });
    pty.onExit((e) => this.handleExit(worktreeId, session, e));

    const running = this.buildSession(worktreeId, 'running', pty.pid, continueSession);
    this.emitter.emitStatus(running);

    await this.recordActive(worktreeId);

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
      // Idle notification is fired by handleExit (the PTY's exit event always
      // follows kill, sync from the fake / async from real node-pty), so it runs
      // exactly once whether the session ends by kill or by natural exit.
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

  /**
   * b-full: ends a worktree's DETACHED background session — closes the front-end
   * PTY AND kills the surviving abduco master so nothing keeps running in the
   * background. No-op beyond the front-end kill for b-lite (DirectLauncher has no
   * endDetached). Best-effort; the master kill is awaited so callers can sequence.
   */
  async endDetached(worktreeId: string): Promise<void> {
    this.kill(worktreeId);
    if (this.launcher.endDetached) await this.launcher.endDetached(worktreeId);
  }

  /**
   * b-full global kill-switch: ends EVERY detached background session (every
   * surviving abduco master). No-op for b-lite. The front-ends of any currently
   * attached sessions then receive their natural exit. Best-effort.
   */
  async endAllDetached(): Promise<void> {
    if (this.launcher.endAllDetached) await this.launcher.endAllDetached();
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
    this.notifyIfIdle();
  }

  /**
   * Fires onIdle exactly when the LAST live PTY has gone away. Called from the
   * kill/natural-exit paths (NOT the quit sweep) so a settings edit deferred while
   * busy can take effect "once the live work ends" by rebuilding on next spawn.
   */
  private notifyIfIdle(): void {
    if (this.liveWorktreeIds().length === 0) this.onIdle?.();
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
    // AgentSession.hasActiveTurn stays false here ON PURPOSE: this status snapshot is a
    // POINT-IN-TIME event, but turn activity is a live, time-decaying signal. Real turn
    // detection (V2 C) lives in the hasActiveTurn(worktreeId) METHOD + activeTurnWorktreeIds(),
    // which the before-quit warning reads on demand. Nothing consumes this field today; it is
    // kept only to preserve the AgentSession shape. (Don't compute it here — it would bake a
    // stale 'active' into a status that is emitted on lifecycle changes, not on output.)
    return { worktreeId, pid, status, hasActiveTurn: false, continued };
  }

  /** Lists worktrees whose PTY is currently running (used by the quit warning). */
  liveWorktreeIds(): string[] {
    const ids: string[] = [];
    for (const [worktreeId, session] of this.sessions) {
      if (!session.exited) ids.push(worktreeId);
    }
    return ids;
  }

  /**
   * True iff the worktree has a LIVE (non-exited) session whose last PTY output was
   * within ACTIVE_TURN_MS — i.e. a turn is in flight right now. The before-quit
   * WARNING keys on this (a running turn would be lost on quit); an idle live session
   * is lossless (b-lite re-spawns it via `claude --continue`). Output-activity
   * heuristic, NOT TUI parsing (V2 C).
   */
  hasActiveTurn(worktreeId: string): boolean {
    const s = this.sessions.get(worktreeId);
    if (!s || s.exited) return false;
    return this.clock() - s.lastOutputAt < ACTIVE_TURN_MS;
  }

  /**
   * Live worktrees that currently have an active turn (subset of liveWorktreeIds).
   * The before-quit warning fires only when this is non-empty. The kill-sweep on
   * confirmed quit STILL uses liveWorktreeIds()/killAll() (kills idle sessions too).
   */
  activeTurnWorktreeIds(): string[] {
    return this.liveWorktreeIds().filter((id) => this.hasActiveTurn(id));
  }

  /**
   * Persists {hadActiveSession:true} for a worktree after a successful spawn so a
   * reopen offers `claude --continue`. Resolves branch via the injected resolver
   * (falls back to '' if unknown). No-op when no store is injected. NEVER writes
   * conversation content — only the four SessionRecord contract fields.
   */
  private async recordActive(worktreeId: string): Promise<void> {
    if (!this.store) return;
    const branch = (await this.resolveBranch?.(worktreeId)) ?? '';
    this.store.upsert({
      worktreePath: worktreeId,
      branch,
      hadActiveSession: true,
      updatedAt: this.clock(),
    });
  }
}
