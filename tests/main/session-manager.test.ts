import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager, type SessionEmitter } from '../../src/main/managers/session-manager';
import type { PtyFactory, IPtyLike } from '../../src/main/pty/pty-factory';
import { makeFakePty, type FakePtyHandle } from '../helpers/fake-pty';
import type { AgentSession } from '../../src/shared/types';

/** A spy emitter capturing every event SessionManager publishes. */
function makeSpyEmitter() {
  const outputs: { worktreeId: string; data: string }[] = [];
  const exits: { worktreeId: string; exitCode: number; signal?: number }[] = [];
  const statuses: AgentSession[] = [];
  const emitter: SessionEmitter = {
    emitOutput: (e) => void outputs.push(e),
    emitExit: (e) => void exits.push(e),
    emitStatus: (s) => void statuses.push(s),
  };
  return { emitter, outputs, exits, statuses };
}

/** A PtyFactory that hands back a queue of pre-built fakes and records spawn args. */
function makeFakeFactory(fakes: FakePtyHandle[]) {
  const calls: {
    file: string;
    args: readonly string[];
    cwd: string;
    cols: number;
    rows: number;
  }[] = [];
  let i = 0;
  const factory: PtyFactory = {
    spawn: (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
      const fake = fakes[i++];
      if (!fake) throw new Error('fake factory ran out of PTYs');
      return fake as unknown as IPtyLike;
    },
  };
  return { factory, calls };
}

const WT = '/repo/.worktrees/feat';

function makeManager(opts: {
  fakes: FakePtyHandle[];
  resolvePath?: (id: string) => Promise<string | undefined>;
  command?: string;
}) {
  const { factory, calls } = makeFakeFactory(opts.fakes);
  const { emitter, outputs, exits, statuses } = makeSpyEmitter();
  const mgr = new SessionManager({
    factory,
    emitter,
    command: opts.command ?? 'claude',
    resolvePath: opts.resolvePath ?? (async (id) => id),
  });
  return { mgr, calls, outputs, exits, statuses };
}

describe('SessionManager.spawn', () => {
  let fake: FakePtyHandle;
  beforeEach(() => {
    fake = makeFakePty(1234);
  });

  it('spawns claude in the worktree cwd and returns a running AgentSession', async () => {
    const { mgr, calls } = makeManager({ fakes: [fake] });
    const session = await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ file: 'claude', args: [], cwd: WT, cols: 80, rows: 24 });
    expect(session).toEqual({
      worktreeId: WT,
      pid: 1234,
      status: 'running',
      hasActiveTurn: false,
      continued: false,
    });
  });

  it('passes --continue when continueSession is true and marks continued', async () => {
    const { mgr, calls } = makeManager({ fakes: [fake] });
    const session = await mgr.spawn({ worktreeId: WT, continueSession: true, cols: 80, rows: 24 });
    expect(calls[0].args).toEqual(['--continue']);
    expect(session.continued).toBe(true);
  });

  it('emits a starting then running status during spawn', async () => {
    const { mgr, statuses } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(statuses.map((s) => s.status)).toEqual(['starting', 'running']);
  });

  it('forwards PTY data as SESSION_OUTPUT events keyed by worktreeId', async () => {
    const { mgr, outputs } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitData('hello');
    expect(outputs).toEqual([{ worktreeId: WT, data: 'hello' }]);
  });

  it('returns status:error (no PTY) when the worktree id is unknown', async () => {
    const { mgr, calls, statuses } = makeManager({
      fakes: [fake],
      resolvePath: async () => undefined,
    });
    const session = await mgr.spawn({
      worktreeId: '/nope',
      continueSession: false,
      cols: 80,
      rows: 24,
    });
    expect(calls).toHaveLength(0);
    expect(session.status).toBe('error');
    expect(session.pid).toBeUndefined();
    expect(statuses.map((s) => s.status)).toContain('error');
  });

  it('replaces an existing PTY when spawning the same worktree again', async () => {
    const first = makeFakePty(1);
    const second = makeFakePty(2);
    const killSpy = vi.spyOn(first, 'kill');
    const { mgr, calls } = makeManager({ fakes: [first, second] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    const again = await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(killSpy).toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(again.pid).toBe(2);
  });

  it('does not emit SESSION_EXIT for a worktree being replaced (respawn)', async () => {
    const first = makeFakePty(1);
    const second = makeFakePty(2);
    const { mgr, exits } = makeManager({ fakes: [first, second] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    // Respawn: killing `first` synchronously fires its onExit, but it has already
    // been unmapped/replaced, so handleExit must swallow it — no exit leaks.
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(exits).toHaveLength(0);
  });
});

describe('SessionManager write/resize', () => {
  it('writes input to the PTY of that worktree', async () => {
    const fake = makeFakePty();
    const writeSpy = vi.spyOn(fake, 'write');
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.write({ worktreeId: WT, data: 'ls\r' });
    expect(writeSpy).toHaveBeenCalledWith('ls\r');
  });

  it('ignores input for an unknown worktree (no throw)', () => {
    const { mgr } = makeManager({ fakes: [] });
    expect(() => mgr.write({ worktreeId: '/ghost', data: 'x' })).not.toThrow();
  });

  it('resizes the PTY of that worktree', async () => {
    const fake = makeFakePty();
    const resizeSpy = vi.spyOn(fake, 'resize');
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.resize({ worktreeId: WT, cols: 120, rows: 40 });
    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
  });
});

describe('SessionManager exit + kill', () => {
  it('emits SESSION_EXIT and an exited status when the PTY exits', async () => {
    const fake = makeFakePty();
    const { mgr, exits, statuses } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitExit(0);
    expect(exits).toEqual([{ worktreeId: WT, exitCode: 0, signal: undefined }]);
    expect(statuses.at(-1)?.status).toBe('exited');
  });

  it('kill terminates the PTY and returns ok', async () => {
    const fake = makeFakePty();
    const killSpy = vi.spyOn(fake, 'kill');
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    const ack = mgr.kill(WT);
    expect(killSpy).toHaveBeenCalled();
    expect(ack).toEqual({ ok: true });
  });

  it('kill of an unknown worktree returns ok:false', () => {
    const { mgr } = makeManager({ fakes: [] });
    expect(mgr.kill('/ghost')).toEqual({ ok: false, error: 'no session for /ghost' });
  });

  it('does not leak: after exit the worktree has no live session for write', async () => {
    const fake = makeFakePty();
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitExit(0);
    expect(mgr.snapshot(WT)?.status).toBe('exited');
    // a second exit must not double-emit
  });

  it('killAll terminates every live PTY (Plan 5 hook)', async () => {
    const a = makeFakePty(1);
    const b = makeFakePty(2);
    const killA = vi.spyOn(a, 'kill');
    const killB = vi.spyOn(b, 'kill');
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.spawn({ worktreeId: '/wt/a', continueSession: false, cols: 80, rows: 24 });
    await mgr.spawn({ worktreeId: '/wt/b', continueSession: false, cols: 80, rows: 24 });
    mgr.killAll();
    expect(killA).toHaveBeenCalled();
    expect(killB).toHaveBeenCalled();
  });
});
