import { describe, it, expect, vi } from 'vitest';
import { QuitController, type QuitControllerDeps } from '../../src/main/app/quit-controller';

function deps(over: Partial<QuitControllerDeps> = {}) {
  const calls: string[] = [];
  const liveWorktreeIds = over.liveWorktreeIds ?? (() => ['/wt/a', '/wt/b']);
  const base = {
    liveWorktreeIds,
    // The warning now keys on ACTIVE TURNS, not merely live sessions. Default to
    // mirror liveWorktreeIds so the existing warn-on-quit AND no-live-no-warn tests
    // are unchanged (an override of liveWorktreeIds flows through); idle-only cases
    // override this to [].
    activeTurnWorktreeIds: () => liveWorktreeIds(),
    unsavedFileCount: () => 0,
    emitQuitWarning: vi.fn((ids: readonly string[]) => calls.push(`warn:${ids.join(',')}`)),
    sweep: vi.fn(() => calls.push('sweep')),
    quitNow: vi.fn(() => calls.push('quitNow')),
    ...over,
  };
  return { base, calls };
}

describe('QuitController', () => {
  it('intercepts the first quit when sessions are live: preventDefault + emit warning, no sweep yet', () => {
    const { base } = deps();
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(base.emitQuitWarning).toHaveBeenCalledWith(['/wt/a', '/wt/b'], 0);
    expect(base.sweep).not.toHaveBeenCalled();
    expect(base.quitNow).not.toHaveBeenCalled();
  });

  it('does NOT intercept when there are no live sessions (lets quit proceed, still sweeps)', () => {
    const { base } = deps({ liveWorktreeIds: () => [] });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(base.sweep).toHaveBeenCalledOnce(); // unconditional orphan-claude prevention
    expect(base.emitQuitWarning).not.toHaveBeenCalled();
  });

  it('decide(true): sweeps then quits, and a re-fired before-quit is allowed through', () => {
    const { base, calls } = deps();
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() }); // intercepted
    ctrl.decide(true);
    expect(calls).toEqual(['warn:/wt/a,/wt/b', 'sweep', 'quitNow']);
    // app.quit() re-fires before-quit; the confirmed flag must let it pass without re-warning.
    const e2 = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e2);
    expect(e2.preventDefault).not.toHaveBeenCalled();
    expect(base.emitQuitWarning).toHaveBeenCalledOnce(); // not warned a second time
  });

  it('decide(false): does not sweep or quit; stays open and can be re-intercepted', () => {
    const { base } = deps();
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    ctrl.decide(false);
    expect(base.sweep).not.toHaveBeenCalled();
    expect(base.quitNow).not.toHaveBeenCalled();
    const e2 = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e2);
    expect(e2.preventDefault).toHaveBeenCalledOnce(); // intercepts again
  });

  it('sweep on the no-live path runs only once even if before-quit fires repeatedly', () => {
    const { base } = deps({ liveWorktreeIds: () => [] });
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    expect(base.sweep).toHaveBeenCalledOnce();
  });

  it('does NOT warn when sessions are LIVE but all IDLE (no active turn): lets quit proceed, still sweeps', () => {
    // Live sessions exist (kill-sweep must still run) but none has an active turn,
    // so the warning must NOT fire — an idle session is lossless (claude --continue).
    const { base } = deps({
      liveWorktreeIds: () => ['/wt/a', '/wt/b'],
      activeTurnWorktreeIds: () => [],
    });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(base.emitQuitWarning).not.toHaveBeenCalled();
    expect(base.sweep).toHaveBeenCalledOnce(); // killAll still runs (kills idle sessions too)
  });

  it('warns with the ACTIVE-TURN worktrees (subset of live) and sweeps ALL on confirm', () => {
    // /wt/a and /wt/b are live, but only /wt/a has an active turn.
    const { base, calls } = deps({
      liveWorktreeIds: () => ['/wt/a', '/wt/b'],
      activeTurnWorktreeIds: () => ['/wt/a'],
    });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(base.emitQuitWarning).toHaveBeenCalledWith(['/wt/a'], 0); // active turns only
    expect(base.sweep).not.toHaveBeenCalled(); // not yet
    ctrl.decide(true);
    // Confirmed quit sweeps (killAll kills ALL live sessions, idle /wt/b included) then quits.
    expect(calls).toEqual(['warn:/wt/a', 'sweep', 'quitNow']);
  });

  it('warns on an UNSAVED editor even with NO active turn (a dirty buffer is lost on quit) [A4]', () => {
    const { base } = deps({
      liveWorktreeIds: () => [],
      activeTurnWorktreeIds: () => [],
      unsavedFileCount: () => 2,
    });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(base.emitQuitWarning).toHaveBeenCalledWith([], 2); // no turns, 2 unsaved files
    expect(base.sweep).not.toHaveBeenCalled();
  });

  it('does NOT warn when there is neither an active turn nor an unsaved editor [A4]', () => {
    const { base } = deps({
      liveWorktreeIds: () => ['/wt/a'], // live but idle
      activeTurnWorktreeIds: () => [],
      unsavedFileCount: () => 0,
    });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(base.emitQuitWarning).not.toHaveBeenCalled();
    expect(base.sweep).toHaveBeenCalledOnce();
  });

  it('warns with BOTH the active turns and the unsaved count when both are present [A4]', () => {
    const { base, calls } = deps({
      liveWorktreeIds: () => ['/wt/a'],
      activeTurnWorktreeIds: () => ['/wt/a'],
      unsavedFileCount: () => 1,
    });
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    expect(base.emitQuitWarning).toHaveBeenCalledWith(['/wt/a'], 1);
    ctrl.decide(true);
    expect(calls).toEqual(['warn:/wt/a', 'sweep', 'quitNow']);
  });
});
