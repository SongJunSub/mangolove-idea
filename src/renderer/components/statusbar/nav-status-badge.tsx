import { useI18n } from '../../i18n/i18n-context';
import type { CodeNavRuntimeState } from '../../../shared/types';

/**
 * Status-bar badge for Java/Kotlin code navigation, so a Cmd+Click that resolves to nothing is
 * no longer a silent mystery: it shows the language server is still starting/indexing, has failed
 * (hover for the reason), or isn't installed. Hidden when nav is ready or the active file isn't
 * Java/Kotlin — pure/presentational so it unit-tests without the IPC layer.
 */
export type NavIndicatorState = CodeNavRuntimeState | 'unavailable';

export interface NavStatusBadgeProps {
  /** The active file's nav language, or null when it's not Java/Kotlin (badge hidden). */
  readonly lang: 'java' | 'kotlin' | null;
  /** Current state; null or 'ready' hides the badge (no clutter when nav works). */
  readonly state: NavIndicatorState | null;
  /** Extra context for the tooltip: the failure reason, or the install hint. */
  readonly detail?: string;
  /** When set AND the state is actionable (failed / unavailable), the badge becomes a button that
   *  invokes this — App wires it to open Settings, where the LSP paths + install hints live. Busy
   *  states (starting/indexing) stay non-interactive. */
  onAction?(): void;
}

const LANG_LABEL: Readonly<Record<'java' | 'kotlin', string>> = { java: 'Java', kotlin: 'Kotlin' };

export function NavStatusBadge({
  lang,
  state,
  detail,
  onAction,
}: NavStatusBadgeProps): React.JSX.Element | null {
  const { t } = useI18n();
  if (!lang || !state || state === 'ready') return null; // ready/other = nothing to say
  const label = LANG_LABEL[lang];
  const busy = state === 'starting' || state === 'indexing';
  const text =
    state === 'failed'
      ? t('nav.failed', { lang: label })
      : state === 'unavailable'
        ? t('nav.unavailable', { lang: label })
        : t('nav.indexing', { lang: label }); // starting | indexing
  const inner = (
    <>
      {busy && <span className="nav-status__dot" aria-hidden="true" />}
      {text}
    </>
  );
  // failed/unavailable → an actionable button (open Settings); busy/others stay a static span.
  if (onAction && (state === 'failed' || state === 'unavailable')) {
    return (
      <button
        type="button"
        className={`nav-status nav-status--${state} nav-status--action`}
        data-testid="nav-status"
        title={detail ? t('nav.actionTip', { detail }) : t('nav.actionTipBare')}
        onClick={onAction}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className={`nav-status nav-status--${state}`}
      data-testid="nav-status"
      title={detail || undefined}
    >
      {inner}
    </span>
  );
}
