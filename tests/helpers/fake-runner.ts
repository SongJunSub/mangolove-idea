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

/**
 * Builds an EventEmitter-backed fake child process for windowless tests.
 *
 * The bus BUFFERS-and-REPLAYS: an emit that happens before any listener has
 * subscribed is replayed to the first listener that subscribes for that event.
 * This lets tests drive a multi-step async consumer (e.g. GhStatusReader, which
 * `await`s several closures before it subscribes via spawnArgs) by emitting all
 * events synchronously up front. Consumers that subscribe BEFORE emitting (e.g.
 * ServerManager, which `await`s start() to completion first) are unaffected.
 */
export function makeFakeRunner(pid = 5252): FakeProcHandle {
  const bus = new EventEmitter();
  const pending = new Map<string, unknown[][]>();
  let done = false;

  const on = (event: string, cb: (...args: unknown[]) => void): void => {
    bus.on(event, cb);
    const queued = pending.get(event);
    if (queued) {
      pending.delete(event);
      for (const args of queued) cb(...args);
    }
  };
  const emit = (event: string, ...args: unknown[]): void => {
    if (bus.listenerCount(event) === 0) {
      const queued = pending.get(event) ?? [];
      queued.push(args);
      pending.set(event, queued);
      return;
    }
    bus.emit(event, ...args);
  };

  return {
    pid,
    kill: () => {
      if (done) return;
      done = true;
      emit('exit', { code: null, signal: 'SIGTERM' });
    },
    onStdout: (cb) => on('stdout', (c) => cb(c as string)),
    onStderr: (cb) => on('stderr', (c) => cb(c as string)),
    onExit: (cb) => on('exit', (e) => cb(e as Parameters<typeof cb>[0])),
    onError: (cb) => on('procError', (e) => cb(e as Error)),
    emitStdout: (chunk) => emit('stdout', chunk),
    emitStderr: (chunk) => emit('stderr', chunk),
    emitExit: (code, signal = null) => {
      if (done) return;
      done = true;
      emit('exit', { code, signal });
    },
    emitError: (err) => emit('procError', err),
    killed: () => done,
  };
}
