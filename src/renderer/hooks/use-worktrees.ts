import { useCallback, useEffect, useState } from 'react';
import type { CreateWorktreeRequest, Worktree } from '../../shared/types';

/** Return shape of the worktree CRUD hook. */
export interface UseWorktrees {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  refresh(): Promise<void>;
  create(req: CreateWorktreeRequest): Promise<void>;
  remove(worktreeId: string, force?: boolean): Promise<void>;
}

/**
 * Worktree CRUD over window.mango.worktree. Loads the list on mount; create and
 * remove refresh the list and surface errors as a string (never throws to UI).
 */
export function useWorktrees(): UseWorktrees {
  const [worktrees, setWorktrees] = useState<readonly Worktree[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.mango.worktree.list();
      setWorktrees(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (req: CreateWorktreeRequest): Promise<void> => {
      setError(null);
      try {
        await window.mango.worktree.create(req);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (worktreeId: string, force?: boolean): Promise<void> => {
      setError(null);
      try {
        const ack = await window.mango.worktree.remove({ worktreeId, force });
        if (!ack.ok) {
          setError(ack.error ?? 'remove failed');
          return;
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { worktrees, loading, error, refresh, create, remove };
}
