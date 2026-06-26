import type { ServerStatus } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';
import { SERVER_STATE_KEY } from '../../i18n/status-keys';

export interface ServerControlsProps {
  readonly selectedId: string | null;
  /** The SELECTED worktree's server snapshot (or null when it has never run). */
  readonly status: ServerStatus | null;
  /**
   * The SELECTED worktree's auto-detected localhost URL (already demuxed from its logs),
   * or null. Shown as a clickable chip only while the server is running. The detected
   * URL carries the actual port (which can differ from the injected one), so it is the
   * authoritative thing to show/open — no port plumbing through the status is needed.
   */
  readonly serverUrl?: string | null;
  onStart(worktreeId: string): void;
  onStop(worktreeId: string): void;
  /** Open the running server in the embedded Browser tab (App switches paneMode). */
  onOpen?(): void;
}

/** Run/Stop for the SELECTED worktree's server (each worktree runs its own, V2). */
export function ServerControls({
  selectedId,
  status,
  serverUrl,
  onStart,
  onStop,
  onOpen,
}: ServerControlsProps): React.JSX.Element {
  const { t } = useI18n();
  const state = status?.process.state ?? 'stopped';
  const isBusy = state === 'starting' || state === 'stopping';
  const isRunning = state === 'running';
  // Only offer "Open" when there is somewhere to go: a running server WITH a detected URL.
  const canOpen = isRunning && !!serverUrl && !!onOpen;

  return (
    <div
      data-testid="server-controls"
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <button
        type="button"
        disabled={!selectedId || isRunning || isBusy}
        onClick={() => selectedId && onStart(selectedId)}
        title={selectedId ? t('server.startTip') : t('app.selectWorktreeFirst')}
      >
        {t('server.run')}
      </button>
      <button
        type="button"
        disabled={!selectedId || (!isRunning && !isBusy)}
        onClick={() => selectedId && onStop(selectedId)}
      >
        {t('server.stop')}
      </button>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
        {t('server.line', { state: t(SERVER_STATE_KEY[state]) })}
      </span>
      {canOpen && (
        <button
          type="button"
          data-testid="server-open"
          className="server-open-chip"
          title={t('server.openTip', { url: serverUrl ?? '' })}
          onClick={() => onOpen?.()}
        >
          ↗ {serverUrl}
        </button>
      )}
    </div>
  );
}
