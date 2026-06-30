import type { Worktree } from '../../../shared/types';
import type { WorktreeRowStatus } from '../../state/app-store';
import { useI18n } from '../../i18n/i18n-context';
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
  const { t } = useI18n();
  return (
    <section className="wt-list" data-testid="worktree-list">
      {error && <pre className="wt-error">{t('worktree.error', { error })}</pre>}
      {loading && <p className="wt-empty">{t('worktree.loading')}</p>}
      {!loading && worktrees.length === 0 && <p className="wt-empty">{t('worktree.empty')}</p>}
      <ul className="wt-list-ul">
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
