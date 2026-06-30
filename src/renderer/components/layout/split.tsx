import { useCallback, useEffect, useRef } from 'react';
import { clampSplitPx, clampSplitFraction } from './split-math';

/** The gutter's main-axis size in px — MUST match .split-gutter-x/.split-gutter-y in theme.css. */
const GUTTER_PX = 6;

export interface SplitProps {
  /** 'x' = side-by-side panes with a VERTICAL gutter; 'y' = stacked panes with a HORIZONTAL gutter. */
  readonly axis: 'x' | 'y';
  /** How `size` is interpreted: 'px' (first pane fixed px) or 'fraction' (first pane 0..1 of container). */
  readonly unit: 'px' | 'fraction';
  /** First-pane size (px or fraction). Controlled by the parent (the pane-layout hook). */
  readonly size: number;
  /** Bounds for `size` (px for unit 'px', fraction for unit 'fraction'). */
  readonly min: number;
  readonly max: number;
  /** Absolute px floor for the first pane (fraction unit only). */
  readonly minFirstPx?: number;
  /** Absolute px floor for the second pane. */
  readonly minSecondPx?: number;
  /** Double-click-to-reset target. */
  readonly defaultSize: number;
  /** Live size during drag / re-clamp — NOT persisted. */
  readonly onResize: (size: number) => void;
  /** Drag-end size — persisted (only when it changed). */
  readonly onResizeEnd: (size: number) => void;
  readonly label: string;
  readonly testId?: string;
  readonly first: React.ReactNode;
  readonly second: React.ReactNode;
}

/**
 * A two-pane splitter with a draggable gutter (A2d). Generic over axis + unit so the workspace
 * can nest four of them. Controlled: the parent owns `size`; the gutter calls onResize live and
 * onResizeEnd once on drag-end (only if the size changed — SETTINGS_SET is heavyweight). The
 * drag is scoped to its pointerId, recovers from a dropped capture, and a ResizeObserver re-clamps
 * the size to the live container (window resize / a parent split drag) without persisting.
 */
export function Split(props: SplitProps): React.JSX.Element {
  const { axis, unit, size, min, max, minFirstPx = 0, minSecondPx = 0, defaultSize } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; start: number } | null>(null);

  // Refs mirror the changing inputs so the ResizeObserver effect can run ONCE (mount) without
  // tearing down/recreating the observer on every drag tick.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const cfgRef = useRef({ axis, unit, min, max, minFirstPx, minSecondPx });
  cfgRef.current = { axis, unit, min, max, minFirstPx, minSecondPx };
  const onResizeRef = useRef(props.onResize);
  onResizeRef.current = props.onResize;

  const sizeFromPointer = useCallback(
    (clientX: number, clientY: number): number => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return sizeRef.current;
      const span = axis === 'x' ? rect.width : rect.height;
      const offset = axis === 'x' ? clientX - rect.left : clientY - rect.top;
      return unit === 'px'
        ? clampSplitPx(offset, span, min, max, minSecondPx, GUTTER_PX)
        : clampSplitFraction(offset, span, min, max, minFirstPx, minSecondPx, GUTTER_PX);
    },
    [axis, unit, min, max, minFirstPx, minSecondPx],
  );

  // Re-clamp to the live container on mount + container resize (display-only, never persisted).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (drag.current) return;
      const rect = el.getBoundingClientRect();
      const c = cfgRef.current;
      const span = c.axis === 'x' ? rect.width : rect.height;
      if (span <= 0) return;
      const cur = sizeRef.current;
      const clamped =
        c.unit === 'px'
          ? clampSplitPx(cur, span, c.min, c.max, c.minSecondPx, GUTTER_PX)
          : clampSplitFraction(
              cur * Math.max(1, span - GUTTER_PX),
              span,
              c.min,
              c.max,
              c.minFirstPx,
              c.minSecondPx,
              GUTTER_PX,
            );
      const eps = c.unit === 'px' ? 0.5 : 0.002;
      if (Math.abs(clamped - cur) > eps) onResizeRef.current(clamped);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onPointerDown = (e: React.PointerEvent): void => {
    drag.current = { pointerId: e.pointerId, start: sizeRef.current };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const finish = (e: React.PointerEvent): void => {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (sizeRef.current !== active.start) props.onResizeEnd(sizeRef.current);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    if (e.buttons === 0) {
      finish(e);
      return;
    }
    props.onResize(sizeFromPointer(e.clientX, e.clientY));
  };
  const onDoubleClick = (): void => {
    props.onResize(defaultSize);
    props.onResizeEnd(defaultSize);
  };

  const firstStyle: React.CSSProperties =
    unit === 'px'
      ? axis === 'x'
        ? { flex: `0 0 ${size}px`, minWidth: 0, display: 'flex', flexDirection: 'column' }
        : { flex: `0 0 ${size}px`, minHeight: 0, display: 'flex', flexDirection: 'column' }
      : {
          flex: `${size} 1 0`,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        };
  const secondStyle: React.CSSProperties =
    unit === 'px'
      ? { flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
      : {
          flex: `${1 - size} 1 0`,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        };

  return (
    <div
      ref={containerRef}
      className={axis === 'x' ? 'split split-x' : 'split split-y'}
      style={{
        display: 'flex',
        flexDirection: axis === 'x' ? 'row' : 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
      }}
    >
      <div style={firstStyle}>{props.first}</div>
      <div
        className={axis === 'x' ? 'split-gutter split-gutter-x' : 'split-gutter split-gutter-y'}
        role="separator"
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        aria-label={props.label}
        title={props.label}
        data-testid={props.testId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={onDoubleClick}
      />
      <div style={secondStyle}>{props.second}</div>
    </div>
  );
}
