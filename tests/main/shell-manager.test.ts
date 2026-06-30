import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ShellManager } from '../../src/main/managers/shell-manager';
import type { IPtyLike, PtyFactory } from '../../src/main/pty/pty-factory';

/** A spy-able fake PTY: write/resize/kill are vi.fn; emitData/emitExit drive it from tests. */
function fakePty(): IPtyLike & {
  emitData(d: string): void;
  emitExit(code: number, sig?: number): void;
} {
  const bus = new EventEmitter();
  return {
    pid: 1,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => bus.emit('exit', { exitCode: 0 })),
    onData: (cb) => void bus.on('data', cb),
    onExit: (cb) => void bus.on('exit', (e) => cb(e)),
    emitData: (d) => bus.emit('data', d),
    emitExit: (code, sig) => bus.emit('exit', { exitCode: code, signal: sig }),
  };
}

function setup() {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const factory: PtyFactory = {
    spawn: vi.fn(() => {
      const p = fakePty();
      spawned.push(p);
      return p;
    }),
  };
  const out: Array<{ id: string; data: string }> = [];
  const exits: Array<{ id: string; code: number }> = [];
  const mgr = new ShellManager({
    factory,
    shellPath: '/bin/zsh',
    emitOutput: (id, data) => out.push({ id, data }),
    emitExit: (id, code) => exits.push({ id, code }),
  });
  return { mgr, factory, spawned, out, exits };
}

describe('ShellManager', () => {
  it('spawns the login shell in the requested cwd and streams output', () => {
    const { mgr, factory, spawned, out } = setup();
    expect(mgr.spawn({ terminalId: 't1', cwd: '/repo/wt', cols: 100, rows: 30 })).toEqual({
      ok: true,
    });
    expect(factory.spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], {
      cwd: '/repo/wt',
      cols: 100,
      rows: 30,
      env: undefined,
    });
    spawned[0].emitData('hello');
    expect(out).toEqual([{ id: 't1', data: 'hello' }]);
    expect(mgr.liveCount()).toBe(1);
  });

  it('routes input + resize to the right terminal only', () => {
    const { mgr, spawned } = setup();
    mgr.spawn({ terminalId: 'a', cwd: '/r', cols: 80, rows: 24 });
    mgr.spawn({ terminalId: 'b', cwd: '/r', cols: 80, rows: 24 });
    mgr.input({ terminalId: 'a', data: 'ls\n' });
    mgr.resize({ terminalId: 'b', cols: 120, rows: 40 });
    expect(spawned[0].write).toHaveBeenCalledWith('ls\n');
    expect(spawned[1].write).not.toHaveBeenCalled();
    expect(spawned[1].resize).toHaveBeenCalledWith(120, 40);
    expect(spawned[0].resize).not.toHaveBeenCalled();
  });

  it('emits exit and drops the terminal when the shell exits', () => {
    const { mgr, spawned, exits } = setup();
    mgr.spawn({ terminalId: 't1', cwd: '/r', cols: 80, rows: 24 });
    spawned[0].emitExit(0);
    expect(exits).toEqual([{ id: 't1', code: 0 }]);
    expect(mgr.liveCount()).toBe(0);
    // input to an exited terminal is a no-op (no throw)
    expect(() => mgr.input({ terminalId: 't1', data: 'x' })).not.toThrow();
  });

  it('re-spawning the same id kills the previous shell first', () => {
    const { mgr, spawned } = setup();
    mgr.spawn({ terminalId: 't1', cwd: '/r', cols: 80, rows: 24 });
    mgr.spawn({ terminalId: 't1', cwd: '/r2', cols: 80, rows: 24 });
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(mgr.liveCount()).toBe(1); // only the new one
  });

  it('a late exit from a killed/replaced pty does not drop the live terminal', () => {
    const { mgr, spawned, exits } = setup();
    mgr.spawn({ terminalId: 't1', cwd: '/r', cols: 80, rows: 24 }); // spawned[0]
    mgr.spawn({ terminalId: 't1', cwd: '/r2', cols: 80, rows: 24 }); // spawned[1] (replaces)
    exits.length = 0;
    spawned[0].emitExit(0); // OLD pty exits late
    expect(exits).toEqual([]); // identity guard drops it
    expect(mgr.liveCount()).toBe(1);
  });

  it('killAll kills every live shell; dispose also clears so late exits are stale', () => {
    const { mgr, spawned, exits } = setup();
    mgr.spawn({ terminalId: 'a', cwd: '/r', cols: 80, rows: 24 });
    mgr.spawn({ terminalId: 'b', cwd: '/r', cols: 80, rows: 24 });
    mgr.dispose();
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].kill).toHaveBeenCalled();
    exits.length = 0;
    spawned[0].emitExit(0); // post-dispose straggler
    expect(exits).toEqual([]);
    expect(mgr.liveCount()).toBe(0);
  });

  it('returns an error Ack AND surfaces the failure as terminal output (no silent dead tab)', () => {
    const { mgr, factory, out } = setup();
    (factory.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('node-pty unavailable');
    });
    const ack = mgr.spawn({ terminalId: 't1', cwd: '/r', cols: 80, rows: 24 });
    expect(ack).toEqual({ ok: false, error: 'node-pty unavailable' });
    expect(out.some((o) => o.id === 't1' && o.data.includes('node-pty unavailable'))).toBe(true);
  });

  it('after respawn (reused id), late output from the OLD pty does NOT bleed into the new one', () => {
    const { mgr, spawned, out } = setup();
    mgr.spawn({ terminalId: 't1', cwd: '/r', cols: 80, rows: 24 }); // spawned[0] (old)
    mgr.spawn({ terminalId: 't1', cwd: '/r2', cols: 80, rows: 24 }); // spawned[1] (new, same id)
    out.length = 0;
    spawned[0].emitData('stale'); // OLD pty trailing bytes — must be dropped
    expect(out).toEqual([]);
    spawned[1].emitData('fresh'); // NEW pty still streams
    expect(out).toEqual([{ id: 't1', data: 'fresh' }]);
  });
});
