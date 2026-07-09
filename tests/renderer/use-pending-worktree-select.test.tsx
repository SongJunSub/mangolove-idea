import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePendingWorktreeSelect } from '../../src/renderer/hooks/use-pending-worktree-select';
import type { Worktree } from '../../src/shared/types';

function wt(id: string): Worktree {
  return { id, path: id, branch: 'b', isPrimary: false, isLocked: false };
}

/** Stub window.mango.repo.{takePendingSelect,onSelectWorktree} with a controllable pull + nudge. */
function stub(takePending: () => Promise<string | null>) {
  let nudgeCb: ((e: { worktreeId: string }) => void) | undefined;
  const takePendingSelect = vi.fn(takePending);
  const onSelectWorktree = vi.fn((cb: (e: { worktreeId: string }) => void) => {
    nudgeCb = cb;
    return () => {
      nudgeCb = undefined;
    };
  });
  Object.defineProperty(window, 'mango', {
    value: { repo: { takePendingSelect, onSelectWorktree } },
    configurable: true,
  });
  return {
    takePendingSelect,
    nudge: (worktreeId: string) => act(() => nudgeCb?.({ worktreeId })),
  };
}

interface Props {
  worktrees: Worktree[];
  loading: boolean;
  selectedId: string | null;
}
const render = (onSelect: (id: string) => void, initial: Props) =>
  renderHook(
    ({ worktrees, loading, selectedId }: Props) =>
      usePendingWorktreeSelect(worktrees, loading, selectedId, onSelect),
    { initialProps: initial },
  );

describe('usePendingWorktreeSelect', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pulls the pended id once and applies it when the worktrees have loaded', async () => {
    const { takePendingSelect } = stub(async () => '/wt/a');
    const onSelect = vi.fn();
    const { rerender } = render(onSelect, { worktrees: [], loading: true, selectedId: null });
    await waitFor(() => expect(takePendingSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).not.toHaveBeenCalled(); // still loading -> not yet
    rerender({ worktrees: [wt('/wt/a')], loading: false, selectedId: null });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/wt/a'));
  });

  it('applies even when the pull RESOLVES AFTER the worktrees already loaded (no race)', async () => {
    let resolvePull!: (id: string) => void;
    const { takePendingSelect } = stub(() => new Promise<string>((r) => (resolvePull = r)));
    const onSelect = vi.fn();
    const { rerender } = render(onSelect, { worktrees: [], loading: true, selectedId: null });
    await waitFor(() => expect(takePendingSelect).toHaveBeenCalled());
    // worktrees finish loading BEFORE the pull resolves
    rerender({ worktrees: [wt('/wt/a')], loading: false, selectedId: null });
    await act(async () => resolvePull('/wt/a'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/wt/a'));
  });

  it('does not clobber a selection the user already made', async () => {
    stub(async () => '/wt/a');
    const onSelect = vi.fn();
    const { rerender } = render(onSelect, { worktrees: [], loading: true, selectedId: null });
    rerender({ worktrees: [wt('/wt/a')], loading: false, selectedId: '/wt/other' });
    await act(async () => {});
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('drops a since-deleted / unknown target (not in the loaded list)', async () => {
    stub(async () => '/wt/gone');
    const onSelect = vi.fn();
    const { rerender } = render(onSelect, { worktrees: [], loading: true, selectedId: null });
    rerender({ worktrees: [wt('/wt/a')], loading: false, selectedId: null });
    await act(async () => {});
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does nothing when nothing was pended (null)', async () => {
    const { takePendingSelect } = stub(async () => null);
    const onSelect = vi.fn();
    render(onSelect, { worktrees: [wt('/wt/a')], loading: false, selectedId: null });
    await waitFor(() => expect(takePendingSelect).toHaveBeenCalled());
    await act(async () => {});
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('applies a live nudge when this window has that worktree, ignores it otherwise', async () => {
    const s = stub(async () => null);
    const onSelect = vi.fn();
    render(onSelect, { worktrees: [wt('/wt/a')], loading: false, selectedId: null });
    await s.nudge('/wt/x'); // not in this window's list -> ignored
    expect(onSelect).not.toHaveBeenCalled();
    await s.nudge('/wt/a');
    expect(onSelect).toHaveBeenCalledWith('/wt/a');
  });

  it('a delivered nudge CONSUMES the durable pending (so a later reload can not re-apply it)', async () => {
    const s = stub(async () => null);
    const onSelect = vi.fn();
    render(onSelect, { worktrees: [wt('/wt/a')], loading: false, selectedId: null });
    const before = s.takePendingSelect.mock.calls.length; // the mount pull already ran once
    await s.nudge('/wt/a');
    expect(s.takePendingSelect.mock.calls.length).toBeGreaterThan(before);
  });
});
