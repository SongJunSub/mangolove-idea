import { describe, it, expect, vi } from 'vitest';
import { QuitController } from '../../src/main/app/quit-controller';
import {
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  aggregateUnsavedCount,
  sweepAll,
} from '../../src/main/app/window-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('aggregate quit across all windows', () => {
  it('confirmed quit sweeps EVERY window killAll+dispose (no orphan in any window)', () => {
    const sweepCalls: string[] = [];
    const a: IpcContext = {
      mainWindow: null,
      sessionManager: {
        killAll: () => sweepCalls.push('killA'),
        liveWorktreeIds: () => ['wA'],
        activeTurnWorktreeIds: () => ['wA'],
      } as never,
      serverManager: { dispose: () => sweepCalls.push('dispA') } as never,
    };
    const b: IpcContext = {
      mainWindow: null,
      sessionManager: {
        killAll: () => sweepCalls.push('killB'),
        liveWorktreeIds: () => ['wB'],
        activeTurnWorktreeIds: () => [],
      } as never,
      serverManager: { dispose: () => sweepCalls.push('dispB') } as never,
    };
    const contexts = new Map<number, IpcContext>([
      [1, a],
      [2, b],
    ]);

    const emitQuitWarning = vi.fn();
    const quitNow = vi.fn();
    const ctrl = new QuitController({
      liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
      activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
      unsavedFileCount: () => aggregateUnsavedCount(contexts),
      emitQuitWarning,
      sweep: () => sweepAll(contexts),
      quitNow,
    });

    // Window A has an active turn -> first quit is vetoed + warns with the UNION'd ids.
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(emitQuitWarning).toHaveBeenCalledWith(['wA'], 0); // no unsaved editors here

    // Confirm: sweepAll runs over BOTH windows.
    ctrl.decide(true);
    expect(sweepCalls.sort()).toEqual(['dispA', 'dispB', 'killA', 'killB']);
    expect(quitNow).toHaveBeenCalledOnce();
  });

  it('no active turn in any window: quit proceeds but still sweeps both (orphan prevention)', () => {
    const sweepCalls: string[] = [];
    const mk = (tag: string): IpcContext => ({
      mainWindow: null,
      sessionManager: {
        killAll: () => sweepCalls.push(`kill${tag}`),
        liveWorktreeIds: () => [`w${tag}`],
        activeTurnWorktreeIds: () => [],
      } as never,
      serverManager: { dispose: () => sweepCalls.push(`disp${tag}`) } as never,
    });
    const contexts = new Map<number, IpcContext>([
      [1, mk('A')],
      [2, mk('B')],
    ]);
    const ctrl = new QuitController({
      liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
      activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
      unsavedFileCount: () => aggregateUnsavedCount(contexts),
      emitQuitWarning: vi.fn(),
      sweep: () => sweepAll(contexts),
      quitNow: vi.fn(),
    });
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled(); // no active turn -> no veto
    expect(sweepCalls.sort()).toEqual(['dispA', 'dispB', 'killA', 'killB']); // still swept
  });

  it('an UNSAVED editor in any window vetoes the quit even with no active turn (A4, summed)', () => {
    const mk = (live: string, unsaved: number): IpcContext => ({
      mainWindow: null,
      sessionManager: {
        killAll: () => {},
        liveWorktreeIds: () => [live],
        activeTurnWorktreeIds: () => [], // idle: lossless on its own
      } as never,
      serverManager: { dispose: () => {} } as never,
      unsavedFileCount: unsaved,
    });
    const contexts = new Map<number, IpcContext>([
      [1, mk('wA', 1)],
      [2, mk('wB', 2)],
    ]);
    expect(aggregateUnsavedCount(contexts)).toBe(3); // summed across windows
    const emitQuitWarning = vi.fn();
    const ctrl = new QuitController({
      liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
      activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
      unsavedFileCount: () => aggregateUnsavedCount(contexts),
      emitQuitWarning,
      sweep: () => sweepAll(contexts),
      quitNow: vi.fn(),
    });
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce(); // dirty buffers -> veto + warn
    expect(emitQuitWarning).toHaveBeenCalledWith([], 3); // no turns, 3 unsaved across windows
  });
});
