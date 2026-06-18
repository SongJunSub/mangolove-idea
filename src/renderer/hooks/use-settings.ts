import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/types';

/** Reads + writes the persisted AppSettings via window.mango.settings. */
export interface UseSettings {
  /** Current settings (empty until the initial fetch resolves). */
  readonly settings: AppSettings;
  /** True until the initial fetch resolves. */
  readonly loading: boolean;
  /** Persists a partial and updates local state with the merged result. */
  save(partial: Partial<AppSettings>): Promise<void>;
}

/** Fetches settings once on mount; save() persists a partial and refreshes state. */
export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<AppSettings>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.mango.settings
      .get()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (partial: Partial<AppSettings>): Promise<void> => {
    const merged = await window.mango.settings.set(partial);
    setSettings(merged);
  }, []);

  return { settings, loading, save };
}
