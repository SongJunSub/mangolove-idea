import { useI18n } from '../../i18n/i18n-context';

export interface NavBackProps {
  /** True when there is a previous location to return to. */
  readonly canGoBack: boolean;
  onBack(): void;
}

/**
 * Back control for code-nav history (← / Cmd+[). Pops the last {relPath,line,column}
 * pushed before a cross-file jump and re-opens it through App's dirty-guard. Disabled
 * when the history is empty.
 */
export function NavBack({ canGoBack, onBack }: NavBackProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-testid="nav-back"
      className="nav-back-btn"
      disabled={!canGoBack}
      title={t('editor.navBack')}
      onClick={onBack}
    >
      ←
    </button>
  );
}
