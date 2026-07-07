import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenTabs, WorktreeTabs } from '../../shared/open-tabs';

/** The current worktree's tab strip + the mutations the tab bar / file tree drive. */
export interface UseOpenTabs {
  /** Ordered open file relPaths for the selected worktree (empty when none). */
  readonly tabs: readonly string[];
  /** The active relPath (drives the editor), or null. */
  readonly active: string | null;
  /** The single preview (temporary, italic) tab, or null when every open tab is pinned. */
  readonly preview: string | null;
  /**
   * Open a file and make it active. `preview: true` (single-click) opens it in the single preview
   * slot, REPLACING the current preview tab so previewing never accumulates tabs; `preview: false`
   * (default — double-click / go-to-definition) opens a pinned tab.
   */
  open(relPath: string, opts?: { preview?: boolean }): void;
  /** Make an already-open tab active. Does NOT change its preview/pinned status. */
  activate(relPath: string): void;
  /** Promote a tab from preview to pinned (on first edit / double-clicking the tab). */
  pin(relPath: string): void;
  /** Close a tab; if it was active, activate its right neighbour (else left, else none). */
  close(relPath: string): void;
}

/** In-memory tab state — a superset of the persisted shape with the non-persisted preview slot. */
interface LiveTabs {
  readonly open: readonly string[];
  readonly active: string | null;
  /** In-memory only — never persisted, so a restored tab is always pinned. */
  readonly preview: string | null;
}
type LiveMap = Record<string, LiveTabs>;

const EMPTY: readonly string[] = [];

/** Re-pick the active tab after `removedIdx` is closed: right neighbour, else left, else null. */
function nextActive(open: readonly string[], removedIdx: number): string | null {
  if (open.length === 0) return null;
  return open[Math.min(removedIdx, open.length - 1)] ?? null;
}

/** Rehydrate the persisted (preview-less) map into the live shape — restored tabs are all pinned. */
function toLive(persisted: OpenTabs): LiveMap {
  const out: LiveMap = {};
  for (const [wt, t] of Object.entries(persisted)) out[wt] = { ...t, preview: null };
  return out;
}

/**
 * Owns the per-worktree editor tab strip. Keeps ALL worktrees' tabs in memory (adopting the
 * persisted map once it arrives from the async settings fetch) so switching worktrees back and
 * forth preserves each one's tabs without a reload round-trip; `worktreeId` just selects the view.
 * Every mutation persists ONLY the changed worktree's {open, active} via `save` (the preview slot is
 * in-memory), which the SettingsStore merges per key — so this never stomps another window's tabs.
 */
export function useOpenTabs(
  worktreeId: string | null,
  persisted: OpenTabs | undefined,
  save: (worktreeId: string, tabs: WorktreeTabs) => void,
): UseOpenTabs {
  const [byWorktree, setByWorktree] = useState<LiveMap>(() => (persisted ? toLive(persisted) : {}));
  const ref = useRef<LiveMap>(byWorktree);
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
    ref.current = toLive(persisted);
    setByWorktree(ref.current);
  }, [persisted]);

  const current = worktreeId ? ref.current[worktreeId] : undefined;
  const tabs = current?.open ?? EMPTY;
  const active = current?.active ?? null;
  const preview = current?.preview ?? null;

  const update = useCallback(
    (mut: (cur: LiveTabs) => LiveTabs): void => {
      const wt = worktreeId;
      if (!wt) return;
      const cur = ref.current[wt] ?? { open: [], active: null, preview: null };
      const next = mut(cur);
      if (next === cur) return; // no-op — don't mark local-authoritative or persist
      adopted.current = true; // a real local change wins over any later-arriving persisted
      ref.current = { ...ref.current, [wt]: next };
      setByWorktree(ref.current);
      save(wt, { open: next.open, active: next.active }); // preview is in-memory only
    },
    [worktreeId, save],
  );

  const open = useCallback(
    (relPath: string, opts?: { preview?: boolean }): void => {
      const asPreview = opts?.preview ?? false;
      update((cur) => {
        if (cur.open.includes(relPath)) {
          // Already open: activate it. A pinned open of the CURRENT preview promotes it to pinned.
          const previewNext = !asPreview && cur.preview === relPath ? null : cur.preview;
          return cur.active === relPath && cur.preview === previewNext
            ? cur
            : { ...cur, active: relPath, preview: previewNext };
        }
        if (asPreview && cur.preview && cur.open.includes(cur.preview)) {
          // Replace the existing preview slot IN PLACE — previewing never accumulates tabs.
          const open = cur.open.map((p) => (p === cur.preview ? relPath : p));
          return { open, active: relPath, preview: relPath };
        }
        return {
          open: [...cur.open, relPath],
          active: relPath,
          preview: asPreview ? relPath : cur.preview,
        };
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

  const pin = useCallback(
    (relPath: string): void => {
      update((cur) => (cur.preview === relPath ? { ...cur, preview: null } : cur));
    },
    [update],
  );

  const close = useCallback(
    (relPath: string): void => {
      update((cur) => {
        const idx = cur.open.indexOf(relPath);
        if (idx < 0) return cur;
        const open = cur.open.filter((p) => p !== relPath);
        const activeNext = cur.active === relPath ? nextActive(open, idx) : cur.active;
        const previewNext = cur.preview === relPath ? null : cur.preview;
        return { open, active: activeNext, preview: previewNext };
      });
    },
    [update],
  );

  return { tabs, active, preview, open, activate, pin, close };
}
