import type { PaneLayout } from './types';

/**
 * Shared geometry, clamp + legacy migration for the workspace's four independent splitters
 * (A2d). The SINGLE source of truth for the bounds: the main-process SettingsStore sanitizer
 * (read + write) and the renderer Split drag handlers both import from here, so a value that
 * is valid on one side is valid on the other (boundary coherence — no pane can be collapsed
 * by a hand-edited settings.json or an off-by-one in the drag math).
 */

/** The CSS-default geometry used when `paneLayout` is unset (mirrors theme.css). */
export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  topRowFraction: 0.56, // ~1.25:1 top:bottom (matches the legacy 1.25fr/1fr grid)
  topLeftWidth: 264,
  bottomLeftWidth: 264,
  repoFraction: 0.28, // repo list takes ~28% of the top-left column; file tree the rest
};

/** Inclusive clamp bounds. Widths in px; fractions are 0..1 shares of the container. */
export const PANE_BOUNDS = {
  minWidth: 160,
  maxWidth: 640,
  minRowFraction: 0.15,
  maxRowFraction: 0.85,
  minRepoFraction: 0.1,
  maxRepoFraction: 0.7,
} as const;

/** Clamps n into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A finite number, or undefined for anything else (NaN/Infinity/strings/etc.). */
function finiteOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Clamps every field into its safe range. Callers MUST have already verified the inputs are
 * finite numbers (coercePaneLayout does) — a NaN would clamp to NaN here, so this never sees one.
 */
export function clampPaneLayout(layout: PaneLayout): PaneLayout {
  return {
    topRowFraction: clamp(
      layout.topRowFraction,
      PANE_BOUNDS.minRowFraction,
      PANE_BOUNDS.maxRowFraction,
    ),
    topLeftWidth: clamp(layout.topLeftWidth, PANE_BOUNDS.minWidth, PANE_BOUNDS.maxWidth),
    bottomLeftWidth: clamp(layout.bottomLeftWidth, PANE_BOUNDS.minWidth, PANE_BOUNDS.maxWidth),
    repoFraction: clamp(
      layout.repoFraction,
      PANE_BOUNDS.minRepoFraction,
      PANE_BOUNDS.maxRepoFraction,
    ),
  };
}

/**
 * Projects an unknown (a persisted settings.json value) to a clamped PaneLayout, or undefined
 * when it is not a recognizable layout object. Handles BOTH the current 4-field shape AND the
 * legacy 2-field `{leftColWidth, topRowFraction(fr ratio)}` shape (v0.1.12), migrating the old
 * fr ratio to a 0..1 fraction and duplicating the single column width into both columns. A
 * recognizable-but-partial object has its missing/invalid fields filled from the defaults; an
 * object with NO valid numeric field at all => undefined (treated as unset -> CSS defaults).
 */
export function coercePaneLayout(raw: unknown): PaneLayout | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const isNewShape = 'topLeftWidth' in o || 'bottomLeftWidth' in o || 'repoFraction' in o;

  if (isNewShape) {
    const topLeftWidth = finiteOrUndef(o.topLeftWidth);
    const bottomLeftWidth = finiteOrUndef(o.bottomLeftWidth);
    const topRowFraction = finiteOrUndef(o.topRowFraction);
    const repoFraction = finiteOrUndef(o.repoFraction);
    if (
      topLeftWidth === undefined &&
      bottomLeftWidth === undefined &&
      topRowFraction === undefined &&
      repoFraction === undefined
    )
      return undefined;
    return clampPaneLayout({
      topRowFraction: topRowFraction ?? DEFAULT_PANE_LAYOUT.topRowFraction,
      topLeftWidth: topLeftWidth ?? DEFAULT_PANE_LAYOUT.topLeftWidth,
      bottomLeftWidth: bottomLeftWidth ?? DEFAULT_PANE_LAYOUT.bottomLeftWidth,
      repoFraction: repoFraction ?? DEFAULT_PANE_LAYOUT.repoFraction,
    });
  }

  // Legacy 2-field shape: { leftColWidth, topRowFraction } where topRowFraction was an fr ratio.
  const leftColWidth = finiteOrUndef(o.leftColWidth);
  const legacyFr = finiteOrUndef(o.topRowFraction);
  if (leftColWidth === undefined && legacyFr === undefined) return undefined;
  const width = leftColWidth ?? DEFAULT_PANE_LAYOUT.topLeftWidth;
  const fr = legacyFr ?? 1.25;
  return clampPaneLayout({
    topRowFraction: fr / (fr + 1), // fr ratio -> 0..1 fraction
    topLeftWidth: width,
    bottomLeftWidth: width,
    repoFraction: DEFAULT_PANE_LAYOUT.repoFraction,
  });
}
