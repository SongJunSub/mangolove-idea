import { describe, it, expect } from 'vitest';
import { modelPoolEvictions } from '../../src/renderer/lib/code-nav/model-pool';

describe('modelPoolEvictions', () => {
  it('evicts pooled models whose tab has closed (not in the open set)', () => {
    const pool = ['a', 'b', 'c'];
    const open = new Set(['a', 'c']); // b was closed
    expect(modelPoolEvictions(pool, open, 'a')).toEqual(['b']);
  });

  it('never evicts the model currently on screen, even if it is somehow not in the open set', () => {
    const pool = ['a', 'b'];
    const open = new Set(['a']); // b not open...
    expect(modelPoolEvictions(pool, open, 'b')).toEqual([]); // ...but b is current -> keep
  });

  it('evicts everything from the old worktree when the open set switches worktrees', () => {
    const pool = ['/wt1/a', '/wt1/b', '/wt2/x'];
    const open = new Set(['/wt2/x', '/wt2/y']); // now viewing wt2
    expect(modelPoolEvictions(pool, open, '/wt2/x').sort()).toEqual(['/wt1/a', '/wt1/b']);
  });

  it('evicts nothing when every pooled model is still open', () => {
    const pool = ['a', 'b'];
    expect(modelPoolEvictions(pool, new Set(['a', 'b']), 'a')).toEqual([]);
  });

  it('handles an empty pool', () => {
    expect(modelPoolEvictions([], new Set(['a']), null)).toEqual([]);
  });
});
