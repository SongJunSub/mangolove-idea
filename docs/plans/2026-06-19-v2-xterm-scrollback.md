# MangoLove IDEA — V2: Conflict-Free xterm Scrollback Replay

> Status: READY TO IMPLEMENT. Date: 2026-06-19. Target: macOS.
> Stack: Electron 42 + React 19 + TypeScript 5.7 (ESM, `verbatimModuleSyntax`), xterm 6.0.0.

## Goal

On selecting a worktree, instantly restore that worktree's **last serialized terminal
screen** to fill the ~0.5–2 s gap before `claude --continue` spawns and redraws. Then, the
moment the LIVE session emits its first output byte, call `term.reset()` **exactly once** and
pipe live output — so the restored scrollback is cleanly **replaced** by the `--continue`
render with **zero overlap or garble**.

This is the only scrollback behavior that adds value without re-introducing the known
`--continue` double-render conflict (where a naively-replayed buffer fights claude's own
full-screen repaint). The restored screen is a disposable *placeholder*, not a second source
of truth — claude still owns conversation rehydration via `--continue`.

## Architecture

```
┌──────────────────────────── RENDERER (AgentTerminal) ─────────────────────────────┐
│ mount:                                                                             │
│   term = new Terminal(); term.loadAddon(new FitAddon());                           │
│   serialize = new SerializeAddon(); term.loadAddon(serialize)   ◄── NEW            │
│   saved = await mango.scrollback.get(worktreeId)                ◄── NEW (replay)   │
│   if (saved) term.write(saved)            // instant restore, BEFORE spawn         │
│   liveStarted = false                                                              │
│   session.onOutput(e => {                                                          │
│     if (e.worktreeId !== worktreeId) return                                        │
│     if (!liveStarted) { term.reset(); liveStarted = true }  ◄── reset-before-live  │
│     term.write(e.data)                                                             │
│   })                                                                               │
│   spawn(cols, rows, continue)                                                      │
│   throttle: after output, at most once / 1500ms -> serialize+scrollback.set ◄─ NEW │
│   cleanup(): FINAL serialize+set, then kill + dispose            ◄── NEW           │
└────────────────────────────────────────────────────────────────────────────────────┘
        │  scrollback:get (invoke)        ▲ scrollback:set (invoke)
        ▼                                 │
┌──────────────────────────────── MAIN ───────────────────────────────────────────┐
│ ScrollbackStore (scrollback.json)  ◄── NEW, mirrors SettingsStore/SessionStore   │
│   get(worktreeId) -> string|undefined                                            │
│   set(worktreeId, data)  // per-entry 256KB cap + atomic temp+rename             │
│   remove(worktreeId)     // best-effort on WORKTREE_REMOVE                        │
│ ctx.scrollbackStore (eager in index.ts)  · getScrollbackStore(ctx) (sync, throws)│
└──────────────────────────────────────────────────────────────────────────────────┘
```

Key invariants (mirrors of existing stores):
- **Corrupt-safe:** missing / bad-JSON / non-object file → `{}` (never throws).
- **Atomic write:** temp file + `renameSync` (a crash mid-write cannot leave a half file).
- **Bounded:** `serialize({ scrollback: 1000 })` bounds captured lines; ScrollbackStore caps
  each stored string to **256 KB** (truncates oldest = leading bytes, keeps the tail/most
  recent screen). A crash loses **at most ~1.5 s** of screen (throttle window).
- **Additive only:** new store, new IPC pair, new addon. No existing channel/type changes.

## Tech Stack

- `@xterm/addon-serialize@0.14.0` — **NEW dependency.** Verified against npm: the xterm 6.0.0
  release batch was published 2025-12-22, and `@xterm/addon-serialize@0.14.0` is that batch's
  serialize companion (published 13:50:43 the same minute as `@xterm/xterm@6.0.0` 13:50:12 and
  the already-installed `@xterm/addon-fit@0.11.0` 13:50:25). The earlier `0.13.0` line is the
  xterm 5.5.0 batch (2024-04-05) and declares `peerDependencies: { "@xterm/xterm": "^5.0.0" }`.
  `0.14.0` (like `addon-fit@0.11.0`) declares **no** explicit peer range — consistent with the
  xterm-6 addon batch dropping the `^5.0.0` peer. **Pin exactly `0.14.0`** (no caret), matching
  the existing pinned `@xterm/addon-fit` and `@xterm/xterm` entries.
  - `SerializeAddon.serialize(opts?)` returns the terminal buffer as a `string` with ANSI escape
    sequences. `serialize({ scrollback: N })` bounds the captured lines to the last `N`.
- No version bumps to xterm/addon-fit/electron/react. ScrollbackStore uses only `node:fs` +
  `node:path` (same imports as `settings-store.ts`).

> **REQUIRED SUB-SKILL: superpowers:subagent-driven-development** — execute the tasks below one
> at a time, each as an isolated subagent step (write the failing test → confirm it fails → write
> the minimal COMPLETE implementation → confirm it passes → commit), reviewing between tasks.

---

## File Structure

```
src/
  main/
    managers/
      scrollback-store.ts        ◄── NEW   (ScrollbackStore + getDefaultScrollbackPath)
    ipc/
      ipc-context.ts             ~~~ EDIT  (import type + ctx.scrollbackStore slot)
      register-ipc.ts            ~~~ EDIT  (getScrollbackStore + SCROLLBACK_GET/SET + remove hook)
    index.ts                     ~~~ EDIT  (eager ctx.scrollbackStore before registerIpc)
  shared/
    ipc-channels.ts              ~~~ EDIT  (SCROLLBACK_GET / SCROLLBACK_SET)
    ipc-contract.ts              ~~~ EDIT  (MangoApi.scrollback {get,set})
    types.ts                     ~~~ EDIT  (ScrollbackSetRequest)
  preload/
    index.ts                     ~~~ EDIT  (api.scrollback {get,set})
  renderer/
    components/terminal/
      agent-terminal.tsx         ~~~ EDIT  (SerializeAddon + replay + reset-before-live + throttle)
tests/
  main/
    scrollback-store.test.ts     ◄── NEW   (mirrors settings-store.test.ts)
    ipc-roundtrip.test.ts        ~~~ EDIT  (new `registerIpc — scrollback` describe block)
package.json                     ~~~ EDIT  (@xterm/addon-serialize 0.14.0)
docs/plans/2026-06-19-v2-xterm-scrollback.md   ◄── THIS FILE
docs/V2-BACKLOG.md               ◄── NEW / APPEND (deferred ideas)
```

---

## Task 1 — Add the pinned `@xterm/addon-serialize` dependency

No test (dependency add). Verify by import resolution + typecheck.

**Step 1.1 — Edit `package.json`.** Add the dependency in the `dependencies` block, alphabetically
adjacent to the existing xterm addon. Replace this exact block:

```json
  "dependencies": {
    "@xterm/addon-fit": "0.11.0",
    "@xterm/xterm": "6.0.0",
    "monaco-editor": "0.55.1",
    "node-pty": "1.1.0",
    "simple-git": "3.36.0"
  },
```

with:

```json
  "dependencies": {
    "@xterm/addon-fit": "0.11.0",
    "@xterm/addon-serialize": "0.14.0",
    "@xterm/xterm": "6.0.0",
    "monaco-editor": "0.55.1",
    "node-pty": "1.1.0",
    "simple-git": "3.36.0"
  },
```

**Step 1.2 — Install + verify.** Run:

```bash
npm install @xterm/addon-serialize@0.14.0 --save-exact
node -e "console.log(require('@xterm/addon-serialize/package.json').version)"
```

Expected output: `0.14.0` (and `package-lock.json` updated; the `postinstall`
electron-rebuild step runs but does not touch the pure-JS addon).

**Step 1.3 — Confirm the type surface resolves** (no app code yet, just the import path the
renderer will use):

```bash
node -e "require('@xterm/addon-serialize'); console.log('addon resolves')"
```

Expected output: `addon resolves`

**Commit:** `chore(deps): add @xterm/addon-serialize 0.14.0 (xterm 6 companion)`

---

## Task 2 — `ScrollbackStore` (TDD, mirrors `settings-store`)

A per-worktree string store: corrupt-safe, atomic, sanitized to a `Record<string,string>`,
with a per-entry 256 KB cap.

**Step 2.1 — Write the failing test** at `tests/main/scrollback-store.test.ts` (mirrors
`tests/main/settings-store.test.ts` structure: temp dir per test, corrupt-safe, sanitize,
round-trip, remove, size-cap):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScrollbackStore,
  getDefaultScrollbackPath,
  SCROLLBACK_MAX_BYTES,
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
});
```

**Step 2.2 — Run it, expect failure** (module does not exist yet):

```bash
npx vitest run tests/main/scrollback-store.test.ts
```

Expected: FAIL — `Cannot find module '../../src/main/managers/scrollback-store'`.

**Step 2.3 — Write the minimal COMPLETE implementation** at
`src/main/managers/scrollback-store.ts`:

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-worktree cap on a stored scrollback string (256 KB of UTF-8). Combined with
 * the renderer's serialize({ scrollback: ~1000 }) line bound, this keeps scrollback.json
 * small even with many worktrees. Exported so the unit test asserts the exact bound.
 */
export const SCROLLBACK_MAX_BYTES = 256 * 1024;

/**
 * Resolves the default scrollback.json path under Electron's userData dir. Kept
 * separate (mirrors getDefaultSettingsPath/getDefaultSessionsPath) so register-ipc reads
 * the store from ctx while tests inject an explicit temp path into the constructor.
 */
export function getDefaultScrollbackPath(getUserDataPath: () => string): string {
  return join(getUserDataPath(), 'scrollback.json');
}

/** The on-disk shape: a flat map of worktreeId -> serialized terminal buffer string. */
type ScrollbackMap = Record<string, string>;

/**
 * Persists each worktree's LAST serialized xterm screen (ANSI string from SerializeAddon)
 * to a single JSON file whose path is injected (tests use a temp file). Mirrors the
 * corrupt-safe / atomic / sanitize pattern of SettingsStore/SessionStore: never throws on
 * a missing/corrupt/non-object file (treated as empty {}), sanitizes to ONLY string values
 * keyed by worktreeId (drops non-strings), writes atomically (temp file + rename) so a crash
 * mid-write cannot leave a half file, and caps each entry to SCROLLBACK_MAX_BYTES (keeping
 * the TAIL = newest screen). Two intentional deviations from SettingsStore: write() uses
 * COMPACT JSON (these values are large opaque ANSI blobs — pretty-printing only wastes bytes
 * against the cap), and sanitize() explicitly rejects arrays (the non-object test requires it).
 *
 * This is a DISPOSABLE placeholder cache: it holds NO durable conversation state (claude
 * owns rehydration via `--continue`). The worst case of corruption/loss is one missed
 * "instant restore" flash, never data loss — so the corrupt-as-empty recovery is intentional.
 */
export class ScrollbackStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Reads + parses the map, returning {} on missing/corrupt/non-object files. */
  private load(): ScrollbackMap {
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return {}; // corrupt JSON -> recover as empty
    }
    return this.sanitize(parsed);
  }

  /** Returns the saved buffer for a worktree, or undefined if none/invalid. */
  get(worktreeId: string): string | undefined {
    return this.load()[worktreeId];
  }

  /** Stores (capped) the buffer for a worktree, then persists atomically. */
  set(worktreeId: string, data: string): void {
    const map = this.load();
    map[worktreeId] = this.cap(data);
    this.write(map);
  }

  /** Drops the entry for a worktree (no-op if absent), then persists. */
  remove(worktreeId: string): void {
    const map = this.load();
    if (!(worktreeId in map)) return; // nothing to do; avoid a pointless write
    delete map[worktreeId];
    this.write(map);
  }

  /**
   * Bounds a buffer to SCROLLBACK_MAX_BYTES of UTF-8, keeping the TAIL (the newest
   * screen content is at the end of a SerializeAddon dump). Slices on a code-point
   * boundary via Buffer so a multi-byte char is never split.
   */
  private cap(data: string): string {
    const buf = Buffer.from(data, 'utf8');
    if (buf.byteLength <= SCROLLBACK_MAX_BYTES) return data;
    // Keep the last SCROLLBACK_MAX_BYTES bytes. A cut landing mid-codepoint makes
    // toString emit a leading U+FFFD (3 bytes) in place of the 1-3 partial bytes,
    // which can push the result a few bytes OVER the cap. Strip those leading
    // replacement char(s) so the stored string is STRICTLY <= SCROLLBACK_MAX_BYTES.
    // (Real claude TUI output is box-drawing/CJK, so a multibyte cut is the common
    // case, not ASCII — the cap must hold for it.)
    return buf
      .subarray(buf.byteLength - SCROLLBACK_MAX_BYTES)
      .toString('utf8')
      .replace(/^�+/, '');
  }

  /** Projects an input to a string-only map (drops non-string values + non-objects). */
  private sanitize(raw: unknown): ScrollbackMap {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const source = raw as Record<string, unknown>;
    const out: ScrollbackMap = {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  private write(map: ScrollbackMap): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, this.filePath);
  }
}
```

**Step 2.4 — Run it, expect pass:**

```bash
npx vitest run tests/main/scrollback-store.test.ts
```

Expected: all tests pass (10 passed).

**Commit:** `feat(main): add ScrollbackStore (per-worktree, capped, corrupt-safe)`

---

## Task 3 — `ctx.scrollbackStore` slot + eager construction + sync resolver

Wire the store into the IPC context exactly like `sessionStore`/`settingsStore`.

**Step 3.1 — Edit `src/main/ipc/ipc-context.ts`.** Add the import (after the `SettingsStore`
import line):

```ts
import type { SettingsStore } from '../managers/settings-store';
```

becomes:

```ts
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';
```

Then add the slot in the `IpcContext` interface, immediately after the `settingsStore` slot:

```ts
  /** Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 E). */
  settingsStore?: SettingsStore;
```

becomes:

```ts
  /** Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 E). */
  settingsStore?: SettingsStore;
  /**
   * Per-worktree serialized-terminal cache for conflict-free scrollback replay.
   * Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 scrollback).
   */
  scrollbackStore?: ScrollbackStore;
```

**Step 3.2 — Edit `src/main/index.ts`.** Add the import (after the SettingsStore import):

```ts
import { SettingsStore, getDefaultSettingsPath } from './managers/settings-store';
```

becomes:

```ts
import { SettingsStore, getDefaultSettingsPath } from './managers/settings-store';
import { ScrollbackStore, getDefaultScrollbackPath } from './managers/scrollback-store';
```

Then construct it eagerly inside `app.whenReady().then(...)`, right after the `settingsStore`
assignment and BEFORE `registerIpc(ipcMain, ctx)`:

```ts
    ctx.settingsStore = new SettingsStore(getDefaultSettingsPath(() => app.getPath('userData')));
    registerIpc(ipcMain, ctx);
```

becomes:

```ts
    ctx.settingsStore = new SettingsStore(getDefaultSettingsPath(() => app.getPath('userData')));
    // Construct the ScrollbackStore eagerly (same reason as the others: we hold the real
    // electron `app` for the userData path) and assign it BEFORE registerIpc so the sync
    // getScrollbackStore resolver finds it on the SCROLLBACK_GET/SET handlers.
    ctx.scrollbackStore = new ScrollbackStore(
      getDefaultScrollbackPath(() => app.getPath('userData')),
    );
    registerIpc(ipcMain, ctx);
```

**Step 3.3 — Add the sync resolver in `src/main/ipc/register-ipc.ts`.** Add the import (after
the `SettingsStore` type import):

```ts
import type { SettingsStore } from '../managers/settings-store';
```

becomes:

```ts
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';
```

Then add the resolver immediately AFTER `getSettingsStore` (mirrors `getSessionStore` —
synchronous, throws if unset):

```ts
/**
 * Resolves the ScrollbackStore SYNCHRONOUSLY. Constructed eagerly in index.ts (which holds
 * the real electron `app` for the userData path) and assigned to ctx.scrollbackStore BEFORE
 * registerIpc; tests inject ctx.scrollbackStore directly. Kept sync (mirrors getSessionStore)
 * so the SCROLLBACK_GET/SET handlers delegate without an await hop.
 */
function getScrollbackStore(ctx: IpcContext): ScrollbackStore {
  if (ctx.scrollbackStore) return ctx.scrollbackStore;
  throw new Error(
    'scrollbackStore not initialized — index.ts must set ctx.scrollbackStore before registerIpc',
  );
}
```

**Step 3.4 — Typecheck both projects** (no behavior change yet; the handlers come in Task 4,
so `getScrollbackStore` is currently unused — TypeScript's `noUnusedLocals` does NOT flag
module-level functions, only locals, so this typechecks clean):

```bash
npm run typecheck
```

Expected output: both `typecheck:node` and `typecheck:web` exit 0 (no errors).

**Commit:** `feat(main): wire ctx.scrollbackStore slot + eager construct + sync resolver`

---

## Task 4 — `SCROLLBACK_GET` / `SCROLLBACK_SET` IPC across all 4 layers + wiring test

Additive 4-layer IPC mirroring SETTINGS_GET/SET.

**Step 4.1 — Write the failing wiring test.** Append a new `describe` block to the END of
`tests/main/ipc-roundtrip.test.ts` (after the `registerIpc — settings (V2 E)` block):

```ts
describe('registerIpc — scrollback (V2)', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('SCROLLBACK_GET returns the stored buffer for a worktree', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(() => 'SAVED\x1b[0m'), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, scrollbackStore: store as never });
    const out = await handlers.get('scrollback:get')!({}, '/wt');
    expect(store.get).toHaveBeenCalledWith('/wt');
    expect(out).toBe('SAVED\x1b[0m');
  });

  it('SCROLLBACK_GET returns null (not undefined) when nothing is stored', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(() => undefined), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, scrollbackStore: store as never });
    const out = await handlers.get('scrollback:get')!({}, '/wt');
    expect(out).toBeNull(); // IPC-serializable: undefined would arrive as undefined; we normalize to null
  });

  it('SCROLLBACK_SET persists {worktreeId, data} and returns an Ack', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, scrollbackStore: store as never });
    const ack = await handlers.get('scrollback:set')!({}, { worktreeId: '/wt', data: 'BUF' });
    expect(store.set).toHaveBeenCalledWith('/wt', 'BUF');
    expect(ack).toEqual({ ok: true });
  });

  it('WORKTREE_REMOVE best-effort removes the scrollback entry on success', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const wt = { list: vi.fn(), create: vi.fn(), remove: vi.fn(async () => undefined) };
    const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, {
      mainWindow: null,
      worktreeManager: wt as never,
      scrollbackStore: store as never,
    });
    const ack = await handlers.get('worktree:remove')!({}, { worktreeId: '/wt' });
    expect(ack).toEqual({ ok: true });
    expect(store.remove).toHaveBeenCalledWith('/wt');
  });

  it('WORKTREE_REMOVE does NOT remove scrollback when the worktree removal fails', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const wt = {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(async () => {
        throw new Error('cannot remove the primary working tree');
      }),
    };
    const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, {
      mainWindow: null,
      worktreeManager: wt as never,
      scrollbackStore: store as never,
    });
    const ack = (await handlers.get('worktree:remove')!({}, { worktreeId: '/r' })) as {
      ok: boolean;
    };
    expect(ack.ok).toBe(false);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('WORKTREE_REMOVE still returns ok:true if scrollback cleanup throws (best-effort)', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const wt = { list: vi.fn(), create: vi.fn(), remove: vi.fn(async () => undefined) };
    const store = {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(() => {
        throw new Error('disk full');
      }),
    };
    registerIpc(ipcMain as never, {
      mainWindow: null,
      worktreeManager: wt as never,
      scrollbackStore: store as never,
    });
    const ack = await handlers.get('worktree:remove')!({}, { worktreeId: '/wt' });
    expect(ack).toEqual({ ok: true }); // cleanup is best-effort; never demotes the remove
  });
});
```

**Step 4.2 — Run it, expect failure:**

```bash
npx vitest run tests/main/ipc-roundtrip.test.ts
```

Expected: FAIL — `handlers.get('scrollback:get')` is `undefined` (handlers not registered), and
the `store.remove` assertion fails (no cleanup hook yet).

**Step 4.3 — Layer 1: channels.** Edit `src/shared/ipc-channels.ts`. After the settings block:

```ts
  // settings (V2 E) — persisted per-project config (renderer -> main, invoke)
  SETTINGS_GET: 'settings:get', // invoke (-> AppSettings)
  SETTINGS_SET: 'settings:set', // invoke (Partial<AppSettings> -> AppSettings)
} as const;
```

becomes:

```ts
  // settings (V2 E) — persisted per-project config (renderer -> main, invoke)
  SETTINGS_GET: 'settings:get', // invoke (-> AppSettings)
  SETTINGS_SET: 'settings:set', // invoke (Partial<AppSettings> -> AppSettings)

  // scrollback (V2) — per-worktree serialized terminal screen for conflict-free replay
  SCROLLBACK_GET: 'scrollback:get', // invoke (worktreeId -> string | null)
  SCROLLBACK_SET: 'scrollback:set', // invoke ({worktreeId, data} -> Ack)
} as const;
```

**Step 4.4 — Layer 2: shared type.** Edit `src/shared/types.ts`. Append after the
`OpenExternalRequest` interface (line ~344–346):

```ts
export interface OpenExternalRequest {
  readonly url: string;
}
```

becomes:

```ts
export interface OpenExternalRequest {
  readonly url: string;
}

/** Payload for SCROLLBACK_SET: persist one worktree's serialized terminal screen. */
export interface ScrollbackSetRequest {
  readonly worktreeId: string;
  /** SerializeAddon ANSI string (capped by the store to SCROLLBACK_MAX_BYTES). */
  readonly data: string;
}
```

**Step 4.5 — Layer 3: contract.** Edit `src/shared/ipc-contract.ts`. Add the import:

```ts
  OpenExternalRequest,
} from './types';
```

becomes:

```ts
  OpenExternalRequest,
  ScrollbackSetRequest,
} from './types';
```

Then add the `scrollback` group to `MangoApi`, after the `settings` group:

```ts
  settings: {
    /** Current persisted settings (every field optional; unset => env/default). */
    get(): Promise<AppSettings>;
    /** Persists a partial; returns the merged, sanitized settings. */
    set(partial: Partial<AppSettings>): Promise<AppSettings>;
  };
```

becomes:

```ts
  settings: {
    /** Current persisted settings (every field optional; unset => env/default). */
    get(): Promise<AppSettings>;
    /** Persists a partial; returns the merged, sanitized settings. */
    set(partial: Partial<AppSettings>): Promise<AppSettings>;
  };
  scrollback: {
    /** Last serialized terminal screen for a worktree, or null if none saved. */
    get(worktreeId: string): Promise<string | null>;
    /** Persist a worktree's serialized terminal screen (store caps the size). */
    set(req: ScrollbackSetRequest): Promise<Ack>;
  };
```

**Step 4.6 — Layer 4: preload.** Edit `src/preload/index.ts`. Add the `scrollback` group after
the `settings` group in the `api` object:

```ts
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (partial) => ipcRenderer.invoke(IPC.SETTINGS_SET, partial),
  },
};
```

becomes:

```ts
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (partial) => ipcRenderer.invoke(IPC.SETTINGS_SET, partial),
  },
  scrollback: {
    get: (worktreeId) => ipcRenderer.invoke(IPC.SCROLLBACK_GET, worktreeId),
    set: (req) => ipcRenderer.invoke(IPC.SCROLLBACK_SET, req),
  },
};
```

**Step 4.7 — Main handlers.** Edit `src/main/ipc/register-ipc.ts`. First add the type import to
the existing `from '../../shared/types'` block — add `ScrollbackSetRequest` to the import list:

```ts
  OpenExternalRequest,
} from '../../shared/types';
```

becomes:

```ts
  OpenExternalRequest,
  ScrollbackSetRequest,
} from '../../shared/types';
```

Then register the two handlers. Place them just after the `IPC.SETTINGS_SET` handler block
closes (after its `});` near the end of `registerIpc`, before the `APP_QUIT_DECISION` handler):

```ts
  ipcMain.handle(
    IPC.SCROLLBACK_GET,
    async (_event: unknown, worktreeId: string): Promise<string | null> => {
      // Normalize undefined -> null so the invoke result is an explicit, serializable value.
      return getScrollbackStore(ctx).get(worktreeId) ?? null;
    },
  );

  ipcMain.handle(
    IPC.SCROLLBACK_SET,
    async (_event: unknown, req: ScrollbackSetRequest): Promise<Ack> => {
      getScrollbackStore(ctx).set(req.worktreeId, req.data);
      return { ok: true };
    },
  );
```

**Step 4.8 — Best-effort cleanup on `WORKTREE_REMOVE`.** Still in `register-ipc.ts`, replace the
existing `WORKTREE_REMOVE` handler body to remove the scrollback entry on a successful removal
(only when a scrollbackStore is present, and never letting a cleanup failure demote the Ack):

```ts
  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    async (_event: unknown, req: RemoveWorktreeRequest): Promise<Ack> => {
      const manager = await getWorktreeManager(ctx);
      try {
        await manager.remove(req);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
```

becomes:

```ts
  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    async (_event: unknown, req: RemoveWorktreeRequest): Promise<Ack> => {
      const manager = await getWorktreeManager(ctx);
      try {
        await manager.remove(req);
        // Best-effort: drop the stale scrollback so removed worktrees do not accumulate
        // buffers. Guarded (store may be absent in a partial test ctx) and try/catch'd so a
        // cleanup failure NEVER demotes the successful removal Ack. Relies on the per-entry
        // size cap as the backstop if this ever no-ops.
        try {
          ctx.scrollbackStore?.remove(req.worktreeId);
        } catch {
          // ignore — scrollback cleanup is non-essential; the size cap bounds growth anyway
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
```

**Step 4.9 — Run the wiring test + typecheck, expect pass:**

```bash
npx vitest run tests/main/ipc-roundtrip.test.ts
npm run typecheck
```

Expected: the new `registerIpc — scrollback (V2)` block passes (6 tests), all prior tests still
pass, and both typecheck projects exit 0.

**Commit:** `feat(ipc): add SCROLLBACK_GET/SET 4-layer wiring + best-effort remove on cleanup`

---

## Task 5 — `AgentTerminal`: SerializeAddon capture (throttled + unmount) + replay + reset-before-live

No RTL test (`@testing-library/react` is absent — the repo covers the terminal via
`typecheck:web` + the Playwright smoke, see Task 7). The logic is verified by typecheck and the
documented smoke. Implement the COMPLETE component.

**Step 5.1 — Edit `src/renderer/components/terminal/agent-terminal.tsx`.** Replace the ENTIRE
file with the version below. Changes vs. current:
1. import + load `SerializeAddon`;
2. on mount, `scrollback.get(worktreeId)` → `term.write(saved)` (instant restore, before spawn);
3. `liveStarted` ref; in `onOutput`, first byte → `term.reset()` once, then write;
4. throttled `serialize` → `scrollback.set` (≤ once / 1500 ms) after output;
5. FINAL `serialize` → `scrollback.set` in the cleanup, before kill + dispose.

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useSession } from '../../hooks/use-session';

/** Max serialized scrollback lines captured per persist (bounds buffer size). */
const SERIALIZE_SCROLLBACK_LINES = 1000;
/** Min interval between throttled persists (ms). A crash loses at most this much screen. */
const PERSIST_THROTTLE_MS = 1500;

/** Props for the embedded agent terminal (one per selected worktree). */
export interface AgentTerminalProps {
  /** The worktree whose `claude` PTY this terminal is bound to. */
  readonly worktreeId: string;
  /** When true, spawn `claude --continue` to rehydrate (b-lite restart, MVP item 6). */
  readonly continueSession?: boolean;
}

/**
 * Embedded xterm.js terminal bound to a worktree's claude PTY. On mount it builds a
 * Terminal + FitAddon + SerializeAddon, REPLAYS the worktree's last serialized screen
 * (instant restore that fills the spawn gap), spawns the session at the fitted cols/rows,
 * and bridges: term.onData -> session.sendInput, session.onOutput -> term.write,
 * ResizeObserver -> fit() + session.resize.
 *
 * CONFLICT-FREE REPLAY: the replayed screen is a disposable placeholder. The FIRST live
 * output byte triggers term.reset() exactly once (`liveStarted` latch) BEFORE writing it, so
 * the restored screen is cleanly REPLACED by claude's `--continue` redraw with zero overlap.
 * If no live output ever arrives, the restored screen simply stays (acceptable).
 *
 * CAPTURE: after output, a serialize+persist is scheduled at most once per PERSIST_THROTTLE_MS
 * (never per byte — serialize is O(buffer)); a FINAL serialize+persist runs in the cleanup so
 * switching/closing a worktree captures its latest screen. On unmount it kills the PTY and
 * disposes the terminal. Re-mounts (worktreeId change) tear down and rebuild via the effect's
 * cleanup + the key in App.tsx.
 */
export function AgentTerminal({
  worktreeId,
  continueSession = false,
}: AgentTerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { spawn, kill, sendInput, resize } = useSession(worktreeId);

  // Keep the latest glue callbacks without retriggering the heavy mount effect.
  const spawnRef = useRef(spawn);
  const killRef = useRef(kill);
  const sendInputRef = useRef(sendInput);
  const resizeRef = useRef(resize);
  spawnRef.current = spawn;
  killRef.current = kill;
  sendInputRef.current = sendInput;
  resizeRef.current = resize;

  const continueRef = useRef(continueSession);
  continueRef.current = continueSession;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Guards mutated across this effect's closures; reset per (re)mount.
    let disposed = false;
    let liveStarted = false;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      convertEol: true,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.open(host);
    fit.fit();

    /** Serialize the current screen + persist it (bounded). Swallows errors (best-effort). */
    const persistNow = (): void => {
      try {
        const data = serialize.serialize({ scrollback: SERIALIZE_SCROLLBACK_LINES });
        void window.mango.scrollback.set({ worktreeId, data });
      } catch {
        // best-effort capture — a serialize/IPC hiccup must never break the terminal
      }
    };

    /** Schedule a persist at most once per PERSIST_THROTTLE_MS (trailing-edge). */
    const schedulePersist = (): void => {
      if (persistTimer !== null) return; // already scheduled within this window
      persistTimer = setTimeout(() => {
        persistTimer = null;
        if (!disposed) persistNow();
      }, PERSIST_THROTTLE_MS);
    };

    // REPLAY: restore the last screen instantly, BEFORE the session spawns/redraws.
    void window.mango.scrollback.get(worktreeId).then((saved) => {
      // Only valid before live output begins; once reset-before-live has fired, a late
      // restore would re-introduce the stale screen. Guard on !liveStarted && !disposed.
      if (saved && !liveStarted && !disposed) term.write(saved);
    });

    const onData = term.onData((data) => sendInputRef.current(data));

    const offOutput = window.mango.session.onOutput((e) => {
      if (e.worktreeId !== worktreeId) return;
      if (!liveStarted) {
        // FIRST live byte: wipe the restored placeholder ONCE, then pipe live output so
        // claude's --continue redraw (or a fresh session) replaces it with zero overlap.
        term.reset();
        liveStarted = true;
      }
      term.write(e.data);
      schedulePersist();
    });
    const offExit = window.mango.session.onExit((e) => {
      if (e.worktreeId === worktreeId) {
        term.writeln(`\r\n\x1b[2m[claude exited: code ${e.exitCode}]\x1b[0m`);
      }
    });

    void spawnRef.current(term.cols, term.rows, continueRef.current);

    const observer = new ResizeObserver(() => {
      fit.fit();
      resizeRef.current(term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // FINAL capture BEFORE dispose: persist the latest screen so reselecting this worktree
      // restores it. Runs even if no throttled persist had fired yet (e.g. quick switch).
      persistNow();
      observer.disconnect();
      offOutput();
      offExit();
      onData.dispose();
      void killRef.current();
      term.dispose();
    };
  }, [worktreeId]);

  return (
    <div
      data-testid="agent-terminal"
      ref={hostRef}
      style={{ width: '100%', height: 420, background: '#1e1e1e', borderRadius: 4 }}
    />
  );
}
```

**Step 5.2 — Typecheck the web project, expect pass:**

```bash
npm run typecheck:web
```

Expected: exit 0. (`window.mango.scrollback.{get,set}` resolves via the Task-4 contract;
`SerializeAddon` resolves via the Task-1 dependency.)

**Step 5.3 — Full suite + lint, expect pass:**

```bash
npm run typecheck && npx vitest run && npm run lint
```

Expected: typecheck both projects exit 0; all vitest files pass; eslint reports no errors.

**Commit:** `feat(terminal): conflict-free scrollback replay (SerializeAddon + reset-before-live)`

---

## Task 6 — Cleanup on worktree removal (best-effort) — VERIFY

The cleanup hook itself was implemented in **Task 4 Step 4.8** (it had to ship with the IPC
wiring so the `WORKTREE_REMOVE` test in that task passes). This task is the explicit
**verification gate** that the best-effort cleanup is correct and non-scope-creeping — no new
code unless a gap is found.

**Step 6.1 — Re-run the cleanup assertions in isolation:**

```bash
npx vitest run tests/main/ipc-roundtrip.test.ts -t "WORKTREE_REMOVE"
```

Expected: the three `WORKTREE_REMOVE` scrollback cases pass:
- removes the entry on success,
- does NOT remove when the worktree removal fails,
- still returns `ok:true` when scrollback cleanup throws (best-effort).

**Step 6.2 — Confirm scope discipline.** The merge/cleanup path
(`merge-runner.ts#cleanupWorktree`) calls `worktrees.remove(...)` directly (not through IPC), so
it does NOT trigger the IPC-level scrollback cleanup. This is INTENTIONAL and acceptable per the
locked design: the per-entry size cap (Task 2) is the backstop, and over-scoping the merge runner
to know about scrollback is explicitly out of bounds. Record this as a known limitation in the
backlog (Task 7). No code change.

**Commit:** none for this task (verification only — the implementation committed in Task 4).
If Step 6.1 reveals a gap, fix it and commit `fix(ipc): correct best-effort scrollback cleanup`.

---

## Task 7 — Full suite, documented Playwright smoke, V2-BACKLOG

**Step 7.1 — Green-bar the whole repo:**

```bash
npm run typecheck && npx vitest run && npm run lint && npm run format:check
```

Expected: all four exit 0. (If `format:check` flags the new files, run `npm run format` and
amend the relevant commit.)

**Step 7.2 — Documented manual / Playwright restart smoke.** No automated assertion is added
(the behavior is timing- and PTY-bound); document the exact reproduction so a human or the
existing Playwright harness can confirm it. This smoke lives in THIS plan (mirror the prior
features by also dropping it in `tests/smoke/scrollback-smoke.md`); it does NOT go into
`docs/V2-BACKLOG.md`. Run it once manually:

> **Scrollback replay smoke (manual):**
> 1. `npm run dev`. Create/select a worktree; let `claude` render a recognizable screen
>    (e.g. type a prompt so there is visible output). Wait > 1.5 s so the throttled persist
>    fires (or just switch away, which forces the final persist).
> 2. Select a DIFFERENT worktree, then select the FIRST one again. EXPECT: the saved screen
>    flashes instantly (instant restore), then — the moment `claude --continue` emits its first
>    byte — the screen RESETS ONCE and is replaced by the live `--continue` render with **no**
>    doubled/garbled lines.
> 3. Quit and relaunch the app, select the worktree. EXPECT: same — the persisted screen flashes,
>    then resets to the live render. Confirm `~/Library/Application Support/<app>/scrollback.json`
>    exists and is bounded (each value ≤ 256 KB).
> 4. Remove a worktree (merge+cleanup OR direct remove via IPC). EXPECT: its key is gone from
>    `scrollback.json` (direct/IPC remove) or bounded by the cap (merge-runner path).

**Step 7.3 — Update `docs/V2-BACKLOG.md`** (the file already exists). Two edits, matching how
the prior v2 features (Monaco / Settings / merge-conflict / PR-CI) were marked complete:

(a) Strike through the existing scrollback item in the section-A table and mark it done — find
the `xterm 스크롤백 저장·재생` row and change its leading cell to
`| ~~**xterm 스크롤백 저장·재생**~~ ✅ **완료**` with a one-line summary (reset-before-live replay,
ScrollbackStore 256 KB cap, addon-serialize@0.14.0, plan path). Also append
`, **xterm 스크롤백 재생 완료**` to the top `상태:` line.

(b) APPEND the deferred-ideas section below — note the leading `---` separator to match the
file's existing section convention:

```markdown
---

# V2 Backlog — Scrollback replay (deferred ideas, 2026-06-19)

- **Merge-runner cleanup of scrollback:** `merge-runner.ts#cleanupWorktree` removes worktrees
  directly (not via the WORKTREE_REMOVE IPC handler), so it does NOT drop the scrollback entry.
  Backstopped by the per-entry 256 KB cap. Revisit if scrollback.json growth is ever observed.
- **Per-worktree last-access pruning / global cap:** today only a PER-ENTRY byte cap exists.
  Could add a global entry-count LRU cap if a user accumulates very many worktrees over time.
- **Configurable scrollback line bound:** `SERIALIZE_SCROLLBACK_LINES` (1000) and
  `PERSIST_THROTTLE_MS` (1500) are constants. Could surface in Settings (V2 E) if needed.
- **flush-on-quit:** the before-quit sweep kills PTYs but does not force a final serialize of
  every open terminal (the unmount cleanup covers worktree switches; a hard quit relies on the
  last throttled persist, ≤1.5 s stale). Acceptable; revisit if users want pixel-exact restore.
- **RTL component test:** `@testing-library/react` is absent; the reset-before-live latch +
  throttle are covered only by typecheck + the manual smoke. Adding RTL + jsdom would let us
  unit-test the latch (mock window.mango.scrollback + session.onOutput, assert term.reset()
  called exactly once on the first output).
```

**Step 7.4 — Final commit:**

```bash
git add docs/V2-BACKLOG.md docs/plans/2026-06-19-v2-xterm-scrollback.md
```

**Commit:** `docs: scrollback replay smoke + V2 backlog`

---

## Migration Strategy (additive)

- **No breaking changes.** Every change is additive: a new file (`scrollback-store.ts`), a new
  optional `ctx` slot, a new IPC pair, a new `MangoApi.scrollback` group, a new dependency, and
  an in-place rewrite of `AgentTerminal` that preserves its existing public props + behavior.
- **First run with no `scrollback.json`:** `get()` returns `undefined` → `null` over IPC → the
  renderer skips the restore (`if (saved && ...)`). Behavior is identical to today (empty terminal
  until live output). The file is created lazily on the first `set()`.
- **Existing/older files:** corrupt or non-object `scrollback.json` is recovered as `{}` (never
  throws), exactly like `settings.json`/`sessions.json`. Hand-edited non-string values are dropped
  by `sanitize`.
- **Rollback:** removing the feature = revert the commits; a stale `scrollback.json` left on disk
  is harmless (nothing reads it) and can be deleted. No schema migration, no data loss (claude
  still owns conversation rehydration via `--continue`).
- **The env/Playwright smokes** that set `MANGO_*_CMD` are unaffected — scrollback is orthogonal
  to command resolution and adds no new env seam.

## Acceptance Checklist

- [ ] `@xterm/addon-serialize` pinned to exactly `0.14.0` in `package.json`; `require(...).version`
      prints `0.14.0`.
- [ ] `ScrollbackStore` round-trips, is corrupt-safe (missing/bad-JSON/non-object → empty),
      sanitizes to a string map, removes entries, and caps each entry to 256 KB keeping the tail —
      all 10 `scrollback-store.test.ts` cases pass.
- [ ] `ctx.scrollbackStore` is constructed EAGERLY in `index.ts` BEFORE `registerIpc`;
      `getScrollbackStore` is synchronous and throws if unset (mirrors `getSessionStore`).
- [ ] `SCROLLBACK_GET` returns the stored buffer or `null`; `SCROLLBACK_SET` persists
      `{worktreeId, data}` and returns `{ ok: true }` — all 6 `registerIpc — scrollback` cases pass.
- [ ] `WORKTREE_REMOVE` best-effort removes the scrollback entry on success, skips it on failure,
      and never lets a cleanup error demote the Ack.
- [ ] `AgentTerminal` loads `SerializeAddon`, replays the saved screen on mount BEFORE spawn,
      calls `term.reset()` exactly once on the first live output byte, then writes live output;
      persists on a ≤1500 ms throttle and once more in the unmount cleanup.
- [ ] `npm run typecheck && npx vitest run && npm run lint && npm run format:check` all exit 0.
- [ ] Manual restart smoke: saved screen flashes on select, then resets cleanly to the live
      `--continue` render with no overlap/garble; `scrollback.json` exists and entries are ≤256 KB.

## Self-Review

- **Why reset-before-live (not replay-and-coexist)?** A naive replay of claude's prior screen
  coexisting with `--continue`'s own full-screen repaint double-renders and garbles. Resetting on
  the FIRST live byte makes the restored screen a pure, disposable gap-filler — the only behavior
  that adds value without the known conflict. This is the locked design decision.
- **Why a 256 KB per-entry cap AND `serialize({scrollback:1000})`?** Two independent bounds: the
  line bound limits what we capture; the byte cap bounds what we store even if a line is pathological
  (very long single lines). Keeping the TAIL means the newest, most-relevant screen survives.
- **Why throttle at 1500 ms + a final persist?** Serialize is O(buffer); per-byte would be costly
  under a fast stream. 1500 ms bounds crash-loss to ~1.5 s; the unmount final-persist guarantees a
  worktree switch always captures the latest screen (the common path).
- **Why normalize `undefined → null` at the IPC boundary?** `invoke` serializes `undefined`
  ambiguously; `null` is an explicit, testable "nothing saved", and the renderer's `if (saved)`
  treats both falsy values identically.
- **Why guard the late restore on `!liveStarted && !disposed`?** `scrollback.get` is async; if live
  output (or unmount) wins the race, writing the stale restore afterward would re-introduce the
  conflict. The guard makes the restore a no-op once live has started or the terminal is gone.
- **Sync `getScrollbackStore` consistency:** mirrors `getSessionStore`/`getSettingsStore` so the
  handlers delegate without an await hop and the eager-construct-before-registerIpc discipline in
  `index.ts` is uniform across all three stores.
- **Scope discipline:** the merge-runner cleanup path is intentionally NOT wired to scrollback
  removal (documented in V2-BACKLOG); the size cap is the backstop. No over-scoping.
- **Version verification:** `0.14.0` confirmed as the xterm-6.0.0 release-batch serialize companion
  by npm publish timeline (same minute as xterm 6.0.0 and addon-fit 0.11.0), not guessed.
