import { useCallback, useEffect, useState } from 'react';
import type { UsageStatus } from '../../shared/types';

/** State + refresh for the Claude usage widget (mirrors useUpdateCheck/useSettings). */
export interface UseUsage {
  /** Latest usage result, or null before the first fetch resolves. */
  readonly status: UsageStatus | null;
  /** True while a fetch is in flight. */
  readonly loading: boolean;
  /** Re-fetch now (the status-bar refresh button). */
  refresh(): Promise<void>;
}

/**
 * Fetches Claude Code usage on mount and on demand. Read-only, no token cost; never throws
 * (main maps every failure to a status with `error` set). The Keychain prompt (if any) appears
 * at most once per app launch — main caches the credential for the session.
 */
export function useUsage(): UseUsage {
  const [status, setStatus] = useState<UsageStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStatus(await window.mango.usage.get());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void window.mango.usage
      .get()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { status, loading, refresh };
}
