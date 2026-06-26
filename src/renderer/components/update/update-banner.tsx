import type { UpdateStatus } from '../../../shared/types';

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
}

/**
 * A thin top bar shown ONLY when a strictly-newer stable release exists and the user has
 * not dismissed that exact version. The app is unsigned, so this never auto-installs — the
 * buttons open the release notes / the .dmg download in the OS browser (the user installs
 * manually). Presentational: side-effects (open/dismiss) are injected by App.
 */
export function UpdateBanner({
  status,
  dismissedVersion,
  onDismiss,
  onOpen,
}: UpdateBannerProps): React.JSX.Element | null {
  if (!status?.updateAvailable || !status.latestVersion) return null;
  if (status.latestVersion === dismissedVersion) return null;

  const { latestVersion, currentVersion, dmgUrl, releaseUrl } = status;
  const downloadUrl = dmgUrl ?? releaseUrl; // fall back to the release page if no .dmg asset

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
      <span>
        MangoLove IDEA <strong>v{latestVersion}</strong> 사용 가능{' '}
        <span style={{ color: 'var(--muted)' }}>(현재 v{currentVersion})</span>
      </span>
      <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
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
        <button type="button" data-testid="update-dismiss" onClick={() => onDismiss(latestVersion)}>
          나중에
        </button>
      </span>
    </div>
  );
}
