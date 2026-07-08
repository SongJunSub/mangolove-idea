import { useCallback, useRef, useState } from 'react';
import type { Worktree } from '../../shared/types';

/** Per-repo lazy-load state for the project tree's cross-repo worktree listing. */
export interface RepoWorktreesState {
  readonly status: 'idle' | 'loading' | 'loaded' | 'error';
  readonly worktrees: readonly Worktree[];
  readonly error: string | null;
}

/** Lazy, per-repo worktree loading over window.mango.worktree.listFor with independent state. */
export interface UseWorktreesFor {
  /** Current state for a repo path (idle until first requested). */
  stateFor(repoPath: string): RepoWorktreesState;
  /** Fetch a repo's worktrees once — no-op if already loading or loaded (call on expand). */
  ensureLoaded(repoPath: string): void;
  /** Force a re-fetch (background refresh of an already-loaded repo). */
  reload(repoPath: string): void;
}

const IDLE: RepoWorktreesState = { status: 'idle', worktrees: [], error: null };

/**
 * Lazily lists worktrees for repos OTHER than the window's active one — the project tree fetches
 * a repo's worktrees only when its node expands, keeping each repo's loading/error independent so
 * one repo's failure never blanks the tree. Requests are guarded by a per-repo sequence: a stale
 * response (superseded by a newer reload, or arriving after a collapse) is dropped, never applied.
 */
export function useWorktreesFor(): UseWorktreesFor {
  const [byPath, setByPath] = useState<Record<string, RepoWorktreesState>>({});
  // Monotonic request id per repo — only the newest response is allowed to land.
  const seqRef = useRef<Map<string, number>>(new Map());
  // Mirror of each repo's status so ensureLoaded stays idempotent without reading async state.
  const statusRef = useRef<Map<string, RepoWorktreesState['status']>>(new Map());

  const load = useCallback((repoPath: string): void => {
    const seq = (seqRef.current.get(repoPath) ?? 0) + 1;
    seqRef.current.set(repoPath, seq);
    statusRef.current.set(repoPath, 'loading');
    setByPath((prev) => ({
      ...prev,
      // Keep the previous worktrees visible while refreshing (no flash to empty).
      [repoPath]: { status: 'loading', worktrees: prev[repoPath]?.worktrees ?? [], error: null },
    }));
    void window.mango.worktree
      .listFor(repoPath)
      .then((worktrees) => {
        if (seqRef.current.get(repoPath) !== seq) return; // superseded
        statusRef.current.set(repoPath, 'loaded');
        setByPath((prev) => ({
          ...prev,
          [repoPath]: { status: 'loaded', worktrees, error: null },
        }));
      })
      .catch((e: unknown) => {
        if (seqRef.current.get(repoPath) !== seq) return;
        statusRef.current.set(repoPath, 'error');
        const error = e instanceof Error ? e.message : String(e);
        setByPath((prev) => ({ ...prev, [repoPath]: { status: 'error', worktrees: [], error } }));
      });
  }, []);

  const ensureLoaded = useCallback(
    (repoPath: string): void => {
      const status = statusRef.current.get(repoPath);
      if (status === 'loading' || status === 'loaded') return;
      load(repoPath);
    },
    [load],
  );

  const reload = useCallback((repoPath: string): void => load(repoPath), [load]);

  const stateFor = useCallback(
    (repoPath: string): RepoWorktreesState => byPath[repoPath] ?? IDLE,
    [byPath],
  );

  return { stateFor, ensureLoaded, reload };
}
