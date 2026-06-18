import { useCallback, useEffect, useState } from 'react';
import type { ServerStatus } from '../../shared/types';

/** Return shape of the single-server hook. */
export interface UseServer {
  readonly status: ServerStatus | null;
  start(worktreeId: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Drives the ONE local server over window.mango.server. Seeds from status() on
 * mount and stays live via onState. start/stop are thin invoke wrappers; the
 * returned status feeds the toolbar Run/Stop + the sidebar server indicator.
 */
export function useServer(): UseServer {
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void window.mango.server.status().then((s) => {
      if (alive) setStatus(s);
    });
    const off = window.mango.server.onState((s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useCallback(async (worktreeId: string): Promise<void> => {
    const s = await window.mango.server.start({ worktreeId });
    setStatus(s);
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    const s = await window.mango.server.stop({});
    setStatus(s);
  }, []);

  return { status, start, stop };
}
