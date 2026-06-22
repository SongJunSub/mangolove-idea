import { useCallback, useEffect, useState } from 'react';
import type { ServerStatus } from '../../shared/types';

/** Return shape of the per-worktree server hook. */
export interface UseServer {
  /** Live per-worktree server snapshots, keyed by worktreeId. */
  readonly servers: ReadonlyMap<string, ServerStatus>;
  start(worktreeId: string): Promise<void>;
  stop(worktreeId: string): Promise<void>;
}

/**
 * Drives the per-worktree dev servers over window.mango.server. Seeds the whole map
 * from statusAll() on mount and stays live via onState (each delta is keyed by
 * process.worktreeId). start/stop are thin invoke wrappers. The returned map feeds
 * the toolbar (selected worktree) + the sidebar dots (all worktrees).
 */
export function useServer(): UseServer {
  const [servers, setServers] = useState<ReadonlyMap<string, ServerStatus>>(new Map());

  useEffect(() => {
    let alive = true;
    void window.mango.server.statusAll().then((all) => {
      if (!alive) return;
      setServers(new Map(Object.entries(all)));
    });
    const off = window.mango.server.onState((s) => {
      const id = s.process.worktreeId;
      if (id === null) return; // main never emits a null-worktree snapshot (D8); guard anyway
      setServers((prev) => {
        const next = new Map(prev);
        next.set(id, s);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useCallback(async (worktreeId: string): Promise<void> => {
    const s = await window.mango.server.start({ worktreeId });
    const id = s.process.worktreeId ?? worktreeId;
    setServers((prev) => new Map(prev).set(id, s));
  }, []);

  const stop = useCallback(async (worktreeId: string): Promise<void> => {
    const s = await window.mango.server.stop({ worktreeId });
    const id = s.process.worktreeId ?? worktreeId;
    setServers((prev) => new Map(prev).set(id, s));
  }, []);

  return { servers, start, stop };
}
