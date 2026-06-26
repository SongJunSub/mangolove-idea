import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '../../shared/types';

/** State + actions for the in-app update check (mirrors useGhStatus/useSettings shape). */
export interface UseUpdateCheck {
  /** Latest check result, or null before the first check resolves. */
  readonly status: UpdateStatus | null;
  /** True while a MANUAL check() is in flight (the mount check is silent). */
  readonly checking: boolean;
  /** Run a check now, surfacing progress via `checking` (for the Settings button). */
  check(): Promise<void>;
}

/**
 * Owns the update-check IPC + result state. `checkOnMount` runs ONE silent check on mount
 * (for the launch banner) without toggling `checking`; the returned `check()` is the manual
 * path (Settings button) that does toggle it. check() never throws — main maps every failure
 * to a typed status with `error` set.
 */
export function useUpdateCheck(checkOnMount: boolean): UseUpdateCheck {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      setStatus(await window.mango.update.check());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!checkOnMount) return;
    let alive = true;
    void window.mango.update.check().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [checkOnMount]);

  return { status, checking, check };
}
