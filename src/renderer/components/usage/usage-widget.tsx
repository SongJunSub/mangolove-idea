import type { UsageStatus, UsageLimit } from '../../../shared/types';

export interface UsageWidgetProps {
  /** Latest usage, or null before the first fetch. */
  readonly status: UsageStatus | null;
  /** True while a fetch is in flight (spins the refresh icon). */
  readonly loading: boolean;
  /** Re-fetch. */
  readonly onRefresh: () => void;
}

/** A short chip label for a limit (the long label + reset go in the tooltip). */
function shortLabel(l: UsageLimit): string {
  switch (l.kind) {
    case 'session':
      return '세션';
    case 'weekly_all':
      return '주간';
    case 'weekly_scoped':
      return l.model ?? '모델';
    default:
      return l.label;
  }
}

/** Human "time until reset" for the tooltip. */
function untilReset(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '곧 리셋';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}시간 ${m}분 후 리셋` : `${m}분 후 리셋`;
}

function chipTitle(l: UsageLimit): string {
  const until = untilReset(l.resetsAt);
  const at = l.resetsAt ? new Date(l.resetsAt).toLocaleString() : '';
  return [`${l.label} ${l.percent}%`, at && `리셋: ${at}`, until].filter(Boolean).join('\n');
}

/** maps the API severity to a color class. */
function severityClass(severity: string): string {
  if (severity === 'critical') return 'usage-chip--crit';
  if (severity === 'warning') return 'usage-chip--warn';
  return '';
}

const ERROR_TEXT: Record<NonNullable<UsageStatus['error']>, string> = {
  'no-login': 'Claude 미연결',
  denied: '키체인 접근 거부',
  rate_limited: '사용량 잠시 후 다시',
  offline: '사용량 불러오기 실패',
  failed: '사용량 불러오기 실패',
};

/** Radiating rays for the Claude mark (a small sunburst), computed once. */
const CLAUDE_RAYS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6;
  return {
    x1: 8 + Math.cos(a) * 2.4,
    y1: 8 + Math.sin(a) * 2.4,
    x2: 8 + Math.cos(a) * 6.7,
    y2: 8 + Math.sin(a) * 6.7,
  };
});

/** A small Claude-orange sunburst mark, evoking the Anthropic logo. */
function ClaudeMark(): React.JSX.Element {
  return (
    <svg
      className="usage-claude"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      stroke="#d97757"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {CLAUDE_RAYS.map((r, i) => (
        <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
      ))}
    </svg>
  );
}

/**
 * Bottom-left status item: the user's Claude usage (5h session + weekly), with a Claude mark +
 * refresh. Read-only, no token cost. The reset time + full label live in each chip's tooltip.
 */
export function UsageWidget({ status, loading, onRefresh }: UsageWidgetProps): React.JSX.Element {
  const refresh = (
    <button
      type="button"
      className={`usage-refresh${loading ? ' usage-refresh--spin' : ''}`}
      data-testid="usage-refresh"
      title="새로고침"
      onClick={onRefresh}
    >
      ↻
    </button>
  );

  let body: React.JSX.Element;
  if (!status) {
    body = <span className="usage-muted">Claude 사용량…</span>;
  } else if (status.error) {
    body = (
      <span className="usage-muted" data-testid="usage-error">
        {ERROR_TEXT[status.error]}
      </span>
    );
  } else {
    // Only the session (5h) + weekly-all windows; per-model (weekly_scoped) is omitted.
    const shown = status.limits.filter((l) => l.kind === 'session' || l.kind === 'weekly_all');
    body =
      shown.length === 0 ? (
        <span className="usage-muted">사용량 없음</span>
      ) : (
        <span className="usage-chips" data-testid="usage-chips">
          {shown.map((l, i) => (
            <span key={l.kind + i}>
              {i > 0 && <span className="usage-sep">·</span>}
              <span
                className={`usage-chip ${severityClass(l.severity)}`}
                data-testid={`usage-${l.kind}`}
                title={chipTitle(l)}
              >
                {shortLabel(l)} <strong>{l.percent}%</strong>
              </span>
            </span>
          ))}
        </span>
      );
  }

  return (
    <div className="usage" data-testid="usage-widget">
      <ClaudeMark />
      {body}
      {refresh}
    </div>
  );
}
