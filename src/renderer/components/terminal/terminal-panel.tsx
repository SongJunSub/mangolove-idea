import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/i18n-context';
import {
  computeRects,
  computeGutters,
  setRatioAt,
  edgeForPoint,
  insertAtEdge,
  leafAtPoint,
  leavesOf,
  removeLeaf,
  replaceLeaf,
  MAX_TILES,
  type Edge,
  type Rect,
  type Gutter,
  type TileNode,
} from '../layout/tile-math';
import { clampSplitFraction } from '../layout/split-math';
import type { TerminalLayout } from '../../../shared/terminal-layout';
import { computeInitialLayout, toPersisted, type LeafKind } from '../../lib/terminal-layout-bridge';
import { AgentTerminal } from './agent-terminal';

// Shells share xterm's chunk; lazy keeps the initial bundle smaller (mirrors AgentTerminal).
const ShellTerminal = lazy(() =>
  import('./shell-terminal').then((m) => ({ default: m.ShellTerminal })),
);

/** Gap (px) inset around each tile so adjacent terminals show a seam. */
const TILE_GAP = 3;
/** Min px a tile keeps when resizing a gutter (so a pane can't be dragged to nothing). */
const MIN_TILE_PX = 80;
/** Width (px) of a gutter's pointer hit-strip, centered on the boundary. */
const GUTTER_HIT = 9;

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
  const mintShell = (): string => `sh-${(seq.current += 1)}`;

  // The managed AGENT (auto-running claude) exists for this worktree ONLY when it has a resumable
  // session (continueAgent). With no session we open a plain $SHELL instead and never auto-launch
  // claude — the user runs it themselves when they want. Captured at mount (the panel is keyed by
  // worktreeId, so a worktree switch remounts; App gates this mount on records having loaded, so
  // continueAgent is settled — never the loading-window false).
  const agentPresent = continueAgent;

  // Rehydrate ONCE on mount (the panel is keyed by worktreeId, so a worktree switch remounts).
  // Default = a single agent tile (session) or a single fresh shell tile (no session).
  const init = useMemo(
    () => computeInitialLayout(persisted, agentPresent, worktreePath, mintShell),
    [],
  );

  const [tree, setTree] = useState<TileNode>(init.tree);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const [shells, setShells] = useState<readonly ShellEntry[]>(init.shells);
  const [focused, setFocused] = useState<string>(
    () => leavesOf(init.tree)[0] ?? init.shells[0]?.id ?? 'agent',
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; id: string } | null>(null);
  // Set on a committed drop so the trailing synthetic `click` (pointer capture re-targets it to
  // the tab) doesn't re-run selection.
  const justDragged = useRef(false);
  const [drop, setDrop] = useState<{ target: string; edge: Edge } | null>(null);
  const gutterDragRef = useRef<{ pointerId: number; gutter: Gutter; moved: boolean } | null>(null);

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

  const allIds = useMemo(
    () => [...(agentPresent ? ['agent'] : []), ...shells.map((s) => s.id)],
    [shells, agentPresent],
  );
  const tiled = useMemo(() => new Set(leavesOf(tree)), [tree]);
  const rects = useMemo(() => computeRects(tree), [tree]);
  const gutters = useMemo(() => computeGutters(tree), [tree]);

  // ── tab actions ──
  // The active TILED leaf to grow from / swap into — never collapses the layout.
  const slotLeaf = (): string => (tiled.has(focused) ? focused : (leavesOf(tree)[0] ?? allIds[0]));

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
  // Never closes the LAST remaining terminal (a worktree always keeps at least one). When the
  // closed shell was the only TILED leaf, another terminal is promoted into the tree: the agent
  // if present, else the first surviving shell.
  const closeShell = useCallback(
    (id: string): void => {
      if (allIds.length <= 1) return; // can't close the only terminal
      const nextShells = shells.filter((s) => s.id !== id);
      const fallbackId = agentPresent ? 'agent' : nextShells[0]?.id;
      const nextTree = removeLeaf(tree, id) ?? (fallbackId ? { id: fallbackId } : tree);
      setTree(nextTree);
      setShells(nextShells);
      setFocused((f) => (f === id ? (leavesOf(nextTree)[0] ?? allIds[0]) : f));
      persist(nextTree, nextShells);
    },
    [tree, shells, persist, allIds, agentPresent],
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

  // ── resize a tile boundary (drag a gutter to change its split ratio) ──
  const onGutterPointerDown =
    (g: Gutter) =>
    (e: React.PointerEvent): void => {
      gutterDragRef.current = { pointerId: e.pointerId, gutter: g, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
  const onGutterPointerMove = (e: React.PointerEvent): void => {
    const active = gutterDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    if (e.buttons === 0) {
      gutterDragRef.current = null;
      return;
    }
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || stage.width <= 0 || stage.height <= 0) return;
    const { gutter: g } = active;
    const sr = g.splitRect;
    const spanPx = g.dir === 'row' ? sr.width * stage.width : sr.height * stage.height;
    const offsetPx =
      g.dir === 'row'
        ? e.clientX - (stage.left + sr.left * stage.width)
        : e.clientY - (stage.top + sr.top * stage.height);
    // gutterPx = 0: unlike <Split> (a real flex:none gutter div between panes), computeRects applies
    // ratio to the FULL split span — the seam is only faked by symmetric tile insets — so reserving a
    // gutter track here would bias ratio = offset/(span−6) and the divider would trail the cursor ~3px.
    const ratio = clampSplitFraction(offsetPx, spanPx, 0.1, 0.9, MIN_TILE_PX, MIN_TILE_PX, 0);
    active.moved = true;
    setTree((t) => setRatioAt(t, g.path, ratio));
  };
  const onGutterPointerUp = (e: React.PointerEvent): void => {
    const active = gutterDragRef.current;
    gutterDragRef.current = null;
    if (!active || active.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    // Persist only when the boundary actually moved — a click-without-drag must not rewrite the
    // identical layout (mirrors the persistedRef no-op-write discipline of the pane splitters).
    if (active.moved) persist(treeRef.current, shells);
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

  /** The thin draggable strip sitting ON a split boundary, centered over the inter-tile gap. */
  const gutterStyle = (g: Gutter): React.CSSProperties => {
    const sr = g.splitRect;
    if (g.dir === 'row') {
      const x = sr.left + sr.width * g.ratio;
      return {
        position: 'absolute',
        left: `calc(${x * 100}% - ${GUTTER_HIT / 2}px)`,
        top: `${sr.top * 100}%`,
        width: `${GUTTER_HIT}px`,
        height: `${sr.height * 100}%`,
        cursor: 'col-resize',
        touchAction: 'none',
      };
    }
    const y = sr.top + sr.height * g.ratio;
    return {
      position: 'absolute',
      left: `${sr.left * 100}%`,
      top: `calc(${y * 100}% - ${GUTTER_HIT / 2}px)`,
      width: `${sr.width * 100}%`,
      height: `${GUTTER_HIT}px`,
      cursor: 'row-resize',
      touchAction: 'none',
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
            {id !== 'agent' && allIds.length > 1 && (
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
        {gutters.map((g) => (
          <div
            key={g.path.join('-') || 'root'}
            className={`term-gutter term-gutter--${g.dir}`}
            style={gutterStyle(g)}
            data-testid={`term-gutter-${g.path.join('-') || 'root'}`}
            role="separator"
            aria-orientation={g.dir === 'row' ? 'vertical' : 'horizontal'}
            onPointerDown={onGutterPointerDown(g)}
            onPointerMove={onGutterPointerMove}
            onPointerUp={onGutterPointerUp}
            onPointerCancel={onGutterPointerUp}
          />
        ))}
        {previewStyle && <div className="term-drop-preview" style={previewStyle} />}
      </div>
    </div>
  );
}
