import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenTabs, WorktreeTabs } from '../../shared/open-tabs';

/** The current worktree's tab strip + the mutations the tab bar / file tree drive. */
export interface UseOpenTabs {
  /** Ordered open file relPaths for the selected worktree (empty when none). */
  readonly tabs: readonly string[];
  /** The active relPath (drives the editor), or null. */
  readonly active: string | null;
  /** Open a file: append a tab if new, then make it active. No-op switch if already active. */
  open(relPath: string): void;
  /** Make an already-open tab active. */
  activate(relPath: string): void;
  /** Close a tab; if it was active, activate its right neighbour (else left, else none). */
  close(relPath: string): void;
}

const EMPTY: readonly string[] = [];

/** Re-pick the active tab after `removedIdx` is closed: right neighbour, else left, else null. */
function nextActive(open: readonly string[], removedIdx: number): string | null {
  if (open.length === 0) return null;
  return open[Math.min(removedIdx, open.length - 1)] ?? null;
}

/**
 * Owns the per-worktree editor tab strip. Keeps ALL worktrees' tabs in memory (adopting the
 * persisted map once it arrives from the async settings fetch) so switching worktrees back and
 * forth preserves each one's tabs without a reload round-trip; `worktreeId` just selects the view.
 * Every mutation persists ONLY the changed worktree's entry via `save`, which the SettingsStore
 * merges per key — so this never stomps another window's tabs. Preview state is a later layer;
 * this layer is pinned tabs only.
 */
export function useOpenTabs(
  worktreeId: string | null,
  persisted: OpenTabs | undefined,
  save: (worktreeId: string, tabs: WorktreeTabs) => void,
): UseOpenTabs {
  const [byWorktree, setByWorktree] = useState<OpenTabs>(() => persisted ?? {});
  const ref = useRef<OpenTabs>(byWorktree);
  ref.current = byWorktree;
  // Adopt the persisted map the FIRST time it arrives from the async settings fetch — but ONLY if
  // the user has not already mutated locally. On a fresh install `persisted` is undefined until the
  // very first save round-trips back through settings, so adoption can arrive LATE; without the
  // local-authoritative guard, a stale early save (e.g. carrying only the first-opened tab) would
  // stomp tabs the user opened in the meantime. `update` sets adopted=true on the first real change.
  const adopted = useRef(persisted !== undefined);
  useEffect(() => {
    if (adopted.current || !persisted) return;
    adopted.current = true;
    ref.current = persisted;
    setByWorktree(persisted);
  }, [persisted]);

  const current = worktreeId ? ref.current[worktreeId] : undefined;
  const tabs = current?.open ?? EMPTY;
  const active = current?.active ?? null;

  const update = useCallback(
    (mut: (cur: WorktreeTabs) => WorktreeTabs): void => {
      const wt = worktreeId;
      if (!wt) return;
      const cur = ref.current[wt] ?? { open: [], active: null };
      const next = mut(cur);
      if (next === cur) return; // no-op — don't mark local-authoritative or persist
      adopted.current = true; // a real local change wins over any later-arriving persisted
      ref.current = { ...ref.current, [wt]: next };
      setByWorktree(ref.current);
      save(wt, next);
    },
    [worktreeId, save],
  );

  const open = useCallback(
    (relPath: string): void => {
      update((cur) => {
        if (!cur.open.includes(relPath)) return { open: [...cur.open, relPath], active: relPath };
        return cur.active === relPath ? cur : { ...cur, active: relPath };
      });
    },
    [update],
  );

  const activate = useCallback(
    (relPath: string): void => {
      update((cur) =>
        !cur.open.includes(relPath) || cur.active === relPath ? cur : { ...cur, active: relPath },
      );
    },
    [update],
  );

  const close = useCallback(
    (relPath: string): void => {
      update((cur) => {
        const idx = cur.open.indexOf(relPath);
        if (idx < 0) return cur;
        const open = cur.open.filter((p) => p !== relPath);
        const nextActiveTab = cur.active === relPath ? nextActive(open, idx) : cur.active;
        return { open, active: nextActiveTab };
      });
    },
    [update],
  );

  return { tabs, active, open, activate, close };
}
