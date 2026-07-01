import { describe, it, expect } from 'vitest';
import {
  toPersisted,
  fromPersisted,
  computeInitialLayout,
  type LeafKind,
} from '../../src/renderer/lib/terminal-layout-bridge';
import type { TileNode } from '../../src/renderer/components/layout/tile-math';
import { leavesOf } from '../../src/renderer/components/layout/tile-math';
import type { TerminalLayout } from '../../src/shared/terminal-layout';
import { coerceTerminalLayout } from '../../src/shared/terminal-layout';

describe('terminal-layout bridge', () => {
  it('toPersisted strips ids and projects leaf kinds', () => {
    const tree: TileNode = { dir: 'row', ratio: 0.4, a: { id: 'agent' }, b: { id: 'sh-1' } };
    const kinds = new Map<string, LeafKind>([
      ['agent', { kind: 'agent' }],
      ['sh-1', { kind: 'shell', cwd: '/repo/wt' }],
    ]);
    expect(toPersisted(tree, (id) => kinds.get(id), '/fallback')).toEqual({
      dir: 'row',
      ratio: 0.4,
      a: { kind: 'agent' },
      b: { kind: 'shell', cwd: '/repo/wt' },
    });
  });

  it('an unknown/registry-less non-agent leaf degrades to a SHELL (never a 2nd agent)', () => {
    expect(toPersisted({ id: 'sh-x' }, () => undefined, '/fallback')).toEqual({
      kind: 'shell',
      cwd: '/fallback',
    });
  });

  it('fromPersisted rehydrates: agent keeps id "agent", shells get fresh minted ids + cwds', () => {
    let n = 0;
    const layout = {
      root: {
        dir: 'col' as const,
        ratio: 0.6,
        a: { kind: 'agent' as const },
        b: { kind: 'shell' as const, cwd: '/repo/wt' },
      },
    };
    const { tree, registry } = fromPersisted(layout, () => `sh-${++n}`);
    expect(leavesOf(tree)).toEqual(['agent', 'sh-1']);
    expect(registry.get('agent')).toEqual({ kind: 'agent' });
    expect(registry.get('sh-1')).toEqual({ kind: 'shell', cwd: '/repo/wt' });
  });

  it('round-trips through coerce: persist -> coerce -> rehydrate -> persist is stable', () => {
    const tree: TileNode = {
      dir: 'row',
      ratio: 0.5,
      a: { id: 'agent' },
      b: { dir: 'col', ratio: 0.5, a: { id: 'sh-1' }, b: { id: 'sh-2' } },
    };
    const kinds = new Map<string, LeafKind>([
      ['agent', { kind: 'agent' }],
      ['sh-1', { kind: 'shell', cwd: '/a' }],
      ['sh-2', { kind: 'shell', cwd: '/b' }],
    ]);
    const persisted = { root: toPersisted(tree, (id) => kinds.get(id), '/fallback') };
    const coerced = coerceTerminalLayout(persisted);
    expect(coerced).toBeTruthy();
    let n = 0;
    const { tree: tree2, registry: reg2 } = fromPersisted(coerced!, () => `sh-${++n}`);
    const persisted2 = { root: toPersisted(tree2, (id) => reg2.get(id), '/fallback') };
    expect(persisted2).toEqual(persisted);
  });
});

describe('computeInitialLayout (agent-vs-shell default at mount)', () => {
  const mint = () => {
    let n = 0;
    return () => `sh-${(n += 1)}`;
  };
  const agentShell: TerminalLayout = {
    root: { dir: 'row', ratio: 0.5, a: { kind: 'agent' }, b: { kind: 'shell', cwd: '/wt/x' } },
  };
  const agentOnly: TerminalLayout = { root: { kind: 'agent' } };
  const shellsOnly: TerminalLayout = {
    root: {
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'shell', cwd: '/a' },
      b: { kind: 'shell', cwd: '/b' },
    },
  };

  it('no persisted + session → a lone agent tile, no shells', () => {
    const r = computeInitialLayout(undefined, true, '/wt', mint());
    expect(r.tree).toEqual({ id: 'agent' });
    expect(r.shells).toEqual([]);
  });

  it('no persisted + NO session → a fresh SHELL in the worktree cwd (never an agent)', () => {
    const r = computeInitialLayout(undefined, false, '/wt', mint());
    expect(leavesOf(r.tree)).toEqual(['sh-1']);
    expect(r.shells).toEqual([{ id: 'sh-1', cwd: '/wt' }]);
    expect(leavesOf(r.tree)).not.toContain('agent');
  });

  it('persisted agent+shell + session → kept as persisted', () => {
    const r = computeInitialLayout(agentShell, true, '/wt', mint());
    expect(leavesOf(r.tree).sort()).toEqual(['agent', 'sh-1']);
    expect(r.shells).toEqual([{ id: 'sh-1', cwd: '/wt/x' }]);
  });

  it('persisted agent+shell + NO session → agent STRIPPED, shell kept (no auto-claude)', () => {
    const r = computeInitialLayout(agentShell, false, '/wt', mint());
    expect(leavesOf(r.tree)).toEqual(['sh-1']);
    expect(leavesOf(r.tree)).not.toContain('agent');
    expect(r.shells).toEqual([{ id: 'sh-1', cwd: '/wt/x' }]);
  });

  it('persisted agent-ONLY + NO session → falls back to a fresh shell (stripping emptied the tree)', () => {
    const r = computeInitialLayout(agentOnly, false, '/wt', mint());
    expect(leavesOf(r.tree)).toEqual(['sh-1']);
    expect(leavesOf(r.tree)).not.toContain('agent');
    expect(r.shells).toEqual([{ id: 'sh-1', cwd: '/wt' }]);
  });

  it('persisted shells-only → kept intact regardless of session (nothing to strip)', () => {
    const withSession = computeInitialLayout(shellsOnly, true, '/wt', mint());
    expect(leavesOf(withSession.tree).sort()).toEqual(['sh-1', 'sh-2']);
    const noSession = computeInitialLayout(shellsOnly, false, '/wt', mint());
    expect(leavesOf(noSession.tree).sort()).toEqual(['sh-1', 'sh-2']);
    expect(noSession.shells).toEqual([
      { id: 'sh-1', cwd: '/a' },
      { id: 'sh-2', cwd: '/b' },
    ]);
  });
});
