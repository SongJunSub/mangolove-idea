import { useCallback, useEffect, useState } from 'react';
import type { RecentRepo, RepoPickResult } from '../../shared/types';

/** State + actions for the sidebar repo switcher. */
export interface UseRecentRepos {
  /** Known repos (most-recent first); the active one carries `active: true`. */
  readonly repos: readonly RecentRepo[];
  /** True until the first list resolves. */
  readonly loading: boolean;
  /** Re-fetch the list (e.g. after adding a repo). */
  refresh(): Promise<void>;
  /**
   * Switch to a known repo by path: main opens or FOCUSES its window (never a second
   * window for the same repo). This window stays put when it focuses another; the
   * empty-gate window attaches + reloads. `opts.worktreeId` (cross-repo worktree select)
   * is delivered to the target window once its repo is active.
   */
  open(path: string, opts?: { worktreeId?: string }): Promise<RepoPickResult>;
}

/** Reads recentRepos once on mount; open() switches to a repo, refresh() re-lists. */
export function useRecentRepos(): UseRecentRepos {
  const [repos, setRepos] = useState<readonly RecentRepo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setRepos(await window.mango.repo.list());
  }, []);

  const open = useCallback(
    async (path: string, opts?: { worktreeId?: string }): Promise<RepoPickResult> =>
      window.mango.repo.open(path, opts),
    [],
  );

  useEffect(() => {
    let alive = true;
    void window.mango.repo
      .list()
      .then((r) => {
        if (alive) setRepos(r);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { repos, loading, refresh, open };
}
