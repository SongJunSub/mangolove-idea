import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectTreeExpanded } from '../../shared/project-groups';

/** Expand/collapse state for the project tree (groups by id, repos by canonical path). */
export interface UseProjectTreeExpanded {
  isGroupExpanded(id: string): boolean;
  isRepoExpanded(path: string): boolean;
  toggleGroup(id: string): void;
  toggleRepo(path: string): void;
  /** Ensure a group (optional) + repo are expanded — used to reveal the active repo. Idempotent. */
  reveal(groupId: string | null, repoPath: string): void;
}

/**
 * Owns the project tree's expanded set, seeded from persisted settings and persisted back on every
 * change (skipping the initial hydrate so we never rewrite what we just read). Kept as plain arrays
 * in state (JSON-serializable) with memoized Sets for O(1) lookups. A repo switch reloads the
 * renderer, so persisting is what lets the tree keep its shape across switches.
 */
export function useProjectTreeExpanded(
  persisted: ProjectTreeExpanded | undefined,
  save: (next: ProjectTreeExpanded) => void,
): UseProjectTreeExpanded {
  const [expanded, setExpanded] = useState<{ groups: string[]; repos: string[] }>(() => ({
    groups: persisted?.groups ? [...persisted.groups] : [],
    repos: persisted?.repos ? [...persisted.repos] : [],
  }));

  // Plain array membership — the expanded set is a handful of ids/paths, so .includes is simpler
  // (and no slower at this scale) than deriving Sets.
  const isGroupExpanded = useCallback(
    (id: string): boolean => expanded.groups.includes(id),
    [expanded.groups],
  );
  const isRepoExpanded = useCallback(
    (path: string): boolean => expanded.repos.includes(path),
    [expanded.repos],
  );

  const toggleGroup = useCallback((id: string): void => {
    setExpanded((e) => ({
      ...e,
      groups: e.groups.includes(id) ? e.groups.filter((x) => x !== id) : [...e.groups, id],
    }));
  }, []);

  const toggleRepo = useCallback((path: string): void => {
    setExpanded((e) => ({
      ...e,
      repos: e.repos.includes(path) ? e.repos.filter((x) => x !== path) : [...e.repos, path],
    }));
  }, []);

  const reveal = useCallback((groupId: string | null, repoPath: string): void => {
    setExpanded((e) => {
      const needGroup = groupId !== null && !e.groups.includes(groupId);
      const needRepo = !e.repos.includes(repoPath);
      if (!needGroup && !needRepo) return e; // already revealed -> no re-render / no persist
      return {
        groups: needGroup ? [...e.groups, groupId] : e.groups,
        repos: needRepo ? [...e.repos, repoPath] : e.repos,
      };
    });
  }, []);

  // Persist on change; skip the first run so hydrating from settings doesn't write settings back.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    save({ groups: expanded.groups, repos: expanded.repos });
  }, [expanded, save]);

  return { isGroupExpanded, isRepoExpanded, toggleGroup, toggleRepo, reveal };
}
