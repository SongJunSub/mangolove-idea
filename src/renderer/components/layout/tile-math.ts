/**
 * Pure, no-DOM model + geometry for the terminal TILE layout (A2g) — a binary tree of up to 4
 * leaves, each a live terminalId. Sibling of split-math.ts. The renderer feeds computeRects()
 * into a FLAT, absolutely-positioned, id-keyed stage (so terminals never re-parent → PTYs/
 * buffers survive every layout change); insertAtEdge/removeLeaf are the drag/close reducers.
 */

/** A live terminalId ('agent' | 'sh-N'). */
export type LeafId = string;
export interface TileLeaf {
  readonly id: LeafId;
}
/** 'row' = side-by-side (a left, b right; vertical divider); 'col' = stacked (a top, b bottom). */
export type SplitDir = 'row' | 'col';
export interface TileSplit {
  readonly dir: SplitDir;
  readonly a: TileNode;
  readonly b: TileNode;
  /** a's share of the split; undefined ⇒ 0.5. */
  readonly ratio?: number;
}
export type TileNode = TileLeaf | TileSplit;

export const isLeaf = (n: TileNode): n is TileLeaf => 'id' in n;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type InsertResult =
  | { readonly ok: true; readonly tree: TileNode }
  | { readonly ok: false; readonly reason: 'cap' | 'target-missing' | 'noop-self' };

/** Max simultaneously-tiled terminals. */
export const MAX_TILES = 4;

/** In-order DFS leaf ids (a before b). */
export function leavesOf(n: TileNode): LeafId[] {
  return isLeaf(n) ? [n.id] : [...leavesOf(n.a), ...leavesOf(n.b)];
}

/** Clamp a ratio to a sane, non-collapsing range. */
function clampRatio(r: number | undefined): number {
  const v = r ?? 0.5;
  return Math.min(0.9, Math.max(0.1, v));
}

/**
 * Each leaf's rect as 0..1 fractions of `rect` (default the unit square). Pure geometry — the
 * gutter is subtracted in the renderer, not here. The returned map's keys == leavesOf(n), the
 * rects are pairwise non-overlapping, and their areas sum to the parent's (partition invariant).
 */
export function computeRects(
  n: TileNode,
  rect: Rect = { left: 0, top: 0, width: 1, height: 1 },
): Map<LeafId, Rect> {
  if (isLeaf(n)) return new Map([[n.id, rect]]);
  const r = clampRatio(n.ratio);
  let aRect: Rect;
  let bRect: Rect;
  if (n.dir === 'row') {
    const aw = rect.width * r;
    aRect = { left: rect.left, top: rect.top, width: aw, height: rect.height };
    bRect = { left: rect.left + aw, top: rect.top, width: rect.width - aw, height: rect.height };
  } else {
    const ah = rect.height * r;
    aRect = { left: rect.left, top: rect.top, width: rect.width, height: ah };
    bRect = { left: rect.left, top: rect.top + ah, width: rect.width, height: rect.height - ah };
  }
  return new Map([...computeRects(n.a, aRect), ...computeRects(n.b, bRect)]);
}

/** Rebuild the tree replacing the leaf `id` with `sub` (structural sharing where possible). */
export function replaceLeaf(t: TileNode, id: LeafId, sub: TileNode): TileNode {
  if (isLeaf(t)) return t.id === id ? sub : t;
  const a = replaceLeaf(t.a, id, sub);
  const b = replaceLeaf(t.b, id, sub);
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/**
 * Removes the leaf `id`, collapsing its parent split into the surviving sibling (ancestor
 * splits keep their dir+ratio). Returns null iff the whole tree was the single leaf `id`.
 * Removing an absent id returns the tree unchanged.
 */
export function removeLeaf(t: TileNode, id: LeafId): TileNode | null {
  if (isLeaf(t)) return t.id === id ? null : t;
  const a = removeLeaf(t.a, id);
  if (a === null) return t.b; // a was (or contained only) id → promote sibling b
  const b = removeLeaf(t.b, id);
  if (b === null) return t.a;
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/** The split a drop on `edge` produces: which side the dragged terminal takes. */
function splitFor(edge: Edge, target: TileNode, dragged: TileNode): TileSplit {
  switch (edge) {
    case 'left':
      return { dir: 'row', a: dragged, b: target };
    case 'right':
      return { dir: 'row', a: target, b: dragged };
    case 'top':
      return { dir: 'col', a: dragged, b: target };
    case 'bottom':
      return { dir: 'col', a: target, b: dragged };
  }
}

/**
 * Drops `draggedId` onto the `edge` of leaf `targetLeafId`, replacing the target with a 50/50
 * split. A MOVE (dragged already tiled) removes it from its old spot first, so the leaf count is
 * unchanged and never capped; a NEW tile is rejected with 'cap' at MAX_TILES. Dropping a leaf on
 * its own edge is a 'noop-self'. An unknown target is 'target-missing'.
 */
export function insertAtEdge(
  t: TileNode,
  targetLeafId: LeafId,
  draggedId: LeafId,
  edge: Edge,
): InsertResult {
  if (draggedId === targetLeafId) return { ok: false, reason: 'noop-self' };
  const present = leavesOf(t).includes(draggedId);
  if (!present && leavesOf(t).length >= MAX_TILES) return { ok: false, reason: 'cap' };
  // MOVE: detach the dragged leaf first (count unchanged). It cannot be the whole tree here
  // (a single-leaf tree's only id would have been the target → caught by noop-self).
  const base = present ? (removeLeaf(t, draggedId) as TileNode) : t;
  if (!leavesOf(base).includes(targetLeafId)) return { ok: false, reason: 'target-missing' };
  const tree = replaceLeaf(
    base,
    targetLeafId,
    splitFor(edge, { id: targetLeafId }, { id: draggedId }),
  );
  return { ok: true, tree };
}

/**
 * The nearest edge of `rect` to a point, via the normalized diagonal wedge (four equal triangles
 * regardless of aspect ratio). Corner ties resolve to the vertical edge (top/bottom).
 */
export function edgeForPoint(rect: Rect, x: number, y: number): Edge {
  const px = rect.width <= 0 ? 0.5 : (x - rect.left) / rect.width;
  const py = rect.height <= 0 ? 0.5 : (y - rect.top) / rect.height;
  const dTop = py;
  const dBottom = 1 - py;
  const dLeft = px;
  const dRight = 1 - px;
  const min = Math.min(dTop, dBottom, dLeft, dRight);
  // Prefer vertical (top/bottom) on a tie so a corner never feels random.
  if (min === dTop) return 'top';
  if (min === dBottom) return 'bottom';
  if (min === dLeft) return 'left';
  return 'right';
}

/** The leaf whose rect contains (x, y), or undefined. Rects are 0..1 fractions of the stage. */
export function leafAtPoint(rects: Map<LeafId, Rect>, x: number, y: number): LeafId | undefined {
  for (const [id, r] of rects) {
    if (x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height) return id;
  }
  return undefined;
}
