import { useEffect, useState } from 'react';

/** Exposes which worktrees had a recorded agent session (=> spawn with --continue). */
export interface UseSessionRecords {
  /** True if the worktree had a session at last quit (rehydrate via claude --continue). */
  has(worktreeId: string): boolean;
  /** True until the initial fetch resolves (avoids spawning fresh before we know). */
  readonly loading: boolean;
}

/**
 * Fetches the recorded worktree paths ONCE on mount via window.mango.session.records().
 * The app stores no conversation content; this is only the set of worktrees that had a
 * session, used to decide continueSession for the lazily-mounted AgentTerminal.
 */
export function useSessionRecords(): UseSessionRecords {
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.mango.session
      .records()
      .then((recorded) => {
        if (alive) setPaths(new Set(recorded));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { has: (id) => paths.has(id), loading };
}
