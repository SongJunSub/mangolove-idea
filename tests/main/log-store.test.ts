import { describe, it, expect } from 'vitest';
import { LogStore, type LogEmitter } from '../../src/main/managers/log-store';
import type { LogLine } from '../../src/shared/types';

const A = '/repo/.worktrees/a';
const B = '/repo/.worktrees/b';

function makeStore(cap?: number) {
  const lines: LogLine[] = [];
  const emitter: LogEmitter = { emitLine: (l) => void lines.push(l) };
  const store = new LogStore(emitter, cap);
  return { store, lines };
}

describe('LogStore line splitting (per worktree)', () => {
  it('splits a chunk into one LogLine per newline and keeps order + worktreeId', () => {
    const { store, lines } = makeStore();
    store.append(A, 'stdout', 'a\nb\nc\n');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(lines.every((l) => l.worktreeId === A)).toBe(true);
  });

  it('carries a partial line across chunks within one worktree', () => {
    const { store, lines } = makeStore();
    store.append(A, 'stdout', 'hel');
    store.append(A, 'stdout', 'lo\nworld');
    expect(lines.map((l) => l.text)).toEqual(['hello']);
    store.flush(A);
    expect(lines.map((l) => l.text)).toEqual(['hello', 'world']);
  });

  it('strips a trailing CR', () => {
    const { store, lines } = makeStore();
    store.append(A, 'stderr', 'oops\r\n');
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
    store.append(A, 'stdout', text + '\n');
    expect(lines[0].level).toBe(level);
  });

  it('defaults stderr with no level token to error', () => {
    const { store, lines } = makeStore();
    store.append(A, 'stderr', '\tat com.x.Foo(Foo.java:1)\n');
    expect(lines[0].level).toBe('error');
  });
});

describe('LogStore per-worktree partition', () => {
  it('keeps two worktrees fully independent (buffers + monotonic seq)', () => {
    const { store } = makeStore();
    store.append(A, 'stdout', 'a1\na2\n');
    store.append(B, 'stdout', 'b1\n');
    store.append(A, 'stdout', 'a3\n');
    expect(store.snapshot(A).map((l) => [l.seq, l.text])).toEqual([
      [0, 'a1'],
      [1, 'a2'],
      [2, 'a3'],
    ]);
    expect(store.snapshot(B).map((l) => [l.seq, l.text])).toEqual([[0, 'b1']]);
  });

  it('snapshot of an unseen worktree is empty (implicit-create)', () => {
    const { store } = makeStore();
    expect(store.snapshot('/never')).toEqual([]);
  });

  it('caps the ring PER worktree (one worktree overflowing does not evict another)', () => {
    const { store } = makeStore(3);
    store.append(B, 'stdout', 'keep\n');
    store.append(A, 'stdout', 'a\nb\nc\nd\ne\n');
    expect(store.snapshot(A).map((l) => l.text)).toEqual(['c', 'd', 'e']);
    expect(store.snapshot(A).map((l) => l.seq)).toEqual([2, 3, 4]);
    expect(store.snapshot(B).map((l) => l.text)).toEqual(['keep']);
  });

  it('reset clears ONLY that worktree (buffer, carry, seq) and leaves others', () => {
    const { store } = makeStore();
    store.append(A, 'stdout', 'a\npartial');
    store.append(B, 'stdout', 'b\n');
    store.reset(A);
    expect(store.snapshot(A)).toEqual([]);
    store.append(A, 'stdout', 'fresh\n');
    expect(store.snapshot(A)[0].seq).toBe(0);
    expect(store.snapshot(A)[0].text).toBe('fresh');
    expect(store.snapshot(B).map((l) => l.text)).toEqual(['b']);
  });

  it('removeWorktree drops the partition entirely', () => {
    const { store } = makeStore();
    store.append(A, 'stdout', 'a\n');
    store.removeWorktree(A);
    expect(store.snapshot(A)).toEqual([]);
  });

  it('flush(worktreeId) only flushes that worktree partial', () => {
    const { store, lines } = makeStore();
    store.append(A, 'stdout', 'aPartial');
    store.append(B, 'stdout', 'bPartial');
    store.flush(A);
    expect(lines.map((l) => [l.worktreeId, l.text])).toEqual([[A, 'aPartial']]);
  });
});
