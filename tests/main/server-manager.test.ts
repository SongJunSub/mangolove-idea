import { describe, it, expect, vi } from 'vitest';
import { ServerManager, type ServerEmitter } from '../../src/main/managers/server-manager';
import { LogStore, type LogEmitter } from '../../src/main/managers/log-store';
import type { ProcessRunner, IProcLike } from '../../src/main/proc/process-runner';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';
import type { ServerStatus, LogLine } from '../../src/shared/types';
import type { DetectedRunner } from '../../src/main/util/detect-runner';

const A = '/repo/.worktrees/a';
const B = '/repo/.worktrees/b';

function makeRunnerFactory(fakes: FakeProcHandle[]) {
  const calls: { command: string; cwd: string }[] = [];
  let i = 0;
  const runner: ProcessRunner = {
    spawn: (command, opts) => {
      calls.push({ command, cwd: opts.cwd });
      const f = fakes[i++];
      if (!f) throw new Error('fake runner ran out of procs');
      return f as unknown as IProcLike;
    },
    spawnArgs: () => {
      throw new Error('spawnArgs not used by ServerManager');
    },
  };
  return { runner, calls };
}

function makeManager(opts: {
  fakes: FakeProcHandle[];
  detect?: (dir: string) => DetectedRunner;
  resolvePath?: (id: string) => Promise<string | undefined>;
  commandOverride?: string;
  onIdle?: () => void;
}) {
  const states: ServerStatus[] = [];
  const logLines: LogLine[] = [];
  const serverEmitter: ServerEmitter = { emitState: (s) => void states.push(s) };
  const logEmitter: LogEmitter = { emitLine: (l) => void logLines.push(l) };
  const logStore = new LogStore(logEmitter);
  const { runner, calls } = makeRunnerFactory(opts.fakes);
  const mgr = new ServerManager({
    runner,
    logStore,
    emitter: serverEmitter,
    detect: opts.detect ?? (() => ({ kind: 'npm', command: 'npm run dev' })),
    resolvePath: opts.resolvePath ?? (async (id) => id),
    commandOverride: opts.commandOverride,
    onIdle: opts.onIdle,
  });
  return { mgr, states, logLines, calls, logStore };
}

describe('ServerManager.start (per worktree)', () => {
  it('detects + spawns in the worktree cwd and reaches running', async () => {
    const fake = makeFakeRunner(111);
    const { mgr, states, calls } = makeManager({ fakes: [fake] });
    const status = await mgr.start({ worktreeId: A });
    expect(calls).toEqual([{ command: 'npm run dev', cwd: A }]);
    expect(status.process.state).toBe('running');
    expect(status.process.pid).toBe(111);
    expect(status.process.kind).toBe('npm');
    expect(status.process.worktreeId).toBe(A);
    expect(states.map((s) => s.process.state)).toEqual(['starting', 'running']);
  });

  it('uses the env command override (deps) over detection', async () => {
    const fake = makeFakeRunner();
    const { mgr, calls } = makeManager({ fakes: [fake], commandOverride: 'node fake-server.js' });
    await mgr.start({ worktreeId: A });
    expect(calls[0].command).toBe('node fake-server.js');
  });

  it('pipes stdout/stderr into the LogStore stamped with the worktreeId', async () => {
    const fake = makeFakeRunner();
    const { mgr, logLines } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: A });
    fake.emitStdout('INFO up\n');
    fake.emitStderr('ERROR boom\n');
    expect(logLines.map((l) => [l.worktreeId, l.stream, l.level, l.text])).toEqual([
      [A, 'stdout', 'info', 'INFO up'],
      [A, 'stderr', 'error', 'ERROR boom'],
    ]);
  });

  it('resets ONLY that worktree LogStore seq on restart of the same worktree', async () => {
    const a1 = makeFakeRunner(1);
    const a2 = makeFakeRunner(2);
    const { mgr, logStore } = makeManager({ fakes: [a1, a2] });
    await mgr.start({ worktreeId: A });
    a1.emitStdout('first\n');
    await mgr.start({ worktreeId: A }); // replace SAME worktree -> reset(A)
    a2.emitStdout('second\n');
    expect(logStore.snapshot(A).map((l) => [l.seq, l.text])).toEqual([[0, 'second']]);
  });

  it('crashes (no spawn) when the worktree id is unknown', async () => {
    const { mgr, calls } = makeManager({
      fakes: [makeFakeRunner()],
      resolvePath: async () => undefined,
    });
    const status = await mgr.start({ worktreeId: '/nope' });
    expect(calls).toHaveLength(0);
    expect(status.process.state).toBe('crashed');
  });

  it('crashes (no spawn) when detection is unknown and no override', async () => {
    const { mgr, calls } = makeManager({
      fakes: [makeFakeRunner()],
      detect: () => ({ kind: 'unknown', command: undefined }),
    });
    const status = await mgr.start({ worktreeId: A });
    expect(calls).toHaveLength(0);
    expect(status.process.state).toBe('crashed');
  });
});

describe('ServerManager TRUE CONCURRENCY', () => {
  it('runs two worktrees at once — starting B does NOT kill A', async () => {
    const a = makeFakeRunner(1);
    const b = makeFakeRunner(2);
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    expect(a.killed()).toBe(false);
    expect(b.killed()).toBe(false);
    expect(mgr.status(A).process.state).toBe('running');
    expect(mgr.status(B).process.state).toBe('running');
    expect(mgr.liveServerWorktreeIds().sort()).toEqual([A, B].sort());
  });

  it('restarting the SAME worktree kills only that worktree old child', async () => {
    const a1 = makeFakeRunner(1);
    const a2 = makeFakeRunner(2);
    const { mgr, states } = makeManager({ fakes: [a1, a2] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: A }); // replace SAME worktree
    expect(a1.killed()).toBe(true);
    // last state for A is the NEW run's running, never a stale crashed.
    expect(states.at(-1)?.process.state).toBe('running');
    expect(states.some((s) => s.process.state === 'crashed')).toBe(false);
  });

  it('statusAll returns every worktree snapshot keyed by worktreeId', async () => {
    const a = makeFakeRunner(1);
    const b = makeFakeRunner(2);
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    const all = mgr.statusAll();
    expect(all[A].process.state).toBe('running');
    expect(all[B].process.state).toBe('running');
    expect(all[A].process.worktreeId).toBe(A);
  });
});

describe('ServerManager exit + stop (per worktree)', () => {
  it('marks crashed on a non-zero natural exit', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: A });
    fake.emitExit(1, null);
    expect(states.at(-1)?.process.state).toBe('crashed');
    expect(states.at(-1)?.process.exitCode).toBe(1);
  });

  it('marks stopped on a clean (code 0) natural exit', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: A });
    fake.emitExit(0, null);
    expect(states.at(-1)?.process.state).toBe('stopped');
  });

  it('stop(req) kills only that worktree child and ends at stopped', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    const status = await mgr.stop({ worktreeId: A });
    expect(a.killed()).toBe(true);
    expect(b.killed()).toBe(false);
    expect(status.process.state).toBe('stopped');
    expect(mgr.status(B).process.state).toBe('running');
  });

  it('stop() with no running server for that worktree returns a stopped snapshot', async () => {
    const { mgr } = makeManager({ fakes: [] });
    const status = await mgr.stop({ worktreeId: A });
    expect(status.process.state).toBe('stopped');
    expect(status.process.worktreeId).toBe(A);
  });

  it('status(worktreeId) reflects that worktree current server', async () => {
    const fake = makeFakeRunner(7);
    const { mgr } = makeManager({ fakes: [fake] });
    expect(mgr.status(A).process.state).toBe('stopped');
    await mgr.start({ worktreeId: A });
    expect(mgr.status(A).process.state).toBe('running');
    expect(mgr.status(A).process.pid).toBe(7);
  });

  it('dispose() kills ALL running children (before-quit sweep)', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    mgr.dispose();
    expect(a.killed()).toBe(true);
    expect(b.killed()).toBe(true);
  });
});

describe('ServerManager onIdle (fires only on the LAST live server)', () => {
  it('does NOT fire onIdle while another worktree server is still live', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [a, b], onIdle });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    await mgr.stop({ worktreeId: A }); // B still live
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires onIdle exactly once when the LAST live server stops', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [a, b], onIdle });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    await mgr.stop({ worktreeId: A });
    await mgr.stop({ worktreeId: B }); // last one
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('fires onIdle when the LAST server exits naturally (clean or crash)', async () => {
    const fake = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [fake], onIdle });
    await mgr.start({ worktreeId: A });
    fake.emitExit(1, null);
    expect(onIdle).toHaveBeenCalledOnce();
  });
});
