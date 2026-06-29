import type { AgentStatus, ServerState, ServerStatus, Worktree } from '../../shared/types';

/** Unified per-worktree status the sidebar row renders (branch lives on Worktree). */
export interface WorktreeRowStatus {
  readonly agent: AgentStatus;
  readonly server: ServerState;
  /** True iff THIS worktree has a non-stopped (live/transitioning/crashed) server. */
  readonly ownsServer: boolean;
}

/**
 * Pure fold: combines the worktree list with the live agent-status map
 * (SESSION_STATUS) and the per-worktree server-status map (SERVER_STATE deltas +
 * SERVER_STATUS_ALL seed) into one Map<worktreeId, WorktreeRowStatus>. Each worktree
 * shows ITS OWN server state concurrently (V2 parallel servers); a worktree with no
 * record — or a 'stopped' record — is stopped/not-owning (D8). No React, no IO —
 * unit tested directly; useWorktreeStatus is the only live caller.
 */
export function aggregateStatus(
  worktrees: readonly Worktree[],
  agentStatuses: ReadonlyMap<string, AgentStatus>,
  servers: ReadonlyMap<string, ServerStatus>,
): ReadonlyMap<string, WorktreeRowStatus> {
  const out = new Map<string, WorktreeRowStatus>();
  for (const wt of worktrees) {
    const serverState = servers.get(wt.id)?.process.state ?? 'stopped';
    const ownsServer = serverState !== 'stopped';
    out.set(wt.id, {
      agent: agentStatuses.get(wt.id) ?? 'idle',
      server: serverState,
      ownsServer,
    });
  }
  return out;
}

/**
 * Whether switching repos right now would LOSE work — gates the in-place repo switch's
 * confirm dialog (the switch tears this window's agents/servers down + reloads). Busy iff an
 * editor has unsaved changes OR any worktree has an agent turn in flight ('starting' before
 * the PTY is up, 'running' mid-turn). 'idle'/'exited'/'error' are NOT busy — nothing live to
 * interrupt. A live dev SERVER is intentionally NOT counted: it holds no unsaved work and is
 * cheap to restart against the new repo, so it doesn't warrant a confirm prompt. No React, no
 * IO — unit tested directly; App is the only live caller.
 */
export function isRepoBusy(
  editorDirty: boolean,
  statuses: ReadonlyMap<string, WorktreeRowStatus>,
): boolean {
  if (editorDirty) return true;
  for (const s of statuses.values()) {
    if (s.agent === 'starting' || s.agent === 'running') return true;
  }
  return false;
}
