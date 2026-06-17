/** The minimal `before-quit` event slice QuitController needs (window-free). */
export interface BeforeQuitEventLike {
  preventDefault(): void;
}

/** Injected effects so QuitController is pure logic + unit-testable. */
export interface QuitControllerDeps {
  /** Worktrees with a live PTY right now (SessionManager.liveWorktreeIds). */
  liveWorktreeIds(): string[];
  /** Sends APP_QUIT_WARNING({activeWorktreeIds}) to the renderer. */
  emitQuitWarning(activeWorktreeIds: readonly string[]): void;
  /** The PTY/server kill-sweep (sessionManager.killAll + serverManager.dispose). */
  sweep(): void;
  /** Actually quit (app.quit). Re-fires before-quit; the confirmed flag lets it through. */
  quitNow(): void;
}

/**
 * Owns the Electron before-quit interception for MVP item 6.
 *
 * Re-entrancy is the whole game here. `app.quit()` re-fires `before-quit`, so a
 * naive "preventDefault + warn" would deadlock the quit. We track `confirmedQuit`:
 *
 *  1st before-quit, sessions live, not confirmed  -> preventDefault + emit warning.
 *  renderer answers via decide(true)              -> set confirmed, sweep, quitNow().
 *  app.quit() re-fires before-quit, confirmed     -> fall through (no preventDefault).
 *  decide(false)                                  -> stay open; next quit re-intercepts.
 *
 * When NO sessions are live we never intercept, but we STILL sweep exactly once so
 * a server child / any stray PTY can't be orphaned (binding invariant §7).
 */
export class QuitController {
  private confirmedQuit = false;
  private sweptOnQuit = false;

  constructor(private readonly deps: QuitControllerDeps) {}

  /** Wire as `app.on('before-quit', (e) => controller.onBeforeQuit(e))`. */
  onBeforeQuit(e: BeforeQuitEventLike): void {
    if (this.confirmedQuit) {
      this.sweepOnce();
      return; // user already confirmed; let Electron quit.
    }
    const live = this.deps.liveWorktreeIds();
    if (live.length === 0) {
      this.sweepOnce(); // unconditional orphan prevention even on the happy path.
      return;
    }
    e.preventDefault();
    this.deps.emitQuitWarning(live);
  }

  /** Renderer's answer to the warning (APP_QUIT_DECISION handler calls this). */
  decide(quit: boolean): void {
    if (!quit) return; // stay open; before-quit can intercept again later.
    this.confirmedQuit = true;
    this.sweepOnce();
    this.deps.quitNow();
  }

  private sweepOnce(): void {
    if (this.sweptOnQuit) return;
    this.sweptOnQuit = true;
    this.deps.sweep();
  }
}
