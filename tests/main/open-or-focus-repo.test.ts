import { describe, it, expect, vi } from 'vitest';
import {
  findCtxByRepoRoot,
  pickEmptyGateCtx,
  decideRepoSwitch,
  applyRepoSwitchAction,
  decideOpenNewWindow,
  applyOpenWindowAction,
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

describe('applyRepoSwitchAction (side-effect interpretation of a switch)', () => {
  const live = () => ({ isDestroyed: () => false }) as never;
  const ctx = (repoRoot: string | null): IpcContext => ({ mainWindow: live(), repoRoot });
  const fx = () => ({ rebind: vi.fn(), reload: vi.fn(), selectWorktree: vi.fn(), focus: vi.fn() });

  it('noop performs no side effects', () => {
    const f = fx();
    applyRepoSwitchAction({ kind: 'noop' }, 1, '/a', new Map([[1, ctx('/a')]]), f);
    expect(f.rebind).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.selectWorktree).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
  });

  it('reselect only nudges THIS window (no reload / focus / rebind)', () => {
    const c = ctx('/a');
    const f = fx();
    applyRepoSwitchAction({ kind: 'reselect', worktreeId: '/a/wt' }, 1, '/a', new Map([[1, c]]), f);
    expect(f.selectWorktree).toHaveBeenCalledWith(c, '/a/wt');
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.rebind).not.toHaveBeenCalled();
  });

  it('reload rebinds THIS window, pends the worktree, then reloads', () => {
    const c = ctx('/a');
    const f = fx();
    applyRepoSwitchAction({ kind: 'reload', worktreeId: '/b/wt' }, 1, '/b', new Map([[1, c]]), f);
    expect(f.rebind).toHaveBeenCalledWith(c, '/b');
    expect(c.pendingSelectWorktreeId).toBe('/b/wt');
    expect(f.reload).toHaveBeenCalledWith(c);
  });

  it('reload WITHOUT a worktree clears pending to null (no stale target inherited)', () => {
    const c = ctx('/a');
    c.pendingSelectWorktreeId = '/stale';
    applyRepoSwitchAction({ kind: 'reload' }, 1, '/b', new Map([[1, c]]), fx());
    expect(c.pendingSelectWorktreeId).toBeNull();
  });

  it('focus pends the worktree on the OTHER window, nudges it, focuses it (current untouched)', () => {
    const c = ctx('/a');
    const other = ctx('/b');
    const f = fx();
    const contexts = new Map<number, IpcContext>([
      [1, c],
      [2, other],
    ]);
    applyRepoSwitchAction(
      { kind: 'focus', targetWcId: 2, worktreeId: '/b/wt' },
      1,
      '/b',
      contexts,
      f,
    );
    expect(other.pendingSelectWorktreeId).toBe('/b/wt');
    expect(f.selectWorktree).toHaveBeenCalledWith(other, '/b/wt');
    expect(f.focus).toHaveBeenCalledWith(other);
    expect(f.reload).not.toHaveBeenCalled();
    expect(c.pendingSelectWorktreeId).toBeUndefined();
  });

  it('focus WITHOUT a worktree only focuses (pends null, no nudge)', () => {
    const other = ctx('/b');
    const f = fx();
    const contexts = new Map<number, IpcContext>([
      [1, ctx('/a')],
      [2, other],
    ]);
    applyRepoSwitchAction({ kind: 'focus', targetWcId: 2 }, 1, '/b', contexts, f);
    expect(other.pendingSelectWorktreeId).toBeNull();
    expect(f.selectWorktree).not.toHaveBeenCalled();
    expect(f.focus).toHaveBeenCalledWith(other);
  });

  it('does nothing when the focus target window is destroyed', () => {
    const dead: IpcContext = { mainWindow: { isDestroyed: () => true } as never, repoRoot: '/b' };
    const f = fx();
    const contexts = new Map<number, IpcContext>([
      [1, ctx('/a')],
      [2, dead],
    ]);
    applyRepoSwitchAction(
      { kind: 'focus', targetWcId: 2, worktreeId: '/b/wt' },
      1,
      '/b',
      contexts,
      f,
    );
    expect(f.focus).not.toHaveBeenCalled();
    expect(dead.pendingSelectWorktreeId).toBeUndefined();
  });
});

describe('decideOpenNewWindow (open repo in a new window routing)', () => {
  const live = () => ({ isDestroyed: () => false }) as never;
  const ctx = (repoRoot: string | null): IpcContext => ({ mainWindow: live(), repoRoot });

  it('create when no live window owns the repo', () => {
    expect(decideOpenNewWindow(new Map([[1, ctx('/a')]]), '/b')).toEqual({ kind: 'create' });
  });

  it('focus the existing window that owns the repo (one repo per window)', () => {
    const contexts = new Map<number, IpcContext>([
      [1, ctx('/a')],
      [2, ctx('/b')],
    ]);
    expect(decideOpenNewWindow(contexts, '/b')).toEqual({ kind: 'focus', targetWcId: 2 });
  });

  it('create (not focus) when the only ctx on the repo is a destroyed window', () => {
    const dead: IpcContext = { mainWindow: { isDestroyed: () => true } as never, repoRoot: '/b' };
    const contexts = new Map<number, IpcContext>([
      [1, ctx('/a')],
      [2, dead],
    ]);
    expect(decideOpenNewWindow(contexts, '/b')).toEqual({ kind: 'create' });
  });
});

describe('applyOpenWindowAction (side effects of opening a new window)', () => {
  const live = () => ({ isDestroyed: () => false }) as never;
  const ctx = (repoRoot: string | null): IpcContext => ({ mainWindow: live(), repoRoot });
  const fx = () => ({ createWindow: vi.fn(), focus: vi.fn() });

  it('create calls createWindow (never focus)', () => {
    const f = fx();
    applyOpenWindowAction({ kind: 'create' }, new Map(), f);
    expect(f.createWindow).toHaveBeenCalledOnce();
    expect(f.focus).not.toHaveBeenCalled();
  });

  it('focus brings the target window forward (never creates)', () => {
    const other = ctx('/b');
    const f = fx();
    applyOpenWindowAction({ kind: 'focus', targetWcId: 2 }, new Map([[2, other]]), f);
    expect(f.focus).toHaveBeenCalledWith(other);
    expect(f.createWindow).not.toHaveBeenCalled();
  });

  it('focus on a destroyed target is a no-op', () => {
    const dead: IpcContext = { mainWindow: { isDestroyed: () => true } as never, repoRoot: '/b' };
    const f = fx();
    applyOpenWindowAction({ kind: 'focus', targetWcId: 2 }, new Map([[2, dead]]), f);
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.createWindow).not.toHaveBeenCalled();
  });
});
