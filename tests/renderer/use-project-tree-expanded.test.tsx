import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProjectTreeExpanded } from '../../src/renderer/hooks/use-project-tree-expanded';
import type { ProjectTreeExpanded } from '../../src/shared/project-groups';

type Props = { persisted: ProjectTreeExpanded | undefined };

describe('useProjectTreeExpanded', () => {
  it('adopts persisted state that arrives asynchronously, UNION-merged with what is already open', () => {
    // Regression: settings load async, so the hook mounts with persisted=undefined. Without an
    // adopt effect the saved shape is ignored and then clobbered on disk.
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ persisted }: Props) => useProjectTreeExpanded(persisted, save),
      { initialProps: { persisted: undefined } as Props },
    );
    // Before settings resolve, App's auto-reveal expands the active repo:
    act(() => result.current.reveal(null, '/active'));
    expect(result.current.isRepoExpanded('/active')).toBe(true);
    // Persisted settings resolve a render later:
    act(() => rerender({ persisted: { groups: ['g1'], repos: ['/foo'] } }));
    // Adopted AND merged with the already-open active repo — neither dropped:
    expect(result.current.isGroupExpanded('g1')).toBe(true);
    expect(result.current.isRepoExpanded('/foo')).toBe(true);
    expect(result.current.isRepoExpanded('/active')).toBe(true);
  });

  it('persists toggles (skipping the initial hydrate) and never adopts twice', () => {
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ persisted }: Props) => useProjectTreeExpanded(persisted, save),
      { initialProps: { persisted: { groups: [], repos: [] } } as Props },
    );
    expect(save).not.toHaveBeenCalled(); // hydrating from settings is not a write-back
    act(() => result.current.toggleGroup('g1'));
    expect(save).toHaveBeenLastCalledWith({ groups: ['g1'], repos: [] });
    // A later persisted change must NOT re-adopt (already adopted at mount):
    act(() => rerender({ persisted: { groups: ['zzz'], repos: [] } }));
    expect(result.current.isGroupExpanded('zzz')).toBe(false);
  });

  it('toggle adds then removes; reveal is a no-op when already expanded', () => {
    const save = vi.fn();
    const { result } = renderHook(() => useProjectTreeExpanded(undefined, save));
    act(() => result.current.toggleRepo('/a'));
    expect(result.current.isRepoExpanded('/a')).toBe(true);
    act(() => result.current.toggleRepo('/a'));
    expect(result.current.isRepoExpanded('/a')).toBe(false);
    act(() => result.current.reveal('g1', '/a'));
    const calls = save.mock.calls.length;
    act(() => result.current.reveal('g1', '/a')); // already expanded -> no state change, no save
    expect(save.mock.calls.length).toBe(calls);
  });
});
