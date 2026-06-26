import type { ServerState } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';
import { SERVER_STATE_KEY } from '../../i18n/status-keys';

const SERVER_COLOR: Record<ServerState, string> = {
  stopped: 'var(--faint)',
  starting: 'var(--warn)',
  running: 'var(--accent)',
  stopping: 'var(--warn)',
  crashed: 'var(--err)',
};

export interface ServerDotProps {
  readonly state: ServerState;
}

/** Small colored dot showing this worktree's server state in the sidebar. */
export function ServerDot({ state }: ServerDotProps): React.JSX.Element {
  const { t } = useI18n();
  const label = t('worktree.serverDot', { state: t(SERVER_STATE_KEY[state]) });
  return (
    <span
      aria-label={label}
      title={label}
      style={{
        width: 8,
        height: 8,
        borderRadius: 2,
        background: SERVER_COLOR[state],
        flex: '0 0 auto',
      }}
    />
  );
}
