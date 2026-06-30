import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/i18n-context';
import {
  computeRects,
  edgeForPoint,
  insertAtEdge,
  leafAtPoint,
  leavesOf,
  removeLeaf,
  replaceLeaf,
  MAX_TILES,
  type Edge,
  type Rect,
  type TileNode,
} from '../layout/tile-math';
import type { TerminalLayout } from '../../../shared/terminal-layout';
import { fromPersisted, toPersisted, type LeafKind } from '../../lib/terminal-layout-bridge';
import { AgentTerminal } from './agent-terminal';

// Shells share xterm's chunk; lazy keeps the initial bundle smaller (mirrors AgentTerminal).
const ShellTerminal = lazy(() =>
  import('./shell-terminal').then((m) => ({ default: m.ShellTerminal })),
);

/** Gap (px) inset around each tile so adjacent terminals show a seam. */
const TILE_GAP = 3;

export interface TerminalPanelProps {
  /** The selected worktree — the agent leaf's id-binding AND the cwd for new shells. */
  readonly worktreeId: string;
  /** Absolute path of the selected worktree (cwd for spawned shells). */
  readonly worktreePath: string;
  /** Spawn `claude --continue` for the agent (b-lite rehydrate). */
  readonly continueAgent: boolean;
  /** Persisted tile layout for this worktree (settings.terminalLayouts[worktreeId]), or undefined. */
  readonly persisted: TerminalLayout | undefined;
  /** Persist the layout (debounced to structural-change-end by the panel). */
  readonly onPersist: (layout: TerminalLayout) => void;
}

interface ShellEntry {
  readonly id: string;
  readonly cwd: string;
}

/**
 * The multi-terminal panel (A2g). Renders the worktree's agent terminal + plain $SHELL terminals
 * as a FLAT, absolutely-positioned, id-keyed list inside one stable stage — the tile layout is
 * applied as inline style (rect or display:none), NEVER as React tree shape, so a terminal NEVER
 * re-parents and its PTY + scrollback survive every split/move/close. Tiled terminals are placed
 * by computeRects; non-tiled ones are hidden tabs (still alive). Dragging a tab onto a tile's
 * top/bottom/left/right edge splits it (up to 4). The tree (tiled layout) is persisted per worktree.
 *
 * Keyed by worktreeId in App, so switching worktrees remounts the panel (per-worktree shells).
 */
export function TerminalPanel({
  worktreeId,
  worktreePath,
  continueAgent,
  persisted,
  onPersist,
}: TerminalPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const seq = useRef(0);

  // Rehydrate the persisted layout ONCE on mount (the panel is keyed by worktreeId, so a worktree
  // switch remounts + re-runs this). Default = a single agent tile.
  const init = useMemo(() => {
    if (persisted) {
      const { tree, registry } = fromPersisted(persisted, () => `sh-${(seq.current += 1)}`);
      const shells: ShellEntry[] = [];
      for (const [id, k] of registry)
        if (k.kind === 'shell' && k.cwd) shells.push({ id, cwd: k.cwd });
      return { tree, shells };
    }
    return { tree: { id: 'agent' } as TileNode, shells: [] as ShellEntry[] };
    // Mount-only: the panel is keyed by worktreeId in App, so a worktree switch remounts + re-inits.
  }, []);

  const [tree, setTree] = useState<TileNode>(init.tree);
  const [shells, setShells] = useState<readonly ShellEntry[]>(init.shells);
  const [focused, setFocused] = useState<string>(() => leavesOf(init.tree)[0] ?? 'agent');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; id: string } | null>(null);
  // Set on a committed drop so the trailing synthetic `click` (pointer capture re-targets it to
  // the tab) doesn't re-run selection.
  const justDragged = useRef(false);
  const [drop, setDrop] = useState<{ target: string; edge: Edge } | null>(null);

  // Persist the CURRENT tree (projected to kinds). Called on every structural change end.
  const persist = useCallback(
    (next: TileNode, nextShells: readonly ShellEntry[]): void => {
      const kof = (id: string): LeafKind | undefined => {
        if (id === 'agent') return { kind: 'agent' };
        const s = nextShells.find((x) => x.id === id);
        return s ? { kind: 'shell', cwd: s.cwd } : undefined;
      };
      onPersist({ root: toPersisted(next, kof, worktreePath) });
    },
    [onPersist, worktreePath],
  );

  const commitTree = useCallback(
    (next: TileNode): void => {
      setTree(next);
      persist(next, shells);
    },
    [persist, shells],
  );

  const allIds = useMemo(() => ['agent', ...shells.map((s) => s.id)], [shells]);
  const tiled = useMemo(() => new Set(leavesOf(tree)), [tree]);
  const rects = useMemo(() => computeRects(tree), [tree]);

  // ── tab actions ──
  // The active TILED leaf to grow from / swap into — never collapses the layout.
  const slotLeaf = (): string => (tiled.has(focused) ? focused : (leavesOf(tree)[0] ?? 'agent'));

  // Add a shell: SPLIT the focused tile (up to 4) so the layout GROWS — at the cap it lands as
  // a hidden tab (click it to swap in). Never replaces/collapses the existing arrangement.
  const addShell = useCallback((): void => {
    const id = `sh-${(seq.current += 1)}`;
    const nextShells = [...shells, { id, cwd: worktreePath }];
    let nextTree = tree;
    if (leavesOf(tree).length < MAX_TILES) {
      const r = insertAtEdge(tree, slotLeaf(), id, 'right');
      if (r.ok) nextTree = r.tree;
      setFocused(id);
    }
    setShells(nextShells);
    setTree(nextTree);
    persist(nextTree, nextShells);
  }, [shells, worktreePath, tree, tiled, focused, persist]);

  const clickTab = useCallback(
    (id: string): void => {
      if (justDragged.current) {
        justDragged.current = false; // swallow the synthetic click after a drag-drop
        return;
      }
      if (tiled.has(id)) {
        setFocused(id); // already visible — just make it the active tile
        return;
      }
      // Bring a hidden tab into view by SWAPPING it into the focused tile's slot (the displaced
      // terminal becomes a hidden tab). The layout SHAPE is preserved + persisted, never collapsed.
      const slot = slotLeaf();
      setFocused(id);
      commitTree(replaceLeaf(tree, slot, { id }));
    },
    [tiled, focused, tree, commitTree],
  );

  // Remove a tile from the LAYOUT (the terminal stays a live, hidden tab). Never empties the tree.
  const untile = useCallback(
    (id: string): void => {
      const next = removeLeaf(tree, id);
      if (next) commitTree(next);
    },
    [tree, commitTree],
  );

  // Close a SHELL entirely (kill its PTY via unmount): drop from the layout + the tab list.
  const closeShell = useCallback(
    (id: string): void => {
      const nextTree = removeLeaf(tree, id) ?? { id: 'agent' };
      const nextShells = shells.filter((s) => s.id !== id);
      setTree(nextTree);
      setShells(nextShells);
      setFocused((f) => (f === id ? (leavesOf(nextTree)[0] ?? 'agent') : f));
      persist(nextTree, nextShells);
    },
    [tree, shells, persist],
  );

  // ── drag a tab onto a tile edge ──
  const onTabPointerDown =
    (id: string) =>
    (e: React.PointerEvent): void => {
      dragRef.current = { pointerId: e.pointerId, id };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };
  const hitTest = (clientX: number, clientY: number): { target: string; edge: Edge } | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    const target = leafAtPoint(rects, fx, fy);
    if (!target) return null;
    const r = rects.get(target) as Rect;
    return { target, edge: edgeForPoint(r, fx, fy) };
  };
  const onTabPointerMove = (e: React.PointerEvent): void => {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
    if (e.buttons === 0) {
      dragRef.current = null;
      setDrop(null);
      return;
    }
    setDrop(hitTest(e.clientX, e.clientY));
  };
  const onTabPointerUp = (e: React.PointerEvent): void => {
    const active = dragRef.current;
    dragRef.current = null;
    if (!active || active.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    const hit = hitTest(e.clientX, e.clientY);
    setDrop(null);
    if (!hit) return;
    justDragged.current = true; // a real drop occurred → swallow the trailing synthetic click
    const res = insertAtEdge(tree, hit.target, active.id, hit.edge);
    if (res.ok) {
      setFocused(active.id);
      commitTree(res.tree);
    }
    // res.ok === false (cap / noop-self / target-missing): silently ignore.
  };
  // A CANCELLED drag (OS gesture / contextmenu / focus steal) ABORTS — never commits a drop.
  const onTabPointerCancel = (e: React.PointerEvent): void => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    setDrop(null);
  };

  /** The preview overlay rect (the half that becomes the new tile), in % of the stage. */
  const previewStyle = useMemo((): React.CSSProperties | null => {
    if (!drop) return null;
    const r = rects.get(drop.target);
    if (!r) return null;
    const half: Rect =
      drop.edge === 'left'
        ? { ...r, width: r.width / 2 }
        : drop.edge === 'right'
          ? { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
          : drop.edge === 'top'
            ? { ...r, height: r.height / 2 }
            : { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
    return {
      left: `${half.left * 100}%`,
      top: `${half.top * 100}%`,
      width: `${half.width * 100}%`,
      height: `${half.height * 100}%`,
    };
  }, [drop, rects]);

  const tileStyle = (id: string): React.CSSProperties => {
    const r = rects.get(id);
    if (!r) return { display: 'none' };
    return {
      position: 'absolute',
      left: `calc(${r.left * 100}% + ${TILE_GAP}px)`,
      top: `calc(${r.top * 100}% + ${TILE_GAP}px)`,
      width: `calc(${r.width * 100}% - ${TILE_GAP * 2}px)`,
      height: `calc(${r.height * 100}% - ${TILE_GAP * 2}px)`,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      minHeight: 0,
    };
  };

  const tabLabel = (id: string): string =>
    id === 'agent'
      ? t('app.tab.terminal')
      : (shells
          .find((s) => s.id === id)
          ?.cwd.split('/')
          .filter(Boolean)
          .pop() ?? 'shell');

  return (
    <div className="term-panel">
      <div role="tablist" aria-label={t('app.worktreeView')} className="ws-tabs">
        {allIds.map((id) => (
          <span key={id} className="ws-tab-shell">
            <button
              type="button"
              role="tab"
              className="ws-tab"
              aria-selected={tiled.has(id)}
              data-testid={`term-tab-${id}`}
              title={t('app.tab.dragToSplit')}
              onPointerDown={onTabPointerDown(id)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerUp}
              onPointerCancel={onTabPointerCancel}
              onClick={() => clickTab(id)}
            >
              {tabLabel(id)}
            </button>
            {id !== 'agent' && (
              <button
                type="button"
                className="ws-tab-close"
                title={t('app.tab.closeTerminal')}
                aria-label={t('app.tab.closeTerminal')}
                data-testid={`term-close-${id}`}
                onClick={() => closeShell(id)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          className="ws-tab-add"
          title={t('app.tab.newTerminal')}
          aria-label={t('app.tab.newTerminal')}
          data-testid="term-add"
          onClick={addShell}
        >
          +
        </button>
      </div>

      <div className="term-stage" ref={stageRef} data-testid="term-stage">
        {allIds.map((id) => (
          <div
            key={id}
            className={`term-tile${focused === id && tiled.has(id) ? ' term-tile--focused' : ''}`}
            data-tile-id={tiled.has(id) ? id : undefined}
            style={tileStyle(id)}
          >
            {tiled.has(id) && leavesOf(tree).length > 1 && (
              <button
                type="button"
                className="term-tile-untile"
                title={t('app.tab.untile')}
                aria-label={t('app.tab.untile')}
                data-testid={`term-untile-${id}`}
                onClick={() => untile(id)}
              >
                ×
              </button>
            )}
            <Suspense
              fallback={<div className="term-tile-loading">{t('app.loadingTerminal')}</div>}
            >
              {id === 'agent' ? (
                <AgentTerminal worktreeId={worktreeId} continueSession={continueAgent} />
              ) : (
                <ShellTerminal
                  terminalId={id}
                  cwd={shells.find((s) => s.id === id)?.cwd ?? worktreePath}
                />
              )}
            </Suspense>
          </div>
        ))}
        {previewStyle && <div className="term-drop-preview" style={previewStyle} />}
      </div>
    </div>
  );
}
