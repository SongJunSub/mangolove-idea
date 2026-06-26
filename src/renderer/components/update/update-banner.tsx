import type { UpdateStatus } from '../../../shared/types';
import type { SelfUpdateState } from '../../hooks/use-self-update';

/** Props for the update-available notification card (bottom-right). */
export interface UpdateBannerProps {
  /** The latest update-check result, or null before the launch check resolves. */
  readonly status: UpdateStatus | null;
  /** The version the user already dismissed (settings.lastDismissedUpdateVersion). */
  readonly dismissedVersion: string | undefined;
  /** Persist a dismissal of `version` (the card stays hidden until a newer release). */
  readonly onDismiss: (version: string) => void;
  /** Open a URL in the browser (App injects the github.com-pinned openExternal). */
  readonly onOpen: (url: string | null) => void;
  /** Live state of an in-flight one-click update (the card hides while it runs). */
  readonly applyState: SelfUpdateState;
  /** Begin the one-click "Update & Restart" flow. */
  readonly onUpdate: () => void;
}

/** Human label for an in-flight update phase. */
function phaseLabel(state: SelfUpdateState): string {
  switch (state.phase) {
    case 'downloading':
      return state.totalBytes
        ? `다운로드 중 ${Math.floor(((state.receivedBytes ?? 0) / state.totalBytes) * 100)}%`
        : `다운로드 중 ${Math.floor((state.receivedBytes ?? 0) / 1_000_000)}MB`;
    case 'verifying':
      return '검증 중…';
    case 'staging':
      return '설치 준비 중…';
    case 'applying':
      return '설치 후 재시작합니다…';
    default:
      return '';
  }
}

const inProgress = (s: SelfUpdateState): boolean =>
  s.phase === 'downloading' ||
  s.phase === 'verifying' ||
  s.phase === 'staging' ||
  s.phase === 'applying';

/** Determinate download percent (0–100), or null for the indeterminate phases. */
function downloadPercent(s: SelfUpdateState): number | null {
  if (s.phase !== 'downloading' || !s.totalBytes) return null;
  return Math.min(100, Math.floor(((s.receivedBytes ?? 0) / s.totalBytes) * 100));
}

/** Props for the inline update progress/error shown on the RIGHT of the status bar. */
export interface UpdateProgressInlineProps {
  readonly applyState: SelfUpdateState;
  readonly latestVersion: string | null;
  readonly releaseUrl: string | null;
  readonly onOpen: (url: string | null) => void;
  /** Dismiss after an error (clears the bar). */
  readonly onDismiss: () => void;
}

/**
 * The active-update display that lives on the RIGHT of the bottom status bar: a mango loading
 * bar + phase text while downloading/verifying/installing, or an error with a What's-new /
 * dismiss. Renders nothing when idle (the status bar's right side is then empty).
 */
export function UpdateProgressInline({
  applyState,
  latestVersion,
  releaseUrl,
  onOpen,
  onDismiss,
}: UpdateProgressInlineProps): React.JSX.Element | null {
  if (applyState.phase === 'error') {
    return (
      <span className="update-inline">
        <span data-testid="update-error" className="update-bar__err">
          업데이트 실패: {applyState.reason}
        </span>
        {releaseUrl && (
          <button
            type="button"
            className="update-icon"
            data-testid="update-notes"
            title="What's new"
            onClick={() => onOpen(releaseUrl)}
          >
            ✦
          </button>
        )}
        <button
          type="button"
          className="update-icon update-icon--ghost"
          data-testid="update-dismiss"
          title="닫기"
          onClick={onDismiss}
        >
          ✕
        </button>
      </span>
    );
  }
  if (!inProgress(applyState)) return null;
  const pct = downloadPercent(applyState);
  return (
    <span className="update-inline" data-testid="update-progress">
      {latestVersion && <span className="update-bar__muted">v{latestVersion}</span>}
      <div className="update-bar__track">
        <div
          className={`update-bar__fill${pct === null ? ' update-bar__fill--indeterminate' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <span>{phaseLabel(applyState)}</span>
    </span>
  );
}

/**
 * The bottom-right notification CARD shown when a strictly-newer stable release is available
 * and not dismissed (and no update is in flight — once started, the progress shows in the
 * status bar). A single primary [지금 업데이트] (one-click download + verify + swap + restart)
 * plus a small What's-new icon. Presentational — side-effects are injected by App.
 */
export function UpdateBanner({
  status,
  dismissedVersion,
  onDismiss,
  onOpen,
  applyState,
  onUpdate,
}: UpdateBannerProps): React.JSX.Element | null {
  if (!status?.updateAvailable || !status.latestVersion) return null;
  if (inProgress(applyState) || applyState.phase === 'error') return null; // shown in the status bar
  const { latestVersion, currentVersion, dmgUrl, releaseUrl } = status;
  if (latestVersion === dismissedVersion) return null;
  const canOneClick = Boolean(dmgUrl && status.sha256);

  return (
    <div className="update-card" data-testid="update-banner">
      <div className="update-card__head">
        <span className="update-dot" />
        <span className="update-card__title">업데이트 가능</span>
        <button
          type="button"
          className="update-icon update-icon--ghost"
          data-testid="update-dismiss"
          title="나중에"
          style={{ marginLeft: 'auto', width: 24, height: 22 }}
          onClick={() => onDismiss(latestVersion)}
        >
          ✕
        </button>
      </div>
      <div className="update-card__msg">
        MangoLove IDEA <strong>v{latestVersion}</strong>
        <div className="update-card__sub">현재 v{currentVersion}</div>
      </div>
      <div className="update-card__actions">
        {releaseUrl && (
          <button
            type="button"
            className="update-icon"
            data-testid="update-notes"
            title="What's new"
            onClick={() => onOpen(releaseUrl)}
          >
            ✦
          </button>
        )}
        {canOneClick && (
          <button
            type="button"
            className="update-primary"
            data-testid="update-now"
            onClick={onUpdate}
          >
            지금 업데이트
          </button>
        )}
      </div>
    </div>
  );
}
