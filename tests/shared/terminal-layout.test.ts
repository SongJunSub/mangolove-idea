import { describe, it, expect } from 'vitest';
import {
  coerceTerminalLayout,
  coerceTerminalLayouts,
  type PersistedNode,
} from '../../src/shared/terminal-layout';

const agent: PersistedNode = { kind: 'agent' };
const shell = (cwd: string): PersistedNode => ({ kind: 'shell', cwd });
const split = (
  dir: 'row' | 'col',
  a: PersistedNode,
  b: PersistedNode,
  ratio = 0.5,
): PersistedNode => ({
  dir,
  ratio,
  a,
  b,
});

describe('coerceTerminalLayout', () => {
  it('accepts a single agent leaf', () => {
    expect(coerceTerminalLayout({ root: agent })).toEqual({ root: agent });
  });
  it('accepts a valid split with agent + shell', () => {
    const root = split('row', agent, shell('/repo/wt'));
    expect(coerceTerminalLayout({ root })).toEqual({ root });
  });
  it('clamps the ratio to [0.1, 0.9]', () => {
    const r = coerceTerminalLayout({ root: split('row', agent, shell('/r'), 0.99) });
    expect((r!.root as { ratio: number }).ratio).toBe(0.9);
  });
  it('rejects a shell leaf with no cwd', () => {
    expect(coerceTerminalLayout({ root: { kind: 'shell' } })).toBeUndefined();
    expect(coerceTerminalLayout({ root: { kind: 'shell', cwd: '' } })).toBeUndefined();
  });
  it('rejects a bad dir / non-finite ratio / missing child', () => {
    expect(
      coerceTerminalLayout({ root: { dir: 'diag', ratio: 0.5, a: agent, b: agent } }),
    ).toBeUndefined();
    expect(
      coerceTerminalLayout({ root: { dir: 'row', ratio: NaN, a: agent, b: agent } }),
    ).toBeUndefined();
    expect(coerceTerminalLayout({ root: { dir: 'row', ratio: 0.5, a: agent } })).toBeUndefined();
  });
  it('rejects MORE than one agent leaf', () => {
    expect(coerceTerminalLayout({ root: split('row', agent, agent) })).toBeUndefined();
  });
  it('rejects more than 4 leaves', () => {
    const five = split(
      'row',
      shell('/1'),
      split('row', shell('/2'), split('row', shell('/3'), split('row', shell('/4'), shell('/5')))),
    );
    expect(coerceTerminalLayout({ root: five })).toBeUndefined();
  });
  it('accepts exactly 4 leaves (one agent + three shells)', () => {
    const four = split(
      'row',
      split('col', agent, shell('/2')),
      split('col', shell('/3'), shell('/4')),
    );
    expect(coerceTerminalLayout({ root: four })).toBeTruthy();
  });
  it('returns undefined for a non-object / missing root', () => {
    expect(coerceTerminalLayout('nope')).toBeUndefined();
    expect(coerceTerminalLayout({})).toBeUndefined();
  });
});

describe('coerceTerminalLayouts (per-worktree map)', () => {
  it('keeps valid entries, drops invalid keys/values', () => {
    const out = coerceTerminalLayouts({
      '/wt-a': { root: agent },
      '/wt-b': { root: { kind: 'shell' } }, // invalid (no cwd) -> dropped
      '': { root: agent }, // empty key -> dropped
    });
    expect(out).toEqual({ '/wt-a': { root: agent } });
  });
  it('returns undefined when no entry survives', () => {
    expect(coerceTerminalLayouts({ '/wt': { root: { kind: 'shell' } } })).toBeUndefined();
    expect(coerceTerminalLayouts('nope')).toBeUndefined();
    expect(coerceTerminalLayouts({})).toBeUndefined();
  });
});
