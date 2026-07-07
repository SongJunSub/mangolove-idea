import { useI18n } from '../../i18n/i18n-context';

export interface NavButtonsProps {
  /** True when there is a previous code-nav location to return to. */
  readonly canGoBack: boolean;
  /** True when a Back has been taken and there is a location to go forward to. */
  readonly canGoForward: boolean;
  onBack(): void;
  onForward(): void;
}

/**
 * Back/forward cluster for code-nav history (← / Cmd+[, → / Cmd+]). Each pops the last
 * {relPath,line,column} pushed on a cross-file jump and re-opens it through App's auto-save guard;
 * a new jump clears the forward history (browser semantics). Buttons disable when their stack is empty.
 */
export function NavButtons({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: NavButtonsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <span className="nav-buttons">
      <button
        type="button"
        data-testid="nav-back"
        className="nav-btn"
        disabled={!canGoBack}
        title={t('editor.navBack')}
        onClick={onBack}
      >
        ←
      </button>
      <button
        type="button"
        data-testid="nav-forward"
        className="nav-btn"
        disabled={!canGoForward}
        title={t('editor.navForward')}
        onClick={onForward}
      >
        →
      </button>
    </span>
  );
}
