import { describe, it, expect } from 'vitest';
import { DEFAULT_PANE_LAYOUT, PANE_BOUNDS, clampPaneLayout } from '../../src/shared/pane-layout';

describe('clampPaneLayout', () => {
  it('passes through an in-range layout unchanged', () => {
    expect(clampPaneLayout({ leftColWidth: 300, topRowFraction: 1.5 })).toEqual({
      leftColWidth: 300,
      topRowFraction: 1.5,
    });
  });

  it('clamps width to [minWidth, maxWidth]', () => {
    expect(clampPaneLayout({ leftColWidth: 0, topRowFraction: 1 }).leftColWidth).toBe(
      PANE_BOUNDS.minWidth,
    );
    expect(clampPaneLayout({ leftColWidth: 99999, topRowFraction: 1 }).leftColWidth).toBe(
      PANE_BOUNDS.maxWidth,
    );
  });

  it('clamps fraction to [minFraction, maxFraction]', () => {
    expect(clampPaneLayout({ leftColWidth: 300, topRowFraction: 0 }).topRowFraction).toBe(
      PANE_BOUNDS.minFraction,
    );
    expect(clampPaneLayout({ leftColWidth: 300, topRowFraction: 100 }).topRowFraction).toBe(
      PANE_BOUNDS.maxFraction,
    );
  });

  it('the default layout is itself within bounds (idempotent under clamp)', () => {
    expect(clampPaneLayout(DEFAULT_PANE_LAYOUT)).toEqual(DEFAULT_PANE_LAYOUT);
  });
});
