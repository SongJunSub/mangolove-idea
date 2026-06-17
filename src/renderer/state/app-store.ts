import type { AgentStatus, ServerState, ServerStatus, Worktree } from '../../shared/types';

/** Unified per-worktree status the sidebar row renders (branch lives on Worktree). */
export interface WorktreeRowStatus {
  readonly agent: AgentStatus;
  readonly server: ServerState;
  /** True iff this worktree owns the single running server (Plan 3 invariant). */
  readonly ownsServer: boolean;
}

/**
 * Pure fold: combines the worktree list with the live agent-status map
 * (SESSION_STATUS) and the single ServerStatus (SERVER_STATE) into one
 * Map<worktreeId, WorktreeRowStatus>. Only the server's owning worktree shows a
 * non-stopped server state; everyone else is 'stopped'. No React, no IO — unit
 * tested directly; the useWorktreeStatus hook is the only live caller.
 */
export function aggregateStatus(
  worktrees: readonly Worktree[],
  agentStatuses: ReadonlyMap<string, AgentStatus>,
  server: ServerStatus | null,
): ReadonlyMap<string, WorktreeRowStatus> {
  const serverOwner = server?.process.worktreeId ?? null;
  const serverState = server?.process.state ?? 'stopped';
  const out = new Map<string, WorktreeRowStatus>();
  for (const wt of worktrees) {
    const ownsServer = serverOwner !== null && wt.id === serverOwner;
    out.set(wt.id, {
      agent: agentStatuses.get(wt.id) ?? 'idle',
      server: ownsServer ? serverState : 'stopped',
      ownsServer,
    });
  }
  return out;
}
