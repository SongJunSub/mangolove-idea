import type { UpdateStatus } from '../../../shared/types';
import type { SelfUpdateState } from '../../hooks/use-self-update';

/** Props for the update-available banner. */
export interface UpdateBannerProps {
  /** The latest update-check result, or null before the launch check resolves. */
  readonly status: UpdateStatus | null;
  /** The version the user already dismissed (settings.lastDismissedUpdateVersion). */
  readonly dismissedVersion: string | undefined;
  /** Persist a dismissal of `version` (the banner stays hidden until a newer release). */
  readonly onDismiss: (version: string) => void;
  /** Open a URL in the browser (App injects the github.com-pinned openExternal). */
  readonly onOpen: (url: string | null) => void;
  /** Live state of an in-flight one-click update (idle / progress / error). */
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

/**
 * A thin top bar shown ONLY when a strictly-newer stable release exists and the user has not
 * dismissed that exact version. The app is unsigned: [지금 업데이트] runs the one-click
 * download + sha256-verify + bundle-swap + restart; [다운로드] is the manual fallback (opens
 * the .dmg). Presentational — all side-effects are injected by App.
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
  if (status.latestVersion === dismissedVersion) return null;

  const { latestVersion, currentVersion, dmgUrl, releaseUrl } = status;
  const downloadUrl = dmgUrl ?? releaseUrl; // fall back to the release page if no .dmg asset
  // One-click is possible only with a .dmg AND a checksum to verify (unsigned => verify-or-bust).
  const canOneClick = Boolean(dmgUrl && status.sha256);

  return (
    <div
      data-testid="update-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 12px',
        fontSize: 12,
        background: 'var(--accent-soft, var(--surface))',
        color: 'var(--text)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {inProgress(applyState) ? (
        <span data-testid="update-progress">
          MangoLove IDEA <strong>v{latestVersion}</strong> — {phaseLabel(applyState)}
        </span>
      ) : applyState.phase === 'error' ? (
        <span data-testid="update-error" style={{ color: 'var(--warn, var(--text))' }}>
          업데이트 실패: {applyState.reason}
        </span>
      ) : (
        <span>
          MangoLove IDEA <strong>v{latestVersion}</strong> 사용 가능{' '}
          <span style={{ color: 'var(--muted)' }}>(현재 v{currentVersion})</span>
        </span>
      )}

      {!inProgress(applyState) && (
        <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
          {applyState.phase !== 'error' && canOneClick && (
            <button type="button" data-testid="update-now" onClick={onUpdate}>
              지금 업데이트
            </button>
          )}
          {releaseUrl && (
            <button type="button" data-testid="update-notes" onClick={() => onOpen(releaseUrl)}>
              What's new
            </button>
          )}
          {downloadUrl && (
            <button type="button" data-testid="update-download" onClick={() => onOpen(downloadUrl)}>
              다운로드
            </button>
          )}
          <button
            type="button"
            data-testid="update-dismiss"
            onClick={() => onDismiss(latestVersion)}
          >
            나중에
          </button>
        </span>
      )}
    </div>
  );
}
