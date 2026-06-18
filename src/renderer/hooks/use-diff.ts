import { useCallback, useEffect, useState } from 'react';
import type { ChangedFile, FileDiff } from '../../shared/types';

/** Loads the PR-style changed-file list for one worktree (branch vs base). */
export interface UseDiff {
  readonly files: ChangedFile[];
  readonly loading: boolean;
  readonly error: string | null;
  loadFile(path: string): Promise<FileDiff>;
}

export function useDiff(worktreeId: string, base?: string): UseDiff {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.mango.diff
      .list({ worktreeId, base })
      .then((f) => {
        if (!cancelled) setFiles(f);
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
  }, [worktreeId, base]);

  const loadFile = useCallback(
    (path: string): Promise<FileDiff> => window.mango.diff.file({ worktreeId, base, path }),
    [worktreeId, base],
  );

  return { files, loading, error, loadFile };
}
