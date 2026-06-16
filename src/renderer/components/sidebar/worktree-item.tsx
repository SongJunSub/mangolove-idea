import type { AgentStatus, Worktree } from '../../../shared/types';

/** Props for one worktree row. */
export interface WorktreeItemProps {
  readonly worktree: Worktree;
  readonly selected: boolean;
  readonly agentStatus: AgentStatus;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: '#bbb',
  starting: '#d8a657',
  running: '#2ea043',
  exited: '#888',
  error: '#cf222e',
};

/** A single worktree row: agent dot, branch, badges, short HEAD, Remove. Clickable to select. */
export function WorktreeItem({
  worktree,
  selected,
  agentStatus,
  onSelect,
  onRemove,
}: WorktreeItemProps): React.JSX.Element {
  return (
    <li
      data-testid="worktree-item"
      onClick={() => onSelect(worktree.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#eef4ff' : 'transparent',
      }}
    >
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
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}>{worktree.branch}</span>
      {worktree.isPrimary && <span style={{ fontSize: 11, color: '#888' }}>primary</span>}
      {worktree.isLocked && <span style={{ fontSize: 11, color: '#b58900' }}>locked</span>}
      {worktree.head && <span style={{ fontSize: 11, color: '#aaa' }}>{worktree.head}</span>}
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
      >
        Remove
      </button>
    </li>
  );
}
