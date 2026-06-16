import type { AgentStatus, Worktree } from '../../../shared/types';
import { WorktreeItem } from './worktree-item';

/** Props for the worktree sidebar list. */
export interface WorktreeListProps {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly agentStatuses: ReadonlyMap<string, AgentStatus>;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

/** Sidebar list of worktrees with loading/error/empty states + agent dots. */
export function WorktreeList({
  worktrees,
  loading,
  error,
  selectedId,
  agentStatuses,
  onSelect,
  onRemove,
}: WorktreeListProps): React.JSX.Element {
  return (
    <section data-testid="worktree-list" style={{ minWidth: 260 }}>
      <h2 style={{ fontSize: 14, margin: '8px 0' }}>Worktrees</h2>
      {error && <pre style={{ color: 'crimson', fontSize: 12 }}>error: {error}</pre>}
      {loading && <p style={{ fontSize: 12, color: '#888' }}>loading…</p>}
      {!loading && worktrees.length === 0 && (
        <p style={{ fontSize: 12, color: '#888' }}>no worktrees</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {worktrees.map((wt) => (
          <WorktreeItem
            key={wt.id}
            worktree={wt}
            selected={wt.id === selectedId}
            agentStatus={agentStatuses.get(wt.id) ?? 'idle'}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}
