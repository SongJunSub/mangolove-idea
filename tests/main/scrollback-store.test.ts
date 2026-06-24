import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScrollbackStore,
  getDefaultScrollbackPath,
  SCROLLBACK_MAX_BYTES,
  SCROLLBACK_MAX_ENTRIES,
} from '../../src/main/managers/scrollback-store';

describe('ScrollbackStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mango-scroll-'));
    file = join(dir, 'scrollback.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('get() returns undefined when the file does not exist (never throws)', () => {
    expect(new ScrollbackStore(file).get('/wt')).toBeUndefined();
  });

  it('set() persists a buffer and get() reads it back (round-trip)', () => {
    const store = new ScrollbackStore(file);
    store.set('/wt', 'hello\x1b[0m');
    expect(existsSync(file)).toBe(true);
    expect(new ScrollbackStore(file).get('/wt')).toBe('hello\x1b[0m');
  });

  it('set() keys by worktreeId and does not clobber other entries', () => {
    const store = new ScrollbackStore(file);
    store.set('/a', 'AAA');
    store.set('/b', 'BBB');
    const reread = new ScrollbackStore(file);
    expect(reread.get('/a')).toBe('AAA');
    expect(reread.get('/b')).toBe('BBB');
  });

  it('set() overwrites the same worktreeId', () => {
    const store = new ScrollbackStore(file);
    store.set('/wt', 'first');
    store.set('/wt', 'second');
    expect(new ScrollbackStore(file).get('/wt')).toBe('second');
  });

  it('remove() drops one entry and persists; no-op when absent', () => {
    const store = new ScrollbackStore(file);
    store.set('/a', 'AAA');
    store.set('/b', 'BBB');
    store.remove('/a');
    const reread = new ScrollbackStore(file);
    expect(reread.get('/a')).toBeUndefined();
    expect(reread.get('/b')).toBe('BBB');
    // no-op remove on an absent key must not throw and must keep /b
    store.remove('/missing');
    expect(new ScrollbackStore(file).get('/b')).toBe('BBB');
  });

  it('set() CAPS a too-large buffer to SCROLLBACK_MAX_BYTES, keeping the TAIL (newest)', () => {
    const store = new ScrollbackStore(file);
    const big = 'X'.repeat(SCROLLBACK_MAX_BYTES + 5000) + 'TAIL_MARKER';
    store.set('/wt', big);
    const stored = new ScrollbackStore(file).get('/wt')!;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES);
    expect(stored.endsWith('TAIL_MARKER')).toBe(true); // newest screen survives
  });

  it('set() cap holds STRICTLY for multibyte tails (no U+FFFD overflow past the cap)', () => {
    const store = new ScrollbackStore(file);
    // Box-drawing chars are 3 bytes each (real claude TUI output): the byte-cut
    // lands mid-codepoint, so a naive subarray().toString() would emit a leading
    // U+FFFD and exceed the cap. The cap() strip must keep it <= MAX exactly.
    const big = '│'.repeat(SCROLLBACK_MAX_BYTES) + 'TAIL_MARKER';
    store.set('/wt', big);
    const stored = new ScrollbackStore(file).get('/wt')!;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES);
    expect(stored.endsWith('TAIL_MARKER')).toBe(true);
    expect(stored.startsWith('�')).toBe(false); // no leading replacement char
  });

  it('load() treats a corrupt file as empty (get -> undefined), and set() recovers', () => {
    writeFileSync(file, '{ this is not json');
    const store = new ScrollbackStore(file);
    expect(store.get('/wt')).toBeUndefined();
    store.set('/wt', 'recovered');
    expect(new ScrollbackStore(file).get('/wt')).toBe('recovered');
  });

  it('treats a non-object JSON payload as empty', () => {
    writeFileSync(file, JSON.stringify(['not', 'an', 'object']));
    expect(new ScrollbackStore(file).get('/wt')).toBeUndefined();
    writeFileSync(file, JSON.stringify('a-string'));
    expect(new ScrollbackStore(file).get('/wt')).toBeUndefined();
  });

  it('sanitizes to a string map: drops non-string values on read', () => {
    writeFileSync(file, JSON.stringify({ '/wt': 'ok', '/bad': 123, '/null': null }));
    const store = new ScrollbackStore(file);
    expect(store.get('/wt')).toBe('ok');
    expect(store.get('/bad')).toBeUndefined();
    expect(store.get('/null')).toBeUndefined();
  });

  it('getDefaultScrollbackPath joins userData + scrollback.json', () => {
    expect(getDefaultScrollbackPath(() => '/ud')).toBe(join('/ud', 'scrollback.json'));
  });

  it('caps the number of entries, evicting the least-recently-set (global backstop)', () => {
    const store = new ScrollbackStore(file);
    const n = SCROLLBACK_MAX_ENTRIES + 5;
    for (let i = 0; i < n; i++) store.set(`/wt${i}`, `data${i}`);
    const reread = new ScrollbackStore(file);
    expect(reread.get('/wt0')).toBeUndefined(); // oldest evicted
    expect(reread.get('/wt4')).toBeUndefined();
    expect(reread.get('/wt5')).toBe('data5'); // first survivor
    expect(reread.get(`/wt${n - 1}`)).toBe(`data${n - 1}`); // newest kept
    let count = 0;
    for (let i = 0; i < n; i++) if (reread.get(`/wt${i}`) !== undefined) count++;
    expect(count).toBe(SCROLLBACK_MAX_ENTRIES);
  });

  it('re-setting an old entry refreshes its recency so it is NOT evicted next', () => {
    const store = new ScrollbackStore(file);
    for (let i = 0; i < SCROLLBACK_MAX_ENTRIES; i++) store.set(`/wt${i}`, `d${i}`); // fill to cap
    store.set('/wt0', 'refreshed'); // touch the oldest -> becomes most-recent
    store.set('/wtNEW', 'new'); // over cap -> evicts the NOW-oldest (/wt1), not /wt0
    const reread = new ScrollbackStore(file);
    expect(reread.get('/wt0')).toBe('refreshed');
    expect(reread.get('/wt1')).toBeUndefined();
    expect(reread.get('/wtNEW')).toBe('new');
  });
});
