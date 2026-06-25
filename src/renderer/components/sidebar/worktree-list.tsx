import type { Worktree } from '../../../shared/types';
import type { WorktreeRowStatus } from '../../state/app-store';
import { WorktreeItem } from './worktree-item';

export interface WorktreeListProps {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly statuses: ReadonlyMap<string, WorktreeRowStatus>;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

/** Sidebar list of worktrees with loading/error/empty states + agent dots. */
export function WorktreeList({
  worktrees,
  loading,
  error,
  selectedId,
  statuses,
  onSelect,
  onRemove,
}: WorktreeListProps): React.JSX.Element {
  return (
    <section data-testid="worktree-list">
      <h2 style={{ fontSize: 14, margin: '8px 0' }}>Worktrees</h2>
      {error && <pre style={{ color: 'var(--err)', fontSize: 12 }}>error: {error}</pre>}
      {loading && <p style={{ fontSize: 12, color: 'var(--muted)' }}>loading…</p>}
      {!loading && worktrees.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--muted)' }}>no worktrees</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {worktrees.map((wt) => {
          const status = statuses.get(wt.id);
          return (
            <WorktreeItem
              key={wt.id}
              worktree={wt}
              selected={wt.id === selectedId}
              agentStatus={status?.agent ?? 'idle'}
              serverState={status?.server ?? 'stopped'}
              ownsServer={status?.ownsServer ?? false}
              onSelect={onSelect}
              onRemove={onRemove}
            />
          );
        })}
      </ul>
    </section>
  );
}
