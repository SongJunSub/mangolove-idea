import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePaneLayout } from '../../src/renderer/hooks/use-pane-layout';
import { DEFAULT_PANE_LAYOUT, PANE_BOUNDS } from '../../src/shared/pane-layout';

describe('usePaneLayout', () => {
  it('starts at the defaults when nothing is persisted', () => {
    const { result } = renderHook(() => usePaneLayout(undefined, vi.fn()));
    expect(result.current.layout).toEqual(DEFAULT_PANE_LAYOUT);
    expect(result.current.topLeft.size).toBe(DEFAULT_PANE_LAYOUT.topLeftWidth);
    expect(result.current.bottomLeft.size).toBe(DEFAULT_PANE_LAYOUT.bottomLeftWidth);
    expect(result.current.topRow.size).toBe(DEFAULT_PANE_LAYOUT.topRowFraction);
    expect(result.current.repo.size).toBe(DEFAULT_PANE_LAYOUT.repoFraction);
  });

  it('starts from the (clamped) persisted layout when present', () => {
    const { result } = renderHook(() =>
      usePaneLayout(
        { topRowFraction: 0.5, topLeftWidth: 9999, bottomLeftWidth: 280, repoFraction: 0.3 },
        vi.fn(),
      ),
    );
    expect(result.current.layout.topLeftWidth).toBe(PANE_BOUNDS.maxWidth);
    expect(result.current.layout.bottomLeftWidth).toBe(280);
  });

  it('onResize updates ONE field live without persisting', () => {
    const save = vi.fn();
    const { result } = renderHook(() => usePaneLayout(undefined, save));
    act(() => result.current.topLeft.onResize(320));
    expect(result.current.layout.topLeftWidth).toBe(320);
    expect(result.current.layout.bottomLeftWidth).toBe(DEFAULT_PANE_LAYOUT.bottomLeftWidth); // independent
    expect(save).not.toHaveBeenCalled();
  });

  it('the two column widths are INDEPENDENT (top vs bottom)', () => {
    const { result } = renderHook(() => usePaneLayout(undefined, vi.fn()));
    act(() => result.current.topLeft.onResize(400));
    act(() => result.current.bottomLeft.onResize(200));
    expect(result.current.layout.topLeftWidth).toBe(400);
    expect(result.current.layout.bottomLeftWidth).toBe(200);
  });

  it('onResizeEnd persists the FULL updated layout once', () => {
    const save = vi.fn();
    const { result } = renderHook(() => usePaneLayout(undefined, save));
    act(() => result.current.topRow.onResize(0.4));
    act(() => result.current.topRow.onResizeEnd(0.4));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...DEFAULT_PANE_LAYOUT, topRowFraction: 0.4 });
  });

  it('persists the dragged field on the BASELINE — a display-only re-clamp of another field never leaks', () => {
    const save = vi.fn();
    const baseline = {
      topRowFraction: 0.5,
      topLeftWidth: 300,
      bottomLeftWidth: 300,
      repoFraction: 0.5,
    };
    const { result } = renderHook(() => usePaneLayout(baseline, save));
    // A <Split> ResizeObserver re-clamps repoFraction down for DISPLAY (onResize, not onResizeEnd).
    act(() => result.current.repo.onResize(0.2));
    expect(result.current.layout.repoFraction).toBe(0.2); // display shrank
    // Drag-ending a DIFFERENT divider must persist repoFraction at its BASELINE 0.5, not 0.2.
    act(() => result.current.topLeft.onResizeEnd(360));
    expect(save).toHaveBeenCalledWith({
      topRowFraction: 0.5,
      topLeftWidth: 360,
      bottomLeftWidth: 300,
      repoFraction: 0.5,
    });
  });

  it('adopts the persisted layout the first time it arrives (async settings fetch)', () => {
    const target = {
      topRowFraction: 0.5,
      topLeftWidth: 300,
      bottomLeftWidth: 240,
      repoFraction: 0.3,
    };
    const { result, rerender } = renderHook(
      ({ p }: { p: typeof target | undefined }) => usePaneLayout(p, vi.fn()),
      { initialProps: { p: undefined as typeof target | undefined } },
    );
    expect(result.current.layout).toEqual(DEFAULT_PANE_LAYOUT);
    rerender({ p: target });
    expect(result.current.layout).toEqual(target);
  });
});
