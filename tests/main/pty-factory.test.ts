import { describe, it, expect, vi } from 'vitest';
import { NodePtyFactory } from '../../src/main/pty/pty-factory';

/** A fake node-pty module that records the opts forwarded to spawn(). */
function fakeNodePty() {
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const proc = {
    pid: 123,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn(() => ({ dispose() {} })),
  };
  const mod = {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      return proc;
    },
  };
  return { mod, calls };
}

describe('NodePtyFactory color capability', () => {
  it('advertises 256-color TERM + truecolor COLORTERM so accent colors are not downgraded to red', () => {
    const { mod, calls } = fakeNodePty();
    const factory = new NodePtyFactory(mod as never);
    factory.spawn('bash', [], { cwd: '/x', cols: 80, rows: 24, env: { PATH: '/usr/bin' } });
    expect(calls[0].opts.name).toBe('xterm-256color'); // → TERM=xterm-256color (256 colors)
    const env = calls[0].opts.env as Record<string, string>;
    expect(env.COLORTERM).toBe('truecolor'); // → chalk/supports-color enable 24-bit
    expect(env.PATH).toBe('/usr/bin'); // preserves the caller's env
  });

  it('honors an explicit name override but still advertises truecolor', () => {
    const { mod, calls } = fakeNodePty();
    const factory = new NodePtyFactory(mod as never);
    factory.spawn('bash', [], { cwd: '/x', cols: 80, rows: 24, name: 'screen-256color' });
    expect(calls[0].opts.name).toBe('screen-256color');
    expect((calls[0].opts.env as Record<string, string>).COLORTERM).toBe('truecolor');
  });
});
