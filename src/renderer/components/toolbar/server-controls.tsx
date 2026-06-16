import type { ServerStatus } from '../../../shared/types';

export interface ServerControlsProps {
  readonly selectedId: string | null;
  readonly status: ServerStatus | null;
  onStart(worktreeId: string): void;
  onStop(): void;
}

/** Run/Stop for the selected worktree's single local server (MVP item 3). */
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
      <button type="button" disabled={!isRunning && !isBusy} onClick={() => onStop()}>
        Stop
      </button>
      <span style={{ fontSize: 11, color: '#888' }}>server: {state}</span>
    </div>
  );
}
