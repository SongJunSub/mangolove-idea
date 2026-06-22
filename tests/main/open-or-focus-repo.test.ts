import { describe, it, expect } from 'vitest';
import { findCtxByRepoRoot, pickEmptyGateCtx } from '../../src/main/app/window-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('open-or-focus routing helpers', () => {
  it('findCtxByRepoRoot finds an already-open repo (focus-guard target)', () => {
    const open: IpcContext = { mainWindow: null, repoRoot: '/proj' };
    const contexts = new Map<number, IpcContext>([[1, open]]);
    expect(findCtxByRepoRoot(contexts, '/proj')).toBe(open);
    expect(findCtxByRepoRoot(contexts, '/other')).toBeUndefined();
  });

  it('pickEmptyGateCtx returns a window with no repoRoot (to attach), else undefined', () => {
    const gate: IpcContext = { mainWindow: null, repoRoot: null };
    const filled: IpcContext = { mainWindow: null, repoRoot: '/x' };
    expect(
      pickEmptyGateCtx(
        new Map([
          [1, gate],
          [2, filled],
        ]),
      ),
    ).toBe(gate);
    expect(pickEmptyGateCtx(new Map([[2, filled]]))).toBeUndefined();
  });
});

describe('same-repo-twice focus-guard', () => {
  it('opening an already-open repo resolves to the existing window (focus, not duplicate)', () => {
    const a: IpcContext = { mainWindow: null, repoRoot: '/proj-a' };
    const b: IpcContext = { mainWindow: null, repoRoot: '/proj-b' };
    const contexts = new Map<number, IpcContext>([
      [1, a],
      [2, b],
    ]);
    // Re-picking /proj-a finds A: the launcher focuses A instead of opening a 3rd window.
    expect(findCtxByRepoRoot(contexts, '/proj-a')).toBe(a);
    // A brand-new repo finds nothing -> launcher opens a new window for it.
    expect(findCtxByRepoRoot(contexts, '/proj-c')).toBeUndefined();
    // And there is no empty gate to attach to (both windows own a repo).
    expect(pickEmptyGateCtx(contexts)).toBeUndefined();
  });
});
