import { describe, it, expect } from 'vitest';
import {
  leavesOf,
  computeRects,
  computeGutters,
  setRatioAt,
  removeLeaf,
  replaceLeaf,
  insertAtEdge,
  edgeForPoint,
  leafAtPoint,
  MAX_TILES,
  type TileNode,
} from '../../src/renderer/components/layout/tile-math';

const L = (id: string): TileNode => ({ id });
const row = (a: TileNode, b: TileNode, ratio?: number): TileNode => ({ dir: 'row', a, b, ratio });
const col = (a: TileNode, b: TileNode, ratio?: number): TileNode => ({ dir: 'col', a, b, ratio });

describe('leavesOf', () => {
  it('collects leaf ids in order (a before b)', () => {
    expect(leavesOf(L('A'))).toEqual(['A']);
    expect(leavesOf(row(L('A'), L('B')))).toEqual(['A', 'B']);
    expect(leavesOf(row(L('A'), col(L('B'), L('C'))))).toEqual(['A', 'B', 'C']);
    expect(leavesOf(row(col(L('A'), L('B')), col(L('C'), L('D'))))).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('computeRects', () => {
  it('a single leaf fills the unit square', () => {
    expect(computeRects(L('A')).get('A')).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });
  it('row splits left/right 50/50', () => {
    const m = computeRects(row(L('A'), L('B')));
    expect(m.get('A')).toEqual({ left: 0, top: 0, width: 0.5, height: 1 });
    expect(m.get('B')).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });
  });
  it('col splits top/bottom 50/50', () => {
    const m = computeRects(col(L('A'), L('B')));
    expect(m.get('A')).toEqual({ left: 0, top: 0, width: 1, height: 0.5 });
    expect(m.get('B')).toEqual({ left: 0, top: 0.5, width: 1, height: 0.5 });
  });
  it('honors a ratio (clamped to [0.1,0.9])', () => {
    expect(computeRects(row(L('A'), L('B'), 0.3)).get('A')!.width).toBeCloseTo(0.3, 6);
    expect(computeRects(row(L('A'), L('B'), 0.01)).get('A')!.width).toBeCloseTo(0.1, 6);
  });
  it('a 2x2 partitions into four equal quadrants', () => {
    const m = computeRects(row(col(L('A'), L('B')), col(L('C'), L('D'))));
    expect(m.get('A')).toEqual({ left: 0, top: 0, width: 0.5, height: 0.5 });
    expect(m.get('D')).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 });
  });
  it('PARTITION invariant: keys==leaves, non-overlapping, areas sum to 1', () => {
    const trees: TileNode[] = [
      L('A'),
      row(L('A'), L('B'), 0.3),
      row(L('A'), col(L('B'), L('C'), 0.7)),
      row(col(L('A'), L('B')), col(L('C'), L('D')), 0.4),
    ];
    for (const t of trees) {
      const m = computeRects(t);
      expect([...m.keys()].sort()).toEqual(leavesOf(t).sort());
      const rects = [...m.values()];
      const area = rects.reduce((s, r) => s + r.width * r.height, 0);
      expect(area).toBeCloseTo(1, 6);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlap =
            Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
          expect(overlap).toBeCloseTo(0, 6);
        }
    }
  });
});

describe('insertAtEdge — new tiles', () => {
  it('drops on each edge of a single leaf', () => {
    expect(insertAtEdge(L('A'), 'A', 'B', 'right')).toEqual({
      ok: true,
      tree: row(L('A'), L('B')),
    });
    expect(insertAtEdge(L('A'), 'A', 'B', 'left')).toEqual({ ok: true, tree: row(L('B'), L('A')) });
    expect(insertAtEdge(L('A'), 'A', 'B', 'bottom')).toEqual({
      ok: true,
      tree: col(L('A'), L('B')),
    });
    expect(insertAtEdge(L('A'), 'A', 'B', 'top')).toEqual({ ok: true, tree: col(L('B'), L('A')) });
  });
  it('splits a target leaf inside an existing split', () => {
    const r = insertAtEdge(row(L('A'), L('B')), 'B', 'C', 'right');
    expect(r).toEqual({ ok: true, tree: row(L('A'), row(L('B'), L('C'))) });
  });
  it('splits the FIRST child too', () => {
    const r = insertAtEdge(row(L('A'), L('B')), 'A', 'C', 'bottom');
    expect(r).toEqual({ ok: true, tree: row(col(L('A'), L('C')), L('B')) });
  });
  it('allows the 4th tile but REJECTS the 5th with cap', () => {
    const three = row(L('A'), row(L('B'), L('C')));
    const four = insertAtEdge(three, 'C', 'D', 'right');
    expect(four.ok).toBe(true);
    const tree4 = (four as { ok: true; tree: TileNode }).tree;
    expect(leavesOf(tree4).length).toBe(MAX_TILES);
    expect(insertAtEdge(tree4, 'A', 'E', 'right')).toEqual({ ok: false, reason: 'cap' });
  });
  it('rejects an unknown target', () => {
    expect(insertAtEdge(row(L('A'), L('B')), 'Z', 'C', 'right')).toEqual({
      ok: false,
      reason: 'target-missing',
    });
  });
});

describe('insertAtEdge — moves (dragged already tiled)', () => {
  it('dropping a leaf on its OWN edge is a noop-self', () => {
    expect(insertAtEdge(row(L('A'), L('B')), 'A', 'A', 'right')).toEqual({
      ok: false,
      reason: 'noop-self',
    });
  });
  it('moving an existing leaf rearranges WITHOUT changing the leaf set or count', () => {
    const r = insertAtEdge(row(L('A'), L('B')), 'B', 'A', 'right'); // move A to B's right
    expect(r).toEqual({ ok: true, tree: row(L('B'), L('A')) });
    const tree = (r as { ok: true; tree: TileNode }).tree;
    expect(leavesOf(tree).sort()).toEqual(['A', 'B']);
  });
  it('moving an interior leaf in a 2x2 keeps 4 leaves', () => {
    const grid = row(col(L('A'), L('B')), col(L('C'), L('D')));
    const r = insertAtEdge(grid, 'D', 'A', 'bottom'); // move A under D
    expect(r.ok).toBe(true);
    const tree = (r as { ok: true; tree: TileNode }).tree;
    expect(leavesOf(tree).sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('removeLeaf', () => {
  it('removing the only leaf returns null', () => {
    expect(removeLeaf(L('A'), 'A')).toBeNull();
  });
  it('collapses the parent split into the sibling', () => {
    expect(removeLeaf(row(L('A'), L('B')), 'A')).toEqual(L('B'));
    expect(removeLeaf(row(L('A'), col(L('B'), L('C'))), 'A')).toEqual(col(L('B'), L('C')));
  });
  it('removes an interior leaf', () => {
    expect(removeLeaf(row(L('A'), col(L('B'), L('C'))), 'B')).toEqual(row(L('A'), L('C')));
  });
  it('a 2x2 minus one leaf collapses that column', () => {
    const grid = row(col(L('A'), L('B')), col(L('C'), L('D')));
    expect(removeLeaf(grid, 'B')).toEqual(row(L('A'), col(L('C'), L('D'))));
  });
  it('removing an absent leaf leaves the tree unchanged (same reference)', () => {
    const t = row(L('A'), L('B'));
    expect(removeLeaf(t, 'Z')).toBe(t);
  });
});

describe('computeGutters', () => {
  it('a single leaf has no gutters', () => {
    expect(computeGutters(L('A'))).toEqual([]);
  });
  it('a row split yields one gutter at the root with its splitRect + ratio', () => {
    const g = computeGutters(row(L('A'), L('B'), 0.4));
    expect(g).toHaveLength(1);
    expect(g[0].path).toEqual([]);
    expect(g[0].dir).toBe('row');
    expect(g[0].ratio).toBe(0.4);
    expect(g[0].splitRect).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });
  it('a nested split yields a gutter per split with the right path + sub-rect', () => {
    const g = computeGutters(row(L('A'), col(L('B'), L('C'))));
    expect(g.map((x) => x.path)).toEqual([[], ['b']]);
    expect(g[1].dir).toBe('col');
    // the inner split occupies the RIGHT half (row at 0.5)
    expect(g[1].splitRect).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });
  });
});

describe('setRatioAt', () => {
  it('sets the root split ratio (clamped)', () => {
    expect(setRatioAt(row(L('A'), L('B')), [], 0.3)).toEqual(row(L('A'), L('B'), 0.3));
    expect((setRatioAt(row(L('A'), L('B')), [], 0.99) as { ratio: number }).ratio).toBe(0.9);
  });
  it('sets a nested split ratio by path', () => {
    const t = row(L('A'), col(L('B'), L('C')));
    expect(setRatioAt(t, ['b'], 0.7)).toEqual(row(L('A'), col(L('B'), L('C'), 0.7)));
  });
  it('a path pointing at a leaf is ignored (tree unchanged)', () => {
    const t = row(L('A'), L('B'));
    expect(setRatioAt(t, ['a'], 0.3)).toEqual(t);
  });
});

describe('replaceLeaf (tab swap into a tile slot)', () => {
  it('swaps the terminal in a slot, preserving the tree shape', () => {
    expect(replaceLeaf(row(L('A'), L('B')), 'A', L('C'))).toEqual(row(L('C'), L('B')));
    expect(replaceLeaf(row(col(L('A'), L('B')), L('C')), 'B', L('D'))).toEqual(
      row(col(L('A'), L('D')), L('C')),
    );
  });
  it('leaves the tree unchanged when the id is absent', () => {
    const t = row(L('A'), L('B'));
    expect(replaceLeaf(t, 'Z', L('C'))).toBe(t);
  });
});

describe('edgeForPoint', () => {
  const r = { left: 0, top: 0, width: 100, height: 100 };
  it('maps each edge-center to that edge', () => {
    expect(edgeForPoint(r, 50, 5)).toBe('top');
    expect(edgeForPoint(r, 50, 95)).toBe('bottom');
    expect(edgeForPoint(r, 5, 50)).toBe('left');
    expect(edgeForPoint(r, 95, 50)).toBe('right');
  });
  it('resolves the diagonal corner tie to vertical', () => {
    expect(edgeForPoint(r, 25, 25)).toBe('top'); // |dx|==|dy| corner → vertical
  });
});

describe('leafAtPoint', () => {
  it('finds the leaf whose rect contains the point', () => {
    const m = computeRects(row(L('A'), L('B')));
    expect(leafAtPoint(m, 0.25, 0.5)).toBe('A');
    expect(leafAtPoint(m, 0.75, 0.5)).toBe('B');
  });
});

describe('property: insert then remove restores the leaf set', () => {
  it('insert(X) then removeLeaf(X) yields the original leaf set, no duplicate ids', () => {
    const base = row(L('A'), L('B'));
    const r = insertAtEdge(base, 'B', 'C', 'bottom');
    const tree = (r as { ok: true; tree: TileNode }).tree;
    expect(leavesOf(tree).sort()).toEqual(['A', 'B', 'C']);
    expect(new Set(leavesOf(tree)).size).toBe(3); // no dup
    expect(leavesOf(removeLeaf(tree, 'C')!).sort()).toEqual(['A', 'B']);
  });
});
