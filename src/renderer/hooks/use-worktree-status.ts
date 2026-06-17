import { useEffect, useMemo, useState } from 'react';
import type { AgentStatus, ServerStatus, Worktree } from '../../shared/types';
import { aggregateStatus, type WorktreeRowStatus } from '../state/app-store';

/**
 * Live unified per-worktree status. Owns the agent-status map (SESSION_STATUS)
 * and the single ServerStatus (SERVER_STATE, seeded from status()), then derives
 * the row map via the pure aggregateStatus reducer. The sidebar reads this map.
 */
export function useWorktreeStatus(
  worktrees: readonly Worktree[],
): ReadonlyMap<string, WorktreeRowStatus> {
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());
  const [server, setServer] = useState<ServerStatus | null>(null);

  useEffect(() => {
    const offStatus = window.mango.session.onStatus((s) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(s.worktreeId, s.status);
        return next;
      });
    });
    let alive = true;
    void window.mango.server.status().then((s) => {
      if (alive) setServer(s);
    });
    const offState = window.mango.server.onState((s) => setServer(s));
    return () => {
      alive = false;
      offStatus();
      offState();
    };
  }, []);

  return useMemo(
    () => aggregateStatus(worktrees, agentStatuses, server),
    [worktrees, agentStatuses, server],
  );
}
