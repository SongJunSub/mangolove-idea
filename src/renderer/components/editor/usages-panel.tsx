import { useMemo } from 'react';
import type { UsageLocation } from '../../lib/code-nav/find-usages';

/**
 * Persistent find-usages panel: the results of collectUsages() grouped by file, each row
 * navigating to that location through App's dirty-guarded open. A standing alternative to
 * monaco's transient inline Shift+F12 peek (which is kept too). Pure/presentational so it
 * unit-tests without monaco.
 */
export interface UsagesPanelProps {
  readonly usages: readonly UsageLocation[];
  readonly loading: boolean;
  onOpen(relPath: string, line: number, column: number): void;
}

export function UsagesPanel({ usages, loading, onOpen }: UsagesPanelProps): React.JSX.Element {
  // Group by file, preserving first-seen order. Memoized so a re-render with a stable
  // `usages` reference (e.g. unrelated parent state) doesn't rebuild the Map. Hook runs
  // before the early returns to keep hook order stable.
  const groups = useMemo(() => {
    const m = new Map<string, UsageLocation[]>();
    for (const u of usages) {
      const arr = m.get(u.relPath);
      if (arr) arr.push(u);
      else m.set(u.relPath, [u]);
    }
    return m;
  }, [usages]);

  if (loading) {
    return (
      <div
        className="pane-placeholder"
        data-testid="usages-loading"
        style={{ color: 'var(--muted)' }}
      >
        Finding usages…
      </div>
    );
  }
  if (usages.length === 0) {
    return (
      <div
        className="pane-placeholder"
        data-testid="usages-empty"
        style={{ color: 'var(--muted)' }}
      >
        No usages found. Place the cursor on a symbol and run “Find All Usages”.
      </div>
    );
  }

  return (
    <div
      data-testid="usages-panel"
      style={{ overflowY: 'auto', height: 460, flexShrink: 0, fontSize: 13 }}
    >
      <div data-testid="usages-count" style={{ padding: '4px 6px', color: 'var(--muted)' }}>
        {usages.length} usage(s) in {groups.size} file(s)
      </div>
      {[...groups.entries()].map(([relPath, locs]) => (
        <div key={relPath}>
          <div
            style={{
              padding: '4px 6px',
              color: 'var(--text)',
              fontWeight: 600,
              borderTop: '1px solid var(--border)',
            }}
          >
            {relPath}
          </div>
          {locs.map((u, i) => (
            <button
              key={`${u.line}:${u.column}:${i}`}
              type="button"
              data-testid="usage-row"
              onClick={() => onOpen(u.relPath, u.line, u.column)}
              style={{
                display: 'flex',
                gap: 8,
                width: '100%',
                textAlign: 'left',
                padding: '2px 6px 2px 18px',
                background: 'transparent',
                color: 'var(--text)',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'ui-monospace, Menlo, monospace',
              }}
            >
              <span style={{ color: 'var(--muted)', minWidth: 56 }}>
                {u.line}:{u.column}
              </span>
              <span style={{ whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {u.preview || '…'}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
