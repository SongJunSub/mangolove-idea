import { useEffect, useRef, useState } from 'react';
import type { PaneLayout } from '../../shared/types';
import { DEFAULT_PANE_LAYOUT, clampPaneLayout } from '../../shared/pane-layout';

/** Controlled props the hook hands to one <Split>: live size + the two resize callbacks. */
export interface SplitControl {
  readonly size: number;
  readonly onResize: (size: number) => void;
  readonly onResizeEnd: (size: number) => void;
}

export interface UsePaneLayout {
  readonly layout: PaneLayout;
  /** ② top region height (fraction). */
  readonly topRow: SplitControl;
  /** ③ top-left (repos+tree) column width (px). */
  readonly topLeft: SplitControl;
  /** ④ bottom-left (worktree) column width (px). */
  readonly bottomLeft: SplitControl;
  /** ① repo-list height within the top-left column (fraction). */
  readonly repo: SplitControl;
}

/**
 * Owns the workspace's 4-field split geometry (A2d) and hands each <Split> a controlled
 * {size, onResize, onResizeEnd} triple. onResize updates live state (smooth drag, no write);
 * onResizeEnd updates AND persists the full layout once (the Split only fires it when the size
 * changed, so a no-op click never writes — SETTINGS_SET is heavyweight). Adopts the persisted
 * layout the first time it arrives from the async settings fetch. The per-divider clamps + the
 * ResizeObserver re-clamp live inside <Split>; this hook is pure state + persistence.
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
  // The user's PERSISTED baseline, distinct from the live `layout`. A <Split>'s ResizeObserver
  // re-clamps the LIVE layout (display-only) when its container shrinks; that ephemeral value
  // must NOT leak into settings.json. So a drag-end persists the dragged field on top of THIS
  // baseline (not the live layout), keeping every untouched field at the user's preferred size.
  const persistedRef = useRef(layout);
  const adopted = useRef(persisted !== undefined);

  // The persisted layout arrives asynchronously (settings fetch on mount). Adopt it the FIRST
  // time it appears (settings load completes at mount, before any drag) into BOTH the live
  // layout and the baseline.
  useEffect(() => {
    if (adopted.current || !persisted) return;
    adopted.current = true;
    const clamped = clampPaneLayout(persisted);
    persistedRef.current = clamped;
    setLayout(clamped);
  }, [persisted]);

  const live =
    (key: keyof PaneLayout) =>
    (size: number): void =>
      setLayout((l) => (l[key] === size ? l : { ...l, [key]: size }));
  const commit =
    (key: keyof PaneLayout) =>
    (size: number): void => {
      // Display: keep the other fields' current (possibly re-clamped) values + the dragged one.
      const display = { ...layoutRef.current, [key]: size };
      layoutRef.current = display;
      setLayout(display);
      // Persist: only the dragged field changes the baseline — untouched fields keep the user's
      // preferred size, so another pane's display-only re-clamp can never overwrite it.
      const persistedNext = { ...persistedRef.current, [key]: size };
      persistedRef.current = persistedNext;
      save(persistedNext);
    };

  const control = (key: keyof PaneLayout): SplitControl => ({
    size: layout[key],
    onResize: live(key),
    onResizeEnd: commit(key),
  });

  return {
    layout,
    topRow: control('topRowFraction'),
    topLeft: control('topLeftWidth'),
    bottomLeft: control('bottomLeftWidth'),
    repo: control('repoFraction'),
  };
}
