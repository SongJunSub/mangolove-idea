import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';
import { registerIpcForTest } from '../helpers/register-ipc-for-test';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';
import { SettingsStore } from '../../src/main/managers/settings-store';

// BrowserWindow is only reached by GROUPS_SET's broadcast; getAllWindows()->[] makes it a no-op.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getVersion: () => '0.1.0' },
  shell: { openExternal: vi.fn() },
}));

const { createIpcContext } = await import('../../src/main/ipc/ipc-context');

/** A ctx with a REAL SettingsStore over a temp file (so persistence round-trips through IPC). */
function ctxWithStore(settingsFile: string) {
  const ctx = createIpcContext();
  ctx.settingsStore = new SettingsStore(settingsFile);
  return ctx;
}

describe('project-groups + listFor IPC wiring', () => {
  let dir: string;
  let settingsFile: string;
  let repoA: TempGitRepo;
  let repoB: TempGitRepo;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mango-groups-'));
    settingsFile = join(dir, 'settings.json');
    repoA = await makeTempGitRepo();
    repoB = await makeTempGitRepo();
  });
  afterEach(() => {
    repoA.cleanup();
    repoB.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── WORKTREE_LIST_FOR ──────────────────────────────────────────────────────

  it('LIST_FOR returns [] for a non-string or empty path', async () => {
    const ctx = ctxWithStore(settingsFile);
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    expect(await handlers.get(IPC.WORKTREE_LIST_FOR)!(fakeEvent, 123)).toEqual([]);
    expect(await handlers.get(IPC.WORKTREE_LIST_FOR)!(fakeEvent, '')).toEqual([]);
  });

  it('LIST_FOR rejects a path NOT in recentRepos (allowlist) with []', async () => {
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [realpathSync(repoA.dir)] });
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    // repoB is a real git repo but NOT in recentRepos -> must be refused.
    expect(await handlers.get(IPC.WORKTREE_LIST_FOR)!(fakeEvent, repoB.dir)).toEqual([]);
  });

  it('LIST_FOR lists worktrees for an allowlisted repo (canonical + primary)', async () => {
    const canonA = realpathSync(repoA.dir);
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [canonA] });
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = (await handlers.get(IPC.WORKTREE_LIST_FOR)!(fakeEvent, repoA.dir)) as Array<{
      path: string;
      isPrimary: boolean;
    }>;
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].isPrimary).toBe(true);
    expect(out[0].path).toBe(canonA);
  });

  // ── GROUPS_GET / GROUPS_SET ────────────────────────────────────────────────

  it('GROUPS_SET persists, canonicalizes repoPaths, and GROUPS_GET reads them back', async () => {
    const canonA = realpathSync(repoA.dir);
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [canonA, realpathSync(repoB.dir)] });
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    // Pass the RAW (non-canonical) path; the handler must canonicalize it.
    const stored = await handlers.get(IPC.GROUPS_SET)!(fakeEvent, [
      { id: 'g1', name: 'CRS', repoPaths: [repoA.dir] },
    ]);
    expect(stored).toEqual([{ id: 'g1', name: 'CRS', repoPaths: [canonA] }]);

    const got = await handlers.get(IPC.GROUPS_GET)!(fakeEvent, undefined);
    expect(got).toEqual([{ id: 'g1', name: 'CRS', repoPaths: [canonA] }]);
  });

  it('GROUPS_SET prunes repoPaths not in recentRepos and drops blank-name groups', async () => {
    const canonA = realpathSync(repoA.dir);
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [canonA] }); // repoB deliberately NOT listed
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const stored = await handlers.get(IPC.GROUPS_SET)!(fakeEvent, [
      { id: 'g1', name: 'CRS', repoPaths: [repoA.dir, repoB.dir, '/ghost'] },
      { id: 'g2', name: '', repoPaths: [repoA.dir] }, // blank name -> dropped
    ]);
    expect(stored).toEqual([{ id: 'g1', name: 'CRS', repoPaths: [canonA] }]);
  });

  it('GROUPS_SET enforces 1-repo-1-group on the CANONICAL paths', async () => {
    const canonA = realpathSync(repoA.dir);
    const canonB = realpathSync(repoB.dir);
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [canonA, canonB] });
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const stored = (await handlers.get(IPC.GROUPS_SET)!(fakeEvent, [
      { id: 'g1', name: 'one', repoPaths: [repoA.dir, repoB.dir] },
      { id: 'g2', name: 'two', repoPaths: [repoA.dir] }, // A already claimed by g1
    ])) as Array<{ id: string; repoPaths: string[] }>;
    expect(stored).toEqual([
      { id: 'g1', name: 'one', repoPaths: [canonA, canonB] },
      { id: 'g2', name: 'two', repoPaths: [] },
    ]);
  });

  it('GROUPS_GET prunes a repo that has left recentRepos since it was grouped', async () => {
    const canonA = realpathSync(repoA.dir);
    const canonB = realpathSync(repoB.dir);
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [canonA, canonB] });
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    await handlers.get(IPC.GROUPS_SET)!(fakeEvent, [
      { id: 'g1', name: 'CRS', repoPaths: [canonA, canonB] },
    ]);
    // repoB is removed from disk -> no longer in the live canonical set.
    repoB.cleanup();
    const got = await handlers.get(IPC.GROUPS_GET)!(fakeEvent, undefined);
    expect(got).toEqual([{ id: 'g1', name: 'CRS', repoPaths: [canonA] }]);
  });

  it('GROUPS_SET with an empty array clears the persisted groups', async () => {
    const canonA = realpathSync(repoA.dir);
    const ctx = ctxWithStore(settingsFile);
    ctx.settingsStore!.set({ recentRepos: [canonA] });
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    await handlers.get(IPC.GROUPS_SET)!(fakeEvent, [
      { id: 'g1', name: 'CRS', repoPaths: [canonA] },
    ]);
    expect(await handlers.get(IPC.GROUPS_SET)!(fakeEvent, [])).toEqual([]);
    expect(await handlers.get(IPC.GROUPS_GET)!(fakeEvent, undefined)).toEqual([]);
    expect(ctx.settingsStore!.get().projectGroups).toBeUndefined();
  });
});
