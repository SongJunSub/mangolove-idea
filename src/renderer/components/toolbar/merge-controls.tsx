import type { MergeProgressEvent, Worktree } from '../../../shared/types';

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
  const canMerge = !!selected && !selected.isPrimary && !running;
  const stageLabel = progress
    ? `${progress.stage}${progress.ok ? '' : progress.stage === 'conflict' ? ' ⚠' : ' ✗'}: ${progress.message}`
    : '';
  const stageColor =
    progress && progress.stage === 'conflict' ? '#e0a030' : progress && !progress.ok ? 'crimson' : '#888';

  return (
    <div data-testid="merge-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        type="button"
        disabled={!canMerge}
        onClick={() => selected && onMerge(selected)}
        title={
          !selected
            ? 'select a worktree first'
            : selected.isPrimary
              ? 'cannot merge the primary worktree'
              : 'verify, merge into main, then clean up'
        }
      >
        {running ? 'Merging…' : 'Merge → main'}
      </button>
      {stageLabel && (
        <span
          data-testid="merge-stage"
          style={{ fontSize: 11, color: stageColor }}
        >
          {stageLabel}
        </span>
      )}
    </div>
  );
}
