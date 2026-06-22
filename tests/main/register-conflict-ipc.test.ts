import { describe, it, expect, vi } from 'vitest';
import { registerIpcForTest } from '../helpers/register-ipc-for-test';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { ConflictResolver } from '../../src/main/git/conflict-resolver';

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
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    const files = await handlers.get(IPC.MERGE_CONFLICTS)!(fakeEvent, { worktreeId: 'w' });
    expect(files).toEqual([{ path: 'a.txt', code: 'UU', hasOurs: true, hasTheirs: true }]);

    await handlers.get(IPC.MERGE_RESOLVE)!(fakeEvent, {
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

    const cont = await handlers.get(IPC.MERGE_CONTINUE)!(fakeEvent, {
      worktreeId: 'w',
      targetBranch: 'main',
      cleanup: false,
    });
    expect(cont).toMatchObject({ merged: true, status: 'merged' });

    const abort = await handlers.get(IPC.MERGE_ABORT)!(fakeEvent, { worktreeId: 'w' });
    expect(abort).toMatchObject({ status: 'failed' });

    const merging = await handlers.get(IPC.MERGE_IN_PROGRESS)!(fakeEvent, { worktreeId: 'w' });
    expect(merging).toBe(true);
    expect(resolver.inProgress).toHaveBeenCalled();

    const owner = await handlers.get(IPC.MERGE_OWNER)!(fakeEvent, undefined);
    expect(owner).toBe('w');
    expect(resolver.inProgressWorktreeId).toHaveBeenCalled();
  });

  it('MERGE_RUN re-surfaces the in-progress conflict to its TRUE owner, not the clicked worktree', async () => {
    // A merge for worktree 'A' is paused (MERGE_HEAD = tip of A). The user then
    // clicks Merge on worktree 'B'. MERGE_RUN must short-circuit on the paused
    // merge AND attribute it to its owner 'A' — never to the clicked 'B' — so
    // Continue/cleanup acts on A's tree/branch, not B's.
    const resolver = {
      inProgress: vi.fn().mockResolvedValue(true),
      inProgressWorktreeId: vi.fn().mockResolvedValue('A'),
      list: vi
        .fn()
        .mockResolvedValue([{ path: 'a.txt', code: 'UU', hasOurs: true, hasTheirs: true }]),
    } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    const result = await handlers.get(IPC.MERGE_RUN)!(fakeEvent, {
      worktreeId: 'B',
      targetBranch: 'main',
      runVerifyHook: true,
      cleanup: true,
    });
    expect(result).toMatchObject({
      worktreeId: 'A',
      status: 'conflict',
      merged: false,
      cleanedUp: false,
      conflicted: ['a.txt'],
    });
  });

  it('MERGE_RUN falls back to the clicked worktree when no worktree owns MERGE_HEAD', async () => {
    // MERGE_HEAD present but no managed worktree's branch matches it (owner is null):
    // fall back to the request's worktreeId so the conflict still surfaces.
    const resolver = {
      inProgress: vi.fn().mockResolvedValue(true),
      inProgressWorktreeId: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    const result = await handlers.get(IPC.MERGE_RUN)!(fakeEvent, {
      worktreeId: 'B',
      targetBranch: 'main',
      runVerifyHook: true,
      cleanup: true,
    });
    expect(result).toMatchObject({ worktreeId: 'B', status: 'conflict' });
  });

  it('SETTINGS_SET keeps the conflictResolver while a merge is in progress', async () => {
    const resolver = { inProgress: vi.fn().mockResolvedValue(true) } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    await handlers.get(IPC.SETTINGS_SET)!(fakeEvent, { baseBranch: 'develop' });
    expect(ctx.conflictResolver).toBe(resolver); // NOT nulled while inProgress()
  });
});
