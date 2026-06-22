import { describe, it, expect } from 'vitest';
import {
  requireCtxFrom,
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
  findCtxByRepoRoot,
  teardownWindow,
} from '../../src/main/app/window-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function ctxWith(over: Partial<IpcContext>): IpcContext {
  return { mainWindow: null, ...over };
}

describe('window-registry', () => {
  it('requireCtxFrom resolves the ctx by the injected id extractor', () => {
    const ctx = ctxWith({ repoRoot: '/r' });
    const contexts = new Map<number, IpcContext>([[7, ctx]]);
    const out = requireCtxFrom(
      contexts,
      { sender: { id: 7 } },
      (e) => (e.sender as { id: number }).id,
    );
    expect(out).toBe(ctx);
  });

  it('requireCtxFrom defaults the extractor to event.sender.id', () => {
    const ctx = ctxWith({ repoRoot: '/r' });
    const contexts = new Map<number, IpcContext>([[3, ctx]]);
    expect(requireCtxFrom(contexts, { sender: { id: 3 } })).toBe(ctx);
  });

  it('requireCtxFrom throws (fail-loud) when no ctx is registered for the id', () => {
    const contexts = new Map<number, IpcContext>();
    expect(() => requireCtxFrom(contexts, { sender: { id: 99 } })).toThrow(/no window context/i);
  });

  it('aggregateLiveWorktreeIds unions liveWorktreeIds across all contexts', () => {
    const a = ctxWith({ sessionManager: { liveWorktreeIds: () => ['x', 'y'] } as never });
    const b = ctxWith({ sessionManager: { liveWorktreeIds: () => ['y', 'z'] } as never });
    const contexts = new Map<number, IpcContext>([
      [1, a],
      [2, b],
    ]);
    expect(aggregateLiveWorktreeIds(contexts).sort()).toEqual(['x', 'y', 'z']);
  });

  it('aggregateActiveTurnWorktreeIds unions activeTurnWorktreeIds across all contexts', () => {
    const a = ctxWith({ sessionManager: { activeTurnWorktreeIds: () => ['a'] } as never });
    const b = ctxWith({ sessionManager: { activeTurnWorktreeIds: () => ['a', 'b'] } as never });
    const contexts = new Map<number, IpcContext>([
      [1, a],
      [2, b],
    ]);
    expect(aggregateActiveTurnWorktreeIds(contexts).sort()).toEqual(['a', 'b']);
  });

  it('aggregate getters tolerate contexts with no sessionManager', () => {
    const contexts = new Map<number, IpcContext>([[1, ctxWith({})]]);
    expect(aggregateLiveWorktreeIds(contexts)).toEqual([]);
    expect(aggregateActiveTurnWorktreeIds(contexts)).toEqual([]);
  });

  it('sweepAll killAll()s + dispose()s every context (guarded on missing managers)', () => {
    const killA = (): void => {
      calls.push('killA');
    };
    const dispA = (): void => {
      calls.push('dispA');
    };
    const killB = (): void => {
      calls.push('killB');
    };
    const calls: string[] = [];
    const a = ctxWith({
      sessionManager: { killAll: killA } as never,
      serverManager: { dispose: dispA } as never,
    });
    const b = ctxWith({ sessionManager: { killAll: killB } as never }); // no serverManager
    sweepAll(
      new Map([
        [1, a],
        [2, b],
      ]),
    );
    expect(calls.sort()).toEqual(['dispA', 'killA', 'killB']);
  });

  it('findCtxByRepoRoot returns the matching ctx or undefined', () => {
    const a = ctxWith({ repoRoot: '/one' });
    const b = ctxWith({ repoRoot: '/two' });
    const contexts = new Map<number, IpcContext>([
      [1, a],
      [2, b],
    ]);
    expect(findCtxByRepoRoot(contexts, '/two')).toBe(b);
    expect(findCtxByRepoRoot(contexts, '/missing')).toBeUndefined();
  });
});

describe('teardownWindow', () => {
  it('sweeps ONLY the closed window managers and deletes ONLY its id', () => {
    const calls: string[] = [];
    const a = {
      mainWindow: null,
      sessionManager: { killAll: () => calls.push('killA') } as never,
      serverManager: { dispose: () => calls.push('dispA') } as never,
    };
    const b = {
      mainWindow: null,
      sessionManager: { killAll: () => calls.push('killB') } as never,
    };
    const contexts = new Map([
      [1, a],
      [2, b],
    ]);
    teardownWindow(contexts, 1);
    expect(calls.sort()).toEqual(['dispA', 'killA']); // B untouched
    expect(contexts.has(1)).toBe(false);
    expect(contexts.has(2)).toBe(true);
  });

  it('teardownWindow on an unknown id is a guarded no-op', () => {
    const contexts = new Map<number, IpcContext>();
    expect(() => teardownWindow(contexts, 42)).not.toThrow();
  });
});
