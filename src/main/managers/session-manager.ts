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

/**
 * A `claude --continue` that finds no conversation to resume prints one short line
 * ("No conversation found to continue") and exits NONZERO. A `--continue` that DID
 * resume redraws the whole prior transcript first — orders of magnitude more output.
 * So OUTPUT VOLUME (not elapsed time) is the reliable discriminator: a 'continue'
 * that exits nonzero having emitted fewer than this many bytes is the "nothing to
 * resume" case and is self-healed by respawning FRESH; one that streamed a real
 * conversation and then failed is above the threshold and surfaces its exit normally.
 * Time-based gating was rejected — it both over-triggers (a resumed session that
 * crashes fast is wrongly restarted, losing the crash) and under-triggers (a slow/
 * cold-start "no conversation" failure past the window is not healed).
 */
const RESUME_OUTPUT_BYTES = 1024;

/** Matches a complete xterm bracketed-paste envelope (ESC[200~ … ESC[201~), non-greedy.
 *  The ESC (0x1b) control byte is the literal terminal-escape prefix — matching it is the point. */
// eslint-disable-next-line no-control-regex
const BRACKETED_PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;

/**
 * True when PTY input carries a real user SUBMIT (a CR/LF), not merely a terminal auto-reply.
 * xterm fires onData for its OWN replies to claude's startup queries — cursor-position (DSR
 * `ESC[6n`), device-attributes (DA1 `ESC[c`), OSC color probes — with NO keystroke; those are
 * escape sequences that never contain CR/LF (verified against xterm.js source). So gating the
 * b-lite session record on CR/LF marks a worktree resumable only once the user actually sends a
 * line — also exactly when claude persists a conversation to `--continue` — instead of the
 * instant claude probes the terminal. The bracketed-paste envelope is stripped first because
 * xterm rewrites pasted `\n`→`\r`, so a multi-line PASTE (not yet submitted with Enter) would
 * otherwise false-positive; a real Enter after a paste arrives outside the envelope and still
 * counts. (All bytes are still forwarded to the PTY; only the RECORD trigger is gated.)
 */
function isUserSubmit(data: string): boolean {
  return /[\r\n]/.test(data.replace(BRACKETED_PASTE, ''));
}

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
  /** Drops a stale record (a worktree whose `--continue` found no conversation). Optional. */
  remove?(worktreePath: string): void;
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
  /**
   * The RESOLVED launch mode of THIS pty (not the caller's intent): only a
   * 'continue' spawn passed `claude --continue`, so only it is eligible for the
   * fresh-fallback self-heal. A 'fresh' respawn can never re-enter that branch,
   * which is what makes the fallback loop-free.
   */
  readonly mode: LaunchMode;
  /** Total output bytes streamed by this pty — the self-heal "did it resume?" signal. */
  outputBytes: number;
  /**
   * True once hadActiveSession has been persisted for this session. In b-lite it flips on
   * the user's FIRST input — NOT at spawn — because only real interaction produces a
   * conversation claude can `--continue` (recording at spawn marked opened-but-never-used
   * worktrees resumable, so every reopen ran a doomed `--continue`). In b-full it is set at
   * spawn (boot-reap tracks detached sessions by record). Either way it guards the record to
   * fire exactly once — no per-keystroke disk write.
   */
  recorded: boolean;
  /** Last known geometry, so a fresh-fallback respawn keeps the terminal's size. */
  cols: number;
  rows: number;
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
  /**
   * Per-worktree kill counter, bumped on every kill(). A self-heal respawn samples it
   * before its async spawn and re-checks after: a change means a kill landed in the gap
   * (where the map was momentarily empty and kill() no-oped), so the respawn is aborted.
   */
  private readonly killGen = new Map<string, number>();
  /** Set once dispose() runs — a self-heal respawn in flight must not resurrect a session. */
  private disposed = false;

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

  /**
   * Spawns (or replaces) the PTY for a worktree and returns its AgentSession. `opts.skipAttach`
   * is set ONLY by self-heal respawns: they are recovering from a detached session that just
   * died, so re-attaching to it is wrong — skipping the liveness probe forces mode to
   * continue|fresh and makes the self-heal chain (attach→continue→fresh) strictly converge.
   */
  async spawn(args: SpawnArgs, opts?: { readonly skipAttach?: boolean }): Promise<AgentSession> {
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
    if (!opts?.skipAttach && this.launcher.isLiveDetached) {
      try {
        if (await this.launcher.isLiveDetached(worktreeId)) mode = 'attach';
      } catch {
        // The abduco liveness probe failed (binary hiccup / timeout) — fall back to
        // continue/fresh rather than failing the whole spawn and breaking the terminal.
      }
    }
    const { file, args: ptyArgs } = this.launcher.resolveLaunch({ worktreeId, cwd, mode });
    const pty = this.factory.spawn(file, ptyArgs, { cwd, cols, rows });

    const session: Session = {
      pty,
      status: 'running',
      continued: continueSession,
      mode,
      outputBytes: 0,
      recorded: false,
      cols,
      rows,
      exited: false,
      // Count a just-spawned (still-loading, no-output-yet) session as active until
      // it goes quiet for ACTIVE_TURN_MS — better to warn than silently kill spin-up.
      lastOutputAt: this.clock(),
    };
    this.sessions.set(worktreeId, session);

    pty.onData((data) => {
      // Stamp every output byte: turn-detection signal + the self-heal volume signal.
      session.lastOutputAt = this.clock();
      session.outputBytes += data.length;
      this.emitter.emitOutput({ worktreeId, data });
    });
    pty.onExit((e) => this.handleExit(worktreeId, session, e));

    const running = this.buildSession(worktreeId, 'running', pty.pid, continueSession);
    this.emitter.emitStatus(running);

    // b-full detached sessions survive quit and are boot-reaped BY RECORD (abduco-reap only
    // reaps sessions it has a record for; unrecognized live sessions are spared). So a b-full
    // spawn must be recorded IMMEDIATELY — even before any input — or a never-typed session
    // whose worktree is later deleted could never be reaped. b-lite has no reaping, so it
    // defers the record to first input (write()) to avoid marking an opened-but-never-used
    // worktree resumable. The `recorded` flag then keeps write() from recording a second time.
    if (this.launcher.isLiveDetached) {
      session.recorded = true;
      await this.recordActive(worktreeId);
    }

    return running;
  }

  /** Writes raw input to a worktree's PTY (no-op if none). */
  write(req: { worktreeId: string; data: string }): void {
    const s = this.sessions.get(req.worktreeId);
    if (!s || s.exited) return;
    s.pty.write(req.data); // ALL bytes reach the pty (claude needs its query replies too)
    // First real user SUBMIT ⇒ persist hadActiveSession so a reopen offers `--continue`.
    // Recording HERE (not at spawn), and only on a CR/LF submit (not a stray xterm auto-reply
    // to claude's startup queries), means an opened-but-never-typed worktree never gets a
    // record, so its reopen goes straight to a fresh session — no doomed continue attempt.
    if (!s.recorded && isUserSubmit(req.data)) {
      s.recorded = true;
      void this.recordActive(req.worktreeId).catch(() => {});
    }
  }

  /** Resizes a worktree's PTY (no-op if none). */
  resize(req: { worktreeId: string; cols: number; rows: number }): void {
    const s = this.sessions.get(req.worktreeId);
    if (s && !s.exited) {
      s.cols = req.cols;
      s.rows = req.rows;
      s.pty.resize(req.cols, req.rows);
    }
  }

  /** Kills a worktree's PTY. Returns ok:false if there was no session. */
  kill(worktreeId: string): Ack {
    // Record the kill even when it no-ops: a self-heal respawn awaiting its fresh spawn
    // (map momentarily empty) samples this counter and aborts if it changed in the gap.
    this.killGen.set(worktreeId, (this.killGen.get(worktreeId) ?? 0) + 1);
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
    this.disposed = true;
    this.killAll();
    this.sessions.clear();
  }

  /**
   * b-full: ends a worktree's DETACHED background session — closes the front-end
   * PTY AND kills the surviving abduco master so nothing keeps running in the
   * background. No-op beyond the front-end kill for b-lite (DirectLauncher has no
   * endDetached). Returns the front-end kill Ack (ok:false when there was no live
   * front-end session, mirroring kill()); the master kill is awaited so callers can
   * sequence (e.g. before quit).
   */
  async endDetached(worktreeId: string): Promise<Ack> {
    const ack = this.kill(worktreeId);
    if (this.launcher.endDetached) await this.launcher.endDetached(worktreeId);
    return ack;
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
    // kill()/killAll() set exited=true BEFORE pty.kill(), so a true value here means
    // this exit was DELIBERATE (user Stop / quit sweep / dispose) — never self-heal it.
    const killed = session.exited;
    session.status = 'exited';
    session.exited = true;

    // Self-heal a session that died a recoverable "nothing to resume" death (nonzero exit,
    // near-zero output) instead of surfacing a dead terminal. Two cases, each respawning ONCE:
    //   attach-fail   → the detached session vanished between the liveness probe and re-attach
    //                   (b-full TOCTOU). Its conversation JSONL may survive, so retry via
    //                   CONTINUE (which itself self-heals to fresh if there is nothing to resume).
    //   continue-fail → nothing to resume → go FRESH.
    // Respawns pass skipAttach, so the chain is strictly attach→continue→fresh and cannot loop
    // (fresh never satisfies the predicate). surfaceExit is deferred to the respawn's failure path.
    if (!killed && this.shouldSelfHeal(session, e)) {
      const retryContinue = session.mode === 'attach';
      // A doomed b-lite `--continue` proves its record stale — drop it so the next reopen skips
      // straight to fresh (self-corrects records written eagerly by older builds). NOT for
      // attach-fail (b-full only) nor any b-full record: there the reopen mode is chosen by OS
      // liveness, never by the record, so the record is purely reap bookkeeping.
      if (!retryContinue && !this.launcher.isLiveDetached) this.store?.remove?.(worktreeId);
      void this.respawn(worktreeId, session, e, retryContinue);
      return;
    }
    this.surfaceExit(worktreeId, session, e);
  }

  /** Emits the terminal exit + 'exited' status and fires the idle hook (normal end-of-life). */
  private surfaceExit(worktreeId: string, session: Session, e: PtyExitEvent): void {
    this.emitter.emitExit({ worktreeId, exitCode: e.exitCode, signal: e.signal });
    this.emitStatus(worktreeId, 'exited', undefined, session.continued);
    this.notifyIfIdle();
  }

  /**
   * Self-heal respawn of a worktree after a recoverable death (see handleExit). Respawns as
   * CONTINUE (attach-fail: the JSONL may survive) or FRESH (continue-fail), always with
   * skipAttach so it can never re-attach to the session that just died — which is what bounds
   * the attach→continue→fresh chain. Robust to the failure modes the review surfaced:
   * (1) if the respawn itself fails (cwd gone / rejects), the ORIGINAL exit is surfaced so the
   * terminal shows an honest end instead of a blank screen; (2) if the user killed or the
   * manager was disposed during the spawn's async gap (map momentarily empty, so kill()
   * no-ops), that intent is honored by killing the just-created session rather than orphaning
   * a live claude the user asked to close. Fire-and-forget from the sync exit callback.
   */
  private async respawn(
    worktreeId: string,
    prev: Session,
    e: PtyExitEvent,
    continueSession: boolean,
  ): Promise<void> {
    const gen = this.killGen.get(worktreeId) ?? 0;
    // Wipe the stray "No conversation found"/"no session" line so the retry opens clean.
    this.emitter.emitOutput({ worktreeId, data: '\x1b[2J\x1b[3J\x1b[H' });
    let next: AgentSession;
    try {
      next = await this.spawn(
        { worktreeId, continueSession, cols: prev.cols, rows: prev.rows },
        { skipAttach: true },
      );
    } catch {
      this.surfaceExit(worktreeId, prev, e);
      return;
    }
    // A kill/close/dispose landed during the await — honor it, don't leave a live orphan.
    if (this.disposed || (this.killGen.get(worktreeId) ?? 0) !== gen) {
      this.kill(worktreeId);
      return;
    }
    // The respawn couldn't start (e.g. the worktree cwd is gone) — surface the exit.
    if (next.status === 'error') this.surfaceExit(worktreeId, prev, e);
  }

  /**
   * True iff `session` died the recoverable "nothing to resume" way: a `--continue` that found
   * no conversation, OR an `attach` whose detached session vanished between the liveness probe
   * and re-attach (b-full TOCTOU) — both exit nonzero having produced less than
   * RESUME_OUTPUT_BYTES. A `--continue`/`attach` that actually resumed redraws the transcript
   * (far more output), so a later nonzero exit is above the threshold and surfaces normally.
   */
  private shouldSelfHeal(session: Session, e: PtyExitEvent): boolean {
    return (
      (session.mode === 'continue' || session.mode === 'attach') &&
      e.exitCode !== 0 &&
      session.outputBytes < RESUME_OUTPUT_BYTES
    );
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
