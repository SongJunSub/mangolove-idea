import { useCallback, useEffect, useRef, useState } from 'react';
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

  // Stale-result/unmount guard. refresh() is shared (mount effect + imperative
  // resolve()/continueMerge()), so a `cancelled`-style closure flag is not enough.
  // We compare against the worktreeId captured at call time: a slow in-flight
  // request for an OLD worktree must not overwrite state for the current one,
  // and nothing must setState after unmount (effect cleanup flips `alive`).
  const aliveRef = useRef<boolean>(true);
  const worktreeIdRef = useRef<string>(worktreeId);
  worktreeIdRef.current = worktreeId;

  const refresh = useCallback(async (): Promise<void> => {
    const requestedWorktreeId = worktreeId;
    const isFresh = (): boolean =>
      aliveRef.current && worktreeIdRef.current === requestedWorktreeId;
    setLoading(true);
    setError(null);
    try {
      // inProgress is the resolver's real MERGE_HEAD check — NOT files.length>0.
      // That distinction is load-bearing: after the last file is resolved, the
      // conflict list is empty but the merge is still in progress until the user
      // explicitly continues (creates the commit). list() returns [] in that
      // window; only the resolver's MERGE_HEAD probe stays truthful.
      const [list, merging] = await Promise.all([
        window.mango.merge.conflicts({ worktreeId: requestedWorktreeId }),
        window.mango.merge.inProgress({ worktreeId: requestedWorktreeId }),
      ]);
      if (!isFresh()) return;
      setFiles(list);
      setInProgress(merging);
    } catch (e) {
      if (!isFresh()) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isFresh()) setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
    };
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
      // 'merged' => the commit was created, MERGE_HEAD is gone: inProgress is now
      // definitively false. Otherwise re-derive truth (refresh guards itself).
      if (res.status === 'merged') {
        if (aliveRef.current) setInProgress(false);
      } else {
        await refresh();
      }
      return res;
    },
    [worktreeId, refresh],
  );

  const abort = useCallback(async (): Promise<MergeResult> => {
    const res = await window.mango.merge.abort({ worktreeId });
    // `merge --abort` dropped MERGE_HEAD and the conflicts: both are now empty.
    if (aliveRef.current) {
      setInProgress(false);
      setFiles([]);
    }
    return res;
  }, [worktreeId]);

  return { files, loading, error, inProgress, refresh, read, resolve, continueMerge, abort };
}
