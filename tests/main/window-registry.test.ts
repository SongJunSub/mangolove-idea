import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requireCtxFrom,
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
  findCtxByRepoRoot,
  teardownWindow,
  rebindCtxRepo,
  canonicalRepoRoot,
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

describe('rebindCtxRepo (in-place repo switch)', () => {
  const REPO_SCOPED = [
    'worktreeManager',
    'sessionManager',
    'shellManager',
    'sessionPublisher',
    'serverManager',
    'logStore',
    'mergeRunner',
    'diffViewer',
    'fileTreeReader',
    'fileEditor',
    'ghStatusReader',
    'codeNavService',
    'lspManager',
    'conflictResolver',
    'fanoutManager',
  ] as const;

  it('kills live processes, nulls every repo-scoped manager, resets flags, sets the new root — and KEEPS shared state', () => {
    const calls: string[] = [];
    const sentinel = {} as never;
    const ctx: IpcContext = {
      mainWindow: { focus: () => {} } as never,
      repoRoot: '/old',
      // live-process managers (spied — must be torn down). rebind uses sessionManager.dispose()
      // (killAll + sessions.clear), NOT bare killAll, since the window stays alive across reload.
      sessionManager: { dispose: () => calls.push('sessionDispose') } as never,
      shellManager: { dispose: () => calls.push('shellDispose') } as never,
      serverManager: { dispose: () => calls.push('serverDispose') } as never,
      lspManager: { dispose: () => calls.push('lspDispose') } as never,
      fanoutManager: {
        abort: async () => {
          calls.push('abort');
          return { ok: true };
        },
      } as never,
      // the remaining repo-scoped managers (must be nulled)
      worktreeManager: sentinel,
      sessionPublisher: sentinel,
      logStore: sentinel,
      mergeRunner: sentinel,
      diffViewer: sentinel,
      fileTreeReader: sentinel,
      fileEditor: sentinel,
      ghStatusReader: sentinel,
      codeNavService: sentinel,
      conflictResolver: sentinel,
      // per-window flags (must reset)
      unsavedFileCount: 3,
      sessionSettingsDirty: true,
      serverSettingsDirty: true,
      // shared / non-repo state (must be KEPT)
      sessionStore: sentinel,
      settingsStore: sentinel,
      scrollbackStore: sentinel,
      updaterService: sentinel,
      abducoPath: '/usr/bin/abduco',
      requestQuit: () => {},
      openRepo: () => {},
    };

    rebindCtxRepo(ctx, '/new/repo');

    expect(calls.sort()).toEqual([
      'abort',
      'lspDispose',
      'serverDispose',
      'sessionDispose',
      'shellDispose',
    ]);
    for (const key of REPO_SCOPED) {
      expect(ctx[key], key).toBeUndefined();
    }
    expect(ctx.unsavedFileCount).toBe(0);
    expect(ctx.sessionSettingsDirty).toBe(false);
    expect(ctx.serverSettingsDirty).toBe(false);
    expect(ctx.repoRoot).toBe(canonicalRepoRoot('/new/repo'));
    // shared stores + window + updater + abducoPath + injected callbacks are NOT repo-scoped
    expect(ctx.mainWindow).not.toBeNull();
    expect(ctx.sessionStore).toBe(sentinel);
    expect(ctx.settingsStore).toBe(sentinel);
    expect(ctx.scrollbackStore).toBe(sentinel);
    expect(ctx.updaterService).toBe(sentinel);
    expect(ctx.abducoPath).toBe('/usr/bin/abduco');
    expect(typeof ctx.requestQuit).toBe('function');
    expect(typeof ctx.openRepo).toBe('function');
  });

  it('rebinds an empty-gate ctx (no managers) without throwing', () => {
    const ctx: IpcContext = { mainWindow: null, repoRoot: null };
    expect(() => rebindCtxRepo(ctx, '/x')).not.toThrow();
    expect(ctx.repoRoot).toBe(canonicalRepoRoot('/x'));
    expect(ctx.unsavedFileCount).toBe(0);
  });

  // Regression: the same-repo focus-guard was bypassable when the repo was reached via
  // a non-canonical path (e.g. /tmp -> /private/tmp symlink), opening a duplicate window
  // racing the shared .git/MERGE_HEAD. canonicalRepoRoot must collapse path forms so
  // findCtxByRepoRoot dedupes reliably.
  describe('canonicalRepoRoot (same-repo focus-guard robustness)', () => {
    const made: string[] = [];
    afterEach(() => {
      for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
    });

    it('resolves a symlinked path to the same canonical form as the real dir', () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), 'mw-canon-'));
      made.push(base);
      const real = join(base, 'real-repo');
      mkdirSync(real);
      const link = join(base, 'link-repo');
      symlinkSync(real, link);

      expect(canonicalRepoRoot(link)).toBe(real);
      // The whole point: a ctx stored under the real path is FOUND when the lookup
      // key arrives via the symlink, once both are canonicalized.
      const ctx = ctxWith({ repoRoot: canonicalRepoRoot(real) });
      const contexts = new Map<number, IpcContext>([[1, ctx]]);
      expect(findCtxByRepoRoot(contexts, canonicalRepoRoot(link))).toBe(ctx);
    });

    it('strips a trailing slash so two path forms of one repo dedupe', () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), 'mw-canon-'));
      made.push(base);
      const repo = join(base, 'repo');
      mkdirSync(repo);
      expect(canonicalRepoRoot(`${repo}/`)).toBe(repo);
    });

    it('falls back to the raw path when it does not exist (fails loudly later, not here)', () => {
      expect(canonicalRepoRoot('/no/such/repo/xyz')).toBe('/no/such/repo/xyz');
    });
  });
});
