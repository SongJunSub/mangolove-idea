import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaneLayout } from '../../shared/types';
import { DEFAULT_PANE_LAYOUT, PANE_BOUNDS, clampPaneLayout } from '../../shared/pane-layout';

/** Keep the editor/terminal column at least this wide (px) — drag AND load/resize re-clamp. */
const MIN_MAIN_COL = 240;
/** Keep the top-left cell (RepoList + Project head + a few file-tree rows) usable (px). */
const MIN_TOP_PX = 160;
/** Keep the bottom-left/right cells (worktree head + terminal) usable (px). */
const MIN_BOTTOM_PX = 120;

/** Clamps a left-column width (px) to the shared bounds AND the dynamic "keep main >=240px" cap. */
export function clampColWidth(width: number, rectWidth: number): number {
  const dynamicMax = Math.max(
    PANE_BOUNDS.minWidth,
    Math.min(PANE_BOUNDS.maxWidth, rectWidth - MIN_MAIN_COL),
  );
  return Math.max(PANE_BOUNDS.minWidth, Math.min(width, dynamicMax));
}

/**
 * Clamps a top-row fr ratio to the shared fraction bounds AND absolute-px floors so NEITHER
 * row collapses: the divider position (= top fraction of height) is confined so the top row
 * keeps >=MIN_TOP_PX and the bottom keeps >=MIN_BOTTOM_PX. On a window too short to honor both,
 * the top floor wins (the file tree must stay usable). rectHeight<=0 (unmeasured) => ratio only.
 */
export function clampTopFraction(fr: number, rectHeight: number): number {
  const ratioLoPos = PANE_BOUNDS.minFraction / (PANE_BOUNDS.minFraction + 1);
  const ratioHiPos = PANE_BOUNDS.maxFraction / (PANE_BOUNDS.maxFraction + 1);
  const loPos = rectHeight > 0 ? Math.max(ratioLoPos, MIN_TOP_PX / rectHeight) : ratioLoPos;
  const hiPos = rectHeight > 0 ? Math.min(ratioHiPos, 1 - MIN_BOTTOM_PX / rectHeight) : ratioHiPos;
  const pos = Math.min(Math.max(fr / (fr + 1), loPos), Math.max(loPos, hiPos));
  // Snap the derived ratio back onto the shared bounds — the pos<->fr round-trip introduces
  // float error (0.8/0.2 = 4.0000000000000001), and this keeps the value exactly in range.
  return Math.min(PANE_BOUNDS.maxFraction, Math.max(PANE_BOUNDS.minFraction, pos / (1 - pos)));
}

/** Pure drag math (no DOM): new left-column width px from a pointer's clientX + the workspace box. */
export function computeColWidth(clientX: number, rectLeft: number, rectWidth: number): number {
  return clampColWidth(clientX - rectLeft, rectWidth);
}

/** Pure drag math (no DOM): new top-row fr ratio from a pointer's clientY + the workspace box. */
export function computeTopFraction(clientY: number, rectTop: number, rectHeight: number): number {
  const pos = rectHeight <= 0 ? 0.5 : (clientY - rectTop) / rectHeight;
  const fr = pos >= 1 ? PANE_BOUNDS.maxFraction : pos / (1 - pos);
  return clampTopFraction(fr, rectHeight);
}

/** The horizontal handle's top offset (as a CSS % string) for a given top-row fr ratio. */
export function rowHandleTopPercent(topRowFraction: number): string {
  return `${(topRowFraction / (topRowFraction + 1)) * 100}%`;
}

/** Pointer/dblclick handlers spread onto one splitter handle element. */
export interface PaneSplitHandlers {
  onPointerDown(e: React.PointerEvent): void;
  onPointerMove(e: React.PointerEvent): void;
  onPointerUp(e: React.PointerEvent): void;
  onPointerCancel(e: React.PointerEvent): void;
  onLostPointerCapture(e: React.PointerEvent): void;
  onDoubleClick(): void;
}

export interface UsePaneLayout {
  readonly layout: PaneLayout;
  /** Inline style for the .workspace grid (drives both splitters). */
  readonly gridStyle: { gridTemplateColumns: string; gridTemplateRows: string };
  /** Attach to the .workspace element so a drag can measure its box. */
  readonly workspaceRef: React.RefObject<HTMLDivElement | null>;
  /** Handlers for the vertical (column-width) splitter handle. */
  readonly colHandlers: PaneSplitHandlers;
  /** Handlers for the horizontal (row-height) splitter handle. */
  readonly rowHandlers: PaneSplitHandlers;
  /** The horizontal handle's `top` offset (CSS %) — tracks topRowFraction. */
  readonly rowHandleTop: string;
}

/** A live drag: which axis, which pointer owns it, and the layout snapshot at pointer-down. */
interface ActiveDrag {
  readonly axis: 'col' | 'row';
  readonly pointerId: number;
  readonly start: PaneLayout;
}

/**
 * Live geometry + drag handling for the 2x2 workspace's two shared splitters (A2c). Holds the
 * layout in React state for smooth live dragging and persists ONLY on drag-end and ONLY when the
 * geometry actually changed (SETTINGS_SET is heavyweight — a no-op click or a double-click reset
 * must not write/teardown per gesture). The drag is scoped to the owning pointerId so a second
 * pointer can't hijack a handle. On mount + window resize the layout is re-clamped to the live
 * workspace box so a persisted size from a wider window can't squeeze the editor / collapse the
 * file tree. Adopts the persisted layout the first time it arrives from the async settings fetch.
 */
export function usePaneLayout(
  persisted: PaneLayout | undefined,
  save: (layout: PaneLayout) => void,
): UsePaneLayout {
  const [layout, setLayout] = useState<PaneLayout>(() =>
    persisted ? clampPaneLayout(persisted) : DEFAULT_PANE_LAYOUT,
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<ActiveDrag | null>(null);
  const adopted = useRef(persisted !== undefined);

  // The persisted layout arrives asynchronously (settings fetch on mount). Adopt it the FIRST
  // time it appears, unless the user is mid-drag (never clobber an active drag).
  useEffect(() => {
    if (adopted.current || drag.current || !persisted) return;
    adopted.current = true;
    setLayout(clampPaneLayout(persisted));
  }, [persisted]);

  // Re-clamp to the live workspace box on mount + window resize (no persist — this only ADAPTS
  // the display to the current window; the persisted value stays the user's preferred size).
  useEffect(() => {
    const reclamp = (): void => {
      if (drag.current) return;
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setLayout((l) => {
        const leftColWidth = clampColWidth(l.leftColWidth, rect.width);
        const topRowFraction = clampTopFraction(l.topRowFraction, rect.height);
        return leftColWidth === l.leftColWidth && topRowFraction === l.topRowFraction
          ? l
          : { leftColWidth, topRowFraction };
      });
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, []);

  const onDown = useCallback(
    (axis: 'col' | 'row') => (e: React.PointerEvent) => {
      drag.current = { axis, pointerId: e.pointerId, start: layoutRef.current };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    },
    [],
  );
  /** Ends a drag: release capture, persist ONLY if the geometry changed, then clear. */
  const finish = useCallback(
    (axis: 'col' | 'row', e: React.PointerEvent) => {
      const active = drag.current;
      if (!active || active.axis !== axis || active.pointerId !== e.pointerId) return;
      drag.current = null;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      const cur = layoutRef.current;
      if (
        cur.leftColWidth !== active.start.leftColWidth ||
        cur.topRowFraction !== active.start.topRowFraction
      )
        save(cur);
    },
    [save],
  );
  const onMove = useCallback(
    (axis: 'col' | 'row') => (e: React.PointerEvent) => {
      const active = drag.current;
      if (!active || active.axis !== axis || active.pointerId !== e.pointerId) return;
      // Button released without a pointerup/cancel reaching us (capture dropped): end the drag
      // here so a later no-button hover can't jump the divider — and still persist if it moved.
      if (e.buttons === 0) {
        finish(axis, e);
        return;
      }
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (axis === 'col') {
        const leftColWidth = computeColWidth(e.clientX, rect.left, rect.width);
        setLayout((l) => ({ ...l, leftColWidth }));
      } else {
        const topRowFraction = computeTopFraction(e.clientY, rect.top, rect.height);
        setLayout((l) => ({ ...l, topRowFraction }));
      }
    },
    [finish],
  );
  const onEnd = useCallback(
    (axis: 'col' | 'row') => (e: React.PointerEvent) => finish(axis, e),
    [finish],
  );
  const reset = useCallback(() => {
    setLayout(DEFAULT_PANE_LAYOUT);
    save(DEFAULT_PANE_LAYOUT);
  }, [save]);

  const handlersFor = (axis: 'col' | 'row'): PaneSplitHandlers => ({
    onPointerDown: onDown(axis),
    onPointerMove: onMove(axis),
    onPointerUp: onEnd(axis),
    onPointerCancel: onEnd(axis),
    onLostPointerCapture: onEnd(axis),
    onDoubleClick: reset,
  });

  return {
    layout,
    gridStyle: {
      gridTemplateColumns: `${layout.leftColWidth}px 1fr`,
      gridTemplateRows: `${layout.topRowFraction}fr 1fr`,
    },
    workspaceRef,
    colHandlers: handlersFor('col'),
    rowHandlers: handlersFor('row'),
    rowHandleTop: rowHandleTopPercent(layout.topRowFraction),
  };
}
