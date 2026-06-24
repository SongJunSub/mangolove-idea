import { useState } from 'react';
import type { GhBucket, GhStatus } from '../../../shared/types';

/** Per-bucket glyph + color for a check row (mirrors the summary-line idiom). */
const BUCKET_MARK: Record<GhBucket, string> = {
  pass: '✓',
  fail: '✗',
  pending: '…',
  skipping: '⊘',
  cancel: '⊘',
};
const BUCKET_COLOR: Record<GhBucket, string> = {
  pass: 'var(--ok)',
  fail: 'var(--err)',
  pending: 'var(--warn)',
  skipping: 'var(--muted)',
  cancel: 'var(--err)',
};

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
      return { label: 'PR: gh CLI not installed', color: 'var(--muted)' };
    case 'not-authed':
      return { label: 'PR: gh not signed in (run gh auth login)', color: 'var(--muted)' };
    case 'no-remote':
      return { label: 'PR: not a GitHub repo', color: 'var(--muted)' };
    case 'not-pushed':
      return { label: 'PR: branch not pushed', color: 'var(--muted)' };
    case 'no-pr':
      return { label: 'PR: none yet', color: 'var(--muted)' };
    case 'rate-limited':
      return { label: 'PR: GitHub rate limit — try again later', color: 'var(--warn)' };
    case 'error':
      return { label: `PR: ${status.message}`, color: 'var(--err)' };
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
          ? 'var(--err)'
          : status.ci.summary === 'pending'
            ? 'var(--warn)'
            : 'var(--muted)';
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
  const [expanded, setExpanded] = useState(false);
  if (!selectedId) {
    return (
      <div data-testid="gh-status" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>PR: select a worktree</span>
      </div>
    );
  }
  const line = error
    ? { label: `PR: ${error}`, color: 'var(--err)' }
    : loading || !status
      ? { label: 'PR: loading…', color: 'var(--muted)' }
      : describe(status);
  const openPr = status && status.kind === 'open-pr' ? status.pr : null;
  const checks = status && status.kind === 'open-pr' ? status.ci.checks : [];

  return (
    <div data-testid="gh-status" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span data-testid="gh-status-line" style={{ fontSize: 11, color: line.color }}>
          {line.label}
        </span>
        {openPr && (
          <button type="button" data-testid="gh-open" onClick={() => onOpen(openPr.url)}>
            Open in browser
          </button>
        )}
        {checks.length > 0 && (
          <button
            type="button"
            data-testid="gh-checks-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '▾' : '▸'} Checks ({checks.length})
          </button>
        )}
        <button
          type="button"
          data-testid="gh-refresh"
          disabled={loading}
          onClick={() => onRefresh()}
        >
          Refresh
        </button>
      </div>
      {expanded && checks.length > 0 && (
        <ul
          data-testid="gh-checks"
          style={{ listStyle: 'none', margin: 0, paddingLeft: 12, fontSize: 11 }}
        >
          {checks.map((c, i) => (
            <li key={`${c.name}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: BUCKET_COLOR[c.bucket] }} title={c.bucket}>
                {BUCKET_MARK[c.bucket]}
              </span>
              <span style={{ flex: 1 }}>{c.name}</span>
              {c.link && (
                <button
                  type="button"
                  data-testid={`gh-check-open-${c.name}`}
                  onClick={() => onOpen(c.link)}
                >
                  open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
