import type { AgentStatus, ServerState, Worktree } from '../../../shared/types';
import { ServerDot } from './server-dot';

/** Props for one worktree row. */
export interface WorktreeItemProps {
  readonly worktree: Worktree;
  readonly selected: boolean;
  readonly agentStatus: AgentStatus;
  readonly serverState: ServerState;
  readonly ownsServer: boolean;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--faint)',
  starting: 'var(--warn)',
  running: 'var(--ok)',
  exited: 'var(--muted)',
  error: 'var(--err)',
};

/** A single worktree row: agent dot, branch, badges, short HEAD, Remove. Clickable to select. */
export function WorktreeItem({
  worktree,
  selected,
  agentStatus,
  serverState,
  ownsServer,
  onSelect,
  onRemove,
}: WorktreeItemProps): React.JSX.Element {
  return (
    <li
      data-testid="worktree-item"
      onClick={() => onSelect(worktree.id)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '6px 8px',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        minWidth: 0,
        background: selected ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      {/* line 1: status dot + branch (gets the full column width) + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          aria-label={`agent ${agentStatus}`}
          title={`agent ${agentStatus}`}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_COLOR[agentStatus],
            flex: '0 0 auto',
          }}
        />
        {ownsServer && <ServerDot state={serverState} />}
        <span
          title={worktree.branch}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          {worktree.branch}
        </span>
        {worktree.isPrimary && (
          <span style={{ fontSize: 11, color: 'var(--muted)', flex: '0 0 auto' }}>primary</span>
        )}
        {worktree.isLocked && (
          <span style={{ fontSize: 11, color: 'var(--warn)', flex: '0 0 auto' }}>locked</span>
        )}
      </div>
      {/* line 2: short HEAD + Remove (pushed right) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {worktree.head && (
          <span
            style={{ fontSize: 11, color: 'var(--faint)', fontFamily: 'ui-monospace, monospace' }}
          >
            {worktree.head}
          </span>
        )}
        <button
          type="button"
          disabled={worktree.isPrimary || worktree.isLocked}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(worktree.id);
          }}
          title={
            worktree.isPrimary
              ? 'cannot remove the primary worktree'
              : worktree.isLocked
                ? 'worktree is locked; unlock it first'
                : 'remove worktree'
          }
          style={{ marginLeft: 'auto', flex: '0 0 auto', fontSize: 11, padding: '1px 8px' }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
