I now have everything I need. The `worktreeId` IS the path (`Worktree.id === Worktree.path`), and `resolvePath` already maps id→path. For branch resolution, I'll carry it through the existing `resolvePath`-style injected resolver. I have full understanding of the codebase patterns. Writing the plan now.

# Plan 5 — Session Persistence b-lite + Quit Sweep (MVP item 6)

For agentic workers: **REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`**

---

## Goal

On reopen, every worktree that had an agent session gets `claude --continue` auto-spawned so claude rehydrates its own conversation from its on-disk JSONL — **the app stores NO conversation content**, only `{worktreePath, branch, hadActiveSession, updatedAt}`. Quitting with live agent sessions shows a warning dialog ("N agent session(s) are live — quit anyway?"). A `before-quit` PTY kill-sweep guarantees no orphaned `claude` processes survive quit. This is the FINAL MVP plan; it ONLY ADDS persistence + quit-flow + rehydrate — it changes no merge/server/session internals.

## Architecture

Plan 5 plugs into the existing seams without reshaping them:

1. **`SessionStore`** — a new, tiny, dependency-free class that persists `SessionRecord[]` to a JSON file whose path is **injected** (default `app.getPath('userData')/'sessions.json'`). Methods: `load()`, `all()`, `upsert(record)`, `remove(worktreePath)`. Never throws on a missing/corrupt file (treats it as empty). It is constructed in `register-ipc.ts` (lazy-getter pattern, injectable in tests via `ctx.sessionStore`).

2. **`SessionManager` hook** — `SessionManager` gains two **optional injected** deps: a `SessionStore` and a `clock` (`() => number`, default `Date.now`). On a **successful** spawn it upserts `{worktreePath: worktreeId, branch, hadActiveSession: true, updatedAt: clock()}`. Branch comes from a new optional injected `resolveBranch(worktreeId)` resolver (same pattern as the existing `resolvePath`), wired in `register-ipc.ts` from the `WorktreeManager` listing. Everything stays optional so all 107 existing tests and their `makeManager` helper keep passing untouched. **We do NOT fake turn detection** — `AgentSession.hasActiveTurn` stays honestly `false`.

3. **Quit warning — honest, based on LIVE sessions.** Because `hasActiveTurn` is deliberately `false` (Plan 2), the quit warning is based on **worktrees with a live (running, non-exited) PTY**, surfaced by a new `SessionManager.liveWorktreeIds(): string[]`. The `QuitWarningEvent.activeWorktreeIds` carries those ids. (Real turn detection would require parsing claude's TUI — out of MVP scope; warning-on-live-session is the honest MVP behavior.)

4. **`before-quit` flow** (`src/main/index.ts`) — a small `QuitController` (pure, unit-testable) decides: if there are live sessions AND quit isn't already confirmed → `preventDefault()` + emit `APP_QUIT_WARNING({activeWorktreeIds})` to the renderer. The renderer dialog calls `window.mango.app.sendQuitDecision(quit)`. The main `APP_QUIT_DECISION` handler: if `quit === true`, set a `confirmedQuit` flag, run the kill-sweep (`sessionManager.killAll()` + the existing `serverManager.dispose()`), then `app.quit()` — which re-fires `before-quit`, but the flag lets it through (the sweep on the confirmed path is what prevents orphan `claude`). If `quit === false`, stay open.

5. **Rehydrate (the b-lite core) — LAZY.** On reopen, when a worktree's `AgentTerminal` mounts, it asks main whether a record exists for that worktree and spawns with `continueSession = recordExists`. Lazy (spawn-on-select) is chosen over eager (spawn-every-recorded-session-at-startup) because the UI already spawns exactly one PTY per terminal mount, it avoids launching N background `claude` processes the user can't see, and it reuses the existing `AgentTerminal` spawn path with a single boolean flip. A new invoke channel returns the recorded worktree paths to the renderer.

6. **Renderer quit dialog** — `App.tsx` subscribes `window.mango.app.onQuitWarning` (preload already wired in Plan 0), shows a modal with the live-session count, and calls `window.mango.app.sendQuitDecision(true|false)`. All existing UI is preserved.

### Two new IPC channels (reusing existing contract channels + one additive fetch channel)

- `APP_QUIT_WARNING` (main→renderer event) and `APP_QUIT_DECISION` (renderer→main invoke) — **already in `ipc-channels.ts` and the preload `app.*` surface**; Plan 5 only wires the MAIN side.
- `SESSION_RECORDS` (renderer→main invoke, returns `string[]` of recorded worktree paths) — **additive**; needed so the renderer can decide `continueSession`. This is a new const in `ipc-channels.ts`, a new `MangoApi.session.records()` method, a new preload line, and a new handler. It carries NO conversation content — only the recorded paths.

> **Hard invariant (restate):** `SessionStore` persists ONLY the 4 `SessionRecord` contract fields. No conversation text, no transcript, no JSONL — claude owns rehydration via `--continue`. This is asserted by a test.

## Tech Stack

Same as Plans 0–4: Electron 42, electron-vite 5 (Vite 7), React 19, TypeScript 5.7 (`verbatimModuleSyntax`, ESM main), Vitest 4 (node + jsdom projects), node-pty 1.1.0 behind `PtyFactory`. New code uses only `node:fs`/`node:path` (already used by `worktree-manager.ts`) — no new dependencies.

---

## File Structure

| File | New / Edit | Purpose |
|---|---|---|
| `src/main/managers/session-store.ts` | **NEW** | Persist `SessionRecord[]` to injected JSON path; `load/all/upsert/remove`; corrupt-safe; default path helper. |
| `src/main/managers/session-manager.ts` | Edit | Add optional `store`, `clock`, `resolveBranch` deps; upsert `hadActiveSession:true` on successful spawn; add `liveWorktreeIds()`. |
| `src/main/app/quit-controller.ts` | **NEW** | Pure, window-free decision logic for the before-quit interception (unit-testable). |
| `src/main/index.ts` | Edit | Wire `QuitController` into `app.on('before-quit')`; keep `serverManager.dispose()`; add the confirmed-quit sweep path. |
| `src/main/ipc/ipc-context.ts` | Edit | Add `sessionStore?` and `confirmedQuit?` to `IpcContext`. |
| `src/main/ipc/register-ipc.ts` | Edit | Lazy `getSessionStore`; inject store/clock/resolveBranch into the lazily-built `SessionManager`; register `APP_QUIT_DECISION` + `SESSION_RECORDS`; emit `APP_QUIT_WARNING` helper. |
| `src/shared/ipc-channels.ts` | Edit | Add `SESSION_RECORDS` const. |
| `src/shared/ipc-contract.ts` | Edit | Add `session.records(): Promise<string[]>` to `MangoApi`. |
| `src/preload/index.ts` | Edit | Add `session.records` invoke wiring. |
| `src/renderer/hooks/use-session.ts` | Edit | (no signature change needed) — confirm `spawn` already takes `continueSession`. |
| `src/renderer/hooks/use-session-records.ts` | **NEW** | Fetches recorded worktree paths once; exposes `has(worktreeId)`. |
| `src/renderer/components/terminal/agent-terminal.tsx` | Edit | Accept a `continueSession` prop; pass it to `spawn`. |
| `src/renderer/App.tsx` | Edit | Use `use-session-records` to compute `continueSession` for the mounted terminal; add the quit-warning modal subscribing `onQuitWarning` + `sendQuitDecision`. |
| `__mocks__/electron.ts` | Edit | Stub `app.getPath` so `getDefaultSessionsPath()` is callable under node tests. |
| `tests/main/session-store.test.ts` | **NEW** | TDD the store (round-trip, upsert-by-path, remove, corrupt-safe, no-conversation invariant). |
| `tests/main/session-manager-persistence.test.ts` | **NEW** | TDD `hadActiveSession` upsert on spawn + `liveWorktreeIds()`. |
| `tests/main/quit-controller.test.ts` | **NEW** | TDD the before-quit decision + confirmed-quit sweep logic. |
| `tests/main/ipc-roundtrip.test.ts` | Edit | Add `APP_QUIT_DECISION` + `SESSION_RECORDS` handler-delegation tests. |

---

## Tasks

> TDD ordering throughout: write the failing test (RED), run it, write minimal code (GREEN), run full suite, commit. Each step is 2–5 minutes. **All code below is complete — no placeholders.** Reuse the EXACT contract types/channels; the preload `app.*` surface is already wired — do NOT redefine it.

---

### Task 1 — `SessionStore` (TDD, pure persistence)

**Files:** `tests/main/session-store.test.ts` (new), `src/main/managers/session-store.ts` (new), `__mocks__/electron.ts` (edit).

#### Step 1.1 — Extend the electron mock so `app.getPath` exists

The store's default-path helper calls `app.getPath('userData')`; the node test project aliases `electron` to `__mocks__/electron.ts`, which currently lacks `getPath`. Add it.

Edit `__mocks__/electron.ts` — replace the `app` export:

```ts
export const app = {
  getVersion: vi.fn(() => '0.1.0'),
  getPath: vi.fn((name: string) => `/tmp/mango-userData/${name}`),
};
```

(Leave every other export untouched.)

#### Step 1.2 — RED: write `tests/main/session-store.test.ts`

```ts
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
```

Run `npx vitest run tests/main/session-store.test.ts` — expect failure (module not found). **RED confirmed.**

#### Step 1.3 — GREEN: write `src/main/managers/session-store.ts`

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRecord } from '../../shared/types';

/**
 * Resolves the default sessions.json path under Electron's userData dir.
 * Kept separate so register-ipc can build the store lazily while tests inject
 * an explicit temp path into the SessionStore constructor instead.
 */
export function getDefaultSessionsPath(getUserDataPath: () => string): string {
  return join(getUserDataPath(), 'sessions.json');
}

/**
 * Persists the b-lite SessionRecord[] (MVP item 6) to a single JSON file whose
 * path is injected (tests use a temp file). HARD INVARIANT: only the four
 * SessionRecord contract fields are written — NEVER conversation content. claude
 * owns conversation rehydration via `--continue`; this store only records WHICH
 * worktrees had a session. Never throws on a missing/corrupt file (treated as
 * empty). Writes are atomic-ish (temp file + rename) so a crash mid-write cannot
 * leave a half-written sessions.json that would then read as empty.
 */
export class SessionStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Reads + parses the records, returning [] on missing/corrupt/non-array files. */
  load(): SessionRecord[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => this.sanitize(r as SessionRecord));
  }

  /** Alias for load() — present so callers reading "all records" read clearly. */
  all(): SessionRecord[] {
    return this.load();
  }

  /** Inserts or replaces (by worktreePath) a record, then persists. */
  upsert(record: SessionRecord): void {
    const clean = this.sanitize(record);
    const records = this.load().filter((r) => r.worktreePath !== clean.worktreePath);
    records.push(clean);
    this.write(records);
  }

  /** Drops the record for a worktreePath (no-op if absent), then persists. */
  remove(worktreePath: string): void {
    const records = this.load();
    const next = records.filter((r) => r.worktreePath !== worktreePath);
    if (next.length === records.length) return; // nothing to do; avoid a pointless write
    this.write(next);
  }

  /** Projects an input down to EXACTLY the four contract fields (drops anything else). */
  private sanitize(r: SessionRecord): SessionRecord {
    return {
      worktreePath: r.worktreePath,
      branch: r.branch,
      hadActiveSession: r.hadActiveSession,
      updatedAt: r.updatedAt,
    };
  }

  private write(records: SessionRecord[]): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2));
    renameSync(tmp, this.filePath);
  }
}
```

> **Atomic-write justification:** `writeFileSync(tmp) + renameSync` makes the swap atomic on the same filesystem, so a crash mid-write never leaves a truncated `sessions.json` that `load()` would silently treat as empty (which would lose every recorded worktree). `userData` and its `.tmp` sibling are always on the same FS, so `renameSync` is atomic here.

Run `npx vitest run tests/main/session-store.test.ts` — expect **all green**.

#### Step 1.4 — Full suite + commit

`npm test && npm run typecheck:node && npm run lint`. Then commit: `feat(session): add SessionStore b-lite persistence (Plan 5)`.

---

### Task 2 — `SessionManager` persistence hook + `liveWorktreeIds()` (TDD)

**Files:** `tests/main/session-manager-persistence.test.ts` (new), `src/main/managers/session-manager.ts` (edit).

#### Step 2.1 — RED: write `tests/main/session-manager-persistence.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionManager, type SessionEmitter } from '../../src/main/managers/session-manager';
import type { PtyFactory, IPtyLike } from '../../src/main/pty/pty-factory';
import { makeFakePty, type FakePtyHandle } from '../helpers/fake-pty';
import type { AgentSession, SessionRecord } from '../../src/shared/types';

function spyEmitter(): SessionEmitter {
  return { emitOutput: vi.fn(), emitExit: vi.fn(), emitStatus: vi.fn() };
}
function factoryOf(fakes: FakePtyHandle[]): PtyFactory {
  let i = 0;
  return {
    spawn: () => {
      const f = fakes[i++];
      if (!f) throw new Error('out of fakes');
      return f as unknown as IPtyLike;
    },
  };
}
function fakeStore() {
  const records: SessionRecord[] = [];
  return {
    upsert: vi.fn((r: SessionRecord) => {
      const idx = records.findIndex((x) => x.worktreePath === r.worktreePath);
      if (idx >= 0) records[idx] = r;
      else records.push(r);
    }),
    remove: vi.fn(),
    all: () => records,
    load: () => records,
    records,
  };
}

const WT = '/repo/.worktrees/feat';

describe('SessionManager persistence hook', () => {
  it('upserts {hadActiveSession:true} with branch + clock time on a successful spawn', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(7)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
      resolveBranch: async () => 'feature/login',
      store: store as never,
      clock: () => 555,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(store.upsert).toHaveBeenCalledWith({
      worktreePath: WT,
      branch: 'feature/login',
      hadActiveSession: true,
      updatedAt: 555,
    });
  });

  it('does NOT upsert when the worktree id is unknown (spawn errored, no PTY)', async () => {
    const store = fakeStore();
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty()]),
      emitter: spyEmitter(),
      resolvePath: async () => undefined,
      store: store as never,
    });
    const s = await mgr.spawn({ worktreeId: '/nope', continueSession: false, cols: 80, rows: 24 });
    expect(s.status).toBe('error');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('works with no store/clock injected (back-compat for existing tests)', async () => {
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty(9)]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
    });
    const s = await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(s.status).toBe('running'); // no throw despite absent store/branch resolver
  });

  it('liveWorktreeIds() lists worktrees with a running PTY, excluding exited ones', async () => {
    const a = makeFakePty(1);
    const b = makeFakePty(2);
    const mgr = new SessionManager({
      factory: factoryOf([a, b]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
    });
    await mgr.spawn({ worktreeId: '/wt/a', continueSession: false, cols: 80, rows: 24 });
    await mgr.spawn({ worktreeId: '/wt/b', continueSession: false, cols: 80, rows: 24 });
    expect(mgr.liveWorktreeIds().sort()).toEqual(['/wt/a', '/wt/b']);
    a.emitExit(0);
    expect(mgr.liveWorktreeIds()).toEqual(['/wt/b']);
  });

  it('liveWorktreeIds() is empty after killAll (quit sweep leaves nothing live)', async () => {
    const mgr = new SessionManager({
      factory: factoryOf([makeFakePty()]),
      emitter: spyEmitter(),
      resolvePath: async (id) => id,
    });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.killAll();
    expect(mgr.liveWorktreeIds()).toEqual([]);
  });
});
```

Run it — expect failures (`resolveBranch`/`store`/`clock`/`liveWorktreeIds` don't exist). **RED.**

#### Step 2.2 — GREEN: edit `src/main/managers/session-manager.ts`

**(a)** Extend the imports + deps interface. Add a `SessionStore`-shaped port (structural, so the real `SessionStore` and the test fake both satisfy it without importing the class):

Replace the top imports:

```ts
import type { Ack, AgentSession, AgentStatus, SessionRecord } from '../../shared/types';
import type { IPtyLike, PtyExitEvent, PtyFactory } from '../pty/pty-factory';
```

Add, just below the `SessionEmitter` interface:

```ts
/** Structural port for the SessionStore (Plan 5) — only what SessionManager calls. */
export interface SessionRecordSink {
  upsert(record: SessionRecord): void;
}
```

Extend `SessionManagerDeps` (add three optional fields, leaving the existing ones intact):

```ts
export interface SessionManagerDeps {
  readonly factory: PtyFactory;
  readonly emitter: SessionEmitter;
  /** Binary to spawn; default 'claude'. Injectable so smokes use a harmless cmd. */
  readonly command?: string;
  /** Resolves worktreeId -> absolute cwd, or undefined if not a managed worktree. */
  readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  /** Resolves worktreeId -> branch name for the persisted SessionRecord (Plan 5). */
  readonly resolveBranch?: (worktreeId: string) => Promise<string | undefined>;
  /** Persists hadActiveSession on successful spawn (Plan 5). Optional => no-op. */
  readonly store?: SessionRecordSink;
  /** Clock for SessionRecord.updatedAt; default Date.now (Plan 5). */
  readonly clock?: () => number;
}
```

**(b)** Store them in the constructor. Add the three private fields next to the existing ones:

```ts
  private readonly resolveBranch?: (worktreeId: string) => Promise<string | undefined>;
  private readonly store?: SessionRecordSink;
  private readonly clock: () => number;
```

and in the constructor body, after `this.resolvePath = deps.resolvePath;`:

```ts
    this.resolveBranch = deps.resolveBranch;
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
```

**(c)** Record on successful spawn. In `spawn()`, after the session is mapped and the `running` AgentSession is built but before `return running;` — i.e. right after `this.emitter.emitStatus(running);` — add the persistence call. The PTY exists here, so this is the "successful spawn" point (the `error` early-return above never reaches it, satisfying the "no upsert on unknown id" test):

```ts
    await this.recordActive(worktreeId);

    return running;
```

(Replace the existing `return running;` with the two lines above.)

**(d)** Add the two new private/public methods at the end of the class (before the closing brace):

```ts
  /** Lists worktrees whose PTY is currently running (used by the quit warning). */
  liveWorktreeIds(): string[] {
    const ids: string[] = [];
    for (const [worktreeId, session] of this.sessions) {
      if (!session.exited) ids.push(worktreeId);
    }
    return ids;
  }

  /**
   * Persists {hadActiveSession:true} for a worktree after a successful spawn so a
   * reopen offers `claude --continue`. Resolves branch via the injected resolver
   * (falls back to '' if unknown). No-op when no store is injected. NEVER writes
   * conversation content — only the four SessionRecord contract fields.
   */
  private async recordActive(worktreeId: string): Promise<void> {
    if (!this.store) return;
    const branch = (await this.resolveBranch?.(worktreeId)) ?? '';
    this.store.upsert({
      worktreePath: worktreeId,
      branch,
      hadActiveSession: true,
      updatedAt: this.clock(),
    });
  }
```

> **Design decision — do NOT clear `hadActiveSession` on user-kill.** b-lite's purpose is "a worktree that *ever* had an agent offers `--continue` on reopen." If we cleared the record on an explicit `kill()`, restarting and reselecting that worktree would spawn a *fresh* `claude` and silently drop the continuation the user expects. claude's own `--continue` is a no-op-friendly continuation (it just resumes the latest session for that cwd), so keeping the record is the safe, low-surprise choice. Records are therefore only added (on spawn); removal is reserved for worktree teardown if a later plan wants it (out of MVP scope).

Run `npx vitest run tests/main/session-manager-persistence.test.ts` **and** `tests/main/session-manager.test.ts` — both green (the existing test's `makeManager` passes no store/clock/resolveBranch, exercising the back-compat path).

#### Step 2.3 — Full suite + commit

`npm test && npm run typecheck:node && npm run lint`. Commit: `feat(session): track hadActiveSession on spawn + liveWorktreeIds (Plan 5)`.

---

### Task 3 — `QuitController` (TDD, pure before-quit logic)

**Files:** `tests/main/quit-controller.test.ts` (new), `src/main/app/quit-controller.ts` (new).

This isolates the tricky Electron `preventDefault`/re-entrancy logic into a window-free, fully unit-testable object so `index.ts` stays a thin wiring shell.

#### Step 3.1 — RED: write `tests/main/quit-controller.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { QuitController, type QuitControllerDeps } from '../../src/main/app/quit-controller';

function deps(over: Partial<QuitControllerDeps> = {}) {
  const calls: string[] = [];
  const base = {
    liveWorktreeIds: () => ['/wt/a', '/wt/b'],
    emitQuitWarning: vi.fn((ids: readonly string[]) => calls.push(`warn:${ids.join(',')}`)),
    sweep: vi.fn(() => calls.push('sweep')),
    quitNow: vi.fn(() => calls.push('quitNow')),
    ...over,
  };
  return { base, calls };
}

describe('QuitController', () => {
  it('intercepts the first quit when sessions are live: preventDefault + emit warning, no sweep yet', () => {
    const { base } = deps();
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(base.emitQuitWarning).toHaveBeenCalledWith(['/wt/a', '/wt/b']);
    expect(base.sweep).not.toHaveBeenCalled();
    expect(base.quitNow).not.toHaveBeenCalled();
  });

  it('does NOT intercept when there are no live sessions (lets quit proceed, still sweeps)', () => {
    const { base } = deps({ liveWorktreeIds: () => [] });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(base.sweep).toHaveBeenCalledOnce(); // unconditional orphan-claude prevention
    expect(base.emitQuitWarning).not.toHaveBeenCalled();
  });

  it('decide(true): sweeps then quits, and a re-fired before-quit is allowed through', () => {
    const { base, calls } = deps();
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() }); // intercepted
    ctrl.decide(true);
    expect(calls).toEqual(['warn:/wt/a,/wt/b', 'sweep', 'quitNow']);
    // app.quit() re-fires before-quit; the confirmed flag must let it pass without re-warning.
    const e2 = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e2);
    expect(e2.preventDefault).not.toHaveBeenCalled();
    expect(base.emitQuitWarning).toHaveBeenCalledOnce(); // not warned a second time
  });

  it('decide(false): does not sweep or quit; stays open and can be re-intercepted', () => {
    const { base } = deps();
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    ctrl.decide(false);
    expect(base.sweep).not.toHaveBeenCalled();
    expect(base.quitNow).not.toHaveBeenCalled();
    const e2 = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e2);
    expect(e2.preventDefault).toHaveBeenCalledOnce(); // intercepts again
  });

  it('sweep on the no-live path runs only once even if before-quit fires repeatedly', () => {
    const { base } = deps({ liveWorktreeIds: () => [] });
    const ctrl = new QuitController(base);
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    ctrl.onBeforeQuit({ preventDefault: vi.fn() });
    expect(base.sweep).toHaveBeenCalledOnce();
  });
});
```

Run it — RED (module missing).

#### Step 3.2 — GREEN: write `src/main/app/quit-controller.ts`

```ts
/** The minimal `before-quit` event slice QuitController needs (window-free). */
export interface BeforeQuitEventLike {
  preventDefault(): void;
}

/** Injected effects so QuitController is pure logic + unit-testable. */
export interface QuitControllerDeps {
  /** Worktrees with a live PTY right now (SessionManager.liveWorktreeIds). */
  liveWorktreeIds(): string[];
  /** Sends APP_QUIT_WARNING({activeWorktreeIds}) to the renderer. */
  emitQuitWarning(activeWorktreeIds: readonly string[]): void;
  /** The PTY/server kill-sweep (sessionManager.killAll + serverManager.dispose). */
  sweep(): void;
  /** Actually quit (app.quit). Re-fires before-quit; the confirmed flag lets it through. */
  quitNow(): void;
}

/**
 * Owns the Electron before-quit interception for MVP item 6.
 *
 * Re-entrancy is the whole game here. `app.quit()` re-fires `before-quit`, so a
 * naive "preventDefault + warn" would deadlock the quit. We track `confirmedQuit`:
 *
 *  1st before-quit, sessions live, not confirmed  -> preventDefault + emit warning.
 *  renderer answers via decide(true)              -> set confirmed, sweep, quitNow().
 *  app.quit() re-fires before-quit, confirmed     -> fall through (no preventDefault).
 *  decide(false)                                  -> stay open; next quit re-intercepts.
 *
 * When NO sessions are live we never intercept, but we STILL sweep exactly once so
 * a server child / any stray PTY can't be orphaned (binding invariant §7).
 */
export class QuitController {
  private confirmedQuit = false;
  private sweptOnQuit = false;

  constructor(private readonly deps: QuitControllerDeps) {}

  /** Wire as `app.on('before-quit', (e) => controller.onBeforeQuit(e))`. */
  onBeforeQuit(e: BeforeQuitEventLike): void {
    if (this.confirmedQuit) {
      this.sweepOnce();
      return; // user already confirmed; let Electron quit.
    }
    const live = this.deps.liveWorktreeIds();
    if (live.length === 0) {
      this.sweepOnce(); // unconditional orphan prevention even on the happy path.
      return;
    }
    e.preventDefault();
    this.deps.emitQuitWarning(live);
  }

  /** Renderer's answer to the warning (APP_QUIT_DECISION handler calls this). */
  decide(quit: boolean): void {
    if (!quit) return; // stay open; before-quit can intercept again later.
    this.confirmedQuit = true;
    this.sweepOnce();
    this.deps.quitNow();
  }

  private sweepOnce(): void {
    if (this.sweptOnQuit) return;
    this.sweptOnQuit = true;
    this.deps.sweep();
  }
}
```

Run `npx vitest run tests/main/quit-controller.test.ts` — green.

#### Step 3.3 — Full suite + commit

`npm test && npm run typecheck:node && npm run lint`. Commit: `feat(app): QuitController for before-quit warning + kill-sweep (Plan 5)`.

---

### Task 4 — Shared channel + contract + preload for `SESSION_RECORDS`

**Files:** `src/shared/ipc-channels.ts`, `src/shared/ipc-contract.ts`, `src/preload/index.ts`.

> `APP_QUIT_WARNING` / `APP_QUIT_DECISION` already exist in all three files (preload `app.*` is done). This task only adds the additive `SESSION_RECORDS` fetch channel the renderer needs to decide `continueSession`.

#### Step 4.1 — Add the channel const

Edit `src/shared/ipc-channels.ts` — in the `// agent session (mixed)` block, after `SESSION_STATUS`:

```ts
  SESSION_RECORDS: 'session:records', // invoke (recorded worktree paths for rehydrate)
```

#### Step 4.2 — Add the API method

Edit `src/shared/ipc-contract.ts` — inside `session: { ... }`, after `kill(...)`:

```ts
    /** Recorded worktree paths that had an agent (=> spawn with --continue). */
    records(): Promise<string[]>;
```

#### Step 4.3 — Wire the preload

Edit `src/preload/index.ts` — inside `session: { ... }`, after the `kill` line:

```ts
    records: () => ipcRenderer.invoke(IPC.SESSION_RECORDS),
```

#### Step 4.4 — Typecheck both projects + commit

`npm run typecheck` (node + web). Commit: `feat(ipc): add SESSION_RECORDS channel for rehydrate (Plan 5)`.

---

### Task 5 — Wire main: context, register-ipc handlers, index.ts before-quit (TDD on handlers)

**Files:** `src/main/ipc/ipc-context.ts`, `src/main/ipc/register-ipc.ts`, `src/main/index.ts`, `tests/main/ipc-roundtrip.test.ts` (edit).

#### Step 5.1 — Extend `IpcContext`

Edit `src/main/ipc/ipc-context.ts`. Add the import + two fields:

```ts
import type { SessionStore } from '../managers/session-store';
```

Inside `IpcContext` (after `mergeRunner?`):

```ts
  /** Lazily constructed in register-ipc; injectable in tests (Plan 5). */
  sessionStore?: SessionStore;
  /** Set true once the user confirms quit so before-quit stops re-intercepting (Plan 5). */
  confirmedQuit?: boolean;
```

#### Step 5.2 — RED: add handler-delegation tests to `tests/main/ipc-roundtrip.test.ts`

Append a new `describe` block (reuse the existing `makeIpcMain` pattern). This exercises `APP_QUIT_DECISION` delegating to `QuitController.decide` via the sessionManager and `SESSION_RECORDS` returning the store's recorded paths:

```ts
describe('registerIpc — app quit + session records (Plan 5)', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('SESSION_RECORDS returns the recorded worktree paths from the SessionStore', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = {
      all: vi.fn(() => [
        { worktreePath: '/wt/a', branch: 'f', hadActiveSession: true, updatedAt: 1 },
        { worktreePath: '/wt/b', branch: 'g', hadActiveSession: true, updatedAt: 2 },
      ]),
    };
    registerIpc(ipcMain as never, { mainWindow: null, sessionStore: store as never });
    const out = await handlers.get('session:records')!({});
    expect(out).toEqual(['/wt/a', '/wt/b']);
  });

  it('APP_QUIT_DECISION(quit:true) kills all sessions, disposes server, and returns ok', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const session = { killAll: vi.fn(), liveWorktreeIds: vi.fn(() => []) };
    const server = { dispose: vi.fn() };
    const ctx = {
      mainWindow: null,
      sessionManager: session as never,
      serverManager: server as never,
    };
    registerIpc(ipcMain as never, ctx);
    const ack = await handlers.get('app:quit-decision')!({}, { quit: true });
    expect(session.killAll).toHaveBeenCalledOnce();
    expect(server.dispose).toHaveBeenCalledOnce();
    expect(ctx.confirmedQuit).toBe(true);
    expect(ack).toEqual({ ok: true });
  });

  it('APP_QUIT_DECISION(quit:false) does NOT sweep and returns ok', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const session = { killAll: vi.fn(), liveWorktreeIds: vi.fn(() => []) };
    const server = { dispose: vi.fn() };
    const ctx = {
      mainWindow: null,
      sessionManager: session as never,
      serverManager: server as never,
    };
    registerIpc(ipcMain as never, ctx);
    const ack = await handlers.get('app:quit-decision')!({}, { quit: false });
    expect(session.killAll).not.toHaveBeenCalled();
    expect(server.dispose).not.toHaveBeenCalled();
    expect(ctx.confirmedQuit).toBeFalsy();
    expect(ack).toEqual({ ok: true });
  });
});
```

> **Note on the decision split:** to keep `APP_QUIT_DECISION` independently testable (no Electron `app`), the handler performs the sweep + sets `ctx.confirmedQuit` directly and the renderer triggers the actual `app.quit()` indirectly — but the *real* `app.quit()` call must happen in main. We resolve this by having the handler set `confirmedQuit`, sweep, and then call the injected `ctx.requestQuit` if present (wired from `index.ts` to `app.quit`). The test above asserts the sweep + flag; the quit call is covered by the index wiring (Step 5.4) and the manual smoke. Add `requestQuit?: () => void` to `IpcContext` for this.

Add to `IpcContext` (Step 5.1 file) one more field:

```ts
  /** Injected by index.ts so the quit handler can actually quit (app.quit). */
  requestQuit?: () => void;
```

Run the test — RED (`app:quit-decision` / `session:records` handlers don't exist).

#### Step 5.3 — GREEN: edit `src/main/ipc/register-ipc.ts`

**(a)** Add imports near the existing manager imports:

```ts
import type { SessionStore } from '../managers/session-store';
```

**(b)** Add a lazy store getter (mirrors `getLogStore`). Place after `getLogStore`:

```ts
/**
 * Resolves the SessionStore SYNCHRONOUSLY. It is constructed eagerly in
 * `index.ts` (which holds the real electron `app` for the userData path) and
 * assigned to `ctx.sessionStore` BEFORE `registerIpc`; tests inject
 * `ctx.sessionStore` directly. Kept sync so `getSessionManager` and the
 * `SESSION_INPUT`/`SESSION_RESIZE` `ipcMain.on` handlers stay synchronous — the
 * existing Plan-2 delegation tests assert `write`/`resize` was called synchronously.
 */
function getSessionStore(ctx: IpcContext): SessionStore {
  if (ctx.sessionStore) return ctx.sessionStore;
  throw new Error('sessionStore not initialized — index.ts must set ctx.sessionStore before registerIpc');
}
```

**(c)** Inject store/clock/resolveBranch into the lazily-built `SessionManager`. `getSessionManager` stays **synchronous** (do NOT make it async — that would force the `SESSION_INPUT`/`SESSION_RESIZE` `ipcMain.on` handlers to defer `write`/`resize` to a microtask via `.then()`, breaking the existing synchronous Plan-2 delegation tests). The store is read synchronously via `getSessionStore(ctx)` (constructed eagerly in `index.ts`).

The committed `getSessionManager` already builds the manager synchronously with async resolver closures. Edit it to ALSO pass `resolveBranch`, `store`, and `clock` (leave everything else as-is):

```ts
function getSessionManager(ctx: IpcContext): SessionManager {
  if (ctx.sessionManager) return ctx.sessionManager;
  ctx.sessionManager = new SessionManager({
    factory: new NodePtyFactory(),
    emitter: buildSessionEmitter(ctx),
    command: 'claude',
    resolvePath: async (worktreeId) => {
      const manager = await getWorktreeManager(ctx);
      const trees = await manager.list();
      return trees.find((t) => t.id === worktreeId)?.path;
    },
    resolveBranch: async (worktreeId) => {
      const manager = await getWorktreeManager(ctx);
      const trees = await manager.list();
      return trees.find((t) => t.id === worktreeId)?.branch;
    },
    store: getSessionStore(ctx),
    clock: Date.now,
  });
  return ctx.sessionManager;
}
```

The `SESSION_SPAWN`/`SESSION_KILL`/`SESSION_INPUT`/`SESSION_RESIZE` handlers stay EXACTLY as the committed Plan-2 code (synchronous `getSessionManager(ctx)`) — do NOT add `await`/`.then`:

```ts
  ipcMain.handle(
    IPC.SESSION_SPAWN,
    async (_event: unknown, req: SpawnSessionRequest): Promise<AgentSession> => {
      return getSessionManager(ctx).spawn(req);
    },
  );

  ipcMain.handle(
    IPC.SESSION_KILL,
    async (_event: unknown, req: { worktreeId: string }): Promise<Ack> => {
      return getSessionManager(ctx).kill(req.worktreeId);
    },
  );

  ipcMain.on(IPC.SESSION_INPUT, (_event: unknown, req: SessionInputRequest) => {
    getSessionManager(ctx).write(req);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event: unknown, req: SessionResizeRequest) => {
    getSessionManager(ctx).resize(req);
  });
```

> The existing `ipc-roundtrip.test.ts` session tests inject `ctx.sessionManager` directly, so `getSessionManager` short-circuits on the first line and never touches `getSessionStore`/electron — they stay green AND synchronous (no microtask deferral).

**(d)** Add the two new handlers (place them after `MERGE_RUN` inside `registerIpc`):

```ts
  ipcMain.handle(IPC.SESSION_RECORDS, async (): Promise<string[]> => {
    return getSessionStore(ctx)
      .all()
      .map((r) => r.worktreePath);
  });

  ipcMain.handle(
    IPC.APP_QUIT_DECISION,
    async (_event: unknown, req: { quit: boolean }): Promise<Ack> => {
      if (!req.quit) return { ok: true }; // user cancelled — stay open.
      ctx.confirmedQuit = true;
      ctx.sessionManager?.killAll(); // PTY kill-sweep: no orphan claude survives.
      ctx.serverManager?.dispose(); // keep Plan 3's server cleanup.
      ctx.requestQuit?.(); // index.ts wires this to app.quit().
      return { ok: true };
    },
  );
```

Add `SESSION_RECORDS` / `APP_QUIT_DECISION` to the channel-imports — they come via the `IPC` object (already imported), so no import change. Add `AgentSession` etc. are already imported.

Run the edited `ipc-roundtrip.test.ts` — green.

#### Step 5.4 — Wire `src/main/index.ts` (before-quit + quit-warning emission)

Replace the whole `app.on('before-quit', ...)` block and add the `QuitController` + `requestQuit` wiring. New `index.ts`:

```ts
import { resolve } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';
import { IPC } from '../shared/ipc-channels';
import { QuitController } from './app/quit-controller';
import { SessionStore, getDefaultSessionsPath } from './managers/session-store';
import type { QuitWarningEvent } from '../shared/types';

const ctx = createIpcContext();
ctx.repoRoot = process.cwd();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: resolve(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node built-ins (node:module via pty-factory chain)
    },
  });
  ctx.mainWindow = win;

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(resolve(import.meta.dirname, '../renderer/index.html'));
  }
}

/** Sends APP_QUIT_WARNING to the renderer (window-guarded; no-op if destroyed). */
function emitQuitWarning(activeWorktreeIds: readonly string[]): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  const payload: QuitWarningEvent = { activeWorktreeIds };
  win.webContents.send(IPC.APP_QUIT_WARNING, payload);
}

const quitController = new QuitController({
  liveWorktreeIds: () => ctx.sessionManager?.liveWorktreeIds() ?? [],
  emitQuitWarning,
  sweep: () => {
    ctx.sessionManager?.killAll(); // orphan-claude prevention (binding invariant §7).
    ctx.serverManager?.dispose(); // Plan 3 server cleanup.
  },
  quitNow: () => app.quit(),
});

// The APP_QUIT_DECISION handler (in register-ipc) calls ctx.requestQuit when the
// user confirms; route that to the controller so the confirmed flag + sweep + quit
// all flow through one place, and the re-fired before-quit is let through.
ctx.requestQuit = () => quitController.decide(true);

app.whenReady().then(() => {
  // Construct the SessionStore eagerly (we hold the real electron `app` for the
  // userData path) and assign it BEFORE registerIpc, so getSessionStore /
  // getSessionManager stay synchronous and the SESSION_INPUT/RESIZE on-handlers
  // keep their synchronous delegation (the Plan-2 tests assert it).
  ctx.sessionStore = new SessionStore(getDefaultSessionsPath(() => app.getPath('userData')));
  registerIpc(ipcMain, ctx);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  quitController.onBeforeQuit(e);
});
```

> **Re-entrancy, stated exactly:** First quit with live sessions → `QuitController.onBeforeQuit` calls `e.preventDefault()` and `emitQuitWarning`. Renderer confirms → `APP_QUIT_DECISION` handler sets `ctx.confirmedQuit`, sweeps, and calls `ctx.requestQuit()` → `quitController.decide(true)` → sets `confirmedQuit` inside the controller, sweeps (idempotent — `sweepOnce` guards a double sweep), and calls `app.quit()`. `app.quit()` re-fires `before-quit`; now `quitController.confirmedQuit` is true so `onBeforeQuit` does NOT `preventDefault` and the app exits. If no sessions are live, `onBeforeQuit` never prevents default and sweeps once — the app quits immediately with no dialog and no orphan processes.

#### Step 5.5 — Full suite + typecheck + lint + commit

`npm test && npm run typecheck && npm run lint`. Commit: `feat(main): wire before-quit warning, kill-sweep, SESSION_RECORDS (Plan 5)`.

---

### Task 6 — Renderer: rehydrate-on-select + quit-warning dialog

**Files:** `src/renderer/hooks/use-session-records.ts` (new), `src/renderer/components/terminal/agent-terminal.tsx` (edit), `src/renderer/App.tsx` (edit). (`use-session.ts` already accepts `continueSession` — no change.)

> The renderer surfaces here are verified by typecheck/lint/build + a documented manual/Playwright smoke (matching the Plan 0–4 strategy — no flaky e2e committed). No new vitest renderer test is added because there is no pure logic to extract; the dialog + rehydrate are integration behaviors.

#### Step 6.1 — `use-session-records.ts`

```ts
import { useEffect, useState } from 'react';

/** Exposes which worktrees had a recorded agent session (=> spawn with --continue). */
export interface UseSessionRecords {
  /** True if the worktree had a session at last quit (rehydrate via claude --continue). */
  has(worktreeId: string): boolean;
  /** True until the initial fetch resolves (avoids spawning fresh before we know). */
  readonly loading: boolean;
}

/**
 * Fetches the recorded worktree paths ONCE on mount via window.mango.session.records().
 * The app stores no conversation content; this is only the set of worktrees that had a
 * session, used to decide continueSession for the lazily-mounted AgentTerminal.
 */
export function useSessionRecords(): UseSessionRecords {
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.mango.session
      .records()
      .then((recorded) => {
        if (alive) setPaths(new Set(recorded));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { has: (id) => paths.has(id), loading };
}
```

#### Step 6.2 — `agent-terminal.tsx`: accept + forward `continueSession`

Edit the props interface:

```ts
export interface AgentTerminalProps {
  /** The worktree whose `claude` PTY this terminal is bound to. */
  readonly worktreeId: string;
  /** When true, spawn `claude --continue` to rehydrate (b-lite restart, MVP item 6). */
  readonly continueSession?: boolean;
}
```

Update the component signature + the spawn call. Change the destructure:

```ts
export function AgentTerminal({
  worktreeId,
  continueSession = false,
}: AgentTerminalProps): React.JSX.Element {
```

Keep the existing `continueSession` value fresh across the mount effect via a ref (same pattern as the other callbacks). Add near the other refs:

```ts
  const continueRef = useRef(continueSession);
  continueRef.current = continueSession;
```

Change the spawn line inside the effect from:

```ts
    void spawnRef.current(term.cols, term.rows, false);
```

to:

```ts
    void spawnRef.current(term.cols, term.rows, continueRef.current);
```

> The effect dep array stays `[worktreeId]` (unchanged): re-selecting a different worktree remounts via the `key={selectedId}` in `App.tsx`, and `continueRef` carries the current value into the single mount-time spawn. We deliberately do NOT add `continueSession` to the dep array — a flip of that flag should not re-spawn an already-running PTY.

#### Step 6.3 — `App.tsx`: compute `continueSession`, add the quit dialog

Add imports:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, QuitWarningEvent, Worktree } from '../shared/types';
import { useSessionRecords } from './hooks/use-session-records';
```

(Adjust the existing `react` import to include `useEffect`, and add `QuitWarningEvent` to the type import.)

Inside `App`, after the existing hook calls:

```ts
  const sessionRecords = useSessionRecords();
  const [quitWarning, setQuitWarning] = useState<QuitWarningEvent | null>(null);

  useEffect(() => {
    return window.mango.app.onQuitWarning((e) => setQuitWarning(e));
  }, []);

  const onQuitDecision = useCallback(async (quit: boolean): Promise<void> => {
    setQuitWarning(null);
    await window.mango.app.sendQuitDecision(quit);
  }, []);
```

Change the terminal render to pass `continueSession` (only spawn `--continue` once records are loaded, so a fresh worktree isn't accidentally continued mid-fetch):

```tsx
          {selectedId ? (
            <AgentTerminal
              key={selectedId}
              worktreeId={selectedId}
              continueSession={!sessionRecords.loading && sessionRecords.has(selectedId)}
            />
          ) : (
            <p style={{ fontSize: 13, color: '#888' }}>Select a worktree to start its agent.</p>
          )}
```

Add the modal just before the closing `</main>`:

```tsx
      {quitWarning && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="quit-warning"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, maxWidth: 380 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Quit MangoLove IDEA?</h2>
            <p style={{ fontSize: 13 }}>
              {quitWarning.activeWorktreeIds.length} agent session(s) are live. They will be
              terminated (their conversations are saved by claude and resume with{' '}
              <code>--continue</code> next time). Quit anyway?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={() => void onQuitDecision(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void onQuitDecision(true)}>
                Quit anyway
              </button>
            </div>
          </div>
        </div>
      )}
```

#### Step 6.4 — Typecheck web + build + lint + commit

`npm run typecheck:web && npm run lint && npm run build`. Commit: `feat(renderer): rehydrate-on-select + quit-warning dialog (Plan 5)`.

---

### Task 7 — Verification (typecheck/lint/build + documented manual smoke)

**Files:** none (verification only); optionally append a manual-smoke note to `README.md` if Plans 0–4 did so.

#### Step 7.1 — Full automated gate

Run, in order, and confirm each passes (evidence before claiming done — `superpowers:verification-before-completion`):

```bash
npm test            # all prior 107 tests + the new session-store/session-manager-persistence/quit-controller/ipc tests
npm run typecheck   # node + web
npm run lint
npm run build       # electron-vite build of all three targets
```

#### Step 7.2 — Documented manual smoke (no flaky e2e committed)

Perform and record the result of this exact script (matches the Plan 0–4 manual-smoke approach):

1. `npm run dev`. Create a worktree, select it → a `claude` PTY spawns (fresh, `continueSession:false` because no record yet). Confirm `~/Library/Application Support/mangolove-idea/sessions.json` now contains `{worktreePath, branch, hadActiveSession:true, updatedAt}` for that worktree and **nothing else** (grep it for any conversation text — there must be none).
2. With that session live, quit (Cmd-Q). The **quit-warning dialog** appears showing "1 agent session(s) are live". Click **Cancel** → app stays open. Quit again → dialog → **Quit anyway** → app exits.
3. Verify no orphan: `pgrep -f claude` returns nothing spawned by the app (kill-sweep verified).
4. Reopen (`npm run dev`). Select the same worktree → the terminal spawns with `claude --continue` (observe claude rehydrating the prior conversation; the app injected `continueSession:true` from the record). A brand-new, never-recorded worktree still spawns fresh `claude`.
5. (Optional Playwright, NOT committed) drive steps 2–3 via `@playwright/test` against the dev build to confirm the dialog renders `data-testid="quit-warning"` and that `sendQuitDecision(true)` exits the app — but do **not** add this to CI (flaky e2e infra stays out, per §1.4).

#### Step 7.3 — Final commit

If README was updated: `docs(plan5): document session-persistence manual smoke`. Otherwise Plan 5 is complete at the Task 6 commit.

---

## Plan 5 Acceptance Checklist

- [ ] `SessionStore` persists `SessionRecord[]` to an **injected** JSON path (default `userData/sessions.json`); `load/all/upsert(by worktreePath)/remove` work; missing/corrupt/non-array files load as `[]` without throwing; writes are atomic (temp+rename). **Test:** `tests/main/session-store.test.ts`.
- [ ] `SessionStore` writes **ONLY** `{worktreePath, branch, hadActiveSession, updatedAt}` — verified by the "no conversation content" test that smuggles an extra key and asserts it is stripped.
- [ ] `SessionManager` upserts `{hadActiveSession:true, branch, updatedAt:clock()}` on a **successful** spawn (not on the unknown-id error path); store/clock/resolveBranch are optional so all prior `session-manager.test.ts` cases stay green. **Test:** `tests/main/session-manager-persistence.test.ts`.
- [ ] `SessionManager.liveWorktreeIds()` returns running (non-exited) worktrees and is empty after `killAll()`. **Test:** same file.
- [ ] Quit warning is based on **live agent sessions**, NOT a faked turn — `hasActiveTurn` remains honestly `false`. (Stated in Architecture §3; `QuitController` consumes `liveWorktreeIds()`.)
- [ ] `QuitController` intercepts the first quit when sessions are live (`preventDefault` + emit `APP_QUIT_WARNING`), lets a confirmed quit through (re-entrancy via `confirmedQuit`), sweeps exactly once, and sweeps even on the no-live happy path. **Test:** `tests/main/quit-controller.test.ts`.
- [ ] `APP_QUIT_DECISION(true)` runs the kill-sweep (`sessionManager.killAll()` + `serverManager.dispose()`), sets `ctx.confirmedQuit`, and quits; `(false)` stays open. **Test:** `tests/main/ipc-roundtrip.test.ts` (Plan 5 block).
- [ ] `SESSION_RECORDS` returns the recorded worktree paths from the store. **Test:** same block.
- [ ] Renderer: a recorded worktree's `AgentTerminal` spawns with `continueSession:true` on select (lazy rehydrate); a non-recorded one spawns fresh. **Verified:** typecheck/build + manual smoke step 4.
- [ ] Renderer quit dialog subscribes `window.mango.app.onQuitWarning` and calls `sendQuitDecision(true|false)`; all existing UI preserved. **Verified:** typecheck/build + manual smoke step 2.
- [ ] `before-quit` keeps Plan 3's `serverManager.dispose()` AND adds `sessionManager.killAll()`; no `claude` survives quit. **Verified:** manual smoke step 3 (`pgrep -f claude`).
- [ ] `npm test` (existing **107** + new tests), `npm run typecheck`, `npm run lint`, `npm run build` all green.
- [ ] No change to merge/server internals; the `MangoApi` `app.*` surface is unchanged; only `session.records()` is added.

## Self-Review Notes

- **Honest scope on "turns":** I did **not** add turn detection. `AgentSession.hasActiveTurn` stays `false` (Plan 2's note in `buildSession` that called turn detection "Plan 5" is superseded — Plan 5 explicitly declines it). The quit warning is "N agent session(s) are **live**", driven by `liveWorktreeIds()`. The `QuitWarningEvent.activeWorktreeIds` field name still fits (it carries the worktrees that justify the warning); no contract change.
- **No contract drift:** `SessionRecord`, `QuitWarningEvent`, `Ack`, `APP_QUIT_WARNING`, `APP_QUIT_DECISION`, `MangoApi.app.*`, `SpawnSessionRequest.continueSession` are reused exactly. The only additive surface is `SESSION_RECORDS` + `MangoApi.session.records()` — needed for lazy rehydrate, carrying only paths.
- **Back-compat with 107 tests:** `SessionManager`'s new deps are all optional; the existing `makeManager` helper passes none, so `recordActive` is a no-op and `liveWorktreeIds` is unused there. `getSessionManager` short-circuits on injected `ctx.sessionManager`, so the existing `ipc-roundtrip` session tests never hit the new store wiring.
- **`getSessionManager`/`getSessionStore` stay SYNCHRONOUS (corrected from an earlier draft):** the `SESSION_INPUT`/`SESSION_RESIZE` `ipcMain.on` handlers must call `getSessionManager(ctx).write(req)`/`.resize(req)` synchronously — the existing Plan-2 tests assert the call happened synchronously, and an async getter would defer it to a microtask and fail them. The `SessionStore` (which needs the electron `app` for the userData path) is therefore constructed EAGERLY in `index.ts` (after `app.whenReady`) and assigned to `ctx.sessionStore` BEFORE `registerIpc`; `getSessionStore` just reads it. Tests inject `ctx.sessionStore`/`ctx.sessionManager`.
- **Confirmed-quit sweep (known redundancy, harmless):** the `APP_QUIT_DECISION` handler calls `killAll()`/`dispose()` directly AND routes through `ctx.requestQuit → QuitController.decide(true)` whose `sweepOnce()` sweeps again. Both managers' `killAll`/`dispose` are idempotent, so this is harmless; left as-is to avoid churn (a single-owner refactor is a safe follow-up).
- **`__mocks__/electron.ts` extension:** `app.getPath` was missing; the store's default-path helper needs it under node tests. I add it but keep `SessionStore`'s path **injected** so `session-store.test.ts` never touches Electron at all (uses a real temp file) — the mock is only relevant if a test exercises the lazy `getSessionStore` default path.
- **Re-entrancy correctness:** the `confirmedQuit` flag lives in BOTH `QuitController` (authoritative for `onBeforeQuit`) and `ctx.confirmedQuit` (set by the IPC handler for any future inspection). The handler routes the real quit through `ctx.requestQuit → quitController.decide(true)`, so there is a single confirmed-quit path and `sweepOnce` guarantees the sweep runs exactly once even though both the handler and `decide` could request it.
- **Atomic write justification** is stated inline (temp + `renameSync` on the same FS) so a crash can't blank `sessions.json` and lose every recorded worktree.
- **`remove()` keeps records on user-kill:** I justified NOT clearing `hadActiveSession` on `kill()` — b-lite wants `--continue` offered on reopen regardless; clearing would surprise the user by spawning fresh claude.
- **Lazy vs eager rehydrate:** chose lazy (spawn-on-select) and justified it — avoids N hidden background `claude` processes, reuses the single existing terminal-mount spawn path, one-boolean change.

Files authored/edited by this plan are all under `/Users/ltm-luan/Project/mangolove-idea/` as listed in the File Structure table.