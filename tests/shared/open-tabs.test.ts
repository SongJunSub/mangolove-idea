import { describe, it, expect } from 'vitest';
import { coerceWorktreeTabs, coerceOpenTabs } from '../../src/shared/open-tabs';

describe('coerceWorktreeTabs', () => {
  it('keeps a valid entry and its active member', () => {
    expect(coerceWorktreeTabs({ open: ['a.ts', 'b.ts'], active: 'b.ts' })).toEqual({
      open: ['a.ts', 'b.ts'],
      active: 'b.ts',
    });
  });

  it('dedupes paths and drops empty strings, preserving order', () => {
    expect(coerceWorktreeTabs({ open: ['a', 'a', '', 'b'], active: 'a' })).toEqual({
      open: ['a', 'b'],
      active: 'a',
    });
  });

  it('nulls active when it is not an open member', () => {
    expect(coerceWorktreeTabs({ open: ['a'], active: 'gone' })).toEqual({
      open: ['a'],
      active: null,
    });
    expect(coerceWorktreeTabs({ open: ['a'], active: 42 })).toEqual({ open: ['a'], active: null });
  });

  it('treats an empty / non-array open as UNSET (undefined)', () => {
    expect(coerceWorktreeTabs({ open: [], active: null })).toBeUndefined();
    expect(coerceWorktreeTabs({ open: 'x', active: null })).toBeUndefined();
    expect(coerceWorktreeTabs(null)).toBeUndefined();
    expect(coerceWorktreeTabs(42)).toBeUndefined();
  });

  it('caps a corrupt over-long list', () => {
    const many = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
    const res = coerceWorktreeTabs({ open: many, active: 'f0.ts' });
    expect(res?.open).toHaveLength(100);
  });
});

describe('coerceOpenTabs', () => {
  it('keeps valid worktree entries and drops invalid / empty ones', () => {
    expect(
      coerceOpenTabs({
        '/wt/a': { open: ['x.ts'], active: 'x.ts' },
        '/wt/b': { open: [], active: null }, // empty -> dropped
        '': { open: ['y.ts'], active: null }, // empty key -> dropped
        '/wt/c': 'garbage', // invalid -> dropped
      }),
    ).toEqual({ '/wt/a': { open: ['x.ts'], active: 'x.ts' } });
  });

  it('returns undefined when nothing survives', () => {
    expect(coerceOpenTabs({ '/wt/a': { open: [] } })).toBeUndefined();
    expect(coerceOpenTabs(null)).toBeUndefined();
    expect(coerceOpenTabs('nope')).toBeUndefined();
  });
});
