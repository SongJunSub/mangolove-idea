import { useEffect, useRef, useState } from 'react';
import type { Worktree } from '../../shared/types';

/**
 * Applies a cross-repo worktree selection to THIS window. A worktree clicked in another repo pends
 * its id in main; after the switch reload this hook PULLS it once (consume-once) and selects it as
 * soon as the repo's worktrees have loaded — or applies a live NUDGE (the focus / same-repo reselect
 * path, where no reload happens). Robust by construction:
 *  - the pended id lives in state so a late pull re-triggers the apply even if the list already loaded
 *    (no pull-resolves-after-load race);
 *  - it never clobbers a selection the user made in the meantime (selectedId already set);
 *  - it drops a since-deleted / unknown target (one attempt, then cleared).
 * worktree.id === its absolute path, so the id re-matches across the reload.
 */
export function usePendingWorktreeSelect(
  worktrees: readonly Worktree[],
  loading: boolean,
  selectedId: string | null,
  onSelect: (worktreeId: string) => void,
): void {
  // Refs keep the []-dep nudge listener + the apply reading the freshest values without re-subscribing.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const worktreesRef = useRef(worktrees);
  worktreesRef.current = worktrees;

  const [pendingId, setPendingId] = useState<string | null>(null);
  const pulled = useRef(false);
  useEffect(() => {
    if (pulled.current) return; // consume-once, on the first mount only
    pulled.current = true;
    void window.mango.repo.takePendingSelect().then((id) => {
      if (id) setPendingId(id);
    });
  }, []);

  useEffect(() => {
    if (pendingId === null || loading) return; // wait until this repo's worktrees have loaded
    setPendingId(null); // one attempt — also drops a since-deleted / unknown target
    if (selectedId === null && worktrees.some((w) => w.id === pendingId)) {
      onSelectRef.current(pendingId);
    }
  }, [pendingId, loading, worktrees, selectedId]);

  useEffect(
    () =>
      window.mango.repo.onSelectWorktree(({ worktreeId }) => {
        if (worktreesRef.current.some((w) => w.id === worktreeId)) {
          onSelectRef.current(worktreeId);
        }
      }),
    [],
  );
}
