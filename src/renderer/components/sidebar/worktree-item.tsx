import type { AgentStatus, ServerState, Worktree } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';
import { AGENT_STATUS_KEY } from '../../i18n/status-keys';
import { ServerDot } from './server-dot';

/** Props for one worktree row. */
export interface WorktreeItemProps {
  readonly worktree: Worktree;
  readonly selected: boolean;
  readonly agentStatus: AgentStatus;
  readonly serverState: ServerState;
  readonly ownsServer: boolean;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--faint)',
  starting: 'var(--warn)',
  running: 'var(--ok)',
  exited: 'var(--muted)',
  error: 'var(--err)',
};

/** A single worktree row: agent dot, branch, badges, short HEAD, Remove. Clickable to select. */
export function WorktreeItem({
  worktree,
  selected,
  agentStatus,
  serverState,
  ownsServer,
  onSelect,
  onRemove,
}: WorktreeItemProps): React.JSX.Element {
  const { t } = useI18n();
  const agentLabel = t('worktree.agentDot', { status: t(AGENT_STATUS_KEY[agentStatus]) });
  return (
    <li
      data-testid="worktree-item"
      className={`wt-item${selected ? ' sel' : ''}`}
      onClick={() => onSelect(worktree.id)}
    >
      {/* line 1: status dot + branch (gets the full column width) + badges */}
      <div className="wt-row">
        <span
          className="wt-dot"
          aria-label={agentLabel}
          title={agentLabel}
          style={{ background: STATUS_COLOR[agentStatus] }}
        />
        {ownsServer && <ServerDot state={serverState} />}
        <span className="wt-branch" title={worktree.branch}>
          {worktree.branch}
        </span>
        {worktree.isPrimary && <span className="wt-badge">{t('worktree.primary')}</span>}
        {worktree.isLocked && (
          <span className="wt-badge wt-badge--warn">{t('worktree.locked')}</span>
        )}
      </div>
      {/* line 2: short HEAD + Remove (pushed right) */}
      <div className="wt-row">
        {worktree.head && <span className="wt-head">{worktree.head}</span>}
        <button
          type="button"
          className="wt-remove"
          disabled={worktree.isPrimary || worktree.isLocked}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(worktree.id);
          }}
          title={
            worktree.isPrimary
              ? t('worktree.removeTip.primary')
              : worktree.isLocked
                ? t('worktree.removeTip.locked')
                : t('worktree.removeTip.default')
          }
        >
          {t('worktree.remove')}
        </button>
      </div>
    </li>
  );
}
