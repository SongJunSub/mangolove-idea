import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, getDefaultSettingsPath } from '../../src/main/managers/settings-store';

describe('SettingsStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mango-set-'));
    file = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('get() returns {} when the file does not exist (never throws)', () => {
    expect(new SettingsStore(file).get()).toEqual({});
    expect(new SettingsStore(file).load()).toEqual({});
  });

  it('set() persists a field and get() reads it back', () => {
    const store = new SettingsStore(file);
    store.set({ agentCommand: 'fake-claude' });
    expect(existsSync(file)).toBe(true);
    expect(new SettingsStore(file).get()).toEqual({ agentCommand: 'fake-claude' });
  });

  it('set() MERGES partials (does not drop previously-set fields)', () => {
    const store = new SettingsStore(file);
    store.set({ agentCommand: 'a' });
    store.set({ verifyCommand: 'true' });
    expect(new SettingsStore(file).get()).toEqual({ agentCommand: 'a', verifyCommand: 'true' });
  });

  it('set() can overwrite an existing field', () => {
    const store = new SettingsStore(file);
    store.set({ baseBranch: 'main' });
    store.set({ baseBranch: 'develop' });
    expect(new SettingsStore(file).get()).toEqual({ baseBranch: 'develop' });
  });

  it('set() treats an empty string as DELETE (a cleared field reverts to env/default)', () => {
    const store = new SettingsStore(file);
    store.set({ agentCommand: 'custom-claude', baseBranch: 'develop' });
    // The modal re-sends ALL fields; the user cleared agentCommand -> '' arrives.
    store.set({ agentCommand: '', baseBranch: 'develop' });
    const after = new SettingsStore(file).get();
    expect(after).toEqual({ baseBranch: 'develop' }); // agentCommand unset, not stuck
    expect('agentCommand' in after).toBe(false);
  });

  it('load() drops a pre-existing empty string from a hand-edited/corrupt file (never surfaces "")', () => {
    // A file written by an older/other code path (or hand-edited) carries "".
    // sanitize() must enforce the same non-empty invariant as set().
    writeFileSync(file, JSON.stringify({ agentCommand: '', baseBranch: 'main' }));
    const loaded = new SettingsStore(file).load();
    expect(loaded).toEqual({ baseBranch: 'main' });
    expect('agentCommand' in loaded).toBe(false);
  });

  it('sanitizes to ONLY the 5 known string fields (drops unknown keys + non-strings)', () => {
    const store = new SettingsStore(file);
    store.set({
      agentCommand: 'a',
      serverCommand: 'echo hi',
      // smuggled / wrong-typed inputs must be dropped:
      baseBranch: 5,
      bogus: 'SECRET',
    } as unknown as Parameters<SettingsStore['set']>[0]);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('bogus');
    expect(raw).not.toContain('SECRET');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['agentCommand', 'serverCommand']);
    expect(new SettingsStore(file).get()).toEqual({ agentCommand: 'a', serverCommand: 'echo hi' });
  });

  it('round-trips repoRoot (a known string key) and sanitizes a non-string repoRoot', () => {
    const store = new SettingsStore(file);
    store.set({ repoRoot: '/Users/me/project' });
    expect(new SettingsStore(file).get()).toEqual({ repoRoot: '/Users/me/project' });
    // a non-string repoRoot from a hand-edited file must be dropped, not surfaced
    writeFileSync(file, JSON.stringify({ repoRoot: 123, baseBranch: 'main' }));
    expect(new SettingsStore(file).load()).toEqual({ baseBranch: 'main' });
  });

  it('load() treats a corrupt file as {} (never throws), and set() recovers', () => {
    writeFileSync(file, '{ this is not json');
    const store = new SettingsStore(file);
    expect(store.load()).toEqual({});
    store.set({ agentCommand: 'a' });
    expect(new SettingsStore(file).get()).toEqual({ agentCommand: 'a' });
  });

  it('load() treats a non-object JSON payload as {}', () => {
    writeFileSync(file, JSON.stringify(['not', 'an', 'object']));
    expect(new SettingsStore(file).load()).toEqual({});
    writeFileSync(file, JSON.stringify('a-string'));
    expect(new SettingsStore(file).load()).toEqual({});
  });

  it('getDefaultSettingsPath joins userData + settings.json', () => {
    expect(getDefaultSettingsPath(() => '/ud')).toBe(join('/ud', 'settings.json'));
  });
});

describe('SettingsStore — recentRepos (multi-window)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mango-settings-'));
    file = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips a recentRepos string array', () => {
    const store = new SettingsStore(file);
    const merged = store.set({ recentRepos: ['/a', '/b'] });
    expect(merged.recentRepos).toEqual(['/a', '/b']);
    expect(new SettingsStore(file).get().recentRepos).toEqual(['/a', '/b']);
  });

  it('sanitizes a corrupt recentRepos: drops non-strings and empty strings', () => {
    writeFileSync(file, JSON.stringify({ recentRepos: ['/ok', '', 3, null, '/two'] }));
    expect(new SettingsStore(file).get().recentRepos).toEqual(['/ok', '/two']);
  });

  it('treats a non-array recentRepos as absent', () => {
    writeFileSync(file, JSON.stringify({ recentRepos: 'nope' }));
    expect(new SettingsStore(file).get().recentRepos).toBeUndefined();
  });

  it('set({recentRepos: []}) clears the list (unset)', () => {
    const store = new SettingsStore(file);
    store.set({ recentRepos: ['/a'] });
    const merged = store.set({ recentRepos: [] });
    expect(merged.recentRepos).toBeUndefined();
  });

  it('leaves recentRepos untouched when the partial omits it (true partial-merge)', () => {
    const store = new SettingsStore(file);
    store.set({ recentRepos: ['/keep'] });
    store.set({ agentCommand: 'claude' });
    expect(new SettingsStore(file).get().recentRepos).toEqual(['/keep']);
  });

  describe('paneLayout (drag-resize splitters)', () => {
    it('persists a valid paneLayout and reads it back', () => {
      const store = new SettingsStore(file);
      const merged = store.set({ paneLayout: { leftColWidth: 320, topRowFraction: 1.5 } });
      expect(merged.paneLayout).toEqual({ leftColWidth: 320, topRowFraction: 1.5 });
      expect(new SettingsStore(file).get().paneLayout).toEqual({
        leftColWidth: 320,
        topRowFraction: 1.5,
      });
    });

    it('CLAMPS out-of-range values on write (so a pane can never collapse)', () => {
      const store = new SettingsStore(file);
      const merged = store.set({ paneLayout: { leftColWidth: 9999, topRowFraction: 0.001 } });
      expect(merged.paneLayout).toEqual({ leftColWidth: 640, topRowFraction: 0.25 });
      const tiny = store.set({ paneLayout: { leftColWidth: 1, topRowFraction: 99 } });
      expect(tiny.paneLayout).toEqual({ leftColWidth: 160, topRowFraction: 4 });
    });

    it('CLAMPS a hand-edited/stale file on read', () => {
      writeFileSync(file, JSON.stringify({ paneLayout: { leftColWidth: 0, topRowFraction: -5 } }));
      expect(new SettingsStore(file).get().paneLayout).toEqual({
        leftColWidth: 160,
        topRowFraction: 0.25,
      });
    });

    it('treats a non-object / non-finite paneLayout as unset (revert to CSS defaults)', () => {
      writeFileSync(file, JSON.stringify({ paneLayout: 'nope' }));
      expect(new SettingsStore(file).get().paneLayout).toBeUndefined();
      writeFileSync(file, JSON.stringify({ paneLayout: { leftColWidth: 'x', topRowFraction: 1 } }));
      expect(new SettingsStore(file).get().paneLayout).toBeUndefined();
      writeFileSync(
        file,
        JSON.stringify({ paneLayout: { leftColWidth: 300 /* topRowFraction missing */ } }),
      );
      expect(new SettingsStore(file).get().paneLayout).toBeUndefined();
    });

    it('set({paneLayout: <invalid>}) deletes a previously stored layout (unset)', () => {
      const store = new SettingsStore(file);
      store.set({ paneLayout: { leftColWidth: 300, topRowFraction: 1 } });
      const merged = store.set({ paneLayout: { leftColWidth: NaN, topRowFraction: 1 } });
      expect(merged.paneLayout).toBeUndefined();
      expect(new SettingsStore(file).get().paneLayout).toBeUndefined();
    });

    it('leaves paneLayout untouched when the partial omits it (true partial-merge)', () => {
      const store = new SettingsStore(file);
      store.set({ paneLayout: { leftColWidth: 300, topRowFraction: 2 } });
      store.set({ agentCommand: 'claude' });
      expect(new SettingsStore(file).get().paneLayout).toEqual({
        leftColWidth: 300,
        topRowFraction: 2,
      });
    });
  });
});
