import { useCallback, useEffect, useState } from 'react';
import type {
  ConflictedFile,
  ConflictFileVersions,
  MergeResult,
} from '../../shared/types';

type Choice = 'ours' | 'theirs' | 'manual' | 'keep' | 'remove';

/** Drives the conflict-resolution surface for one worktree's in-progress merge. */
export interface UseConflicts {
  readonly files: ConflictedFile[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly inProgress: boolean;
  refresh(): Promise<void>;
  read(path: string): Promise<ConflictFileVersions>;
  resolve(path: string, choice: Choice, targetBranch: string, content?: string): Promise<MergeResult>;
  continueMerge(targetBranch: string, cleanup: boolean): Promise<MergeResult>;
  abort(): Promise<MergeResult>;
}

export function useConflicts(worktreeId: string): UseConflicts {
  const [files, setFiles] = useState<ConflictedFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState<boolean>(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.mango.merge.conflicts({ worktreeId });
      setFiles(list);
      setInProgress(list.length > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const read = useCallback(
    (path: string): Promise<ConflictFileVersions> =>
      window.mango.merge.readConflict({ worktreeId, path }),
    [worktreeId],
  );

  const resolve = useCallback(
    async (path: string, choice: Choice, targetBranch: string, content?: string): Promise<MergeResult> => {
      const res = await window.mango.merge.resolve({ worktreeId, path, choice, content, targetBranch });
      await refresh();
      return res;
    },
    [worktreeId, refresh],
  );

  const continueMerge = useCallback(
    async (targetBranch: string, cleanup: boolean): Promise<MergeResult> => {
      const res = await window.mango.merge.continue({ worktreeId, targetBranch, cleanup });
      if (res.status === 'merged') setInProgress(false);
      else await refresh();
      return res;
    },
    [worktreeId, refresh],
  );

  const abort = useCallback(async (): Promise<MergeResult> => {
    const res = await window.mango.merge.abort({ worktreeId });
    setInProgress(false);
    setFiles([]);
    return res;
  }, [worktreeId]);

  return { files, loading, error, inProgress, refresh, read, resolve, continueMerge, abort };
}
