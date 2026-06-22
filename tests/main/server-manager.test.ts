import { describe, it, expect, vi } from 'vitest';
import { ServerManager, type ServerEmitter } from '../../src/main/managers/server-manager';
import { LogStore, type LogEmitter } from '../../src/main/managers/log-store';
import type { ProcessRunner, IProcLike } from '../../src/main/proc/process-runner';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';
import type { ServerStatus, LogLine } from '../../src/shared/types';
import type { DetectedRunner } from '../../src/main/util/detect-runner';

const WT = '/repo/.worktrees/feat';

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
    // ServerManager only uses the shell-line spawn; stub the argv variant so the
    // literal still satisfies ProcessRunner (used by gh, never reached here).
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

describe('ServerManager.start', () => {
  it('detects + spawns in the worktree cwd and reaches running', async () => {
    const fake = makeFakeRunner(111);
    const { mgr, states, calls } = makeManager({ fakes: [fake] });
    const status = await mgr.start({ worktreeId: WT });
    expect(calls).toEqual([{ command: 'npm run dev', cwd: WT }]);
    expect(status.process.state).toBe('running');
    expect(status.process.pid).toBe(111);
    expect(status.process.kind).toBe('npm');
    expect(status.process.worktreeId).toBe(WT);
    expect(states.map((s) => s.process.state)).toEqual(['starting', 'running']);
  });

  it('uses the env command override (deps, operator-controlled) over detection', async () => {
    // Hardening: the override comes ONLY from the main-side env seam (deps), never
    // from a renderer-supplied request field — so the renderer cannot inject a
    // command into the shell:true spawn.
    const fake = makeFakeRunner();
    const { mgr, calls } = makeManager({ fakes: [fake], commandOverride: 'node fake-server.js' });
    await mgr.start({ worktreeId: WT });
    expect(calls[0].command).toBe('node fake-server.js');
  });

  it('pipes stdout/stderr into the LogStore', async () => {
    const fake = makeFakeRunner();
    const { mgr, logLines } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: WT });
    fake.emitStdout('INFO up\n');
    fake.emitStderr('ERROR boom\n');
    expect(logLines.map((l) => [l.stream, l.level, l.text])).toEqual([
      ['stdout', 'info', 'INFO up'],
      ['stderr', 'error', 'ERROR boom'],
    ]);
  });

  it('resets the LogStore seq on each start', async () => {
    const a = makeFakeRunner(1);
    const b = makeFakeRunner(2);
    const { mgr, logStore } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: WT });
    a.emitStdout('first\n');
    await mgr.start({ worktreeId: WT }); // replace -> reset
    b.emitStdout('second\n');
    expect(logStore.snapshot(WT).map((l) => [l.seq, l.text])).toEqual([[0, 'second']]);
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
    const status = await mgr.start({ worktreeId: WT });
    expect(calls).toHaveLength(0);
    expect(status.process.state).toBe('crashed');
  });

  it('replaces a running server when start is called again (kills the old child)', async () => {
    const first = makeFakeRunner(1);
    const second = makeFakeRunner(2);
    const { mgr, calls } = makeManager({ fakes: [first, second] });
    await mgr.start({ worktreeId: WT });
    const status = await mgr.start({ worktreeId: '/repo/.worktrees/other' });
    expect(first.killed()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(status.process.pid).toBe(2);
    expect(status.process.worktreeId).toBe('/repo/.worktrees/other');
  });

  it('does NOT emit a crashed state for a server replaced by start (stale exit)', async () => {
    const first = makeFakeRunner(1);
    const second = makeFakeRunner(2);
    const { mgr, states } = makeManager({ fakes: [first, second] });
    await mgr.start({ worktreeId: WT });
    await mgr.start({ worktreeId: WT }); // replace; first's kill fires a stale exit
    // last state must be the NEW run's running, never a stale crashed.
    expect(states.at(-1)?.process.state).toBe('running');
    expect(states.some((s) => s.process.state === 'crashed')).toBe(false);
  });
});

describe('ServerManager exit + stop', () => {
  it('marks crashed on a non-zero natural exit', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: WT });
    fake.emitExit(1, null);
    expect(states.at(-1)?.process.state).toBe('crashed');
    expect(states.at(-1)?.process.exitCode).toBe(1);
  });

  it('marks stopped on a clean (code 0) natural exit', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: WT });
    fake.emitExit(0, null);
    expect(states.at(-1)?.process.state).toBe('stopped');
  });

  it('stop() kills the child and ends at stopped', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: WT });
    const status = await mgr.stop({});
    expect(fake.killed()).toBe(true);
    expect(status.process.state).toBe('stopped');
    expect(states.at(-1)?.process.state).toBe('stopped');
  });

  it('stop() with no running server returns a stopped snapshot (idempotent)', async () => {
    const { mgr } = makeManager({ fakes: [] });
    const status = await mgr.stop({});
    expect(status.process.state).toBe('stopped');
    expect(status.process.worktreeId).toBeNull();
  });

  it('status() reflects the current server', async () => {
    const fake = makeFakeRunner(7);
    const { mgr } = makeManager({ fakes: [fake] });
    expect(mgr.status().process.state).toBe('stopped');
    await mgr.start({ worktreeId: WT });
    expect(mgr.status().process.state).toBe('running');
    expect(mgr.status().process.pid).toBe(7);
  });

  it('dispose() kills any running child (before-quit sweep)', async () => {
    const fake = makeFakeRunner();
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: WT });
    mgr.dispose();
    expect(fake.killed()).toBe(true);
  });
});

describe('ServerManager onIdle (deferred live-apply hook, V2 E)', () => {
  it('fires onIdle when stop() ends the running server', async () => {
    const fake = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [fake], onIdle });
    await mgr.start({ worktreeId: WT });
    expect(onIdle).not.toHaveBeenCalled();
    await mgr.stop({});
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('fires onIdle when the server exits naturally', async () => {
    const fake = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [fake], onIdle });
    await mgr.start({ worktreeId: WT });
    fake.emitExit(0, null);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('fires onIdle on a crash exit too (idle either way)', async () => {
    const fake = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [fake], onIdle });
    await mgr.start({ worktreeId: WT });
    fake.emitExit(1, null);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('does NOT fire onIdle from the replace path (still busy with the new server)', async () => {
    const first = makeFakeRunner(1);
    const second = makeFakeRunner(2);
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [first, second], onIdle });
    await mgr.start({ worktreeId: WT });
    await mgr.start({ worktreeId: '/repo/.worktrees/other' }); // replace -> still busy
    expect(onIdle).not.toHaveBeenCalled();
  });
});
