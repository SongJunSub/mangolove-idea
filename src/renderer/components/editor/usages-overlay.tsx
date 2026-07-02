import { useEffect, useMemo, useRef, useState } from 'react';
import type { UsageLocation } from '../../lib/code-nav/find-usages';
import { useI18n } from '../../i18n/i18n-context';

/**
 * IntelliJ "Show Usages"-style FLOATING popup: a count header + a file-grouped list of usages,
 * fully keyboard-navigable (↑/↓ move the cursor, Enter opens, Esc closes) and dismissed by a
 * backdrop click. It floats OVER the editor (a top-level overlay), so it never hijacks the
 * terminal pane. App routes exactly-one-usage straight to navigation (this popup is for 0/2+).
 */
export interface UsagesOverlayProps {
  readonly usages: readonly UsageLocation[];
  readonly loading: boolean;
  /** Navigate to a usage (App's dirty-guarded, worktree-scoped open). */
  onOpen(relPath: string, line: number, column: number): void;
  onClose(): void;
}

type Row =
  | { readonly type: 'file'; readonly relPath: string }
  | { readonly type: 'usage'; readonly u: UsageLocation; readonly index: number };

export function UsagesOverlay({
  usages,
  loading,
  onOpen,
  onClose,
}: UsagesOverlayProps): React.JSX.Element {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const [active, setActive] = useState(0);
  // True while the last input was the keyboard: keyboard nav scrolls a row UNDER a stationary
  // cursor, which fires onMouseEnter and would otherwise hijack the cursor. A real mouse move clears it.
  const usingKbd = useRef(false);

  // Group by file (first-seen order) + a flat render list carrying each usage's keyboard index.
  const { groups, rows, flat } = useMemo(() => {
    const g = new Map<string, UsageLocation[]>();
    for (const u of usages) {
      const arr = g.get(u.relPath);
      if (arr) arr.push(u);
      else g.set(u.relPath, [u]);
    }
    const r: Row[] = [];
    const f: UsageLocation[] = [];
    for (const [relPath, locs] of g) {
      r.push({ type: 'file', relPath });
      for (const u of locs) {
        r.push({ type: 'usage', u, index: f.length });
        f.push(u);
      }
    }
    return { groups: g, rows: r, flat: f };
  }, [usages]);

  useEffect(() => {
    cardRef.current?.focus(); // so ↑/↓/Enter/Esc work immediately
  }, []);
  useEffect(() => {
    setActive(0); // reset the cursor when a new result set arrives
  }, [usages]);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const open = (u: UsageLocation): void => {
    onOpen(u.relPath, u.line, u.column);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab') {
      e.preventDefault(); // trap focus in the card (arrows navigate; Tab must not escape → dead keys)
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (!flat.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      usingKbd.current = true;
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      usingKbd.current = true;
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const u = flat[active];
      if (u) open(u);
    }
  };

  const header = loading
    ? t('usages.loading')
    : usages.length === 0
      ? t('usages.empty')
      : t('usages.count', { count: usages.length, files: groups.size });

  return (
    <div className="usages-backdrop" data-testid="usages-overlay" onMouseDown={onClose}>
      <div
        className="usages-card"
        role="dialog"
        aria-label={t('usages.title')}
        tabIndex={-1}
        ref={cardRef}
        onKeyDown={onKeyDown}
        onMouseMove={() => {
          usingKbd.current = false; // a real pointer move re-enables hover-to-activate
        }}
        onMouseDown={(e) => e.stopPropagation()} // a click INSIDE the card must not dismiss it
      >
        <div className="usages-card__head">
          <span data-testid="usages-count">{header}</span>
          <button
            type="button"
            className="usages-card__close"
            aria-label={t('usages.close')}
            data-testid="usages-close"
            onClick={onClose}
            onKeyDown={(e) => e.stopPropagation()} // Enter/Space/arrows act on the button, not the list
          >
            ×
          </button>
        </div>
        {!loading && usages.length > 0 && (
          <div className="usages-card__list">
            {rows.map((row) =>
              row.type === 'file' ? (
                <div className="usages-file" key={`f:${row.relPath}`}>
                  {row.relPath}
                </div>
              ) : (
                <button
                  key={`u:${row.u.relPath}:${row.u.line}:${row.u.column}:${row.index}`}
                  type="button"
                  data-testid="usage-row"
                  ref={row.index === active ? activeRowRef : undefined}
                  className={`usage-row${row.index === active ? ' usage-row--active' : ''}`}
                  onMouseEnter={() => {
                    if (!usingKbd.current) setActive(row.index); // don't let keyboard-scroll hijack the cursor
                  }}
                  onClick={() => open(row.u)}
                >
                  <span className="usage-row__loc">
                    {row.u.line}:{row.u.column}
                  </span>
                  <span className="usage-row__preview">{row.u.preview || '…'}</span>
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
