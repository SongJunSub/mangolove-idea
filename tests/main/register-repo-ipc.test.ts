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

  it('REPO_PICK persists a valid repo then relaunches via the forced-quit path', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n'); // a linked-worktree .git FILE counts
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    // index.ts wires ctx.requestQuit to quitController.decide(true) (the confirmed
    // forced-quit path). REPO_PICK MUST route through it — not a raw app.quit() the
    // before-quit veto can swallow — so persist+relaunch never leaves a half-state.
    const requestQuit = vi.fn(() => mocks.quit());
    ctx.requestQuit = requestQuit;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: true, repoRoot: dir });
    expect(ctx.settingsStore!.set).toHaveBeenCalledWith({ repoRoot: dir });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    // relaunch registered BEFORE the quit is requested (Electron relaunch contract).
    expect(mocks.relaunch.mock.invocationCallOrder[0]).toBeLessThan(
      requestQuit.mock.invocationCallOrder[0],
    );
    // confirmed-quit flag set so the re-fired before-quit falls through (no veto / popup).
    expect(ctx.confirmedQuit).toBe(true);
    expect(requestQuit).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it('REPO_PICK survives a before-quit veto from live worktree sessions', async () => {
    // Reachable once the renderer adds a change-repo affordance while sessions run.
    // The QuitController vetoes a NON-confirmed quit when liveWorktreeIds > 0; REPO_PICK
    // must use the confirmed forced-quit path so the relaunch is NOT swallowed.
    const { QuitController } = await import('../../src/main/app/quit-controller');
    const emitQuitWarning = vi.fn();
    const controller = new QuitController({
      liveWorktreeIds: () => ['wt-1'], // a live PTY exists -> non-confirmed quit is vetoed.
      emitQuitWarning,
      sweep: vi.fn(),
      quitNow: () => mocks.quit(),
    });

    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    ctx.requestQuit = () => controller.decide(true); // exactly index.ts's wiring.
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    // app.quit() (quitNow) re-fires before-quit; confirmed flag lets it through cleanly.
    let vetoed = false;
    controller.onBeforeQuit({ preventDefault: () => (vetoed = true) });

    expect(out).toEqual({ ok: true, repoRoot: dir });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce(); // quit actually fired despite live sessions.
    expect(vetoed).toBe(false); // NOT vetoed, NO unexpected quit-warning popup.
    expect(emitQuitWarning).not.toHaveBeenCalled();
  });
});
