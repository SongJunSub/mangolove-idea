/**
 * How a worktree's agent PTY should be launched on a given spawn.
 *  - 'fresh'    — a brand-new agent (no prior session).
 *  - 'continue' — rehydrate the agent's own conversation (claude `--continue`).
 *  - 'attach'   — re-attach to a still-running DETACHED session (b-full). Only
 *                 AbducoLauncher produces a distinct behavior here; DirectLauncher
 *                 owns no detached session and degrades 'attach' to 'continue'.
 */
export type LaunchMode = 'fresh' | 'continue' | 'attach';

/** The concrete (file, args) pair handed to PtyFactory.spawn. */
export interface LaunchSpec {
  readonly file: string;
  readonly args: readonly string[];
}

/** Inputs the launcher needs to decide the launch argv for one spawn. */
export interface LaunchContext {
  readonly worktreeId: string;
  readonly cwd: string;
  readonly mode: LaunchMode;
}

/**
 * Decides HOW to launch a worktree's agent PTY (Branch by Abstraction seam for
 * session-persistence b-full). Phase 1 introduces ONLY the synchronous
 * `resolveLaunch` — a behavior-preserving extraction of the inline argv build
 * that previously lived in SessionManager.spawn.
 *
 * `resolveLaunch` MUST stay synchronous: it runs inside SessionManager.spawn
 * without adding an await hop, preserving the existing synchronous spawn flow
 * (the Plan-2 delegation tests rely on that flow). Phase 2's AbducoLauncher
 * extends this interface with the detached-session methods
 * (liveDetached / listDetached / endDetached / detachSignal); the 3-way reopen
 * decision (attach vs continue vs fresh) is taken in SessionManager.spawn's
 * existing async section, never in this synchronous resolver.
 */
export interface AgentLauncher {
  resolveLaunch(ctx: LaunchContext): LaunchSpec;

  // ── b-full detached-session surface (ABSENT on DirectLauncher) ─────────────
  // These are OPTIONAL: a launcher that owns no detached session (DirectLauncher)
  // omits them entirely, so SessionManager's b-lite path is byte-for-byte
  // unchanged. AbducoLauncher implements them. All are async because they shell
  // out to `abduco`; they are called ONLY from SessionManager.spawn's existing
  // async section (never from the synchronous getSessionManager/write/resize).

  /** True iff the worktree has a LIVE detached (background) session to re-attach. */
  isLiveDetached?(worktreeId: string): Promise<boolean>;
  /** Names of all OUR currently-live detached sessions (for reap + reopen UI). */
  listLiveDetached?(): Promise<string[]>;
  /** Deterministically end the worktree's detached session (kills its master). */
  endDetached?(worktreeId: string): Promise<void>;
  /** Global kill-switch: end EVERY one of our detached sessions (stop-all). */
  endAllDetached?(): Promise<void>;
  /**
   * Signal used to KILL a surviving detached master in endDetached/endAllDetached
   * (explicit SIGTERM via process.kill on the exact master pid). NOTE: detaching the
   * FRONT-END PTY does NOT use this — SessionManager's `pty.kill()` sends node-pty's
   * default SIGHUP, which the Phase 0 spike verified leaves the abduco master + agent
   * alive (detach) on macOS arm64; SessionManager never calls node-pty `destroy()`.
   * Absent on DirectLauncher (which owns no master to kill).
   */
  readonly detachSignal?: NodeJS.Signals;
}

/**
 * The b-lite launcher: runs the agent binary directly as a child PTY of the
 * Electron main process (the current, pre-b-full behavior). 'continue' and
 * 'attach' both pass `--continue` — claude rehydrates its own conversation from
 * its on-disk JSONL — because DirectLauncher owns no detached session, so
 * 'attach' has no distinct meaning and safely degrades to `--continue`.
 *
 * This reproduces SessionManager's original argv EXACTLY ({file: command,
 * args: continue ? ['--continue'] : []}) so every existing session test stays
 * green when SessionManager is refactored onto the launcher seam.
 */
export class DirectLauncher implements AgentLauncher {
  constructor(private readonly command: string) {}

  resolveLaunch(ctx: LaunchContext): LaunchSpec {
    return { file: this.command, args: ctx.mode === 'fresh' ? [] : ['--continue'] };
  }
}
