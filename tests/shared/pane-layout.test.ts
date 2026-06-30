import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PANE_LAYOUT,
  PANE_BOUNDS,
  clampPaneLayout,
  coercePaneLayout,
} from '../../src/shared/pane-layout';

const FULL = { topRowFraction: 0.5, topLeftWidth: 300, bottomLeftWidth: 280, repoFraction: 0.3 };

describe('clampPaneLayout', () => {
  it('passes an in-range layout through unchanged', () => {
    expect(clampPaneLayout(FULL)).toEqual(FULL);
  });

  it('clamps widths to [minWidth, maxWidth] (both columns independently)', () => {
    const c = clampPaneLayout({ ...FULL, topLeftWidth: 0, bottomLeftWidth: 99999 });
    expect(c.topLeftWidth).toBe(PANE_BOUNDS.minWidth);
    expect(c.bottomLeftWidth).toBe(PANE_BOUNDS.maxWidth);
  });

  it('clamps the row + repo fractions to their bounds', () => {
    expect(clampPaneLayout({ ...FULL, topRowFraction: 0.99 }).topRowFraction).toBe(
      PANE_BOUNDS.maxRowFraction,
    );
    expect(clampPaneLayout({ ...FULL, topRowFraction: 0 }).topRowFraction).toBe(
      PANE_BOUNDS.minRowFraction,
    );
    expect(clampPaneLayout({ ...FULL, repoFraction: 0.99 }).repoFraction).toBe(
      PANE_BOUNDS.maxRepoFraction,
    );
    expect(clampPaneLayout({ ...FULL, repoFraction: 0 }).repoFraction).toBe(
      PANE_BOUNDS.minRepoFraction,
    );
  });

  it('the default layout is itself within bounds (idempotent under clamp)', () => {
    expect(clampPaneLayout(DEFAULT_PANE_LAYOUT)).toEqual(DEFAULT_PANE_LAYOUT);
  });
});

describe('coercePaneLayout', () => {
  it('accepts + clamps a full 4-field object', () => {
    expect(coercePaneLayout({ ...FULL, topLeftWidth: 9999 })).toEqual({
      ...FULL,
      topLeftWidth: PANE_BOUNDS.maxWidth,
    });
  });

  it('fills missing/invalid fields of a recognizable new-shape object from defaults', () => {
    expect(coercePaneLayout({ topLeftWidth: 300, repoFraction: 'x' })).toEqual({
      topRowFraction: DEFAULT_PANE_LAYOUT.topRowFraction,
      topLeftWidth: 300,
      bottomLeftWidth: DEFAULT_PANE_LAYOUT.bottomLeftWidth,
      repoFraction: DEFAULT_PANE_LAYOUT.repoFraction,
    });
  });

  it('MIGRATES the legacy {leftColWidth, topRowFraction(fr)} shape', () => {
    // fr 1.25 -> fraction 1.25/2.25 = 0.5556; single width -> both columns; repoFraction default.
    const migrated = coercePaneLayout({ leftColWidth: 320, topRowFraction: 1.25 });
    expect(migrated).toEqual({
      topRowFraction: 1.25 / 2.25,
      topLeftWidth: 320,
      bottomLeftWidth: 320,
      repoFraction: DEFAULT_PANE_LAYOUT.repoFraction,
    });
  });

  it('clamps a migrated legacy value that is out of range', () => {
    const migrated = coercePaneLayout({ leftColWidth: 9999, topRowFraction: 0.01 });
    expect(migrated!.topLeftWidth).toBe(PANE_BOUNDS.maxWidth);
    expect(migrated!.bottomLeftWidth).toBe(PANE_BOUNDS.maxWidth);
    // fr 0.01 -> fraction ~0.0099 -> clamped to minRowFraction
    expect(migrated!.topRowFraction).toBe(PANE_BOUNDS.minRowFraction);
  });

  it('returns undefined for a non-object or a shape with no valid numeric field', () => {
    expect(coercePaneLayout('nope')).toBeUndefined();
    expect(coercePaneLayout(null)).toBeUndefined();
    expect(coercePaneLayout({})).toBeUndefined();
    expect(coercePaneLayout({ topLeftWidth: 'x', repoFraction: 'y' })).toBeUndefined();
  });
});
