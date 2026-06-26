import { useCallback, useEffect, useRef } from 'react';

/** Debounced field-level auto-save: queue patches, flush as one merged write. */
export interface UseAutoSave<T extends object> {
  /**
   * Accumulate a partial patch. Without `immediate`, the merged patch is written once
   * after `delayMs` of idle (typing persists when you pause, not per keystroke). With
   * `immediate`, it flushes at once — for discrete controls (toggles, segmented buttons).
   */
  queue(patch: Partial<T>, immediate?: boolean): void;
  /** Write any pending patch now (e.g. on input blur or before closing). */
  flush(): void;
}

/**
 * Field-level auto-save replacing an explicit Save button. Text inputs debounce so a
 * burst of keystrokes is one write; toggles persist immediately. A pending patch is
 * flushed on unmount so a value typed right before the dialog closes is never lost.
 */
export function useAutoSave<T extends object>(
  persist: (patch: Partial<T>) => void,
  delayMs = 400,
): UseAutoSave<T> {
  const pending = useRef<Partial<T>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest persist without re-creating queue/flush (which controls depend on).
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const flush = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (Object.keys(pending.current).length === 0) return;
    const patch = pending.current;
    pending.current = {};
    persistRef.current(patch);
  }, []);

  const queue = useCallback(
    (patch: Partial<T>, immediate = false): void => {
      pending.current = { ...pending.current, ...patch };
      if (immediate) {
        flush();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [flush, delayMs],
  );

  useEffect(() => () => flush(), [flush]); // flush a pending patch on unmount

  return { queue, flush };
}
