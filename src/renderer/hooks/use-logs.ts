import { useEffect, useState } from 'react';
import type { LogLine } from '../../shared/types';

/** Max lines held in renderer memory (mirrors the LogStore cap). */
const MAX_LINES = 5000;

/**
 * Seeds the live log list from logs.snapshot() on mount and appends every
 * LOG_LINE via onLine, capping the in-memory list. A monotonic-seq guard drops
 * any duplicate that races between the snapshot and the first live line.
 */
export function useLogs(): readonly LogLine[] {
  const [lines, setLines] = useState<readonly LogLine[]>([]);

  useEffect(() => {
    let alive = true;
    void window.mango.logs.snapshot().then((snap) => {
      if (alive) setLines(snap);
    });
    const off = window.mango.logs.onLine((line) => {
      setLines((prev) => {
        // A NEW run resets seq to 0 — clear the panel and seed the fresh run.
        // This MUST come before the dup check, which would otherwise block seq 0.
        if (line.seq === 0) return [line];
        const last = prev[prev.length - 1];
        if (last && line.seq <= last.seq) return prev; // dup / pre-reset straggler
        const next = prev.length >= MAX_LINES ? prev.slice(1) : prev.slice();
        next.push(line);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return lines;
}
