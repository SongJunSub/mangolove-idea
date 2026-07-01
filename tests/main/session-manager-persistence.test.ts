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
  // recordActive is fire-and-forget from write() (it awaits resolveBranch) — flush it.
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('upserts {hadActiveSession:true} on the first user SUBMIT (CR/LF), not on spawn', async () => {
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
    expect(store.upsert).not.toHaveBeenCalled(); // spawn alone marks nothing resumable

    mgr.write({ worktreeId: WT, data: 'hi\r' }); // the user sends a line
    await tick();
    expect(store.upsert).toHaveBeenCalledWith({
      worktreePath: WT,
      branch: 'feature/login',
      hadActiveSession: true,
      updatedAt: 555,
    });
  });

  it('does NOT record on a terminal AUTO-REPLY (xterm answering claude, no keystroke)', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      store: store as never,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.write({ worktreeId: WT, data: '\x1b[24;80R' }); // a cursor-position (DSR/CPR) reply
    mgr.write({ worktreeId: WT, data: '\x1b[?1;2c' }); // a device-attributes (DA1) reply
    await tick();
    expect(store.upsert).not.toHaveBeenCalled(); // auto-replies never mark a worktree resumable
  });

  it('does NOT record a multi-line PASTE that was never submitted (bracketed-paste envelope)', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      store: store as never,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    // xterm rewrites pasted \n → \r, wrapped in ESC[200~ … ESC[201~ — but nothing was submitted.
    mgr.write({ worktreeId: WT, data: '\x1b[200~line one\rline two\x1b[201~' });
    await tick();
    expect(store.upsert).not.toHaveBeenCalled();

    mgr.write({ worktreeId: WT, data: '\r' }); // NOW the user hits Enter → recorded
    await tick();
    expect(store.upsert).toHaveBeenCalledTimes(1);
  });

  it('records ONCE on submit, not per keystroke (typing then Enter → single disk write)', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      store: store as never,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.write({ worktreeId: WT, data: 'h' }); // keystrokes before Enter: no record yet
    mgr.write({ worktreeId: WT, data: 'i' });
    await tick();
    expect(store.upsert).not.toHaveBeenCalled();
    mgr.write({ worktreeId: WT, data: '\r' }); // Enter → record once
    mgr.write({ worktreeId: WT, data: 'more\r' }); // subsequent submits do not re-write
    await tick();
    expect(store.upsert).toHaveBeenCalledTimes(1);
  });

  it('does NOT record an opened-but-never-typed worktree (the doomed-continue fix)', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      store: store as never,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    await tick(); // no input ever
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('b-full (launcher.isLiveDetached present) records at SPAWN so boot-reap can track it', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      resolveBranch: async () => 'feat/x',
      store: store as never,
      clock: () => 99,
      launcher: {
        resolveLaunch: () => ({ file: 'abduco', args: [] }),
        isLiveDetached: async () => false,
      },
    });
    await mgr.spawn({ worktreeId: WT, continueSession: true, cols: 80, rows: 24 });
    // No input yet, but b-full must persist immediately (reap is record-driven).
    expect(store.upsert).toHaveBeenCalledWith({
      worktreePath: WT,
      branch: 'feat/x',
      hadActiveSession: true,
      updatedAt: 99,
    });
  });

  it('PRUNES the stale record when a --continue self-heals (older-build records self-correct)', async () => {
    const store = fakeStore();
    const cont = makeFakePty(1);
    const fresh = makeFakePty(2);
    const mgr = new SessionManager({
      factory: factoryOf([cont, fresh]), // continue + the fresh respawn
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      store: store as never,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: true, cols: 80, rows: 24 });

    cont.emitExit(1); // --continue found no conversation: low output + nonzero → self-heal
    await tick();

    // The stale record is dropped so the NEXT open skips the doomed continue and goes fresh.
    expect(store.remove).toHaveBeenCalledWith(WT);
  });

  it('b-full self-heal does NOT prune the record (reap tracks detached sessions by record)', async () => {
    const store = fakeStore();
    const cont = makeFakePty(1);
    const fresh = makeFakePty(2);
    const mgr = new SessionManager({
      factory: factoryOf([cont, fresh]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      store: store as never,
      launcher: {
        resolveLaunch: () => ({ file: 'abduco', args: [] }),
        isLiveDetached: async () => false, // b-full, but no live session → 'continue'
      },
    });
    await mgr.spawn({ worktreeId: WT, continueSession: true, cols: 80, rows: 24 });

    cont.emitExit(1); // self-heal fires...
    await tick();

    expect(store.remove).not.toHaveBeenCalled(); // ...but the reap record is preserved in b-full
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
