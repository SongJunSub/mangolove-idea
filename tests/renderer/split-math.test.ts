import { describe, it, expect } from 'vitest';
import { clampSplitPx, clampSplitFraction } from '../../src/renderer/components/layout/split-math';

describe('clampSplitPx', () => {
  it('returns the offset when in range', () => {
    expect(clampSplitPx(300, 1200, 160, 640, 240)).toBe(300);
  });
  it('clamps to min', () => {
    expect(clampSplitPx(10, 1200, 160, 640, 240)).toBe(160);
  });
  it('clamps to max', () => {
    expect(clampSplitPx(9999, 1200, 160, 640, 240)).toBe(640);
  });
  it('caps so the second pane keeps minSecondPx on a narrow container', () => {
    // container 400, minSecond 240 -> dynamic max 160
    expect(clampSplitPx(9999, 400, 160, 640, 240)).toBe(160);
  });
});

describe('clampSplitFraction', () => {
  it('maps an offset to its fraction when in range', () => {
    expect(clampSplitFraction(500, 1000, 0.15, 0.85, 100, 100)).toBeCloseTo(0.5, 5);
  });
  it('clamps to the max fraction bound', () => {
    expect(clampSplitFraction(990, 1000, 0.15, 0.85, 100, 100)).toBe(0.85);
  });
  it('clamps to the min fraction bound', () => {
    expect(clampSplitFraction(10, 1000, 0.15, 0.85, 100, 100)).toBe(0.15);
  });
  it('enforces the first-pane px floor on a short container', () => {
    // container 300, minFirst 160 -> lo = max(0.15, 0.533) = 0.533
    expect(clampSplitFraction(0, 300, 0.15, 0.85, 160, 120)).toBeCloseTo(160 / 300, 5);
  });
  it('enforces the second-pane px floor on a short container', () => {
    // container 300, minSecond 120 -> hi = min(0.85, 1-0.4) = 0.6
    expect(clampSplitFraction(9999, 300, 0.15, 0.85, 160, 120)).toBeCloseTo(0.6, 5);
  });
  it('falls back to the mid of [min,max] for an unmeasured (0) container', () => {
    expect(clampSplitFraction(0, 0, 0.15, 0.85, 100, 100)).toBe(0.5);
  });

  it('measures the fraction against (container - gutter) so the divider tracks the cursor', () => {
    // 6px gutter: panes share 994px, so an offset of 497 is the true midpoint (0.5), not 0.497.
    expect(clampSplitFraction(497, 1000, 0.15, 0.85, 0, 0, 6)).toBeCloseTo(0.5, 5);
  });
});

describe('clampSplitPx with a gutter', () => {
  it('reserves the gutter when capping for the second pane', () => {
    // container 1000, gutter 6, minSecond 240 -> dynamic max = 754
    expect(clampSplitPx(9999, 1000, 160, 999, 240, 6)).toBe(754);
  });
});
