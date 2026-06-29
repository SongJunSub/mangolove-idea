import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePaneLayout,
  computeColWidth,
  computeTopFraction,
  rowHandleTopPercent,
} from '../../src/renderer/hooks/use-pane-layout';
import { DEFAULT_PANE_LAYOUT, PANE_BOUNDS } from '../../src/shared/pane-layout';

describe('computeColWidth (column splitter drag math)', () => {
  // A roomy workspace: left=0, width=1200 -> dynamic max = min(640, 1200-240)=640.
  it('returns the pointer offset from the left edge when in range', () => {
    expect(computeColWidth(300, 0, 1200)).toBe(300);
  });
  it('clamps to the shared minWidth', () => {
    expect(computeColWidth(10, 0, 1200)).toBe(PANE_BOUNDS.minWidth);
  });
  it('clamps to the shared maxWidth on a wide window', () => {
    expect(computeColWidth(9999, 0, 1200)).toBe(PANE_BOUNDS.maxWidth);
  });
  it('caps so the right column keeps >=240px on a narrow window', () => {
    // width=400 -> dynamic max = 400-240 = 160; a far-right drag stops at 160, not 640.
    expect(computeColWidth(9999, 0, 400)).toBe(160);
  });
  it('honors a non-zero left edge offset', () => {
    expect(computeColWidth(350, 50, 1200)).toBe(300);
  });
});

describe('computeTopFraction (row splitter drag math)', () => {
  // top=0, height=1000.
  it('maps a mid drag to its fr ratio (pos/(1-pos))', () => {
    // pos=0.5 -> fr=1.0
    expect(computeTopFraction(500, 0, 1000)).toBeCloseTo(1, 5);
  });
  it('clamps a high drag to maxFraction', () => {
    expect(computeTopFraction(990, 0, 1000)).toBe(PANE_BOUNDS.maxFraction);
  });
  it('clamps a low drag to minFraction', () => {
    expect(computeTopFraction(10, 0, 1000)).toBe(PANE_BOUNDS.minFraction);
  });
  it('guards divide-by-zero when height is 0 (treats as mid -> fr 1)', () => {
    expect(computeTopFraction(0, 0, 0)).toBeCloseTo(1, 5);
  });
  it('keeps the top row >= ~160px even on a short window (file tree never collapses)', () => {
    const fr = computeTopFraction(0, 0, 300); // drag to the very top
    const topPx = (fr / (fr + 1)) * 300;
    expect(topPx).toBeGreaterThanOrEqual(159.5);
  });
  it('keeps the bottom row >= ~120px even on a short window (terminal never collapses)', () => {
    const fr = computeTopFraction(99999, 0, 300); // drag to the very bottom
    const bottomPx = (1 - fr / (fr + 1)) * 300;
    expect(bottomPx).toBeGreaterThanOrEqual(119.5);
  });
});

describe('rowHandleTopPercent', () => {
  it('fr=1 sits at 50%', () => {
    expect(rowHandleTopPercent(1)).toBe('50%');
  });
  it('the default fr (1.25) sits at ~55.6%', () => {
    expect(rowHandleTopPercent(1.25)).toBe(`${(1.25 / 2.25) * 100}%`);
  });
});

describe('usePaneLayout', () => {
  it('starts at the CSS defaults when nothing is persisted', () => {
    const { result } = renderHook(() => usePaneLayout(undefined, vi.fn()));
    expect(result.current.layout).toEqual(DEFAULT_PANE_LAYOUT);
    expect(result.current.gridStyle).toEqual({
      gridTemplateColumns: '264px 1fr',
      gridTemplateRows: '1.25fr 1fr',
    });
  });

  it('starts from (clamped) persisted layout when present', () => {
    const { result } = renderHook(() =>
      usePaneLayout({ leftColWidth: 9999, topRowFraction: 2 }, vi.fn()),
    );
    expect(result.current.layout).toEqual({
      leftColWidth: PANE_BOUNDS.maxWidth,
      topRowFraction: 2,
    });
  });

  it('reset() restores defaults and persists them', () => {
    const save = vi.fn();
    const { result } = renderHook(() =>
      usePaneLayout({ leftColWidth: 320, topRowFraction: 2 }, save),
    );
    act(() => result.current.colHandlers.onDoubleClick());
    expect(result.current.layout).toEqual(DEFAULT_PANE_LAYOUT);
    expect(save).toHaveBeenCalledWith(DEFAULT_PANE_LAYOUT);
  });

  // A fake PointerEvent: capture methods are optional-chained in the hook, so stubs suffice.
  const evt = (
    over: Partial<{ pointerId: number; buttons: number; clientX: number; clientY: number }> = {},
  ) =>
    ({
      pointerId: 1,
      buttons: 1,
      clientX: 0,
      clientY: 0,
      currentTarget: {
        setPointerCapture: vi.fn(),
        hasPointerCapture: vi.fn(() => false),
        releasePointerCapture: vi.fn(),
      },
      preventDefault: vi.fn(),
      ...over,
    }) as unknown as React.PointerEvent;

  it('a click on a splitter without dragging does NOT persist (no heavyweight write)', () => {
    const save = vi.fn();
    const { result } = renderHook(() => usePaneLayout(undefined, save));
    act(() => result.current.colHandlers.onPointerDown(evt()));
    act(() => result.current.colHandlers.onPointerUp(evt()));
    expect(save).not.toHaveBeenCalled();
  });

  it('a drag that changes the layout persists exactly once on pointer-up', () => {
    const save = vi.fn();
    const { result } = renderHook(() => usePaneLayout(undefined, save));
    (result.current.workspaceRef as React.MutableRefObject<HTMLDivElement | null>).current = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 1000 }),
    } as unknown as HTMLDivElement;
    act(() => result.current.colHandlers.onPointerDown(evt()));
    act(() => result.current.colHandlers.onPointerMove(evt({ clientX: 400, buttons: 1 })));
    expect(result.current.layout.leftColWidth).toBe(400);
    act(() => result.current.colHandlers.onPointerUp(evt()));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      leftColWidth: 400,
      topRowFraction: DEFAULT_PANE_LAYOUT.topRowFraction,
    });
  });

  it('ignores pointer-move from a different pointerId (no hijack)', () => {
    const save = vi.fn();
    const { result } = renderHook(() => usePaneLayout(undefined, save));
    (result.current.workspaceRef as React.MutableRefObject<HTMLDivElement | null>).current = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 1000 }),
    } as unknown as HTMLDivElement;
    act(() => result.current.colHandlers.onPointerDown(evt({ pointerId: 1 })));
    act(() => result.current.colHandlers.onPointerMove(evt({ pointerId: 2, clientX: 400 })));
    expect(result.current.layout.leftColWidth).toBe(DEFAULT_PANE_LAYOUT.leftColWidth); // unchanged
  });

  it('adopts the persisted layout the first time it arrives (async settings fetch)', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: undefined | { leftColWidth: number; topRowFraction: number } }) =>
        usePaneLayout(p, vi.fn()),
      {
        initialProps: {
          p: undefined as undefined | { leftColWidth: number; topRowFraction: number },
        },
      },
    );
    expect(result.current.layout).toEqual(DEFAULT_PANE_LAYOUT);
    rerender({ p: { leftColWidth: 300, topRowFraction: 2 } });
    expect(result.current.layout).toEqual({ leftColWidth: 300, topRowFraction: 2 });
  });
});
