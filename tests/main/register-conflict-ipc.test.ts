import { describe, it, expect, vi } from 'vitest';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { ConflictResolver } from '../../src/main/git/conflict-resolver';

/** Minimal ipcMain double that records handlers by channel. */
function makeIpcMain() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, arg: unknown) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  } as unknown as Parameters<typeof registerIpc>[0];
  return { ipcMain, handlers };
}

describe('conflict IPC wiring', () => {
  it('routes the conflict channels to the injected ConflictResolver', async () => {
    const resolver = {
      list: vi
        .fn()
        .mockResolvedValue([{ path: 'a.txt', code: 'UU', hasOurs: true, hasTheirs: true }]),
      read: vi.fn().mockResolvedValue({ path: 'a.txt' }),
      resolve: vi.fn().mockResolvedValue(undefined),
      continue: vi
        .fn()
        .mockResolvedValue({ worktreeId: 'w', merged: true, cleanedUp: false, status: 'merged' }),
      abort: vi
        .fn()
        .mockResolvedValue({ worktreeId: 'w', merged: false, cleanedUp: false, status: 'failed' }),
      inProgress: vi.fn().mockResolvedValue(true),
      inProgressWorktreeId: vi.fn().mockResolvedValue('w'),
    } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const files = await handlers.get(IPC.MERGE_CONFLICTS)!(null, { worktreeId: 'w' });
    expect(files).toEqual([{ path: 'a.txt', code: 'UU', hasOurs: true, hasTheirs: true }]);

    await handlers.get(IPC.MERGE_RESOLVE)!(null, {
      worktreeId: 'w',
      path: 'a.txt',
      choice: 'ours',
      targetBranch: 'main',
    });
    expect(resolver.resolve).toHaveBeenCalledWith({
      path: 'a.txt',
      choice: 'ours',
      content: undefined,
    });

    const cont = await handlers.get(IPC.MERGE_CONTINUE)!(null, {
      worktreeId: 'w',
      targetBranch: 'main',
      cleanup: false,
    });
    expect(cont).toMatchObject({ merged: true, status: 'merged' });

    const abort = await handlers.get(IPC.MERGE_ABORT)!(null, { worktreeId: 'w' });
    expect(abort).toMatchObject({ status: 'failed' });

    const merging = await handlers.get(IPC.MERGE_IN_PROGRESS)!(null, { worktreeId: 'w' });
    expect(merging).toBe(true);
    expect(resolver.inProgress).toHaveBeenCalled();

    const owner = await handlers.get(IPC.MERGE_OWNER)!(null, undefined);
    expect(owner).toBe('w');
    expect(resolver.inProgressWorktreeId).toHaveBeenCalled();
  });

  it('SETTINGS_SET keeps the conflictResolver while a merge is in progress', async () => {
    const resolver = { inProgress: vi.fn().mockResolvedValue(true) } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    await handlers.get(IPC.SETTINGS_SET)!(null, { baseBranch: 'develop' });
    expect(ctx.conflictResolver).toBe(resolver); // NOT nulled while inProgress()
  });
});
