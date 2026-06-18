import { EventEmitter } from 'node:events';
import type { IProcLike } from '../../src/main/proc/process-runner';

/** Fake IProcLike driven from tests (mirrors FakePtyHandle). */
export interface FakeProcHandle extends IProcLike {
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  /** Simulate the child exiting (no-op once killed/exited). */
  emitExit(code: number | null, signal?: string | null): void;
  /** Subscribe to a spawn-level error (e.g. ENOENT for a missing binary). */
  onError(cb: (err: Error) => void): void;
  /** Simulate a spawn 'error' event (no exit follows). */
  emitError(err: Error): void;
  /** True once kill() was called. */
  readonly killed: () => boolean;
}

/** Builds an EventEmitter-backed fake child process for windowless tests. */
export function makeFakeRunner(pid = 5252): FakeProcHandle {
  const bus = new EventEmitter();
  let done = false;
  return {
    pid,
    kill: () => {
      if (done) return;
      done = true;
      bus.emit('exit', { code: null, signal: 'SIGTERM' });
    },
    onStdout: (cb) => void bus.on('stdout', cb),
    onStderr: (cb) => void bus.on('stderr', cb),
    onExit: (cb) => void bus.on('exit', cb),
    onError: (cb) => void bus.on('procError', cb),
    emitStdout: (chunk) => bus.emit('stdout', chunk),
    emitStderr: (chunk) => bus.emit('stderr', chunk),
    emitExit: (code, signal = null) => {
      if (done) return;
      done = true;
      bus.emit('exit', { code, signal });
    },
    emitError: (err) => bus.emit('procError', err),
    killed: () => done,
  };
}
