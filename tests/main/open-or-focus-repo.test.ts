import { describe, it, expect } from 'vitest';
import {
  findCtxByRepoRoot,
  pickEmptyGateCtx,
  decideRepoSwitch,
} from '../../src/main/app/window-registry';
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

describe('decideRepoSwitch (cross-repo worktree select routing)', () => {
  const live = () => ({ isDestroyed: () => false }) as never; // fake live BrowserWindow
  const ctx = (repoRoot: string | null): IpcContext => ({ mainWindow: live(), repoRoot });

  it('noop when the source window is missing, or already here with no worktree to select', () => {
    const contexts = new Map<number, IpcContext>([[1, ctx('/a')]]);
    expect(decideRepoSwitch(contexts, 9, '/a')).toEqual({ kind: 'noop' }); // wcId not registered
    expect(decideRepoSwitch(contexts, 1, '/a')).toEqual({ kind: 'noop' }); // already on /a, no wt
  });

  it('reselect (no reload) when already on the repo but a worktree is requested', () => {
    const contexts = new Map<number, IpcContext>([[1, ctx('/a')]]);
    expect(decideRepoSwitch(contexts, 1, '/a', '/a/wt')).toEqual({
      kind: 'reselect',
      worktreeId: '/a/wt',
    });
  });

  it('reload (worktree pended) when the target repo is not open in any other window', () => {
    const contexts = new Map<number, IpcContext>([[1, ctx('/a')]]);
    expect(decideRepoSwitch(contexts, 1, '/b', '/b/wt')).toEqual({
      kind: 'reload',
      worktreeId: '/b/wt',
    });
    expect(decideRepoSwitch(contexts, 1, '/b')).toEqual({ kind: 'reload', worktreeId: undefined });
  });

  it('focus the OTHER window that already owns the target repo (carrying the worktree)', () => {
    const contexts = new Map<number, IpcContext>([
      [1, ctx('/a')],
      [2, ctx('/b')],
    ]);
    expect(decideRepoSwitch(contexts, 1, '/b', '/b/wt')).toEqual({
      kind: 'focus',
      targetWcId: 2,
      worktreeId: '/b/wt',
    });
  });

  it('reloads (not focus) when the only ctx on the target repo is a destroyed window', () => {
    const dead: IpcContext = { mainWindow: { isDestroyed: () => true } as never, repoRoot: '/b' };
    const contexts = new Map<number, IpcContext>([
      [1, ctx('/a')],
      [2, dead],
    ]);
    expect(decideRepoSwitch(contexts, 1, '/b', '/b/wt')).toEqual({
      kind: 'reload',
      worktreeId: '/b/wt',
    });
  });
});
