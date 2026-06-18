import { useCallback, useEffect, useState } from 'react';
import type { GhStatus } from '../../shared/types';

/** Loads the gh-backed PR/CI status for one worktree, with a manual refresh(). */
export interface UseGhStatus {
  readonly status: GhStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  refresh(): void;
}

/**
 * Fetches GhStatus on select (keyed on worktreeId) with a stale-response guard
 * (gh is a slow network call), plus a manual refresh() because gh state changes
 * out-of-band (CI finishes, PR opened on github.com). Mirrors use-diff.ts.
 */
export function useGhStatus(worktreeId: string | null): UseGhStatus {
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!worktreeId) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.mango.gh
      .status({ worktreeId })
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { status, loading, error, refresh };
}
