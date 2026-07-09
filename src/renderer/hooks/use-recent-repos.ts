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
  /**
   * Open a known repo in a NEW window (or focus its existing window — one repo per window).
   * Unlike open(), THIS window is left untouched, so no editor flush is needed at the call site.
   */
  openNewWindow(path: string): Promise<RepoPickResult>;
  /** Drop a repo from the list (disk untouched; never the active one). Adopts the updated list. */
  forget(path: string): Promise<void>;
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

  const openNewWindow = useCallback(
    async (path: string): Promise<RepoPickResult> => window.mango.repo.openNewWindow(path),
    [],
  );

  const forget = useCallback(async (path: string): Promise<void> => {
    setRepos(await window.mango.repo.forget(path));
  }, []);

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

  // Any window open/close/repo-swap re-fetches the list so the "open in another window" flags
  // (openElsewhere) stay live in this window's tree.
  useEffect(() => window.mango.repo.onWindowsChanged(() => void refresh()), [refresh]);

  return { repos, loading, refresh, open, openNewWindow, forget };
}
