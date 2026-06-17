import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/main/managers/session-store';
import type { SessionRecord } from '../../src/shared/types';

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    worktreePath: '/wt/a',
    branch: 'feat',
    hadActiveSession: true,
    updatedAt: 1000,
    ...over,
  };
}

describe('SessionStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mango-ss-'));
    file = join(dir, 'sessions.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('load() returns [] when the file does not exist (never throws)', () => {
    const store = new SessionStore(file);
    expect(store.load()).toEqual([]);
    expect(store.all()).toEqual([]);
  });

  it('upsert() persists a record and load() reads it back', () => {
    const store = new SessionStore(file);
    store.upsert(rec());
    expect(existsSync(file)).toBe(true);
    expect(new SessionStore(file).load()).toEqual([rec()]);
  });

  it('upsert() replaces by worktreePath (no duplicates)', () => {
    const store = new SessionStore(file);
    store.upsert(rec({ updatedAt: 1 }));
    store.upsert(rec({ branch: 'feat2', updatedAt: 2 }));
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(rec({ branch: 'feat2', updatedAt: 2 }));
  });

  it('upsert() appends distinct worktreePaths', () => {
    const store = new SessionStore(file);
    store.upsert(rec({ worktreePath: '/wt/a' }));
    store.upsert(rec({ worktreePath: '/wt/b' }));
    expect(store.all().map((r) => r.worktreePath)).toEqual(['/wt/a', '/wt/b']);
  });

  it('remove() drops the record for a worktreePath and is a no-op otherwise', () => {
    const store = new SessionStore(file);
    store.upsert(rec({ worktreePath: '/wt/a' }));
    store.upsert(rec({ worktreePath: '/wt/b' }));
    store.remove('/wt/a');
    expect(store.all().map((r) => r.worktreePath)).toEqual(['/wt/b']);
    expect(() => store.remove('/ghost')).not.toThrow();
    expect(store.all()).toHaveLength(1);
  });

  it('load() treats a corrupt file as empty (never throws)', () => {
    writeFileSync(file, '{ this is not json');
    const store = new SessionStore(file);
    expect(store.load()).toEqual([]);
    // and a subsequent upsert recovers cleanly
    store.upsert(rec());
    expect(new SessionStore(file).load()).toEqual([rec()]);
  });

  it('load() treats a non-array JSON payload as empty', () => {
    writeFileSync(file, JSON.stringify({ not: 'an array' }));
    expect(new SessionStore(file).load()).toEqual([]);
  });

  it('persists ONLY the 4 SessionRecord fields — never conversation content', () => {
    const store = new SessionStore(file);
    // even if a caller smuggles extra keys, only the contract fields are written.
    store.upsert({ ...rec(), transcript: 'SECRET CONVERSATION' } as unknown as SessionRecord);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('SECRET CONVERSATION');
    expect(raw).not.toContain('transcript');
    expect(Object.keys(new SessionStore(file).load()[0]).sort()).toEqual([
      'branch',
      'hadActiveSession',
      'updatedAt',
      'worktreePath',
    ]);
  });
});
