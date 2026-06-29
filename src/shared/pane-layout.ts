import type { PaneLayout } from './types';

/**
 * Shared geometry + clamp for the 2x2 workspace splitters (A2c). This is the SINGLE
 * source of truth for the splitter bounds: the main-process SettingsStore sanitizer
 * (read + write) and the renderer drag handlers both import from here, so a value that
 * is valid on one side is valid on the other (boundary coherence — no pane can be
 * collapsed by a hand-edited settings.json or an off-by-one in the drag math).
 */

/** The CSS-default geometry used when `paneLayout` is unset (mirrors theme.css). */
export const DEFAULT_PANE_LAYOUT: PaneLayout = { leftColWidth: 264, topRowFraction: 1.25 };

/** Inclusive clamp bounds. leftColWidth in px; topRowFraction is the top:bottom ratio (bottom=1fr). */
export const PANE_BOUNDS = {
  minWidth: 160,
  maxWidth: 640,
  minFraction: 0.25,
  maxFraction: 4,
} as const;

/** Clamps n into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Clamps both fields into their safe ranges. Callers MUST have already verified the
 * inputs are finite numbers (the sanitizer rejects non-numbers before clamping) — a
 * NaN would clamp to NaN here, so this never sees one.
 */
export function clampPaneLayout(layout: PaneLayout): PaneLayout {
  return {
    leftColWidth: clamp(layout.leftColWidth, PANE_BOUNDS.minWidth, PANE_BOUNDS.maxWidth),
    topRowFraction: clamp(layout.topRowFraction, PANE_BOUNDS.minFraction, PANE_BOUNDS.maxFraction),
  };
}
