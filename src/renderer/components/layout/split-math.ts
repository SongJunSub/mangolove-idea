/**
 * Pure clamp math for the reusable <Split> (A2d) — no DOM, unit-tested directly. Shared by the
 * drag handler (pointer offset -> size) and the ResizeObserver re-clamp (stored size -> fitted
 * size), so a value valid during a drag stays valid after the container resizes.
 */

/**
 * First-pane PX size from an offset within the container, clamped to [min, max] AND capped so
 * the SECOND pane keeps at least `minSecondPx` (after the `gutterPx` divider). On a container
 * too small to honor both, `min` wins (the first pane stays usable).
 */
export function clampSplitPx(
  offset: number,
  containerSize: number,
  min: number,
  max: number,
  minSecondPx: number,
  gutterPx = 0,
): number {
  const dynamicMax = Math.max(min, Math.min(max, containerSize - gutterPx - minSecondPx));
  return Math.max(min, Math.min(offset, dynamicMax));
}

/**
 * First-pane FRACTION (0..1) from an offset within the container, clamped to [min, max] AND to
 * absolute px floors so NEITHER pane collapses: first keeps `minFirstPx`, second keeps
 * `minSecondPx`. The panes share `containerSize - gutterPx` (the gutter is flex:none), so the
 * fraction is measured against that track — without subtracting the gutter the rendered divider
 * sits a few px off the cursor and the persisted fraction is biased. On a container too small to
 * honor both floors, the first-pane floor wins. A non-positive size falls back to mid of [min, max].
 */
export function clampSplitFraction(
  offset: number,
  containerSize: number,
  min: number,
  max: number,
  minFirstPx: number,
  minSecondPx: number,
  gutterPx = 0,
): number {
  if (containerSize <= 0) return Math.min(max, Math.max(min, 0.5));
  const track = Math.max(1, containerSize - gutterPx);
  const lo = Math.max(min, minFirstPx / track);
  const hi = Math.min(max, 1 - minSecondPx / track);
  const pos = offset / track;
  return Math.min(Math.max(pos, lo), Math.max(lo, hi));
}
