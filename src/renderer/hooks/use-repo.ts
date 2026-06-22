import { useCallback, useEffect, useState } from 'react';

/** Reads the selected repo root and exposes the native picker via window.mango.repo. */
export interface UseRepo {
  /** The currently-selected repo root, or null when none is set. */
  readonly repoRoot: string | null;
  /** True until the initial REPO_GET resolves. */
  readonly loading: boolean;
  /**
   * Open the native folder picker. On a valid git repo, main pushes it to
   * recentRepos and opens (or focuses) a window for it; if THIS window is the empty
   * gate, main attaches the repo and reloads it (so REPO_GET re-resolves to the new
   * root). No app relaunch.
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
    // Main opens/focuses a window for the picked repo (multi-window). If this is the
    // empty-gate window, main reloads it so the mount-time REPO_GET re-resolves to the
    // new root and the worktree UI replaces the picker. On cancel/error nothing changes.
    await window.mango.repo.pick();
  }, []);

  return { repoRoot, loading, pick };
}
