import type { ServerStatus } from '../../../shared/types';

export interface ServerControlsProps {
  readonly selectedId: string | null;
  /** The SELECTED worktree's server snapshot (or null when it has never run). */
  readonly status: ServerStatus | null;
  onStart(worktreeId: string): void;
  onStop(worktreeId: string): void;
}

/** Run/Stop for the SELECTED worktree's server (each worktree runs its own, V2). */
export function ServerControls({
  selectedId,
  status,
  onStart,
  onStop,
}: ServerControlsProps): React.JSX.Element {
  const state = status?.process.state ?? 'stopped';
  const isBusy = state === 'starting' || state === 'stopping';
  const isRunning = state === 'running';

  return (
    <div data-testid="server-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        type="button"
        disabled={!selectedId || isRunning || isBusy}
        onClick={() => selectedId && onStart(selectedId)}
        title={selectedId ? 'start the detected server' : 'select a worktree first'}
      >
        Run
      </button>
      <button
        type="button"
        disabled={!selectedId || (!isRunning && !isBusy)}
        onClick={() => selectedId && onStop(selectedId)}
      >
        Stop
      </button>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>server: {state}</span>
    </div>
  );
}
