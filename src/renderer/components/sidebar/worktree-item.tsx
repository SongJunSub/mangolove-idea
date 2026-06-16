import type { Worktree } from '../../../shared/types';

/** Props for one worktree row. */
export interface WorktreeItemProps {
  readonly worktree: Worktree;
  onRemove(worktreeId: string): void;
}

/** A single worktree row: branch, badges, short HEAD, and a Remove action. */
export function WorktreeItem({ worktree, onRemove }: WorktreeItemProps): React.JSX.Element {
  return (
    <li
      data-testid="worktree-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderBottom: '1px solid #eee',
      }}
    >
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}>{worktree.branch}</span>
      {worktree.isPrimary && <span style={{ fontSize: 11, color: '#888' }}>primary</span>}
      {worktree.isLocked && <span style={{ fontSize: 11, color: '#b58900' }}>locked</span>}
      {worktree.head && <span style={{ fontSize: 11, color: '#aaa' }}>{worktree.head}</span>}
      <button
        type="button"
        disabled={worktree.isPrimary}
        onClick={() => onRemove(worktree.id)}
        title={worktree.isPrimary ? 'cannot remove the primary worktree' : 'remove worktree'}
      >
        Remove
      </button>
    </li>
  );
}
