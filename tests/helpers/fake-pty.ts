import { EventEmitter } from 'node:events';

/** Minimal IPty surface the SessionManager depends on (Plan 2 injects this). */
export interface FakePtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  /** Test helpers to drive the fake from outside. */
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
}

/**
 * Builds an EventEmitter-backed fake PTY for windowless session tests. `killExitCode`
 * models a real pty's exit on kill (SIGTERM commonly yields a NONZERO code) — default 0
 * preserves the historical fakes; pass nonzero to exercise deliberate-kill code paths.
 */
export function makeFakePty(pid = 4242, killExitCode = 0): FakePtyHandle {
  const bus = new EventEmitter();
  let killed = false;
  return {
    pid,
    write: () => {},
    resize: () => {},
    kill: () => {
      killed = true;
      bus.emit('exit', { exitCode: killExitCode });
    },
    onData: (cb) => void bus.on('data', cb),
    onExit: (cb) => void bus.on('exit', cb),
    emitData: (data) => bus.emit('data', data),
    emitExit: (exitCode, signal) => {
      if (!killed) bus.emit('exit', { exitCode, signal });
    },
  };
}
