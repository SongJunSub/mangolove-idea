import type { UsageStatus, UsageLimit } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';
import type { Locale, MessageKey, TranslateFn } from '../../i18n/messages';

export interface UsageWidgetProps {
  /** Latest usage, or null before the first fetch. */
  readonly status: UsageStatus | null;
  /** True while a fetch is in flight (spins the refresh icon). */
  readonly loading: boolean;
  /** Re-fetch. */
  readonly onRefresh: () => void;
}

/** A localized short label for a limit's chip; the chip tooltip adds percent + reset time. */
function shortLabel(l: UsageLimit, t: TranslateFn): string {
  switch (l.kind) {
    case 'session':
      return t('usage.session');
    case 'weekly_all':
      return t('usage.weekly');
    case 'weekly_scoped':
      return l.model ?? t('usage.model');
    default:
      return l.label;
  }
}

/** Human "time until reset" for the tooltip. */
function untilReset(resetsAt: string | null, t: TranslateFn): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return t('usage.resetSoon');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? t('usage.resetInHM', { h, m }) : t('usage.resetInM', { m });
}

function chipTitle(l: UsageLimit, t: TranslateFn, locale: Locale): string {
  const until = untilReset(l.resetsAt, t);
  const at = l.resetsAt
    ? new Date(l.resetsAt).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US')
    : '';
  return [`${shortLabel(l, t)} ${l.percent}%`, at && t('usage.resetAt', { at }), until]
    .filter(Boolean)
    .join('\n');
}

/** maps the API severity to a color class. */
function severityClass(severity: string): string {
  if (severity === 'critical') return 'usage-chip--crit';
  if (severity === 'warning') return 'usage-chip--warn';
  return '';
}

/** API error code -> message key for the localized one-line error. */
const ERROR_KEY: Record<NonNullable<UsageStatus['error']>, MessageKey> = {
  'no-login': 'usage.error.noLogin',
  denied: 'usage.error.denied',
  rate_limited: 'usage.error.rateLimited',
  offline: 'usage.error.failed',
  failed: 'usage.error.failed',
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
 * refresh. Read-only, no token cost. Each chip's tooltip adds the percent + reset time.
 */
export function UsageWidget({ status, loading, onRefresh }: UsageWidgetProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const refresh = (
    <button
      type="button"
      className={`usage-refresh${loading ? ' usage-refresh--spin' : ''}`}
      data-testid="usage-refresh"
      title={t('usage.refresh')}
      onClick={onRefresh}
    >
      ↻
    </button>
  );

  let body: React.JSX.Element;
  if (!status) {
    body = <span className="usage-muted">{t('usage.loading')}</span>;
  } else if (status.error) {
    body = (
      <span className="usage-muted" data-testid="usage-error">
        {t(ERROR_KEY[status.error])}
      </span>
    );
  } else {
    // Only the session (5h) + weekly-all windows; per-model (weekly_scoped) is omitted.
    const shown = status.limits.filter((l) => l.kind === 'session' || l.kind === 'weekly_all');
    body =
      shown.length === 0 ? (
        <span className="usage-muted">{t('usage.none')}</span>
      ) : (
        <span className="usage-chips" data-testid="usage-chips">
          {shown.map((l, i) => (
            <span key={l.kind + i}>
              {i > 0 && <span className="usage-sep">·</span>}
              <span
                className={`usage-chip ${severityClass(l.severity)}`}
                data-testid={`usage-${l.kind}`}
                title={chipTitle(l, t, locale)}
              >
                {shortLabel(l, t)} <strong>{l.percent}%</strong>
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
