import { describe, it, expect } from 'vitest';
import { LogStore, type LogEmitter } from '../../src/main/managers/log-store';
import type { LogLine } from '../../src/shared/types';

function makeStore(cap?: number) {
  const lines: LogLine[] = [];
  const emitter: LogEmitter = { emitLine: (l) => void lines.push(l) };
  const store = new LogStore(emitter, cap);
  return { store, lines };
}

describe('LogStore line splitting', () => {
  it('splits a chunk into one LogLine per newline and keeps order', () => {
    const { store, lines } = makeStore();
    store.append('/wt', 'stdout', 'a\nb\nc\n');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2]);
  });

  it('carries a partial line across chunks', () => {
    const { store, lines } = makeStore();
    store.append('/wt', 'stdout', 'hel');
    store.append('/wt', 'stdout', 'lo\nworld');
    expect(lines.map((l) => l.text)).toEqual(['hello']);
    store.flush();
    expect(lines.map((l) => l.text)).toEqual(['hello', 'world']);
  });

  it('strips a trailing CR (\\r\\n line endings)', () => {
    const { store, lines } = makeStore();
    store.append('/wt', 'stderr', 'oops\r\n');
    expect(lines[0].text).toBe('oops');
    expect(lines[0].stream).toBe('stderr');
  });
});

describe('LogStore level parsing', () => {
  it.each([
    ['2026 ERROR boom', 'error'],
    ['12:00 WARN heads up', 'warn'],
    ['WARNING legacy', 'warn'],
    ['INFO started', 'info'],
    ['DEBUG x=1', 'debug'],
    ['TRACE deep', 'debug'],
    ['plain text', 'raw'],
  ] as const)('parses %j as level %s', (text, level) => {
    const { store, lines } = makeStore();
    store.append('/wt', 'stdout', text + '\n');
    expect(lines[0].level).toBe(level);
  });

  it('defaults stderr with no level token to error', () => {
    const { store, lines } = makeStore();
    store.append('/wt', 'stderr', '\tat com.x.Foo(Foo.java:1)\n');
    expect(lines[0].level).toBe('error');
  });
});

describe('LogStore ring buffer', () => {
  it('snapshot returns appended lines (newest last)', () => {
    const { store } = makeStore();
    store.append('/wt', 'stdout', 'one\ntwo\n');
    expect(store.snapshot().map((l) => l.text)).toEqual(['one', 'two']);
  });

  it('drops oldest lines past the cap but keeps monotonic seq', () => {
    const { store } = makeStore(3);
    store.append('/wt', 'stdout', 'a\nb\nc\nd\ne\n');
    const snap = store.snapshot();
    expect(snap.map((l) => l.text)).toEqual(['c', 'd', 'e']);
    expect(snap.map((l) => l.seq)).toEqual([2, 3, 4]);
  });

  it('reset clears the buffer, the partial carry, and the seq counter', () => {
    const { store } = makeStore();
    store.append('/wt', 'stdout', 'a\npartial');
    store.reset('/wt');
    expect(store.snapshot()).toEqual([]);
    store.append('/wt', 'stdout', 'fresh\n');
    expect(store.snapshot()[0].seq).toBe(0);
    expect(store.snapshot()[0].text).toBe('fresh');
  });
});
