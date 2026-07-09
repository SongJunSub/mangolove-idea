import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';
import { registerIpcForTest } from '../helpers/register-ipc-for-test';
import { SettingsStore } from '../../src/main/managers/settings-store';
import type { AppSettings } from '../../src/shared/types';

/**
 * A get/set pair as a SettingsStore-shaped mock WITH a conforming serialized update(): handlers now
 * route recentRepos/projectGroups writes through store.update(mutator), which is get() -> mutator ->
 * set(partial). The mock mirrors that so set-spy assertions still see the written partial.
 */
function storeMock(
  get: () => Partial<AppSettings>,
  set: (p: Partial<AppSettings>) => unknown,
): SettingsStore {
  return {
    get,
    set,
    // update() returns set()'s value; a bare vi.fn() set-spy returns undefined, so a handler that
    // reads update()'s result (e.g. GROUPS_SET's `stored.projectGroups`) must be driven through the
    // REAL SettingsStore (register-groups-ipc.integration.test.ts), not this mock.
    update: async (fn: (c: Partial<AppSettings>) => unknown) =>
      set((await fn(get())) as Partial<AppSettings>),
  } as unknown as SettingsStore;
}

// Hoisted mock state the fake electron module reads. vi.mock is hoisted, so the
// referenced object must be created with vi.hoisted.
const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showOpenDialog: mocks.showOpenDialog },
  app: { relaunch: mocks.relaunch, quit: mocks.quit, getVersion: () => '0.1.0' },
  shell: { openExternal: vi.fn() },
}));

// Import AFTER vi.mock so register-ipc's dynamic import('electron') hits the mock.
const { createIpcContext } = await import('../../src/main/ipc/ipc-context');

function baseCtx() {
  const ctx = createIpcContext();
  ctx.settingsStore = storeMock(
    () => ({}),
    vi.fn((p: Partial<AppSettings>) => p),
  );
  return ctx;
}

describe('repo IPC wiring', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mango-repo-'));
    mocks.showOpenDialog.mockReset();
    mocks.relaunch.mockReset();
    mocks.quit.mockReset();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('REPO_GET returns ctx.repoRoot', async () => {
    const ctx = baseCtx();
    ctx.repoRoot = '/Users/me/proj';
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = await handlers.get(IPC.REPO_GET)!(fakeEvent, undefined);
    expect(out).toBe('/Users/me/proj');
  });

  it('REPO_GET returns null when no repo is selected', async () => {
    const ctx = baseCtx(); // repoRoot defaults to null
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    expect(await handlers.get(IPC.REPO_GET)!(fakeEvent, undefined)).toBeNull();
  });

  it('REPO_PICK returns {canceled:true} when the user cancels the dialog', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const ctx = baseCtx();
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined);
    expect(out).toEqual({ ok: false, canceled: true });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(ctx.settingsStore!.set).not.toHaveBeenCalled();
  });

  it('REPO_PICK rejects a non-git directory with {error}', async () => {
    // dir has NO .git entry -> not a git work tree.
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined);
    expect(out).toEqual({ ok: false, error: 'not a git repository' });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(ctx.settingsStore!.set).not.toHaveBeenCalled();
  });

  it('REPO_PICK validates a repo, pushes its CANONICAL path to recentRepos, and opens it', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n');
    const canon = realpathSync(dir); // recentRepos is keyed canonically
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const openRepo = vi.fn();
    ctx.openRepo = openRepo; // index.ts injects the real openOrFocusRepo
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined);
    expect(out).toEqual({ ok: true, repoRoot: canon });
    expect(openRepo).toHaveBeenCalledWith(canon);
    expect(mocks.relaunch).not.toHaveBeenCalled(); // multi-window: NEVER relaunch
  });

  it('REPO_PICK does not call openRepo on cancel or a non-git dir', async () => {
    const ctx = baseCtx();
    const openRepo = vi.fn();
    ctx.openRepo = openRepo;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined)).toEqual({
      ok: false,
      canceled: true,
    });

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] }); // dir has no .git
    expect(await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined)).toEqual({
      ok: false,
      error: 'not a git repository',
    });
    expect(openRepo).not.toHaveBeenCalled();
  });

  it('REPO_LIST drops stale dirs, canonicalizes, dedupes, and flags the active repo', async () => {
    const a = mkdtempSync(join(tmpdir(), 'mango-a-'));
    writeFileSync(join(a, '.git'), 'gitdir: a\n');
    const b = mkdtempSync(join(tmpdir(), 'mango-b-'));
    writeFileSync(join(b, '.git'), 'gitdir: b\n');
    const gone = join(tmpdir(), 'mango-gone-does-not-exist');
    try {
      const canonA = realpathSync(a);
      const canonB = realpathSync(b);
      const ctx = baseCtx();
      ctx.repoRoot = canonB; // active = b
      // recentRepos holds raw paths, with a stale entry + a duplicate of b.
      ctx.settingsStore = storeMock(() => ({ recentRepos: [b, gone, a, b] }), vi.fn());
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      const out = await handlers.get(IPC.REPO_LIST)!(fakeEvent, undefined);
      expect(out).toEqual([
        { path: canonB, active: true }, // gone dropped, duplicate b collapsed, order kept
        { path: canonA, active: false },
      ]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('SETTINGS_SET strips recentRepos/projectGroups so they cannot bypass the serialized update()', async () => {
    const setSpy = vi.fn((p: Partial<AppSettings>) => p);
    const ctx = baseCtx();
    ctx.settingsStore = storeMock(() => ({}), setSpy);
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    await handlers.get(IPC.SETTINGS_SET)!(fakeEvent, {
      theme: 'dark',
      recentRepos: ['/evil'],
      projectGroups: [{ id: 'g', name: 'G', repoPaths: ['/evil'] }],
    });
    // The store only ever receives the settings-modal keys; the REPO_*/GROUPS_*-owned keys are dropped.
    expect(setSpy).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('REPO_OPEN switches to a known repo: bumps the CANONICAL path + calls openRepo', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: x\n');
    const canon = realpathSync(dir);
    const setSpy = vi.fn();
    const ctx = baseCtx();
    // '/old' is non-existent -> canonicalRepoRoot falls back to itself, stays in the list.
    ctx.settingsStore = storeMock(() => ({ recentRepos: ['/old', dir] }), setSpy);
    const openRepo = vi.fn();
    ctx.openRepo = openRepo;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = await handlers.get(IPC.REPO_OPEN)!(fakeEvent, dir);
    expect(out).toEqual({ ok: true, repoRoot: canon });
    expect(setSpy).toHaveBeenCalledWith({ recentRepos: [canon, '/old'] }); // canonical, front, deduped
    expect(openRepo).toHaveBeenCalledWith(canon, undefined); // no worktree to select
  });

  it('REPO_OPEN forwards a cross-repo worktree selection to openRepo', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: x\n');
    const canon = realpathSync(dir);
    const ctx = baseCtx();
    ctx.settingsStore = storeMock(() => ({ recentRepos: [dir] }), vi.fn());
    const openRepo = vi.fn();
    ctx.openRepo = openRepo;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    await handlers.get(IPC.REPO_OPEN)!(fakeEvent, dir, { worktreeId: '/wt/feature-x' });
    expect(openRepo).toHaveBeenCalledWith(canon, '/wt/feature-x');
    // a blank / non-string worktreeId is ignored (undefined)
    await handlers.get(IPC.REPO_OPEN)!(fakeEvent, dir, { worktreeId: '' });
    expect(openRepo).toHaveBeenLastCalledWith(canon, undefined);
  });

  it('REPO_TAKE_PENDING_SELECT returns the pended id once, then null (consume-once)', async () => {
    const ctx = baseCtx();
    ctx.pendingSelectWorktreeId = '/wt/feature-x';
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    expect(await handlers.get(IPC.REPO_TAKE_PENDING_SELECT)!(fakeEvent, undefined)).toBe(
      '/wt/feature-x',
    );
    expect(await handlers.get(IPC.REPO_TAKE_PENDING_SELECT)!(fakeEvent, undefined)).toBeNull();
  });

  // REPO_FORGET needs a store whose get() reflects set(), so use a real SettingsStore over a temp file.
  describe('REPO_FORGET', () => {
    /** A ctx bound to a real settings store + two repos (a, b) with a `.git` marker; b is active. */
    function forgetCtx() {
      const a = mkdtempSync(join(tmpdir(), 'mango-fa-'));
      writeFileSync(join(a, '.git'), 'gitdir: a\n');
      const b = mkdtempSync(join(tmpdir(), 'mango-fb-'));
      writeFileSync(join(b, '.git'), 'gitdir: b\n');
      const canonA = realpathSync(a);
      const canonB = realpathSync(b);
      const ctx = baseCtx();
      ctx.repoRoot = canonB; // active = b
      ctx.settingsStore = new SettingsStore(join(dir, 'settings.json'));
      ctx.settingsStore.set({ recentRepos: [canonA, canonB] });
      return {
        ctx,
        a,
        b,
        canonA,
        canonB,
        cleanup: () => [a, b].forEach((p) => rmSync(p, { recursive: true, force: true })),
      };
    }

    it('drops a NON-active repo and returns the updated list', async () => {
      const { ctx, a, canonB, cleanup } = forgetCtx();
      try {
        const { handlers, fakeEvent } = registerIpcForTest(ctx);
        const out = await handlers.get(IPC.REPO_FORGET)!(fakeEvent, a);
        expect(out).toEqual([{ path: canonB, active: true }]); // a gone, active b remains
        expect(ctx.settingsStore!.get().recentRepos).toEqual([canonB]); // persisted
      } finally {
        cleanup();
      }
    });

    it('refuses to forget the ACTIVE repo (list + recentRepos unchanged)', async () => {
      const { ctx, b, canonA, canonB, cleanup } = forgetCtx();
      try {
        const { handlers, fakeEvent } = registerIpcForTest(ctx);
        const out = await handlers.get(IPC.REPO_FORGET)!(fakeEvent, b); // b is active
        expect(out).toEqual([
          { path: canonA, active: false },
          { path: canonB, active: true },
        ]);
        expect(ctx.settingsStore!.get().recentRepos).toEqual([canonA, canonB]);
      } finally {
        cleanup();
      }
    });

    it('ignores a non-string path (list unchanged)', async () => {
      const { ctx, canonA, canonB, cleanup } = forgetCtx();
      try {
        const { handlers, fakeEvent } = registerIpcForTest(ctx);
        const out = (await handlers.get(IPC.REPO_FORGET)!(fakeEvent, 123 as never)) as Array<{
          path: string;
        }>;
        expect(out.map((r) => r.path)).toEqual([canonA, canonB]);
      } finally {
        cleanup();
      }
    });
  });

  it('REPO_OPEN rejects a non-git / non-string path without opening', async () => {
    const ctx = baseCtx();
    const openRepo = vi.fn();
    ctx.openRepo = openRepo;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    expect(await handlers.get(IPC.REPO_OPEN)!(fakeEvent, dir)).toEqual({
      ok: false,
      error: 'not a git repository', // dir has no .git
    });
    expect(await handlers.get(IPC.REPO_OPEN)!(fakeEvent, 123 as never)).toEqual({
      ok: false,
      error: 'not a git repository',
    });
    expect(openRepo).not.toHaveBeenCalled();
  });

  describe('REPO_OPEN_NEW_WINDOW', () => {
    it('opens a KNOWN repo in a new window: bumps recentRepos + calls openRepoNewWindow', async () => {
      writeFileSync(join(dir, '.git'), 'gitdir: x\n');
      const canon = realpathSync(dir);
      const setSpy = vi.fn();
      const ctx = baseCtx();
      // '/old' is non-existent -> dropped from the live allowlist but kept in recentRepos on write.
      ctx.settingsStore = storeMock(() => ({ recentRepos: ['/old', dir] }), setSpy);
      const openRepoNewWindow = vi.fn();
      ctx.openRepoNewWindow = openRepoNewWindow;
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      const out = await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, dir);
      expect(out).toEqual({ ok: true, repoRoot: canon });
      expect(setSpy).toHaveBeenCalledWith({ recentRepos: [canon, '/old'] }); // bumped to front
      expect(openRepoNewWindow).toHaveBeenCalledWith(canon);
    });

    it('rejects a git repo that is NOT in recentRepos (allowlist)', async () => {
      writeFileSync(join(dir, '.git'), 'gitdir: x\n'); // valid repo but not listed
      const ctx = baseCtx();
      ctx.settingsStore = storeMock(() => ({ recentRepos: ['/other'] }), vi.fn());
      const openRepoNewWindow = vi.fn();
      ctx.openRepoNewWindow = openRepoNewWindow;
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      expect(await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, dir)).toEqual({
        ok: false,
        error: 'unknown repository',
      });
      expect(openRepoNewWindow).not.toHaveBeenCalled();
    });

    it('rejects a non-git / non-string path', async () => {
      const ctx = baseCtx();
      const openRepoNewWindow = vi.fn();
      ctx.openRepoNewWindow = openRepoNewWindow;
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      expect(await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, dir)).toEqual({
        ok: false,
        error: 'not a git repository', // dir has no .git
      });
      expect(await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, 123 as never)).toEqual({
        ok: false,
        error: 'not a git repository',
      });
      expect(openRepoNewWindow).not.toHaveBeenCalled();
    });

    it('caps recentRepos at MAX (50) on open, keeping the opened repo at the front', async () => {
      writeFileSync(join(dir, '.git'), 'gitdir: x\n');
      const canon = realpathSync(dir);
      // dir is allowlisted; 60 stale entries follow (they canonicalize to themselves — no .git).
      const stale = Array.from({ length: 60 }, (_, i) => `/stale/${i}`);
      const setSpy = vi.fn();
      const ctx = baseCtx();
      ctx.settingsStore = storeMock(() => ({ recentRepos: [dir, ...stale] }), setSpy);
      ctx.openRepoNewWindow = vi.fn();
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, dir);
      const written = setSpy.mock.calls[0][0].recentRepos as string[];
      expect(written).toHaveLength(50); // capped
      expect(written[0]).toBe(canon); // opened repo bumped to front
      expect(written.slice(1)).toEqual(stale.slice(0, 49)); // oldest tail dropped
    });

    it('the cap never evicts a repo pinned by a group (else GROUPS_SET would persist the loss)', async () => {
      writeFileSync(join(dir, '.git'), 'gitdir: x\n');
      const canon = realpathSync(dir);
      const stale = Array.from({ length: 60 }, (_, i) => `/stale/${i}`);
      const pinned = '/stale/59'; // last entry — would fall past the cap, but it's grouped
      const setSpy = vi.fn();
      const ctx = baseCtx();
      ctx.settingsStore = storeMock(
        () => ({
          recentRepos: [dir, ...stale],
          projectGroups: [{ id: 'g1', name: 'G', repoPaths: [pinned] }],
        }),
        setSpy,
      );
      ctx.openRepoNewWindow = vi.fn();
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, dir);
      const written = setSpy.mock.calls[0][0].recentRepos as string[];
      expect(written).toHaveLength(51); // 50 capped + 1 grouped repo retained beyond the cap
      expect(written[0]).toBe(canon);
      expect(written).toContain(pinned); // the grouped repo survived the cap
    });
    // NOTE: the bump<->GROUPS_SET atomicity (a concurrent grouping is never evicted) is now
    // guaranteed by SettingsStore.update() serialization, exercised in settings-store.test.ts —
    // the old getCall-snapshot "fresh read" test is obsolete and was removed.
  });
});
