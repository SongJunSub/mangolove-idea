/** The minimal `before-quit` event slice QuitController needs (window-free). */
export interface BeforeQuitEventLike {
  preventDefault(): void;
}

/** Injected effects so QuitController is pure logic + unit-testable. */
export interface QuitControllerDeps {
  /**
   * Worktrees with a live PTY right now (SessionManager.liveWorktreeIds). Retained for
   * the kill-sweep / orphan reasoning; the warn-vs-quit decision uses
   * activeTurnWorktreeIds (only an in-flight turn is lost on quit).
   */
  liveWorktreeIds(): string[];
  /**
   * Worktrees with an ACTIVE TURN right now (SessionManager.activeTurnWorktreeIds): a
   * running turn would be lost on quit. An idle live session is lossless (b-lite re-spawns
   * via --continue). The before-quit WARNING fires when this is non-empty OR unsavedFileCount > 0.
   */
  activeTurnWorktreeIds(): string[];
  /**
   * Count of unsaved (dirty) editor files across all windows (A4). A dirty buffer never
   * reached disk, so quitting LOSES it — unlike an idle turn — hence it also gates the warning.
   */
  unsavedFileCount(): number;
  /** Sends APP_QUIT_WARNING({activeWorktreeIds, unsavedFileCount}) to the renderer. */
  emitQuitWarning(activeWorktreeIds: readonly string[], unsavedFileCount: number): void;
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
 *  1st before-quit, a turn in flight OR an unsaved editor, not confirmed -> preventDefault + warn.
 *  renderer answers via decide(true)              -> set confirmed, sweep, quitNow().
 *  app.quit() re-fires before-quit, confirmed     -> fall through (no preventDefault).
 *  decide(false)                                  -> stay open; next quit re-intercepts.
 *
 * When neither a turn nor an unsaved editor exists we never intercept (idle live sessions
 * are lossless), but we STILL sweep exactly once — killAll() kills ALL live PTYs (idle
 * included) so a server child / any stray PTY can't be orphaned (binding invariant §7).
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
    // WARN when a TURN is in flight (lost on quit; an idle live session is lossless and
    // b-lite re-spawns it via `claude --continue`) OR when an editor buffer is unsaved (a
    // dirty buffer never reached disk, so quitting loses it). When NEITHER holds we still
    // sweep — killAll() kills ALL live sessions (idle included) to prevent orphans.
    const activeTurns = this.deps.activeTurnWorktreeIds();
    const unsaved = this.deps.unsavedFileCount();
    if (activeTurns.length === 0 && unsaved === 0) {
      this.sweepOnce(); // unconditional orphan prevention even on the happy path.
      return;
    }
    e.preventDefault();
    this.deps.emitQuitWarning(activeTurns, unsaved);
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
