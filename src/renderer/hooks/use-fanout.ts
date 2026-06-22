import { useCallback, useEffect, useState } from 'react';
import type {
  FanoutLaneStatusEvent,
  FanoutRun,
  FanoutStartRequest,
  MergeResult,
} from '../../shared/types';

/** Drives the ONE active fan-out run: seeds from FANOUT_GET + stays live via onStatus. */
export interface UseFanout {
  readonly run: FanoutRun | null;
  readonly busy: boolean;
  readonly error: string | null;
  start(req: FanoutStartRequest): Promise<void>;
  select(laneId: string): Promise<MergeResult>;
  abort(): Promise<void>;
}

/**
 * Seeds the current run from FANOUT_GET on mount, applies live FANOUT_STATUS
 * lane-status patches, and exposes start/select/abort. A lane patch updates the
 * matching lane in place; an event whose id differs from the current run id is
 * ignored (defensive — only one run exists at a time). The caller refreshes the
 * worktree list after a merged select().
 */
export function useFanout(): UseFanout {
  const [run, setRun] = useState<FanoutRun | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.mango.fanout.get().then((r) => {
      if (alive) setRun(r);
    });
    const off = window.mango.fanout.onStatus((e: FanoutLaneStatusEvent) => {
      setRun((prev) => {
        if (!prev || prev.id !== e.id) return prev;
        return {
          ...prev,
          lanes: prev.lanes.map((l) => (l.laneId === e.lane.laneId ? e.lane : l)),
        };
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useCallback(async (req: FanoutStartRequest): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.mango.fanout.start(req);
      // Seed the run from the start result; live patches arrive via onStatus.
      setRun({
        id: res.id,
        prompt: req.prompt,
        base: '',
        skipPermissions: req.skipPermissions,
        lanes: res.lanes,
      });
      // Reconcile base/prompt from the authoritative get() snapshot.
      const full = await window.mango.fanout.get();
      setRun(full);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const select = useCallback(async (laneId: string): Promise<MergeResult> => {
    setError(null);
    setBusy(true);
    try {
      const result = await window.mango.fanout.select({ laneId });
      if (result.status === 'merged') setRun(null);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  const abort = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await window.mango.fanout.abort();
      setRun(null);
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, error, start, select, abort };
}
