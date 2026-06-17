import { describe, it, expect, vi } from 'vitest';
import { QuitController, type QuitControllerDeps } from '../../src/main/app/quit-controller';

function deps(over: Partial<QuitControllerDeps> = {}) {
  const calls: string[] = [];
  const base = {
    liveWorktreeIds: () => ['/wt/a', '/wt/b'],
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
    expect(base.emitQuitWarning).toHaveBeenCalledWith(['/wt/a', '/wt/b']);
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
});
