import { useEffect, useMemo, useState } from 'react';
import type { AgentStatus, ServerStatus, Worktree } from '../../shared/types';
import { aggregateStatus, type WorktreeRowStatus } from '../state/app-store';

/**
 * Live unified per-worktree status. Owns ONLY the agent-status map (SESSION_STATUS)
 * and derives the row map via the pure aggregateStatus reducer. The per-worktree
 * server map is passed in from useServer (the sole SERVER_STATE subscriber) so we
 * don't open a second redundant server subscription. The sidebar reads this map.
 */
export function useWorktreeStatus(
  worktrees: readonly Worktree[],
  servers: ReadonlyMap<string, ServerStatus>,
): ReadonlyMap<string, WorktreeRowStatus> {
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());

  useEffect(() => {
    const offStatus = window.mango.session.onStatus((s) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(s.worktreeId, s.status);
        return next;
      });
    });
    return () => {
      offStatus();
    };
  }, []);

  return useMemo(
    () => aggregateStatus(worktrees, agentStatuses, servers),
    [worktrees, agentStatuses, servers],
  );
}
