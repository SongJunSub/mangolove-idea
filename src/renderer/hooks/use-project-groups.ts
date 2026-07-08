import { useCallback, useEffect, useState } from 'react';
import type { ProjectGroup } from '../../shared/project-groups';

/** State + mutations for the project tree's grouping layer (over window.mango.groups). */
export interface UseProjectGroups {
  /** Groups as stored in main (repoPaths canonical, pruned to live repos). */
  readonly groups: readonly ProjectGroup[];
  /** True until the first list resolves. */
  readonly loading: boolean;
  /**
   * Create a new group; returns its id, or null when the name is blank. Pass `initialRepoPath` to
   * move that repo INTO the new group in the SAME write (atomic) — never a create-then-assign pair,
   * whose second call would run against a stale pre-create groups snapshot and clobber the group.
   */
  createGroup(name: string, initialRepoPath?: string): Promise<string | null>;
  /** Rename a group; a blank name is rejected (no-op). */
  renameGroup(id: string, name: string): Promise<void>;
  /** Remove a group — its repos become ungrouped (they remain in recentRepos). */
  removeGroup(id: string): Promise<void>;
  /** Move a repo into a group, or ungroup it (groupId null). Enforces 1-repo-1-group. */
  assignRepoToGroup(repoPath: string, groupId: string | null): Promise<void>;
}

/**
 * Reads project groups on mount and re-reads on the cross-window GROUPS_CHANGED signal. Every
 * mutation builds the next group array and routes through main's groups.set, then ADOPTS the
 * returned stored form (main canonicalizes, prunes to live repos, and re-applies the
 * 1-repo-1-group invariant) — so the local state never drifts from what was persisted.
 */
export function useProjectGroups(): UseProjectGroups {
  const [groups, setGroups] = useState<readonly ProjectGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.mango.groups
      .get()
      .then((g) => {
        if (alive) setGroups(g);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // Another window changed the groups -> re-fetch so this tree converges.
    const off = window.mango.groups.onChanged(() => {
      void window.mango.groups.get().then((g) => {
        if (alive) setGroups(g);
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  /** Persist a next-groups array and adopt the stored (coerced) form main returns. */
  const commit = useCallback(async (next: ProjectGroup[]): Promise<void> => {
    setGroups(await window.mango.groups.set(next));
  }, []);

  const createGroup = useCallback(
    async (name: string, initialRepoPath?: string): Promise<string | null> => {
      const trimmed = name.trim();
      if (trimmed === '') return null; // blank name rejected (never rely on the coercer to drop it)
      const id = crypto.randomUUID();
      // Build the whole next set in ONE commit: strip the repo from its old group (1-repo-1-group)
      // and seed it into the new group. Doing create + assign atomically avoids the stale-closure
      // clobber a create-then-assign pair would hit (assign would run against pre-create groups).
      const stripped = initialRepoPath
        ? groups.map((g) => ({ ...g, repoPaths: g.repoPaths.filter((p) => p !== initialRepoPath) }))
        : groups;
      await commit([
        ...stripped,
        { id, name: trimmed, repoPaths: initialRepoPath ? [initialRepoPath] : [] },
      ]);
      return id;
    },
    [groups, commit],
  );

  const renameGroup = useCallback(
    async (id: string, name: string): Promise<void> => {
      const trimmed = name.trim();
      if (trimmed === '') return; // blank rename rejected
      await commit(groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)));
    },
    [groups, commit],
  );

  const removeGroup = useCallback(
    async (id: string): Promise<void> => {
      await commit(groups.filter((g) => g.id !== id));
    },
    [groups, commit],
  );

  const assignRepoToGroup = useCallback(
    async (repoPath: string, groupId: string | null): Promise<void> => {
      // Strip the repo from EVERY group first (1-repo-1-group), then add it to the target — so
      // "move to g2" wins regardless of group order (the coercer's first-wins would otherwise
      // keep it in its old group).
      const stripped = groups.map((g) => ({
        ...g,
        repoPaths: g.repoPaths.filter((p) => p !== repoPath),
      }));
      const next =
        groupId === null
          ? stripped
          : stripped.map((g) =>
              g.id === groupId ? { ...g, repoPaths: [...g.repoPaths, repoPath] } : g,
            );
      await commit(next);
    },
    [groups, commit],
  );

  return { groups, loading, createGroup, renameGroup, removeGroup, assignRepoToGroup };
}
