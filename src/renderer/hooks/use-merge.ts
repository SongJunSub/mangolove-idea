import { useCallback, useEffect, useState } from 'react';
import type { MergeProgressEvent, MergeRequest, MergeResult } from '../../shared/types';

/** Live merge progress for the UI: the latest stage event + a busy flag. */
export interface UseMerge {
  readonly progress: MergeProgressEvent | null;
  readonly running: boolean;
  run(req: MergeRequest): Promise<MergeResult>;
}

/**
 * Drives merge.run + the live MERGE_PROGRESS stream. Tracks the latest stage so
 * the toolbar can show "verify… / merge… / cleanup… / done". `running` gates the
 * Merge button. The caller refreshes the worktree list on a merged result.
 */
export function useMerge(): UseMerge {
  const [progress, setProgress] = useState<MergeProgressEvent | null>(null);
  const [running, setRunning] = useState<boolean>(false);

  useEffect(() => {
    const off = window.mango.merge.onProgress((e) => setProgress(e));
    return off;
  }, []);

  const run = useCallback(async (req: MergeRequest): Promise<MergeResult> => {
    setProgress(null);
    setRunning(true);
    try {
      return await window.mango.merge.run(req);
    } finally {
      setRunning(false);
    }
  }, []);

  return { progress, running, run };
}
