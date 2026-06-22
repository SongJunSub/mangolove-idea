import { useEffect, useState } from 'react';
import type { LogLine } from '../../shared/types';

/** Max lines held in renderer memory per worktree (mirrors the LogStore cap). */
const MAX_LINES = 5000;

/**
 * Seeds ONE worktree's live log list from logs.snapshot(worktreeId) on mount and
 * appends every LOG_LINE whose worktreeId matches via onLine (renderer-side demux,
 * D6), capping the in-memory list. A per-worktree seq===0 reset clears on a fresh
 * run; a monotonic-seq guard drops a duplicate racing between snapshot and the first
 * live line. Re-subscribes when worktreeId changes.
 */
export function useLogs(worktreeId: string | null): readonly LogLine[] {
  const [lines, setLines] = useState<readonly LogLine[]>([]);

  useEffect(() => {
    if (worktreeId === null) {
      setLines([]);
      return;
    }
    let alive = true;
    setLines([]); // clear stale lines from the previously selected worktree
    void window.mango.logs.snapshot(worktreeId).then((snap) => {
      if (alive) setLines(snap);
    });
    const off = window.mango.logs.onLine((line) => {
      if (line.worktreeId !== worktreeId) return; // demux: only THIS worktree's lines
      setLines((prev) => {
        // A NEW run for THIS worktree resets seq to 0 — clear + seed the fresh run.
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
  }, [worktreeId]);

  return lines;
}
