import type { GhStatus } from '../../../shared/types';

export interface GhStatusPanelProps {
  readonly selectedId: string | null;
  readonly status: GhStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  onRefresh(): void;
  onOpen(url: string): void;
}

/** Maps a GhStatus to a calm one-line label + a severity color. */
function describe(status: GhStatus): { label: string; color: string } {
  switch (status.kind) {
    case 'gh-missing':
      return { label: 'PR: gh CLI not installed', color: '#888' };
    case 'not-authed':
      return { label: 'PR: gh not signed in (run gh auth login)', color: '#888' };
    case 'no-remote':
      return { label: 'PR: not a GitHub repo', color: '#888' };
    case 'not-pushed':
      return { label: 'PR: branch not pushed', color: '#888' };
    case 'no-pr':
      return { label: 'PR: none yet', color: '#888' };
    case 'rate-limited':
      return { label: 'PR: GitHub rate limit — try again later', color: '#e0a030' };
    case 'error':
      return { label: `PR: ${status.message}`, color: 'crimson' };
    case 'open-pr': {
      const draft = status.pr.isDraft ? ' (draft)' : '';
      const ci =
        status.ci.summary === 'failing'
          ? 'CI ✗'
          : status.ci.summary === 'pending'
            ? 'CI …'
            : status.ci.summary === 'passing'
              ? 'CI ✓'
              : 'CI —';
      const color =
        status.ci.summary === 'failing'
          ? 'crimson'
          : status.ci.summary === 'pending'
            ? '#e0a030'
            : '#888';
      return {
        label: `PR #${status.pr.number} ${status.pr.state}${draft} · ${ci} · ${status.pr.title}`,
        color,
      };
    }
  }
}

/**
 * Read-only PR/CI status line for the selected worktree. Mirrors MergeControls'
 * structure + color idiom. "Open in browser" shows ONLY for an open-pr; every other
 * kind is a calm neutral state (no toast, no console spam) — no-pr/not-pushed are the
 * COMMON path here.
 */
export function GhStatusPanel({
  selectedId,
  status,
  loading,
  error,
  onRefresh,
  onOpen,
}: GhStatusPanelProps): React.JSX.Element {
  if (!selectedId) {
    return (
      <div data-testid="gh-status" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#888' }}>PR: select a worktree</span>
      </div>
    );
  }
  const line = error
    ? { label: `PR: ${error}`, color: 'crimson' }
    : loading || !status
      ? { label: 'PR: loading…', color: '#888' }
      : describe(status);
  const openPr = status && status.kind === 'open-pr' ? status.pr : null;

  return (
    <div data-testid="gh-status" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span data-testid="gh-status-line" style={{ fontSize: 11, color: line.color }}>
        {line.label}
      </span>
      {openPr && (
        <button type="button" data-testid="gh-open" onClick={() => onOpen(openPr.url)}>
          Open in browser
        </button>
      )}
      <button type="button" data-testid="gh-refresh" disabled={loading} onClick={() => onRefresh()}>
        Refresh
      </button>
    </div>
  );
}
