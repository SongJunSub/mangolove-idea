import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';

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
const { registerIpc } = await import('../../src/main/ipc/register-ipc');
const { createIpcContext } = await import('../../src/main/ipc/ipc-context');

function makeIpcMain() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, arg: unknown) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  } as unknown as Parameters<typeof registerIpc>[0];
  return { ipcMain, handlers };
}

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
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_GET)!(null, undefined);
    expect(out).toBe('/Users/me/proj');
  });

  it('REPO_GET returns null when no repo is selected', async () => {
    const ctx = baseCtx(); // repoRoot defaults to null
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    expect(await handlers.get(IPC.REPO_GET)!(null, undefined)).toBeNull();
  });

  it('REPO_PICK returns {canceled:true} when the user cancels the dialog', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: false, canceled: true });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(ctx.settingsStore!.set).not.toHaveBeenCalled();
  });

  it('REPO_PICK rejects a non-git directory with {error}', async () => {
    // dir has NO .git entry -> not a git work tree.
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: false, error: 'not a git repository' });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(ctx.settingsStore!.set).not.toHaveBeenCalled();
  });

  it('REPO_PICK persists a valid repo then relaunches', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n'); // a linked-worktree .git FILE counts
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: true, repoRoot: dir });
    expect(ctx.settingsStore!.set).toHaveBeenCalledWith({ repoRoot: dir });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
