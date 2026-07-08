import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorktreesFor } from '../../src/renderer/hooks/use-worktrees-for';
import type { Worktree } from '../../src/shared/types';

function wt(path: string, isPrimary = true): Worktree {
  return { id: path, path, branch: 'main', isPrimary, isLocked: false };
}

/** Stub window.mango.worktree.listFor with a controllable implementation. */
function stub(listFor: (repoPath: string) => Promise<Worktree[]>) {
  Object.defineProperty(window, 'mango', {
    value: { worktree: { listFor: vi.fn(listFor) } },
    configurable: true,
  });
  return window.mango.worktree.listFor as ReturnType<typeof vi.fn>;
}

describe('useWorktreesFor', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('stateFor is idle before any request', () => {
    stub(async () => []);
    const { result } = renderHook(() => useWorktreesFor());
    expect(result.current.stateFor('/a')).toEqual({ status: 'idle', worktrees: [], error: null });
  });

  it('ensureLoaded fetches once and lands the worktrees', async () => {
    const listFor = stub(async () => [wt('/a')]);
    const { result } = renderHook(() => useWorktreesFor());
    act(() => result.current.ensureLoaded('/a'));
    await waitFor(() => expect(result.current.stateFor('/a').status).toBe('loaded'));
    expect(result.current.stateFor('/a').worktrees).toEqual([wt('/a')]);
    expect(listFor).toHaveBeenCalledTimes(1);
  });

  it('ensureLoaded is idempotent once loaded (no second fetch)', async () => {
    const listFor = stub(async () => [wt('/a')]);
    const { result } = renderHook(() => useWorktreesFor());
    act(() => result.current.ensureLoaded('/a'));
    await waitFor(() => expect(result.current.stateFor('/a').status).toBe('loaded'));
    act(() => result.current.ensureLoaded('/a'));
    expect(listFor).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected listFor as an error state', async () => {
    stub(async () => {
      throw new Error('git blew up');
    });
    const { result } = renderHook(() => useWorktreesFor());
    act(() => result.current.ensureLoaded('/a'));
    await waitFor(() => expect(result.current.stateFor('/a').status).toBe('error'));
    expect(result.current.stateFor('/a').error).toBe('git blew up');
  });

  it('drops a stale response when a newer reload supersedes it', async () => {
    const resolvers: Array<(w: Worktree[]) => void> = [];
    stub(() => new Promise<Worktree[]>((res) => resolvers.push(res)));
    const { result } = renderHook(() => useWorktreesFor());
    act(() => result.current.ensureLoaded('/a')); // request #1
    act(() => result.current.reload('/a')); // request #2 (supersedes)
    // Resolve the NEWER request first, then the stale one.
    act(() => resolvers[1]([wt('/a', true)]));
    await waitFor(() => expect(result.current.stateFor('/a').status).toBe('loaded'));
    act(() => resolvers[0]([wt('/stale', false)])); // must be ignored
    expect(result.current.stateFor('/a').worktrees).toEqual([wt('/a', true)]);
  });
});
