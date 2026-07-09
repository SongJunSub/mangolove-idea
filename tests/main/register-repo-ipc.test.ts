import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';
import { registerIpcForTest } from '../helpers/register-ipc-for-test';
import { SettingsStore } from '../../src/main/managers/settings-store';

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
  ctx.settingsStore = { get: () => ({}), set: vi.fn((p: unknown) => p) } as never;
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
      ctx.settingsStore = { get: () => ({ recentRepos: [b, gone, a, b] }), set: vi.fn() } as never;
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

  it('REPO_OPEN switches to a known repo: bumps the CANONICAL path + calls openRepo', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: x\n');
    const canon = realpathSync(dir);
    const setSpy = vi.fn();
    const ctx = baseCtx();
    // '/old' is non-existent -> canonicalRepoRoot falls back to itself, stays in the list.
    ctx.settingsStore = { get: () => ({ recentRepos: ['/old', dir] }), set: setSpy } as never;
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
    ctx.settingsStore = { get: () => ({ recentRepos: [dir] }), set: vi.fn() } as never;
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
      ctx.settingsStore = { get: () => ({ recentRepos: ['/old', dir] }), set: setSpy } as never;
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
      ctx.settingsStore = { get: () => ({ recentRepos: ['/other'] }), set: vi.fn() } as never;
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
      ctx.settingsStore = { get: () => ({ recentRepos: [dir, ...stale] }), set: setSpy } as never;
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
      ctx.settingsStore = {
        get: () => ({
          recentRepos: [dir, ...stale],
          projectGroups: [{ id: 'g1', name: 'G', repoPaths: [pinned] }],
        }),
        set: setSpy,
      } as never;
      ctx.openRepoNewWindow = vi.fn();
      const { handlers, fakeEvent } = registerIpcForTest(ctx);
      await handlers.get(IPC.REPO_OPEN_NEW_WINDOW)!(fakeEvent, dir);
      const written = setSpy.mock.calls[0][0].recentRepos as string[];
      expect(written).toHaveLength(51); // 50 capped + 1 grouped repo retained beyond the cap
      expect(written[0]).toBe(canon);
      expect(written).toContain(pinned); // the grouped repo survived the cap
    });
  });
});
