import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectGroups } from '../../src/renderer/hooks/use-project-groups';
import type { ProjectGroup } from '../../src/shared/project-groups';

/** Stub window.mango.groups; set() echoes its argument (main's coercion is tested elsewhere). */
function stub(initial: ProjectGroup[]) {
  let onChangedCb: (() => void) | undefined;
  const get = vi.fn(async () => initial);
  const set = vi.fn(async (groups: ProjectGroup[]) => groups);
  const onChanged = vi.fn((cb: () => void) => {
    onChangedCb = cb;
    return () => {
      onChangedCb = undefined;
    };
  });
  Object.defineProperty(window, 'mango', {
    value: { groups: { get, set, onChanged } },
    configurable: true,
  });
  return { get, set, onChanged, fireChanged: () => onChangedCb?.() };
}

describe('useProjectGroups', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('loads groups on mount and subscribes to GROUPS_CHANGED', async () => {
    const { get, onChanged } = stub([{ id: 'g1', name: 'CRS', repoPaths: ['/a'] }]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toEqual([{ id: 'g1', name: 'CRS', repoPaths: ['/a'] }]);
    expect(get).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('createGroup appends a named empty group and returns its id', async () => {
    const { set } = stub([]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id: string | null = null;
    await act(async () => {
      id = await result.current.createGroup('  CRS  ');
    });
    expect(typeof id).toBe('string');
    expect(set).toHaveBeenCalledWith([
      { id: expect.any(String), name: 'CRS', repoPaths: [] }, // trimmed
    ]);
  });

  it('createGroup with a repoPath seeds it into the new group in ONE atomic commit', async () => {
    const { set } = stub([{ id: 'g1', name: 'one', repoPaths: ['/repo', '/keep'] }]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.createGroup('Infra', '/repo');
    });
    // Single write: /repo stripped from its old group AND seeded into the new one (no stale-closure pair).
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith([
      { id: 'g1', name: 'one', repoPaths: ['/keep'] },
      { id: expect.any(String), name: 'Infra', repoPaths: ['/repo'] },
    ]);
  });

  it('createGroup rejects a blank name (returns null, no set)', async () => {
    const { set } = stub([]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id: string | null = 'x';
    await act(async () => {
      id = await result.current.createGroup('   ');
    });
    expect(id).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it('assignRepoToGroup strips the repo from every group, then adds it to the target', async () => {
    const { set } = stub([
      { id: 'g1', name: 'one', repoPaths: ['/shared', '/only1'] },
      { id: 'g2', name: 'two', repoPaths: ['/only2'] },
    ]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.assignRepoToGroup('/shared', 'g2');
    });
    expect(set).toHaveBeenCalledWith([
      { id: 'g1', name: 'one', repoPaths: ['/only1'] }, // /shared removed
      { id: 'g2', name: 'two', repoPaths: ['/only2', '/shared'] }, // /shared added
    ]);
  });

  it('assignRepoToGroup with null ungroups the repo (strips from all, adds to none)', async () => {
    const { set } = stub([{ id: 'g1', name: 'one', repoPaths: ['/a', '/b'] }]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.assignRepoToGroup('/a', null);
    });
    expect(set).toHaveBeenCalledWith([{ id: 'g1', name: 'one', repoPaths: ['/b'] }]);
  });

  it('removeGroup drops the group (its repos become ungrouped)', async () => {
    const { set } = stub([
      { id: 'g1', name: 'one', repoPaths: ['/a'] },
      { id: 'g2', name: 'two', repoPaths: ['/b'] },
    ]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.removeGroup('g1');
    });
    expect(set).toHaveBeenCalledWith([{ id: 'g2', name: 'two', repoPaths: ['/b'] }]);
  });

  it('re-fetches when another window fires GROUPS_CHANGED', async () => {
    const stubbed = stub([{ id: 'g1', name: 'CRS', repoPaths: [] }]);
    const { result } = renderHook(() => useProjectGroups());
    await waitFor(() => expect(result.current.loading).toBe(false));
    stubbed.get.mockResolvedValueOnce([{ id: 'g9', name: 'NEW', repoPaths: [] }]);
    act(() => stubbed.fireChanged());
    await waitFor(() =>
      expect(result.current.groups).toEqual([{ id: 'g9', name: 'NEW', repoPaths: [] }]),
    );
  });
});
