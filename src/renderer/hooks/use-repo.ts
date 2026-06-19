import { useCallback, useEffect, useState } from 'react';

/** Reads the selected repo root and exposes the native picker via window.mango.repo. */
export interface UseRepo {
  /** The currently-selected repo root, or null when none is set. */
  readonly repoRoot: string | null;
  /** True until the initial REPO_GET resolves. */
  readonly loading: boolean;
  /**
   * Open the native folder picker. On a valid git repo, main persists it and
   * relaunches the app (so this promise rarely resolves observably on success).
   */
  pick(): Promise<void>;
}

/** Fetches the repo root once on mount; pick() opens the native picker. */
export function useRepo(): UseRepo {
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.mango.repo
      .get()
      .then((r) => {
        if (alive) setRepoRoot(r);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const pick = useCallback(async (): Promise<void> => {
    // On success main relaunches the app, so we do not update local state here;
    // the fresh process re-reads REPO_GET. On cancel/error the empty-state stays.
    await window.mango.repo.pick();
  }, []);

  return { repoRoot, loading, pick };
}
