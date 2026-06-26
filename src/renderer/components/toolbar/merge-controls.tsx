import type { MergeProgressEvent, Worktree } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';

export interface MergeControlsProps {
  readonly selected: Worktree | null;
  readonly running: boolean;
  readonly progress: MergeProgressEvent | null;
  onMerge(worktree: Worktree): void;
}

/**
 * Merge button for the selected (non-primary) worktree + a live stage line.
 * Runs verify -> merge -> cleanup into 'main' (MVP item 5). Disabled while a
 * merge is in flight, when nothing is selected, or for the primary worktree.
 */
export function MergeControls({
  selected,
  running,
  progress,
  onMerge,
}: MergeControlsProps): React.JSX.Element {
  const { t } = useI18n();
  const canMerge = !!selected && !selected.isPrimary && !running;
  const stageMark = progress?.ok ? '' : progress?.stage === 'conflict' ? ' ⚠' : ' ✗';
  const stageLabel = progress ? `${progress.stage}${stageMark}: ${progress.message}` : '';
  const stageColor =
    progress && progress.stage === 'conflict'
      ? 'var(--warn)'
      : progress && !progress.ok
        ? 'var(--err)'
        : 'var(--muted)';

  return (
    <div data-testid="merge-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        type="button"
        disabled={!canMerge}
        onClick={() => selected && onMerge(selected)}
        title={
          !selected
            ? t('app.selectWorktreeFirst')
            : selected.isPrimary
              ? t('merge.primaryTip')
              : t('merge.mergeTip')
        }
      >
        {running ? t('merge.merging') : t('merge.merge')}
      </button>
      {stageLabel && (
        <span data-testid="merge-stage" style={{ fontSize: 11, color: stageColor }}>
          {stageLabel}
        </span>
      )}
    </div>
  );
}
