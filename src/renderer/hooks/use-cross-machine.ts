import { useCallback, useState } from 'react';
import type { CrossMachineSessionPointer, Worktree } from '../../shared/types';

/** Reads cross-machine session pointers + checks out a branch, via window.mango.crossMachine. */
export interface UseCrossMachine {
  /** All machines' pointers from the last refresh ([] when opted out). */
  readonly pointers: readonly CrossMachineSessionPointer[];
  /** True while a fetch is in flight. */
  readonly loading: boolean;
  /** Last error string (startHere failures land here), or null. */
  readonly error: string | null;
  /** Re-fetches every machine's pointers (best-effort on the main side; never throws). */
  refresh(): Promise<void>;
  /** Checks out `branch` into a local worktree for a fresh session; null on failure. */
  startHere(branch: string): Promise<Worktree | null>;
}

/** Cross-machine session visibility + "start here". Stateless until refresh() is called. */
export function useCrossMachine(): UseCrossMachine {
  const [pointers, setPointers] = useState<readonly CrossMachineSessionPointer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setPointers(await window.mango.crossMachine.fetch());
    } catch (e) {
      // fetch is best-effort on the main side; this catch is belt-and-suspenders.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const startHere = useCallback(async (branch: string): Promise<Worktree | null> => {
    setError(null);
    try {
      return await window.mango.crossMachine.startHere(branch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  return { pointers, loading, error, refresh, startHere };
}
