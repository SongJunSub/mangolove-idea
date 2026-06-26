import { useCallback, useEffect, useState } from 'react';
import type { UpdatePerformRequest, UpdateProgress } from '../../shared/types';

/** UI state of the one-click self-update (idle → download/verify/stage/apply → error). The
 *  middle member IS an UPDATE_PROGRESS event, so the onProgress setState is exact, not lucky. */
export type SelfUpdateState =
  | { readonly phase: 'idle' }
  | UpdateProgress
  | { readonly phase: 'error'; readonly reason: string };

export interface UseSelfUpdate {
  readonly state: SelfUpdateState;
  /** Begin the one-click update. On success the app quits/restarts; on failure `state` → error. */
  start(req: UpdatePerformRequest): void;
}

/**
 * Drives the one-click self-update: subscribes to UPDATE_PROGRESS for live phase/percent, and
 * calls update.perform(). perform() resolves ONLY on a non-success outcome (success quits the
 * app to swap the bundle), so a resolved result is surfaced as an error message + the manual
 * download fallback.
 */
export function useSelfUpdate(): UseSelfUpdate {
  const [state, setState] = useState<SelfUpdateState>({ phase: 'idle' });

  useEffect(() => {
    return window.mango.update.onProgress((e: UpdateProgress) => setState(e));
  }, []);

  const start = useCallback((req: UpdatePerformRequest): void => {
    setState({ phase: 'downloading', receivedBytes: 0 });
    void window.mango.update.perform(req).then((result) => {
      // Reached only when nothing was installed (blocked / ineligible / error) — success quits.
      setState({ phase: 'error', reason: result.reason });
    });
  }, []);

  return { state, start };
}
