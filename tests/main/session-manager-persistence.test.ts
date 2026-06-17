import { describe, it, expect, vi } from 'vitest';
import { SessionManager, type SessionEmitter } from '../../src/main/managers/session-manager';
import type { PtyFactory, IPtyLike } from '../../src/main/pty/pty-factory';
import { makeFakePty, type FakePtyHandle } from '../helpers/fake-pty';
import type { SessionRecord } from '../../src/shared/types';

function spyEmitter(): SessionEmitter {
  return { emitOutput: vi.fn(), emitExit: vi.fn(), emitStatus: vi.fn() };
}
function factoryOf(fakes: FakePtyHandle[]): PtyFactory {
  let i = 0;
  return {
    spawn: () => {
      const f = fakes[i++];
      if (!f) throw new Error('out of fakes');
      return f as unknown as IPtyLike;
    },
  };
}
function fakeStore() {
  const records: SessionRecord[] = [];
  return {
    upsert: vi.fn((r: SessionRecord) => {
      const idx = records.findIndex((x) => x.worktreePath === r.worktreePath);
      if (idx >= 0) records[idx] = r;
      else records.push(r);
    }),
    remove: vi.fn(),
    all: () => records,
    load: () => records,
    records,
  };
}

const WT = '/repo/.worktrees/feat';

describe('SessionManager persistence hook', () => {
  it('upserts {hadActiveSession:true} with branch + clock time on a successful spawn', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      resolveBranch: async () => 'feature/login',
      store: store as never,
      clock: () => 555,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(store.upsert).toHaveBeenCalledWith({
      worktreePath: WT,
      branch: 'feature/login',
      hadActiveSession: true,
      updatedAt: 555,
    });
  });

  it('does NOT upsert when the worktree id is unknown (spawn errored, no PTY)', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty()]),
      emitter: spyEmitter(),
      resolvePath: async () => undefined,
      store: store as never,
    });
    const s = await mgr.spawn({ worktreeId: '/nope', continueSession: false, cols: 80, rows: 24 });
    expect(s.status).toBe('error');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('works with no store/clock injected (back-compat for existing tests)', async () => {
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(9)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
    });
    const s = await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(s.status).toBe('running'); // no throw despite absent store/branch resolver
  });

  it('liveWorktreeIds() lists worktrees with a running PTY, excluding exited ones', async () => {
    const a = makeFakePty(1);
    const b = makeFakePty(2);
    const mgr = new SessionManager({
      factory: factoryOf([a, b]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
    });
    await mgr.spawn({ worktreeId: '/wt/a', continueSession: false, cols: 80, rows: 24 });
    await mgr.spawn({ worktreeId: '/wt/b', continueSession: false, cols: 80, rows: 24 });
    expect(mgr.liveWorktreeIds().sort()).toEqual(['/wt/a', '/wt/b']);
    a.emitExit(0);
    expect(mgr.liveWorktreeIds()).toEqual(['/wt/b']);
  });

  it('liveWorktreeIds() is empty after killAll (quit sweep leaves nothing live)', async () => {
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty()]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.killAll();
    expect(mgr.liveWorktreeIds()).toEqual([]);
  });
});
