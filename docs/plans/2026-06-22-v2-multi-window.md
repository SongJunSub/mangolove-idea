# Multi-Window (one repo per OS BrowserWindow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MangoLove IDEA open multiple git repos at once, one repo per OS `BrowserWindow`, by multiplying the existing per-window `IpcContext` into a registry keyed by `webContents.id` — reusing the entire renderer, preload, wire contract, and all 8 repoRoot-bound managers VERBATIM.

**Architecture:** The single-repo app already IS "one window = one `ctx.repoRoot` + one manager set". We replace the module-singleton `ctx` in `src/main/index.ts` with `const contexts = new Map<number, IpcContext>()`. `registerIpc` is called ONCE globally (channels are process-global) and every handler resolves its window's ctx via `requireCtx(event)` (`BrowserWindow.fromWebContents(event.sender)` → `webContents.id` → `contexts.get(id)`). The 3 eager stores (Settings/Session/Scrollback) are constructed ONCE and injected into every per-window ctx. The 5 event emitters need ZERO logic change — each reads its own `ctx.mainWindow`, so each window's events target the right window for free. One aggregate `QuitController` fans its deps + sweep across the registry.

**Tech Stack:** Electron (main + preload + renderer), TypeScript (ESM, `verbatimModuleSyntax`), Vitest (node + web projects), React (renderer), electron-vite. `npm run typecheck` = `tsc -p tsconfig.node.json` (includes `tests/main` + `tests/helpers`) + `tsc -p tsconfig.web.json` (includes `tests/renderer` + `src/shared`). `npm run test` = `vitest run`.

---

## Global Constraints

- **GREEN-PER-COMMIT (typecheck).** `tsconfig.node.json` compiles `tests/main` + `tests/helpers`; `tsconfig.web.json` compiles `tests/renderer` + `src/shared`. So `npm run typecheck` (node+web) type-checks the test files. EVERY commit MUST keep `npm run typecheck` GREEN. The `registerIpc(ipcMain, ctx)` → `registerIpc(ipcMain, contexts)` signature change is a TYPE change — it is red-gated by `npm run typecheck`, NEVER by vitest (esbuild type-erases types). Therefore the signature change MUST land in the SAME commit as the test-harness adaptation that re-points every `registerIpc(ipcMain, ...)` call site.
- **GREEN-PER-COMMIT (tests).** EVERY commit MUST keep `npm run test` GREEN.
- **LOCKED: MODEL = MULTI-WINDOW.** One repo per OS `BrowserWindow`. Each per-window `IpcContext` == today's ctx (single-valued `mainWindow`, scalar `repoRoot`, 8 manager slots, quit/dirty flags). NO `repoId` enters ANY signature, wire type, contract, or preload signature.
- **LOCKED: VERBATIM REUSE.** The ENTIRE renderer, preload, `src/shared/types`, `src/shared/ipc-contract`, `src/shared/ipc-channels`, and all 8 repoRoot-bound managers (WorktreeManager, SessionManager, ServerManager, LogStore, MergeRunner, FanoutManager, DiffViewer, GhStatusReader, ConflictResolver) are REUSED UNCHANGED. Only `use-repo.ts` `pick()` semantics + the `Settings.recentRepos` field change in the renderer/shared surface.
- **LOCKED: `createIpcContext()` STAYS AS-IS** (returns `{ mainWindow: null }`). The `IpcContext` shape is UNCHANGED. It is now called PER WINDOW.
- **LOCKED: emitters unchanged.** `buildSessionEmitter`/`buildLogEmitter`/`buildServerEmitter`/`buildMergeEmitter`/`buildFanoutEmitter` + `emitQuitWarning` already read `const win = ctx.mainWindow` and guard `isDestroyed()`. ZERO logic change — each per-window ctx owns its own `mainWindow`.
- **LOCKED: stores GLOBAL & SHARED.** `SettingsStore`, `SessionStore` (keyed by `worktreePath`, globally unique), `ScrollbackStore` (keyed by `worktreeId`) are constructed ONCE in `index.ts` and injected into EVERY per-window ctx.
- **LOCKED: `repoRoot` per-window + persisted `recentRepos: string[]`.** `repoRoot` moves OUT of relying on a single `settings.repoRoot` for the working repo and into per-window state + a persisted `recentRepos` list in `Settings`/`KNOWN_KEYS`. Keep backward-compat: read the old single `repoRoot` as a SEED for `recentRepos`.
- **LOCKED: SAME REPO IN TWO WINDOWS = FORBIDDEN.** Opening a repo already open in a window FOCUSES the existing window (resolves shared `.git`/`MERGE_HEAD` + scrollback/session races).
- **LOCKED: REPO_PICK removes `app.relaunch()`.** It would nuke ALL windows. Instead it opens/attaches a window for the picked repo. The APP_OPEN_EXTERNAL handler logic stays github-pinned and UNTOUCHED.
- **LOCKED: ONE aggregate QuitController** over the registry; `before-quit` deps (`liveWorktreeIds`/`activeTurnWorktreeIds`) = UNION across all `ctx.sessionManager`; `sweep()` iterates the Map and `killAll()`+`dispose()` EVERY window's managers. The `confirmedQuit`/`sweptOnQuit` re-entrancy STAYS — only deps fan out.
- **LOCKED: lifecycle.** `activate` (macOS, `getAllWindows().length === 0`) reopens the last-focused repo or shows the picker. `window-all-closed` unchanged on non-darwin. PATH fix stays process-global.
- **LOCKED: `SESSION_INPUT`/`SESSION_RESIZE` stay SYNCHRONOUS.** They are `ipcMain.on` handlers; the Plan-2 tests assert the `write`/`resize` delegate ran synchronously. The Map lookup (`requireCtx`) is synchronous, so add the lookup BEFORE the existing sync delegate.
- **LOCKED: `APP_PING` is repo-agnostic** (may skip ctx resolution).
- **LOCKED: `requireCtx` must be testable.** It resolves by `event.sender.id` via an INJECTABLE id-extractor (default `BrowserWindow.fromWebContents(event.sender)?.webContents.id`, falling back to `event.sender.id`) so the test harness can pass a fake event `{ sender: { id } }`. It is null-safe and FAILS LOUD (throws) if the id resolves to no ctx.
- **No `repoId` anywhere.** Confirm by `grep -rn "repoId" src/` returning nothing new.
- **DO NOT** modify the APP_OPEN_EXTERNAL handler body.
- **DO NOT** add `repoId` to any wire type/contract/preload signature.
- Mirror the existing emitter / lazy-getter / `vi.fn()` fake-manager test patterns.

### LOCKED open-decisions (already resolved — do not reopen)
1. `repoRoot` = per-window state + persisted `recentRepos: string[]` in `Settings`. Old single `repoRoot` is read as a backward-compat seed for `recentRepos`.
2. `SessionStore` + `ScrollbackStore` stay GLOBAL (keyed by `worktreePath`/`worktreeId`).
3. SAME REPO IN TWO WINDOWS = FORBIDDEN → focus the existing window.
4. New-window UX MVP: boot opens the last repo (or the picker if none); REPO_PICK opens/focuses a window. No drag-tab-to-window.
5. No hard cap on window count (MVP).
6. `activate` reopens last-focused repo (or picker).
7. ONE aggregate QuitController.

---

## File Structure

**Created:**
- `src/main/app/window-registry.ts` — pure helpers over `Map<number, IpcContext>`: `requireCtxFrom(contexts, event, extractId?)`, `aggregateLiveWorktreeIds(contexts)`, `aggregateActiveTurnWorktreeIds(contexts)`, `sweepAll(contexts)`, `findCtxByRepoRoot(contexts, repoRoot)`. Window-free + unit-testable.
- `tests/helpers/register-ipc-for-test.ts` — `registerIpcForTest(ctx, id?)` test harness: builds `contexts = new Map([[id, ctx]])`, calls `registerIpc(ipcMain, contexts)`, and returns `{ handlers, onHandlers, ipcMain, fakeEvent }` where `fakeEvent = { sender: { id } }`. The ONE adapter every IPC test routes through.
- `tests/main/window-registry.test.ts` — unit tests for the pure registry helpers.
- `tests/smoke/multi-window-smoke.md` — documented GUI smoke (two windows / two repos).

**Modified:**
- `src/main/ipc/register-ipc.ts` — signature `registerIpc(ipcMain, contexts: Map<number, IpcContext>)`; add `requireCtx(event)`; every handler resolves `const ctx = requireCtx(event)` at the top then runs its EXISTING body; `_event` → `event`; REPO_PICK rewritten to open/focus a window (no relaunch).
- `src/main/index.ts` — `contexts` Map; per-window `createWindow(repoRoot)`; eager global stores injected per ctx; aggregate `QuitController`; `activate` reopen; `openOrFocusRepo` launcher. The Map adoption + `registerIpc(ipcMain, contexts)` call-site flip land in the SAME commit as the `registerIpc` signature change (Task 2) so `typecheck:node` never goes red on `index.ts`.
- `src/main/managers/settings-store.ts` — add `recentRepos` handling (string-array field) via `KNOWN_ARRAY_KEYS` + sanitize/set.
- `src/shared/types.ts` — add `readonly recentRepos?: readonly string[]` to `AppSettings`; update the stale `RepoPickResult` JSDoc (no relaunch).
- `src/shared/ipc-channels.ts` — update the stale `REPO_PICK` relaunch comment.
- `src/shared/ipc-contract.ts` — update the stale `repo.pick()` relaunch JSDoc.
- `src/renderer/hooks/use-repo.ts` — `pick()` semantics: main opens/focuses a window (not relaunch); doc comment updated (non-behavioral; covered by the main-side `openOrFocusRepo` test).
- `tests/main/ipc-roundtrip.test.ts`, `tests/main/register-conflict-ipc.test.ts`, `tests/main/register-fanout-ipc.test.ts`, `tests/main/register-repo-ipc.test.ts`, `tests/main/register-gh-ipc.test.ts` — re-pointed onto `registerIpcForTest`.
- `tests/main/settings-store.test.ts` — add `recentRepos` round-trip tests.
- `docs/V2-BACKLOG.md` — strike the 멀티레포/멀티윈도우 row (anchor on the row text, not a line number).

---

## Migration Strategy — Branch by Abstraction (5 steps; each ships GREEN)

The 5 Branch-by-Abstraction steps are the task spine; each is a green rollback point. Steps that touch multiple files / many handlers are split into multiple TDD tasks.

1. **`requireCtx(event)` indirection at N=1.** Add the `contexts` Map + the pure registry helpers; change `registerIpc` to take the Map; convert every handler to resolve ctx via `event`. In ONE atomic commit, flip `registerIpc`'s signature, re-point the IPC test harness + all 5 IPC test files, AND adopt the Map in `index.ts` (build the Map, register the one ctx, call `registerIpc(ipcMain, contexts)`) — because `tsconfig.node` compiles `index.ts`, the production call site MUST flip in the same commit or `typecheck:node` goes red. Behavior identical, still one window. — Tasks 1–3.
2. **`createWindow(repoRoot)` per-window factory** + `closed`-teardown (via `teardownWindow`) + registry delete; still one window at boot. — Task 4.
3. **Aggregate quit** + per-window teardown sweep. — Task 5.
4. **Move `repoRoot` to per-window + REPO_PICK opens a window** (remove relaunch); `recentRepos` persistence. — Tasks 6–8.
5. **Enable N windows:** launcher/recent-repos boot, `activate` reopen, same-repo-twice focus-guard. Ship. — Tasks 9–10.

Final verification + smoke + backlog strike — Task 10.

---

## Task 1: Pure window-registry helpers

**Files:**
- Create: `src/main/app/window-registry.ts`
- Test: `tests/main/window-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/main/window-registry.test.ts
import { describe, it, expect } from 'vitest';
import {
  requireCtxFrom,
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
  findCtxByRepoRoot,
} from '../../src/main/app/window-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function ctxWith(over: Partial<IpcContext>): IpcContext {
  return { mainWindow: null, ...over };
}

describe('window-registry', () => {
  it('requireCtxFrom resolves the ctx by the injected id extractor', () => {
    const ctx = ctxWith({ repoRoot: '/r' });
    const contexts = new Map<number, IpcContext>([[7, ctx]]);
    const out = requireCtxFrom(contexts, { sender: { id: 7 } }, (e) => (e.sender as { id: number }).id);
    expect(out).toBe(ctx);
  });

  it('requireCtxFrom defaults the extractor to event.sender.id', () => {
    const ctx = ctxWith({ repoRoot: '/r' });
    const contexts = new Map<number, IpcContext>([[3, ctx]]);
    expect(requireCtxFrom(contexts, { sender: { id: 3 } })).toBe(ctx);
  });

  it('requireCtxFrom throws (fail-loud) when no ctx is registered for the id', () => {
    const contexts = new Map<number, IpcContext>();
    expect(() => requireCtxFrom(contexts, { sender: { id: 99 } })).toThrow(/no window context/i);
  });

  it('aggregateLiveWorktreeIds unions liveWorktreeIds across all contexts', () => {
    const a = ctxWith({ sessionManager: { liveWorktreeIds: () => ['x', 'y'] } as never });
    const b = ctxWith({ sessionManager: { liveWorktreeIds: () => ['y', 'z'] } as never });
    const contexts = new Map<number, IpcContext>([[1, a], [2, b]]);
    expect(aggregateLiveWorktreeIds(contexts).sort()).toEqual(['x', 'y', 'z']);
  });

  it('aggregateActiveTurnWorktreeIds unions activeTurnWorktreeIds across all contexts', () => {
    const a = ctxWith({ sessionManager: { activeTurnWorktreeIds: () => ['a'] } as never });
    const b = ctxWith({ sessionManager: { activeTurnWorktreeIds: () => ['a', 'b'] } as never });
    const contexts = new Map<number, IpcContext>([[1, a], [2, b]]);
    expect(aggregateActiveTurnWorktreeIds(contexts).sort()).toEqual(['a', 'b']);
  });

  it('aggregate getters tolerate contexts with no sessionManager', () => {
    const contexts = new Map<number, IpcContext>([[1, ctxWith({})]]);
    expect(aggregateLiveWorktreeIds(contexts)).toEqual([]);
    expect(aggregateActiveTurnWorktreeIds(contexts)).toEqual([]);
  });

  it('sweepAll killAll()s + dispose()s every context (guarded on missing managers)', () => {
    const killA = (): void => calls.push('killA');
    const dispA = (): void => calls.push('dispA');
    const killB = (): void => calls.push('killB');
    const calls: string[] = [];
    const a = ctxWith({
      sessionManager: { killAll: killA } as never,
      serverManager: { dispose: dispA } as never,
    });
    const b = ctxWith({ sessionManager: { killAll: killB } as never }); // no serverManager
    sweepAll(new Map([[1, a], [2, b]]));
    expect(calls.sort()).toEqual(['dispA', 'killA', 'killB']);
  });

  it('findCtxByRepoRoot returns the matching ctx or undefined', () => {
    const a = ctxWith({ repoRoot: '/one' });
    const b = ctxWith({ repoRoot: '/two' });
    const contexts = new Map<number, IpcContext>([[1, a], [2, b]]);
    expect(findCtxByRepoRoot(contexts, '/two')).toBe(b);
    expect(findCtxByRepoRoot(contexts, '/missing')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/window-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/app/window-registry'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/main/app/window-registry.ts
import type { IpcContext } from '../ipc/ipc-context';

/** The minimal event slice requireCtxFrom needs — a sender carrying an id. */
export interface CtxEventLike {
  readonly sender: unknown;
}

/** Extracts the resolving id from an event. Injectable so tests pass a fake event. */
export type IdExtractor = (event: CtxEventLike) => number | undefined;

/** Default extractor: read event.sender.id (the webContents id). */
const defaultExtractId: IdExtractor = (event) => {
  const sender = event.sender as { id?: number } | null;
  return sender?.id;
};

/**
 * Resolves the per-window IpcContext for an IPC event by its sender's webContents
 * id. FAILS LOUD (throws) when the id maps to no registered context — a handler
 * must never silently operate on the wrong/no window. The id extractor is injected
 * so tests resolve a fake event {sender:{id}} without a real BrowserWindow.
 */
export function requireCtxFrom(
  contexts: Map<number, IpcContext>,
  event: CtxEventLike,
  extractId: IdExtractor = defaultExtractId,
): IpcContext {
  const id = extractId(event);
  const ctx = id == null ? undefined : contexts.get(id);
  if (!ctx) throw new Error(`no window context for sender id ${String(id)}`);
  return ctx;
}

/** Union of every window's live PTY worktree ids (orphan reasoning + sweep). */
export function aggregateLiveWorktreeIds(contexts: Map<number, IpcContext>): string[] {
  const out = new Set<string>();
  for (const ctx of contexts.values()) {
    for (const id of ctx.sessionManager?.liveWorktreeIds() ?? []) out.add(id);
  }
  return [...out];
}

/** Union of every window's active-turn worktree ids (the before-quit warning gate). */
export function aggregateActiveTurnWorktreeIds(contexts: Map<number, IpcContext>): string[] {
  const out = new Set<string>();
  for (const ctx of contexts.values()) {
    for (const id of ctx.sessionManager?.activeTurnWorktreeIds() ?? []) out.add(id);
  }
  return [...out];
}

/** killAll() + dispose() EVERY window's managers (no orphan claude/server anywhere). */
export function sweepAll(contexts: Map<number, IpcContext>): void {
  for (const ctx of contexts.values()) {
    ctx.sessionManager?.killAll();
    ctx.serverManager?.dispose();
  }
}

/** First ctx whose repoRoot equals the given path (same-repo focus-guard), or undefined. */
export function findCtxByRepoRoot(
  contexts: Map<number, IpcContext>,
  repoRoot: string,
): IpcContext | undefined {
  for (const ctx of contexts.values()) {
    if (ctx.repoRoot === repoRoot) return ctx;
  }
  return undefined;
}
```

- [ ] **Step 4: Run test + typecheck to verify green**

Run: `npx vitest run tests/main/window-registry.test.ts && npm run typecheck`
Expected: PASS (8 tests) + typecheck OK.

- [ ] **Step 5: Commit**

```bash
git add src/main/app/window-registry.ts tests/main/window-registry.test.ts
git commit -m "feat(main): add pure window-registry helpers for multi-window contexts

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Flip `registerIpc` to the `contexts` Map — atomic (harness + 5 test files + `index.ts`)

This is the riskiest migration: it changes the `registerIpc` signature (a TYPE change, red-gated by `npm run typecheck`). The signature flip and EVERY consumer of it — the test harness, all 5 IPC test files, AND `src/main/index.ts`'s production call site — MUST land in ONE atomic commit, because `tsconfig.node.json` compiles BOTH `tests/main` + `tests/helpers` AND `src/main` (so `index.ts`'s `registerIpc(ipcMain, ctx)` call is in the typecheck graph). Leaving `index.ts` out → `typecheck:node` RED at this commit. We introduce the harness first, flip `registerIpc`, re-point all 5 test files, and adopt the Map in `index.ts` (build the Map, the per-window `createWindow` factory with the `wcId`-captured `closed` handler, the aggregate `QuitController`, and `registerIpc(ipcMain, contexts)`) — all in this one commit. The FULL multi-window `index.ts` body ships HERE, whole: the per-window factory + aggregate-quit wiring are cleaner to land complete than to half-flip, and landing them now keeps the call site type-correct. Tasks 3 and 4 do NOT change `index.ts` further for the factory/quit — they only ADD explicit regression tests (per-window teardown; aggregate quit) plus, in Task 3, a small DRY refactor of the `closed` handler to call `teardownWindow(contexts, wcId)`.

**Files:**
- Create: `tests/helpers/register-ipc-for-test.ts`
- Modify: `src/main/ipc/register-ipc.ts` (signature + `requireCtx` + every handler resolves ctx)
- Modify: `tests/main/ipc-roundtrip.test.ts` (re-point ALL call sites onto the harness)
- Modify: `tests/main/register-conflict-ipc.test.ts`, `tests/main/register-fanout-ipc.test.ts`, `tests/main/register-repo-ipc.test.ts`, `tests/main/register-gh-ipc.test.ts` (re-point onto the harness — Step 4b)
- Modify: `src/main/index.ts` (build the `contexts` Map; per-window `createWindow`; `registerIpc(ipcMain, contexts)` — Step 4c)

- [ ] **Step 1: Write the test harness (the failing-import driver)**

```typescript
// tests/helpers/register-ipc-for-test.ts
import { vi } from 'vitest';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

/** Fixed fake webContents id every test ctx registers under. */
export const TEST_WC_ID = 1;

/** A fake IPC event whose sender.id matches the registered ctx (requireCtx resolves it). */
export const fakeEvent = { sender: { id: TEST_WC_ID } } as const;

/**
 * Registers a SINGLE ctx under TEST_WC_ID and returns the recorded handlers + the
 * fake event. The ONE adapter that bridges the new registerIpc(ipcMain, contexts:
 * Map) signature to the existing handler-invoking tests: it builds the Map, records
 * every ipcMain.handle/on, and hands back a fakeEvent whose sender.id resolves to ctx
 * via requireCtx. Tests invoke `handlers.get(CH)!(fakeEvent, req)`.
 */
export function registerIpcForTest(ctx: IpcContext, id: number = TEST_WC_ID) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const onHandlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
    on: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void onHandlers.set(c, fn)),
  };
  const contexts = new Map<number, IpcContext>([[id, ctx]]);
  registerIpc(ipcMain as never, contexts);
  return { handlers, onHandlers, ipcMain, fakeEvent: { sender: { id } } };
}
```

- [ ] **Step 2: Run typecheck to SEE it red**

Run: `npm run typecheck`
Expected: FAIL in `tsconfig.node.json` — `register-ipc-for-test.ts` passes `Map<number, IpcContext>` where `registerIpc` still expects `IpcContext` (`Argument of type 'Map<...>' is not assignable to parameter of type 'IpcContext'`).

- [ ] **Step 3: Flip `registerIpc` to take the Map + add `requireCtx`; resolve ctx at the top of every handler**

Edit `src/main/ipc/register-ipc.ts`. First add the import + the `requireCtx` factory just below `requireRepoRoot`:

```typescript
import { requireCtxFrom, type CtxEventLike } from '../app/window-registry';
```

Change the signature + open with a `requireCtx` closure bound to the Map. Replace the `export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {` line and the `APP_PING` handler block through to the end so EVERY handler resolves its ctx from the event:

```typescript
/**
 * Registers ALL main-process IPC handlers ONCE (channels are process-global). Each
 * handler resolves ITS window's IpcContext from the event sender via requireCtx; the
 * existing per-handler body is then UNCHANGED. APP_PING is repo-agnostic so it skips
 * the lookup.
 */
export function registerIpc(ipcMain: IpcMain, contexts: Map<number, IpcContext>): void {
  /** Resolve the sender's per-window ctx; fail-loud if the window is gone. */
  const requireCtx = (event: CtxEventLike): IpcContext => requireCtxFrom(contexts, event);

  ipcMain.handle(IPC.APP_PING, async (): Promise<AppInfo> => {
    const { app } = await import('electron');
    return buildAppInfo(app, process.versions, probeNodePty);
  });

  ipcMain.handle(IPC.WORKTREE_LIST, async (event): Promise<Worktree[]> => {
    const ctx = requireCtx(event);
    const manager = await getWorktreeManager(ctx);
    return manager.list();
  });

  ipcMain.handle(
    IPC.WORKTREE_CREATE,
    async (event, req: CreateWorktreeRequest): Promise<Worktree> => {
      const ctx = requireCtx(event);
      const manager = await getWorktreeManager(ctx);
      return manager.create(req);
    },
  );

  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    async (event, req: RemoveWorktreeRequest): Promise<Ack> => {
      const ctx = requireCtx(event);
      const manager = await getWorktreeManager(ctx);
      try {
        await manager.remove(req);
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

  ipcMain.handle(
    IPC.SESSION_SPAWN,
    async (event, req: SpawnSessionRequest): Promise<AgentSession> => {
      const ctx = requireCtx(event);
      return getSessionManager(ctx).spawn(req);
    },
  );

  ipcMain.handle(
    IPC.SESSION_KILL,
    async (event, req: { worktreeId: string }): Promise<Ack> => {
      const ctx = requireCtx(event);
      return getSessionManager(ctx).kill(req.worktreeId);
    },
  );

  ipcMain.on(IPC.SESSION_INPUT, (event, req: SessionInputRequest) => {
    // requireCtx + the Map lookup are SYNCHRONOUS, so write() still runs synchronously
    // (the Plan-2 delegation tests assert sync write).
    const ctx = requireCtx(event);
    getSessionManager(ctx).write(req);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (event, req: SessionResizeRequest) => {
    const ctx = requireCtx(event);
    getSessionManager(ctx).resize(req);
  });

  ipcMain.handle(
    IPC.SERVER_START,
    async (event, req: StartServerRequest): Promise<ServerStatus> => {
      const ctx = requireCtx(event);
      return getServerManager(ctx).start(req);
    },
  );

  ipcMain.handle(
    IPC.SERVER_STOP,
    async (event, req: StopServerRequest): Promise<ServerStatus> => {
      const ctx = requireCtx(event);
      return getServerManager(ctx).stop(req);
    },
  );

  ipcMain.handle(
    IPC.SERVER_STATUS,
    async (event, req: { worktreeId: string }): Promise<ServerStatus> => {
      const ctx = requireCtx(event);
      return getServerManager(ctx).status(req.worktreeId);
    },
  );

  ipcMain.handle(IPC.SERVER_STATUS_ALL, async (event): Promise<Record<string, ServerStatus>> => {
    const ctx = requireCtx(event);
    return getServerManager(ctx).statusAll();
  });

  ipcMain.handle(
    IPC.LOG_SNAPSHOT,
    async (event, req: LogSnapshotRequest): Promise<LogLine[]> => {
      const ctx = requireCtx(event);
      return getLogStore(ctx).snapshot(req.worktreeId);
    },
  );

  ipcMain.handle(IPC.MERGE_RUN, async (event, req: MergeRequest): Promise<MergeResult> => {
    const ctx = requireCtx(event);
    const resolver = await getConflictResolver(ctx);
    if (await resolver.inProgress()) {
      const conflicted = (await resolver.list()).map((f) => f.path);
      const ownerId = (await resolver.inProgressWorktreeId()) ?? req.worktreeId;
      return { worktreeId: ownerId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
    }
    return (await getMergeRunner(ctx)).run(req);
  });

  ipcMain.handle(IPC.DIFF_LIST, async (event, req: DiffListRequest): Promise<ChangedFile[]> => {
    const ctx = requireCtx(event);
    return (await getDiffViewer(ctx)).listChangedFiles(req);
  });

  ipcMain.handle(IPC.DIFF_FILE, async (event, req: DiffFileRequest): Promise<FileDiff> => {
    const ctx = requireCtx(event);
    return (await getDiffViewer(ctx)).getFileDiff(req);
  });

  ipcMain.handle(IPC.GH_STATUS, async (event, req: GhStatusRequest): Promise<GhStatus> => {
    const ctx = requireCtx(event);
    try {
      const reader = await getGhStatusReader(ctx);
      return await reader.status(req);
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    IPC.APP_OPEN_EXTERNAL,
    async (_event, req: OpenExternalRequest): Promise<Ack> => {
      // APP_OPEN_EXTERNAL is repo-agnostic + github-pinned: body UNCHANGED, no ctx.
      try {
        const u = new URL(req.url);
        if (
          u.protocol !== 'https:' ||
          (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com'))
        ) {
          return { ok: false, error: 'refused: only https github.com URLs may be opened' };
        }
        const { shell } = await import('electron');
        await shell.openExternal(req.url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.MERGE_CONFLICTS,
    async (event, _req: ConflictListRequest): Promise<ConflictedFile[]> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).list();
    },
  );

  ipcMain.handle(
    IPC.MERGE_READ_CONFLICT,
    async (event, req: ConflictReadRequest): Promise<ConflictFileVersions> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).read(req.path);
    },
  );

  ipcMain.handle(
    IPC.MERGE_RESOLVE,
    async (event, req: ConflictResolveRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      const resolver = await getConflictResolver(ctx);
      await resolver.resolve({ path: req.path, choice: req.choice, content: req.content });
      const conflicted = (await resolver.list()).map((f) => f.path);
      return { worktreeId: req.worktreeId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
    },
  );

  ipcMain.handle(
    IPC.MERGE_CONTINUE,
    async (event, req: ConflictContinueRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).continue(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_ABORT,
    async (event, req: ConflictAbortRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).abort(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_IN_PROGRESS,
    async (event, _req: ConflictInProgressRequest): Promise<boolean> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).inProgress();
    },
  );

  ipcMain.handle(IPC.MERGE_OWNER, async (event): Promise<string | null> => {
    const ctx = requireCtx(event);
    return (await getConflictResolver(ctx)).inProgressWorktreeId();
  });

  ipcMain.handle(
    IPC.FANOUT_START,
    async (event, req: FanoutStartRequest): Promise<FanoutStartResult> => {
      const ctx = requireCtx(event);
      return (await getFanoutManager(ctx)).start(req);
    },
  );

  ipcMain.handle(IPC.FANOUT_GET, async (event): Promise<FanoutRun | null> => {
    const ctx = requireCtx(event);
    return (await getFanoutManager(ctx)).get() ?? null;
  });

  ipcMain.handle(
    IPC.FANOUT_SELECT,
    async (event, req: FanoutSelectRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      return (await getFanoutManager(ctx)).select(req);
    },
  );

  ipcMain.handle(IPC.FANOUT_ABORT, async (event): Promise<Ack> => {
    const ctx = requireCtx(event);
    return (await getFanoutManager(ctx)).abort();
  });

  ipcMain.handle(IPC.SESSION_RECORDS, async (event): Promise<string[]> => {
    const ctx = requireCtx(event);
    return getSessionStore(ctx)
      .all()
      .map((r) => r.worktreePath);
  });

  ipcMain.handle(IPC.SETTINGS_GET, async (event): Promise<AppSettings> => {
    const ctx = requireCtx(event);
    return getSettingsStore(ctx).get();
  });

  ipcMain.handle(
    IPC.SETTINGS_SET,
    async (event, partial: Partial<AppSettings>): Promise<AppSettings> => {
      const ctx = requireCtx(event);
      const merged = getSettingsStore(ctx).set(partial);
      ctx.mergeRunner = undefined;
      ctx.diffViewer = undefined;
      if (ctx.fanoutManager && ctx.fanoutManager.get() === null) {
        ctx.fanoutManager = undefined;
      }
      if (!(await ctx.conflictResolver?.inProgress())) {
        ctx.conflictResolver = undefined;
      }
      if ((ctx.sessionManager?.liveWorktreeIds().length ?? 0) === 0) {
        ctx.sessionSettingsDirty = false;
        ctx.sessionManager = undefined;
      } else {
        ctx.sessionSettingsDirty = true;
      }
      if ((ctx.serverManager?.liveServerWorktreeIds().length ?? 0) === 0) {
        ctx.serverSettingsDirty = false;
        ctx.serverManager = undefined;
      } else {
        ctx.serverSettingsDirty = true;
      }
      return merged;
    },
  );

  ipcMain.handle(IPC.REPO_GET, async (event): Promise<string | null> => {
    const ctx = requireCtx(event);
    return ctx.repoRoot ?? null;
  });

  ipcMain.handle(IPC.REPO_PICK, async (event): Promise<RepoPickResult> => {
    const ctx = requireCtx(event);
    const { dialog } = await import('electron');
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a git repository',
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dir = res.filePaths[0];
    if (!existsSync(join(dir, '.git'))) {
      return { ok: false, error: 'not a git repository' };
    }
    // Step-4 of the migration (Task 6) replaces this body with openOrFocusRepo + the
    // empty-gate attach. For THIS commit keep the legacy persist-only behavior so the
    // signature change is isolated: persist repoRoot and bind it on this window's ctx.
    getSettingsStore(ctx).set({ repoRoot: dir });
    ctx.repoRoot = dir;
    return { ok: true, repoRoot: dir };
  });

  ipcMain.handle(
    IPC.SCROLLBACK_GET,
    async (event, worktreeId: string): Promise<string | null> => {
      const ctx = requireCtx(event);
      return getScrollbackStore(ctx).get(worktreeId) ?? null;
    },
  );

  ipcMain.handle(
    IPC.SCROLLBACK_SET,
    async (event, req: ScrollbackSetRequest): Promise<Ack> => {
      const ctx = requireCtx(event);
      getScrollbackStore(ctx).set(req.worktreeId, req.data);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.APP_QUIT_DECISION,
    async (event, req: { quit: boolean }): Promise<Ack> => {
      const ctx = requireCtx(event);
      if (!req.quit) return { ok: true };
      ctx.confirmedQuit = true;
      ctx.sessionManager?.killAll();
      ctx.serverManager?.dispose();
      ctx.requestQuit?.();
      return { ok: true };
    },
  );
}
```

> NOTE for the implementer: REPO_PICK is NOT de-relaunched in this Task. This Task only flips the `registerIpc` signature; `register-repo-ipc.test.ts` is re-pointed onto the harness HERE (Step 4b) but keeps its CURRENT relaunch assertions, which still expect `app.relaunch()`. So **REPO_PICK KEEPS `app.relaunch()` in THIS task** (it is de-relaunched later, in Task 6 = Branch-by-Abstraction step 4). Dropping relaunch now would make the re-pointed `register-repo-ipc.test.ts` relaunch assertions fail → red commit. Use the body below for REPO_PICK in THIS task instead of the persist-only placeholder above:

```typescript
  ipcMain.handle(IPC.REPO_PICK, async (event): Promise<RepoPickResult> => {
    const ctx = requireCtx(event);
    const { dialog, app } = await import('electron');
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a git repository',
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dir = res.filePaths[0];
    if (!existsSync(join(dir, '.git'))) {
      return { ok: false, error: 'not a git repository' };
    }
    getSettingsStore(ctx).set({ repoRoot: dir });
    app.relaunch();
    ctx.confirmedQuit = true;
    ctx.requestQuit?.();
    return { ok: true, repoRoot: dir };
  });
```

- [ ] **Step 4a: Re-point `tests/main/ipc-roundtrip.test.ts` onto the harness (same commit)**

In `tests/main/ipc-roundtrip.test.ts`, add the import and replace EVERY `registerIpc(ipcMain as never, <ctx>)` + `handlers.get(CH)!({}, req)` pattern with the harness. There are ~40 `registerIpc(ipcMain as never, X)` call sites in this file — EVERY one becomes `registerIpcForTest(X)`. Concretely:

1. Add at top: `import { registerIpcForTest } from '../helpers/register-ipc-for-test';`
2. Remove each local `makeIpcMain()` definition AND each `registerIpc(...)` call; instead build the ctx object, then `const { handlers, onHandlers, fakeEvent } = registerIpcForTest(ctx);`.
3. Replace every handler invocation's event arg `{}` / `null` with `fakeEvent`.
4. **`as never` ctx forms must be reshaped, NOT left as `never`.** `registerIpcForTest(ctx: IpcContext)` is TYPED — it rejects `ctx as never`. Several call sites pass `registerIpc(ipcMain as never, ctx as never)` (e.g. lines ~512, ~527) or other `X as never` partials. For each, drop the trailing `as never` and make `X` satisfy `IpcContext`: a valid object literal `{ mainWindow: null, <injectedManager>: <fake> as never }`. The `as never` may remain on the INNER fake-manager values (those mirror the existing `serverManager: sm as never` pattern), but NEVER on the whole ctx argument to `registerIpcForTest`.

Example — the `worktree:list` test becomes:

```typescript
  it('worktree:list delegates to the injected WorktreeManager', async () => {
    const fakeManager = {
      list: vi.fn(async () => [
        { id: '/r', path: '/r', branch: 'main', isPrimary: true, isLocked: false },
      ]),
      create: vi.fn(),
      remove: vi.fn(),
    };
    const { handlers, fakeEvent } = registerIpcForTest({
      mainWindow: null,
      worktreeManager: fakeManager as never,
    });
    const list = await handlers.get('worktree:list')!(fakeEvent);
    expect(fakeManager.list).toHaveBeenCalledOnce();
    expect(list).toEqual([
      { id: '/r', path: '/r', branch: 'main', isPrimary: true, isLocked: false },
    ]);
  });
```

And the `app:ping` test (repo-agnostic — fakeEvent still fine, requireCtx is not called inside APP_PING):

```typescript
  it('registers a handler for app:ping that returns AppInfo', async () => {
    const { handlers, fakeEvent } = registerIpcForTest({ mainWindow: null });
    expect(handlers.has('app:ping')).toBe(true);
    const pingResult = (await handlers.get('app:ping')!(fakeEvent)) as { electronVersion: string };
    expect(typeof pingResult.electronVersion).toBe('string');
  });
```

The `session:input`/`session:resize` on-handler tests use `onHandlers` from the harness:

```typescript
  it('SESSION_INPUT is an ipcMain.on handler that delegates to write', () => {
    const sm = fakeSession();
    const { onHandlers, fakeEvent } = registerIpcForTest({
      mainWindow: null,
      sessionManager: sm as never,
    });
    const req = { worktreeId: '/wt', data: 'ls\r' };
    onHandlers.get('session:input')!(fakeEvent, req);
    expect(sm.write).toHaveBeenCalledWith(req);
  });
```

Apply the SAME mechanical transform (build ctx → `registerIpcForTest(ctx)` → invoke with `fakeEvent`) to ALL remaining tests in this file (`worktree:create`, `worktree:remove` ×2, `session:spawn`, `session:kill`, `session:resize`, `merge:run`, `server:*`, `log:snapshot`, `diff:*`, `session:records`, `app:quit-decision` ×2, `settings:*`, the deferred-apply end-to-end test, and `scrollback:*` ×5). For the `app:quit-decision` and `settings:set` tests that assert on `ctx` mutation, capture the ctx object in a variable first:

```typescript
  it('APP_QUIT_DECISION(quit:true) kills all sessions, disposes server, and returns ok', async () => {
    const session = { killAll: vi.fn(), liveWorktreeIds: vi.fn(() => []) };
    const server = { dispose: vi.fn() };
    const ctx: IpcContext = {
      mainWindow: null,
      sessionManager: session as never,
      serverManager: server as never,
    };
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const ack = await handlers.get('app:quit-decision')!(fakeEvent, { quit: true });
    expect(session.killAll).toHaveBeenCalledOnce();
    expect(server.dispose).toHaveBeenCalledOnce();
    expect(ctx.confirmedQuit).toBe(true);
    expect(ack).toEqual({ ok: true });
  });
```

- [ ] **Step 4b: Re-point the remaining 4 IPC test files onto the harness (SAME commit)**

Because `tsconfig.node.json` type-checks `tests/main/*`, the `registerIpc` signature change makes EVERY remaining `registerIpc(ipcMain, ctx)` call a type error — so these MUST be re-pointed in this same commit. Each file's `makeIpcMain()` + `registerIpc(ipcMain, ctx)` becomes `registerIpcForTest(ctx)`, and each `handlers.get(CH)!(null, req)` becomes `handlers.get(CH)!(fakeEvent, req)`.

1. **`register-conflict-ipc.test.ts`** — Add `import { registerIpcForTest } from '../helpers/register-ipc-for-test';` and delete the local `makeIpcMain`. In each `it`, replace:
   ```typescript
       const { ipcMain, handlers } = makeIpcMain();
       registerIpc(ipcMain, ctx);
   ```
   with
   ```typescript
       const { handlers, fakeEvent } = registerIpcForTest(ctx);
   ```
   and replace every `handlers.get(IPC.X)!(null, arg)` with `handlers.get(IPC.X)!(fakeEvent, arg)`. The `ctx` objects keep `ctx.conflictResolver`, `ctx.sessionStore`, `ctx.settingsStore` exactly as today. Drop the now-unused `registerIpc` import line.

2. **`register-fanout-ipc.test.ts`** — Same transform: import the harness, drop the local `makeIpcMain` + `registerIpc` import, replace the two-line register pattern with `const { handlers, fakeEvent } = registerIpcForTest(ctx);`, and pass `fakeEvent` (not `null`) to every `handlers.get(...)!(...)` invocation.

3. **`register-repo-ipc.test.ts`** — Same transform. KEEP the `vi.mock('electron', ...)` block and `requestQuit`/relaunch assertions UNCHANGED — REPO_PICK still calls `app.relaunch()` in THIS commit, so `mocks.relaunch` assertions stay green. Replace `makeIpcMain()` + `registerIpc(ipcMain, ctx)` with `registerIpcForTest(ctx)` and pass `fakeEvent` to every handler invocation (e.g. `handlers.get(IPC.REPO_GET)!(fakeEvent, undefined)`).

4. **`register-gh-ipc.test.ts`** — Same mechanical transform (3 `registerIpc` sites): import the harness, replace each register pattern with `registerIpcForTest(ctx)`, pass `fakeEvent` to each handler invocation.

- [ ] **Step 4c: Adopt the `contexts` Map in `src/main/index.ts` (SAME commit — keeps `typecheck:node` green)**

`tsconfig.node.json` compiles `src/main`, so `index.ts`'s `registerIpc(ipcMain, ctx)` call (the OLD 2-arg signature, ~line 127) becomes a type error the instant `registerIpc` flips. It MUST be rewritten in THIS commit or `typecheck:node` is RED. Replace the file body from the `const ctx = createIpcContext();` line through the `app.on('before-quit', ...)` end with the final multi-window body below. Note `const wcId = win.webContents.id;` is captured immediately after `new BrowserWindow(...)` — reading `win.webContents.id` INSIDE `win.on('closed', ...)` THROWS "Object has been destroyed" on Electron 42.4.0 (the webContents is already gone when 'closed' fires), so the registry key MUST be captured at creation and used in the closed handler.

```typescript
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext, type IpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';
import { IPC } from '../shared/ipc-channels';
import { QuitController } from './app/quit-controller';
import {
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
} from './app/window-registry';
import { SessionStore, getDefaultSessionsPath } from './managers/session-store';
import { SettingsStore, getDefaultSettingsPath } from './managers/settings-store';
import { ScrollbackStore, getDefaultScrollbackPath } from './managers/scrollback-store';
import type { QuitWarningEvent } from '../shared/types';
import { resolveRepoRoot } from './util/resolve-repo-root';

/** One IpcContext per OS BrowserWindow, keyed by webContents.id (multi-window). */
const contexts = new Map<number, IpcContext>();

/** The three GLOBAL stores, constructed once in whenReady and injected into every ctx. */
let sessionStore: SessionStore;
let settingsStore: SettingsStore;
let scrollbackStore: ScrollbackStore;

/**
 * Builds a BrowserWindow + a per-window IpcContext bound to `repoRoot`, sharing the
 * 3 global stores. Captures webContents.id AT CREATION and registers the ctx under it
 * BEFORE loading content (so the quit sweep never misses a window), and sweeps THAT
 * window's managers on 'closed'. repoRoot=null opens the empty-gate window (renderer
 * shows the picker).
 */
function createWindow(repoRoot: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: resolve(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  // Capture the webContents id NOW. On Electron 42.4.0, reading win.webContents.id
  // inside win.on('closed', ...) THROWS "Object has been destroyed" (the webContents is
  // already gone when 'closed' fires). The id is constant for the window's lifetime
  // (stable across loadURL/reload), so capturing it up front is correct.
  const wcId = win.webContents.id;

  const ctx = createIpcContext();
  ctx.mainWindow = win;
  ctx.repoRoot = repoRoot;
  ctx.sessionStore = sessionStore;
  ctx.settingsStore = settingsStore;
  ctx.scrollbackStore = scrollbackStore;
  ctx.requestQuit = () => quitController.decide(true);
  // Register BEFORE loading content so a quit during load still sweeps this window.
  contexts.set(wcId, ctx);

  win.on('closed', () => {
    // Sweep ONLY this window's processes (no orphan claude/server), then drop the ctx.
    // Use the CAPTURED wcId — reading win.webContents.id here would throw post-destroy.
    ctx.sessionManager?.killAll();
    ctx.serverManager?.dispose();
    contexts.delete(wcId);
  });

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(resolve(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * Sends APP_QUIT_WARNING to EVERY live window (each window's renderer owns its own
 * warning modal). Window-guarded; a destroyed window is skipped.
 */
function emitQuitWarning(activeWorktreeIds: readonly string[]): void {
  const payload: QuitWarningEvent = { activeWorktreeIds };
  for (const ctx of contexts.values()) {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(IPC.APP_QUIT_WARNING, payload);
  }
}

const quitController = new QuitController({
  // Deps fan out across the WHOLE registry — the warn-vs-quit decision and the
  // kill-sweep both span every window (no orphan claude/server in any window).
  liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
  activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
  emitQuitWarning,
  sweep: () => sweepAll(contexts),
  quitNow: () => app.quit(),
});

app.whenReady().then(() => {
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      const out = execFileSync(
        process.env.SHELL || '/bin/zsh',
        ['-ilc', 'printf "__MLPATH__%s__MLPATH__" "$PATH"'],
        { encoding: 'utf8', timeout: 5000 },
      );
      const match = out.match(/__MLPATH__([\s\S]*?)__MLPATH__/);
      const captured = match?.[1]?.trim();
      if (captured) process.env.PATH = captured;
    } catch {
      // keep the launchd PATH; spawning degrades gracefully (gh -> gh-missing etc.)
    }
  }
  // Construct the 3 GLOBAL stores ONCE (one process / one userData) and inject them
  // into every per-window ctx that createWindow() builds.
  sessionStore = new SessionStore(getDefaultSessionsPath(() => app.getPath('userData')));
  settingsStore = new SettingsStore(getDefaultSettingsPath(() => app.getPath('userData')));
  scrollbackStore = new ScrollbackStore(getDefaultScrollbackPath(() => app.getPath('userData')));

  // Channels are process-global: register the handlers ONCE over the registry.
  registerIpc(ipcMain, contexts);

  // N=1 boot for THIS step: open the single resolved repo (Task 7 replaces this with
  // the recentRepos launcher).
  const repoRoot = resolveRepoRoot({
    persisted: settingsStore.get().repoRoot,
    cwd: process.cwd(),
  });
  createWindow(repoRoot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const root = resolveRepoRoot({ persisted: settingsStore.get().repoRoot, cwd: process.cwd() });
      createWindow(root);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  quitController.onBeforeQuit(e);
});
```

- [ ] **Step 5: Run the FULL atomic green gate (this single commit must be green node+web)**

Run: `npm run typecheck && npm run test`
Expected: typecheck OK (BOTH `tsconfig.node.json` — which compiles `src/main/index.ts` + `tests/main` + `tests/helpers` — AND `tsconfig.web.json` are green); ALL tests PASS. Behavior is identical (N=1, one ctx under the boot window's `webContents.id` / `TEST_WC_ID` in tests). There is NO intermediate state where `registerIpc`'s signature and any of its call sites (the harness, the 5 test files, OR `src/main/index.ts`) are out of sync. (No new test for `index.ts` — it is Electron-bound glue; the registry + emitter logic is unit-tested via `window-registry.test.ts`.)

- [ ] **Step 6: Commit (ONE atomic commit — signature flip + ALL consumers, including `index.ts`)**

```bash
git add src/main/ipc/register-ipc.ts tests/helpers/register-ipc-for-test.ts tests/main/ipc-roundtrip.test.ts tests/main/register-conflict-ipc.test.ts tests/main/register-fanout-ipc.test.ts tests/main/register-repo-ipc.test.ts tests/main/register-gh-ipc.test.ts src/main/index.ts
git commit -m "refactor(ipc): route handlers by sender via requireCtx + Map of contexts

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> ROLLBACK POINT: this commit is green per `npm run typecheck` (node+web) + `npm run test`. It is the single coherent point where the `registerIpc` signature, the test harness, all 5 IPC test files, and the production `index.ts` call site flip together — no consumer is left on the old 2-arg signature.

---

## Task 3: Per-window factory + closed-teardown verified (Branch-by-Abstraction step 2)

The factory + teardown (`wcId`-captured closed handler) already shipped in Task 2. This task adds the EXPLICIT regression test for per-window teardown (sweep only that window's managers, delete only that id) by testing the teardown logic as a pure helper so it is unit-covered (the prompt requires per-window teardown to have its own test).

**Files:**
- Modify: `src/main/app/window-registry.ts` (add `teardownWindow`)
- Modify: `tests/main/window-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/main/window-registry.test.ts`:

```typescript
import { teardownWindow } from '../../src/main/app/window-registry';

describe('teardownWindow', () => {
  it('sweeps ONLY the closed window managers and deletes ONLY its id', () => {
    const calls: string[] = [];
    const a = {
      mainWindow: null,
      sessionManager: { killAll: () => calls.push('killA') } as never,
      serverManager: { dispose: () => calls.push('dispA') } as never,
    };
    const b = {
      mainWindow: null,
      sessionManager: { killAll: () => calls.push('killB') } as never,
    };
    const contexts = new Map([[1, a], [2, b]]);
    teardownWindow(contexts, 1);
    expect(calls.sort()).toEqual(['dispA', 'killA']); // B untouched
    expect(contexts.has(1)).toBe(false);
    expect(contexts.has(2)).toBe(true);
  });

  it('teardownWindow on an unknown id is a guarded no-op', () => {
    const contexts = new Map<number, IpcContext>();
    expect(() => teardownWindow(contexts, 42)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/window-registry.test.ts`
Expected: FAIL — `teardownWindow` is not exported.

- [ ] **Step 3: Add `teardownWindow` to `src/main/app/window-registry.ts`**

```typescript
/**
 * Sweeps the named window's managers (killAll + dispose — no orphan claude/server)
 * and removes its ctx from the registry. Guarded no-op for an unknown id. The
 * win.on('closed') handler in index.ts delegates here.
 */
export function teardownWindow(contexts: Map<number, IpcContext>, id: number): void {
  const ctx = contexts.get(id);
  if (!ctx) return;
  ctx.sessionManager?.killAll();
  ctx.serverManager?.dispose();
  contexts.delete(id);
}
```

- [ ] **Step 4: Use `teardownWindow` in `index.ts` (DRY the closed handler)**

In `src/main/index.ts`, import it:

```typescript
import {
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
  teardownWindow,
} from './app/window-registry';
```

and replace the `win.on('closed', ...)` body (the inline sweep from Task 2) with the helper, passing the CAPTURED `wcId` — NOT `win.webContents.id`, which throws "Object has been destroyed" inside 'closed' on Electron 42.4.0:

```typescript
  win.on('closed', () => {
    teardownWindow(contexts, wcId);
  });
```

- [ ] **Step 5: Run test + typecheck + suite**

Run: `npx vitest run tests/main/window-registry.test.ts && npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/app/window-registry.ts src/main/index.ts tests/main/window-registry.test.ts
git commit -m "feat(main): per-window teardown helper sweeps only the closed window

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Aggregate quit sweep across all windows (Branch-by-Abstraction step 3)

The aggregate deps + `sweepAll` shipped in Task 2. Add the EXPLICIT regression test asserting the aggregate quit sweep spans EVERY window (the prompt requires the aggregate quit sweep to have its own test). We test the `QuitController` wired to the aggregate deps over a 2-context registry.

**Files:**
- Test: `tests/main/aggregate-quit.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/main/aggregate-quit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { QuitController } from '../../src/main/app/quit-controller';
import {
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
} from '../../src/main/app/window-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('aggregate quit across all windows', () => {
  it('confirmed quit sweeps EVERY window killAll+dispose (no orphan in any window)', () => {
    const sweepCalls: string[] = [];
    const a: IpcContext = {
      mainWindow: null,
      sessionManager: {
        killAll: () => sweepCalls.push('killA'),
        liveWorktreeIds: () => ['wA'],
        activeTurnWorktreeIds: () => ['wA'],
      } as never,
      serverManager: { dispose: () => sweepCalls.push('dispA') } as never,
    };
    const b: IpcContext = {
      mainWindow: null,
      sessionManager: {
        killAll: () => sweepCalls.push('killB'),
        liveWorktreeIds: () => ['wB'],
        activeTurnWorktreeIds: () => [],
      } as never,
      serverManager: { dispose: () => sweepCalls.push('dispB') } as never,
    };
    const contexts = new Map<number, IpcContext>([[1, a], [2, b]]);

    const emitQuitWarning = vi.fn();
    const quitNow = vi.fn();
    const ctrl = new QuitController({
      liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
      activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
      emitQuitWarning,
      sweep: () => sweepAll(contexts),
      quitNow,
    });

    // Window A has an active turn -> first quit is vetoed + warns with the UNION'd ids.
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(emitQuitWarning).toHaveBeenCalledWith(['wA']);

    // Confirm: sweepAll runs over BOTH windows.
    ctrl.decide(true);
    expect(sweepCalls.sort()).toEqual(['dispA', 'dispB', 'killA', 'killB']);
    expect(quitNow).toHaveBeenCalledOnce();
  });

  it('no active turn in any window: quit proceeds but still sweeps both (orphan prevention)', () => {
    const sweepCalls: string[] = [];
    const mk = (tag: string): IpcContext => ({
      mainWindow: null,
      sessionManager: {
        killAll: () => sweepCalls.push(`kill${tag}`),
        liveWorktreeIds: () => [`w${tag}`],
        activeTurnWorktreeIds: () => [],
      } as never,
      serverManager: { dispose: () => sweepCalls.push(`disp${tag}`) } as never,
    });
    const contexts = new Map<number, IpcContext>([[1, mk('A')], [2, mk('B')]]);
    const ctrl = new QuitController({
      liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
      activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
      emitQuitWarning: vi.fn(),
      sweep: () => sweepAll(contexts),
      quitNow: vi.fn(),
    });
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled(); // no active turn -> no veto
    expect(sweepCalls.sort()).toEqual(['dispA', 'dispB', 'killA', 'killB']); // still swept
  });
});
```

- [ ] **Step 2: Run test to verify it passes (logic already shipped in Task 2)**

Run: `npx vitest run tests/main/aggregate-quit.test.ts`
Expected: PASS. (This is a CHARACTERIZATION test that locks the aggregate-quit behavior wired in Task 2; if it fails, the Task-2 wiring is wrong — fix `index.ts`/`window-registry.ts` before committing.)

- [ ] **Step 3: Run typecheck + full suite**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/main/aggregate-quit.test.ts
git commit -m "test(main): lock aggregate quit sweep across every window

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `recentRepos` in `Settings` type + `SettingsStore` (Branch-by-Abstraction step 4a)

`repoRoot` moves to per-window state backed by a persisted `recentRepos: string[]`. `SettingsStore` today sanitizes ONLY string fields; add an explicit string-array field that round-trips (drops non-strings/empties), and a backward-compat seed of the old single `repoRoot` into `recentRepos`.

**Files:**
- Modify: `src/shared/types.ts` (add `recentRepos`)
- Modify: `src/main/managers/settings-store.ts` (sanitize/set/get the array)
- Modify: `tests/main/settings-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/main/settings-store.test.ts`:

```typescript
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
});
```

(Ensure the `mkdtempSync`, `rmSync`, `writeFileSync`, `tmpdir`, `join` imports already present in the file; if not, add `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` and `import { beforeEach, afterEach } from 'vitest';`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/settings-store.test.ts`
Expected: FAIL — `recentRepos` is dropped (sanitize only keeps the 5 string keys), and `AppSettings` has no `recentRepos` (typecheck red too).

- [ ] **Step 3: Add `recentRepos` to the `AppSettings` type**

In `src/shared/types.ts`, inside `interface AppSettings` (after the `repoRoot` field):

```typescript
  /**
   * Absolute paths of recently-opened repos (multi-window). The launcher reopens
   * the most-recent on boot; REPO_PICK pushes the picked repo to the front. Empty
   * array unsets the key. Seeded from the legacy single `repoRoot` on first read.
   */
  readonly recentRepos?: readonly string[];
```

- [ ] **Step 4: Sanitize/set the array in `SettingsStore`**

In `src/main/managers/settings-store.ts`, the existing `KNOWN_KEYS` covers the STRING fields. `recentRepos` is an ARRAY, handled separately so the string-only invariant for the others is preserved. Edit:

Add an array-key constant under `KNOWN_KEYS`:

```typescript
/** The string-array AppSettings keys (sanitized as arrays of non-empty strings). */
const KNOWN_ARRAY_KEYS: readonly (keyof AppSettings)[] = ['recentRepos'];
```

In `set(partial)`, after the existing `for (const key of KNOWN_KEYS)` loop and BEFORE `this.write(merged)`, fold in the array keys. Replace the `set` method body with:

```typescript
  set(partial: Partial<AppSettings>): AppSettings {
    const current = this.load();
    const merged: Record<string, unknown> = { ...current };
    const source = partial as Record<string, unknown>;
    for (const key of KNOWN_KEYS) {
      if (!(key in source)) continue;
      const value = source[key];
      if (typeof value === 'string' && value !== '') {
        merged[key] = value;
      } else {
        delete merged[key];
      }
    }
    for (const key of KNOWN_ARRAY_KEYS) {
      if (!(key in source)) continue;
      const arr = sanitizeStringArray(source[key]);
      if (arr.length > 0) {
        merged[key] = arr;
      } else {
        delete merged[key]; // [] or non-array -> unset
      }
    }
    this.write(merged as AppSettings);
    return merged as AppSettings;
  }
```

Update `sanitize` to also project the array keys, and add the `sanitizeStringArray` helper. Replace `sanitize`:

```typescript
  private sanitize(raw: unknown): AppSettings {
    if (raw === null || typeof raw !== 'object') return {};
    const source = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of KNOWN_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    for (const key of KNOWN_ARRAY_KEYS) {
      const arr = sanitizeStringArray(source[key]);
      if (arr.length > 0) out[key] = arr;
    }
    return out as AppSettings;
  }
```

Add this module-level helper (above the `SettingsStore` class):

```typescript
/** Projects an unknown to an array of non-empty strings ([] for any non-array input). */
function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v !== '');
}
```

The `merged` local is widened to `Record<string, unknown>` ON PURPOSE: `recentRepos` is a `string[]` (an array value) that must be stored ALONGSIDE the string-valued keys before the single `this.write(merged as AppSettings)`. A `Record<string, unknown>` accumulator is the only shape that holds both the string fields and the string-array field uniformly during the merge. `write(settings: AppSettings)` KEEPS its param type unchanged. The closing `this.write(merged as AppSettings)` cast is LOAD-BEARING and INTENTIONAL — it bridges the `Record<string, unknown>` accumulator (and the `string[]` → `readonly string[]` variance on `recentRepos`) back to the `AppSettings` interface that `write` expects. It is NOT a smell to remove; do not try to eliminate it (e.g. by typing `merged` as `AppSettings` directly — that would reject the `string[]` assignment to the `readonly string[]` field and the dynamic-key writes).

- [ ] **Step 5: Run test + typecheck + suite**

Run: `npx vitest run tests/main/settings-store.test.ts && npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/managers/settings-store.ts tests/main/settings-store.test.ts
git commit -m "feat(settings): persist recentRepos string array for multi-window

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: REPO_PICK opens/focuses a window (remove relaunch) (Branch-by-Abstraction step 4b)

REPO_PICK stops calling `app.relaunch()` (it would nuke ALL windows). Instead: validate the dir, push it to `recentRepos`, and signal the renderer to attach THIS empty-gate window to the repo (REPO_PICK returns `{ok:true, repoRoot}` and binds `ctx.repoRoot` on the picking window). The actual "focus existing window vs open new window" routing lives in `index.ts` (Task 7 `openOrFocusRepo`), but the in-process attach for the current empty-gate window is done HERE so the single-window flow already works end-to-end. We make REPO_PICK delegate window orchestration to an injected callback on ctx so it stays testable without Electron windows. This task also updates the THREE stale "relaunch" comments in the shared surface.

**Files:**
- Modify: `src/main/ipc/ipc-context.ts` (add `openRepo?` injected callback)
- Modify: `src/main/ipc/register-ipc.ts` (REPO_PICK body)
- Modify: `tests/main/register-repo-ipc.test.ts` (drop relaunch assertions, assert openRepo)
- Modify: `src/shared/ipc-channels.ts`, `src/shared/ipc-contract.ts`, `src/shared/types.ts` (update the 3 stale "relaunch" comments to reflect "opens/focuses a window")

- [ ] **Step 1: Write the failing test (rewrite the REPO_PICK success cases)**

Replace the two relaunch-based tests in `tests/main/register-repo-ipc.test.ts` (`'REPO_PICK persists a valid repo then relaunches...'` and `'REPO_PICK survives a before-quit veto...'`) with these, and adjust the cancel/non-git tests to assert `openRepo` was NOT called:

```typescript
  it('REPO_PICK validates a repo, pushes it to recentRepos, and asks main to open it', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const openRepo = vi.fn();
    ctx.openRepo = openRepo; // index.ts injects the real openOrFocusRepo
    const { handlers, fakeEvent } = registerIpcForTest(ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined);
    expect(out).toEqual({ ok: true, repoRoot: dir });
    expect(openRepo).toHaveBeenCalledWith(dir);
    expect(mocks.relaunch).not.toHaveBeenCalled(); // multi-window: NEVER relaunch
  });

  it('REPO_PICK does not call openRepo on cancel or a non-git dir', async () => {
    const ctx = baseCtx();
    const openRepo = vi.fn();
    ctx.openRepo = openRepo;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined)).toEqual({
      ok: false,
      canceled: true,
    });

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] }); // dir has no .git
    expect(await handlers.get(IPC.REPO_PICK)!(fakeEvent, undefined)).toEqual({
      ok: false,
      error: 'not a git repository',
    });
    expect(openRepo).not.toHaveBeenCalled();
  });
```

Add `import { registerIpcForTest } from '../helpers/register-ipc-for-test';` if not already present, and keep the existing `REPO_GET` tests (re-pointed onto the harness in Task 2 Step 4b). The `mocks.relaunch`/`mocks.quit` hoisted mock stays (still referenced by the negative assertions).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/register-repo-ipc.test.ts`
Expected: FAIL — `ctx.openRepo` is not on `IpcContext` (typecheck red) and REPO_PICK still calls relaunch.

- [ ] **Step 3: Add `openRepo` to `IpcContext`**

In `src/main/ipc/ipc-context.ts`, add to the `IpcContext` interface (next to `requestQuit`):

```typescript
  /**
   * Injected by index.ts: open (or focus an existing window for) a repo by path.
   * REPO_PICK delegates here instead of relaunching, so picking a repo opens/focuses
   * a window in this process (multi-window). Optional so windowless tests omit it.
   */
  openRepo?: (repoRoot: string) => void;
```

- [ ] **Step 4: Rewrite the REPO_PICK handler body (no relaunch)**

In `src/main/ipc/register-ipc.ts`, replace the REPO_PICK handler with:

```typescript
  ipcMain.handle(IPC.REPO_PICK, async (event): Promise<RepoPickResult> => {
    const ctx = requireCtx(event);
    const { dialog } = await import('electron');
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a git repository',
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dir = res.filePaths[0];
    if (!existsSync(join(dir, '.git'))) {
      return { ok: false, error: 'not a git repository' };
    }
    // Multi-window: push to recentRepos (most-recent first, deduped) and ask main to
    // open or FOCUS a window for this repo — NEVER app.relaunch() (it would nuke every
    // other window). The same-repo-twice focus-guard lives in openRepo (index.ts).
    const store = getSettingsStore(ctx);
    const prev = store.get().recentRepos ?? [];
    const recentRepos = [dir, ...prev.filter((r) => r !== dir)];
    store.set({ recentRepos });
    ctx.openRepo?.(dir);
    return { ok: true, repoRoot: dir };
  });
```

(Drop the now-unused `app` from the `const { dialog, app } = await import('electron');` line — it becomes `const { dialog } = ...`. The `RepoPickResult` import already exists.)

- [ ] **Step 5: Update the THREE stale "relaunch" comments in the shared surface**

Now that REPO_PICK no longer relaunches, three doc comments are stale. Update each to reflect "opens/focuses a window for the picked repo (no relaunch)":

1. `src/shared/ipc-channels.ts` — the `REPO_PICK` channel comment (currently `// invoke (-> RepoPickResult; persists + relaunches on success)`):
   ```typescript
     REPO_PICK: 'repo:pick', // invoke (-> RepoPickResult; persists to recentRepos + opens/focuses a window on success, no relaunch)
   ```

2. `src/shared/ipc-contract.ts` — the `repo.pick()` JSDoc (currently `Open a native folder picker; on a valid git repo, persist it and relaunch.`):
   ```typescript
       /**
        * Open a native folder picker; on a valid git repo, push it to recentRepos and
        * open (or focus) a window for it (no relaunch). Returns {canceled} or {error}
        * when nothing was opened.
        */
       pick(): Promise<RepoPickResult>;
   ```

3. `src/shared/types.ts` — the `RepoPickResult` JSDoc (currently says main "is about to relaunch — so the renderer rarely observes `ok:true`"):
   ```typescript
   /**
    * Result of the REPO_PICK flow. On success the main process has pushed the repo to
    * recentRepos and opened (or focused) a window for it — no relaunch — so the renderer
    * observes `ok:true` normally (its empty-gate window may be reloaded to attach the
    * repo). The error/canceled shapes let the renderer keep the empty-state up.
    */
   ```

These three are in `src/shared`, compiled by `tsconfig.web.json` — comment-only edits, so no type/test change. (`ipc-contract.ts` + `types.ts` are also compiled by `tsconfig.node` via `src/main` imports; comment-only edits keep both green.)

- [ ] **Step 6: Run test + typecheck + suite**

Run: `npx vitest run tests/main/register-repo-ipc.test.ts && npm run typecheck && npm run test`
Expected: PASS. Confirm `grep -n "relaunch" src/main/ipc/register-ipc.ts` returns NOTHING, and `grep -rn "relaunch" src/shared/` returns NOTHING.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/ipc-context.ts src/main/ipc/register-ipc.ts tests/main/register-repo-ipc.test.ts src/shared/ipc-channels.ts src/shared/ipc-contract.ts src/shared/types.ts
git commit -m "feat(ipc): REPO_PICK opens or focuses a window instead of relaunching

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `openOrFocusRepo` launcher + same-repo-twice focus-guard + recentRepos boot (Branch-by-Abstraction step 5a)

Wire `index.ts` to: inject `openRepo` into every ctx; implement `openOrFocusRepo(repoRoot)` that FOCUSES an existing window for that repo (forbid same-repo-twice) else opens a new window (or attaches the empty-gate window if the focused window has no repo); boot from `recentRepos`; reopen last on `activate`. The same-repo focus-guard uses `findCtxByRepoRoot` — unit-tested as a pure helper here.

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/main/open-or-focus-repo.test.ts` (Create — pure routing helper)
- Modify: `src/main/app/window-registry.ts` (add `pickEmptyGateCtx` helper used by the launcher)

- [ ] **Step 1: Write the failing test for the pure routing decision**

```typescript
// tests/main/open-or-focus-repo.test.ts
import { describe, it, expect } from 'vitest';
import { findCtxByRepoRoot, pickEmptyGateCtx } from '../../src/main/app/window-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('open-or-focus routing helpers', () => {
  it('findCtxByRepoRoot finds an already-open repo (focus-guard target)', () => {
    const open: IpcContext = { mainWindow: null, repoRoot: '/proj' };
    const contexts = new Map<number, IpcContext>([[1, open]]);
    expect(findCtxByRepoRoot(contexts, '/proj')).toBe(open);
    expect(findCtxByRepoRoot(contexts, '/other')).toBeUndefined();
  });

  it('pickEmptyGateCtx returns a window with no repoRoot (to attach), else undefined', () => {
    const gate: IpcContext = { mainWindow: null, repoRoot: null };
    const filled: IpcContext = { mainWindow: null, repoRoot: '/x' };
    expect(pickEmptyGateCtx(new Map([[1, gate], [2, filled]]))).toBe(gate);
    expect(pickEmptyGateCtx(new Map([[2, filled]]))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/open-or-focus-repo.test.ts`
Expected: FAIL — `pickEmptyGateCtx` is not exported.

- [ ] **Step 3: Add `pickEmptyGateCtx` to `window-registry.ts`**

```typescript
/**
 * The first context with NO repoRoot (the empty-gate window showing the picker), or
 * undefined when every window already owns a repo. The launcher attaches a picked
 * repo to this window rather than spawning a second window for it.
 */
export function pickEmptyGateCtx(contexts: Map<number, IpcContext>): IpcContext | undefined {
  for (const ctx of contexts.values()) {
    if (ctx.repoRoot == null) return ctx;
  }
  return undefined;
}
```

- [ ] **Step 4: Wire `openOrFocusRepo` + boot/activate in `index.ts`**

In `src/main/index.ts`, import the new helper:

```typescript
import {
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
  teardownWindow,
  findCtxByRepoRoot,
  pickEmptyGateCtx,
} from './app/window-registry';
```

Add `ctx.openRepo` injection inside `createWindow` (next to `ctx.requestQuit`):

```typescript
  ctx.openRepo = (root) => openOrFocusRepo(root);
```

Add the launcher function (above `createWindow` so it is in scope for the injected callback — function declarations hoist, so placement is flexible):

```typescript
/**
 * Opens a window for `repoRoot`, OR focuses the existing window if that repo is
 * already open (SAME REPO IN TWO WINDOWS = FORBIDDEN — shared .git/MERGE_HEAD +
 * scrollback/session races). If an empty-gate window (no repo) exists, ATTACH the
 * repo to it (bind ctx.repoRoot + reload so its renderer re-reads REPO_GET) instead of
 * spawning a duplicate window.
 */
function openOrFocusRepo(repoRoot: string): void {
  const existing = findCtxByRepoRoot(contexts, repoRoot);
  if (existing?.mainWindow && !existing.mainWindow.isDestroyed()) {
    existing.mainWindow.focus();
    return;
  }
  const gate = pickEmptyGateCtx(contexts);
  if (gate?.mainWindow && !gate.mainWindow.isDestroyed()) {
    // Attach: set this window's repoRoot, then reload it. The reload re-runs the
    // renderer's mount-time REPO_GET, which now returns the new ctx.repoRoot, so the
    // picker is replaced by the worktree UI. NO new REPO_OPENED channel. webContents.id
    // is STABLE across reload (empirically confirmed on Electron 42.4.0), so the
    // contexts key for this window is unaffected.
    gate.repoRoot = repoRoot;
    gate.mainWindow.webContents.reload();
    return;
  }
  createWindow(repoRoot);
}
```

Replace the boot block (the `const repoRoot = resolveRepoRoot(...)` + `createWindow(repoRoot)` lines) with the recentRepos launcher:

```typescript
  // Multi-window boot: reopen the MOST-RECENT repo (recentRepos[0]) if valid; else
  // fall back to the legacy single repoRoot / cwd resolve; else open the empty gate.
  const recent = settingsStore.get().recentRepos ?? [];
  const seed = recent[0] ?? settingsStore.get().repoRoot;
  const bootRepo = resolveRepoRoot({ persisted: seed, cwd: process.cwd() });
  createWindow(bootRepo);
```

Replace the `activate` handler to reopen the last-focused repo (recentRepos[0]) or the picker:

```typescript
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const last = settingsStore.get().recentRepos?.[0] ?? settingsStore.get().repoRoot;
      const root = resolveRepoRoot({ persisted: last, cwd: process.cwd() });
      createWindow(root);
    }
  });
```

- [ ] **Step 5: Run test + typecheck + suite**

Run: `npx vitest run tests/main/open-or-focus-repo.test.ts && npm run typecheck && npm run test`
Expected: PASS. Confirm `grep -rn "repoId" src/` is empty.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/app/window-registry.ts tests/main/open-or-focus-repo.test.ts
git commit -m "feat(main): openOrFocusRepo launcher with same-repo focus-guard + recentRepos boot

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Renderer `use-repo.ts` pick() doc (Branch-by-Abstraction step 5b)

`pick()` no longer relies on "main relaunches the app". With REPO_PICK opening/focusing a window (and attaching the empty-gate window via `webContents.reload()`), the renderer's empty-state window is reloaded by main on success, so `pick()` just awaits the result; on attach the window reloads and re-reads REPO_GET. The ONLY change to `use-repo.ts` is NON-behavioral: the `pick()` doc comments drop the relaunch language. NO new wire type, NO `repoId`.

**No renderer test is added.** The behavioral coverage for the open-or-focus flow already lives MAIN-SIDE in `tests/main/open-or-focus-repo.test.ts` (the right place — that is where the `openOrFocusRepo`/`findCtxByRepoRoot`/`pickEmptyGateCtx` routing is exercised). `use-repo.ts`'s change is a doc-only comment edit and needs no test; the existing renderer tests are all pure-function `.test.ts` (no React rendering, no `@testing-library/react` — it is NOT a dependency, and `vitest.config.ts`/`tsconfig.web.json` only collect `tests/renderer/**/*.test.ts`, not `.tsx`), so introducing an RTL `.tsx` test here would be uncompilable and never collected. If a characterization is ever wanted, it must be a plain pure-function `tests/renderer/use-repo.test.ts` (no RTL, no JSX) — but it is NOT required by this task.

**Files:**
- Modify: `src/renderer/hooks/use-repo.ts` (doc comments only)

- [ ] **Step 1: Update the `use-repo.ts` doc comments (drop relaunch language)**

In `src/renderer/hooks/use-repo.ts`, replace the `pick()` JSDoc on the interface:

```typescript
  /**
   * Open the native folder picker. On a valid git repo, main pushes it to
   * recentRepos and opens (or focuses) a window for it; if THIS window is the empty
   * gate, main attaches the repo and reloads it (so REPO_GET re-resolves to the new
   * root). No app relaunch.
   */
  pick(): Promise<void>;
```

and the inline comment inside the `pick` callback:

```typescript
  const pick = useCallback(async (): Promise<void> => {
    // Main opens/focuses a window for the picked repo (multi-window). If this is the
    // empty-gate window, main reloads it so the mount-time REPO_GET re-resolves to the
    // new root and the worktree UI replaces the picker. On cancel/error nothing changes.
    await window.mango.repo.pick();
  }, []);
```

- [ ] **Step 2: Run typecheck + suite**

Run: `npm run typecheck && npm run test`
Expected: PASS. (Comment-only edit — no behavior change. The open-or-focus behavior is covered by `tests/main/open-or-focus-repo.test.ts` from Tasks 7 + 9.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/use-repo.ts
git commit -m "docs(renderer): use-repo pick() opens or focuses a window, no relaunch

Change-Track: Small

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Same-repo-twice focus-guard explicit test (Branch-by-Abstraction step 5c)

The focus-guard logic lives in `openOrFocusRepo` (Task 7) over `findCtxByRepoRoot`. Add an explicit behavioral test that, given a registry where a repo is already open, `findCtxByRepoRoot` returns the existing ctx (so the launcher focuses, never opens a duplicate) — and that a DISTINCT repo finds no existing ctx (so a new window is created). This is the prompt-required dedicated test for the same-repo-twice focus-guard.

**Files:**
- Modify: `tests/main/open-or-focus-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/main/open-or-focus-repo.test.ts`:

```typescript
describe('same-repo-twice focus-guard', () => {
  it('opening an already-open repo resolves to the existing window (focus, not duplicate)', () => {
    const a: IpcContext = { mainWindow: null, repoRoot: '/proj-a' };
    const b: IpcContext = { mainWindow: null, repoRoot: '/proj-b' };
    const contexts = new Map<number, IpcContext>([[1, a], [2, b]]);
    // Re-picking /proj-a finds A: the launcher focuses A instead of opening a 3rd window.
    expect(findCtxByRepoRoot(contexts, '/proj-a')).toBe(a);
    // A brand-new repo finds nothing -> launcher opens a new window for it.
    expect(findCtxByRepoRoot(contexts, '/proj-c')).toBeUndefined();
    // And there is no empty gate to attach to (both windows own a repo).
    expect(pickEmptyGateCtx(contexts)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/main/open-or-focus-repo.test.ts`
Expected: PASS (helpers already exist from Task 7 — this locks the focus-guard contract).

- [ ] **Step 3: Run typecheck + full suite**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/main/open-or-focus-repo.test.ts
git commit -m "test(main): lock same-repo-twice focus-guard contract

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full suite + documented GUI smoke + backlog strike (Ship)

**Files:**
- Create: `tests/smoke/multi-window-smoke.md`
- Modify: `docs/V2-BACKLOG.md`

- [ ] **Step 1: Run the FULL gate**

Run: `npm run typecheck && npm run test`
Expected: typecheck OK; ALL tests PASS. Capture the vitest summary line (e.g. `Test Files  N passed`).

- [ ] **Step 2: Confirm no `repoId` and no `relaunch` leaked into the wire/handlers**

Run: `grep -rn "repoId" src/ ; grep -n "relaunch" src/main/ipc/register-ipc.ts`
Expected: BOTH empty (no `repoId` anywhere; REPO_PICK no longer relaunches).

- [ ] **Step 3: Write the GUI smoke doc**

```markdown
<!-- tests/smoke/multi-window-smoke.md -->
# Multi-window GUI smoke (one repo per OS window)

Manual smoke proving the multi-window model. Two windows, two DIFFERENT repos,
each operating independently; closing one sweeps only its processes; quit sweeps both.

## Setup
- Two distinct local git repos, e.g. `/tmp/repoA` and `/tmp/repoB` (each `git init`).
- `MANGO_AGENT_CMD` / `MANGO_SERVER_CMD` may be set to harmless line-emitters for a
  windowless-friendly run (see existing smokes), but a real `claude`/server is fine.
- `npm run dev`.

## Steps + expected results

1. **Boot opens one window on the most-recent repo.**
   - Expect: a single window loads repoA (or the empty picker if recentRepos is empty).
   - If empty picker: click "Select repository…", choose `/tmp/repoA`. The SAME window
     reloads into repoA's worktree UI (NO app relaunch — other state untouched).

2. **Open a SECOND window on a SECOND repo.**
   - In repoA's window, click "change repo" and pick `/tmp/repoB`.
   - Expect: a window now shows repoB. repoA's window stays open and unchanged.
   - (MVP: change-repo on a window with a repo opens/focuses per openOrFocusRepo; the
     empty-gate attach path is exercised by the first-boot picker.)

3. **Same repo twice is FORBIDDEN → focus.**
   - From repoB's window, pick `/tmp/repoA` again.
   - Expect: the EXISTING repoA window is focused; NO third window opens.

4. **Independent operation — no cross-window leak.**
   - In repoA: create a worktree, spawn a session, start the server. Watch logs stream.
   - In repoB: create a DIFFERENT worktree, spawn a session, start the server.
   - Expect: repoA's terminal output / server logs / events appear ONLY in repoA's
     window; repoB's ONLY in repoB's. No event from A leaks into B (each emitter targets
     its own ctx.mainWindow).

5. **Closing one window sweeps ONLY its processes.**
   - Close repoB's window.
   - Expect: repoB's claude PTYs + server children are killed (verify with
     `ps aux | grep -E 'claude|<server-bin>'` — repoB's pids gone, repoA's still alive).
     repoA's window keeps working normally.

6. **Quit sweeps BOTH windows (no orphans).**
   - Re-open repoB (change repo → repoB), start a session in each window.
   - Quit the app (Cmd-Q). If a turn is in flight in either window, the quit-warning
     modal appears in that window; confirm.
   - Expect: after quit, `ps aux | grep -E 'claude|<server-bin>'` shows NONE of either
     window's children survive (aggregate sweep killAll+dispose over the whole registry).

## Pass criteria
- Two repos run side by side, fully isolated.
- Same-repo-twice focuses, never duplicates.
- Per-window close sweeps only that window; quit sweeps all. No orphan claude/server.
```

- [ ] **Step 4: Run the GUI smoke**

Run: `npm run dev` and execute the 6 steps above.
Expected: every "Expect" holds. (If a step fails, STOP and fix before shipping.)

- [ ] **Step 5: Strike the backlog item**

In `docs/V2-BACKLOG.md`, mark the 멀티레포/멀티윈도우 row done (strike-through + ✅, mirroring the other completed rows). Anchor the replace SOLELY on the quoted row text below (it matches the real row verbatim — do NOT rely on a line number). Replace:

```
| **멀티레포 / 멀티윈도우** | L | — | 지금은 단일 레포(`process.cwd()`). 여러 레포를 열기 |
```

with:

```
| ~~**멀티레포 / 멀티윈도우**~~ ✅ **완료** | L | — | 레포당 1 OS `BrowserWindow`(멀티윈도우). 모듈-싱글톤 `ctx` → `Map<number, IpcContext>`(webContents.id 키). `registerIpc(ipcMain, contexts)` 1회 등록 + `requireCtx(event)`로 sender별 ctx 해소(주입형 id-추출, 테스트는 `registerIpcForTest`). 8개 repoRoot-바운드 매니저 · 렌더러 · preload · wire 계약 VERBATIM 재사용(`repoId` 미도입). 글로벌 스토어 3종(Settings/Session/Scrollback) 1회 생성·전 ctx 주입, `repoRoot`는 per-window + persisted `recentRepos`. `win.on('closed')` per-window sweep + 1개 집계 `QuitController`(라이브/액티브턴 합집합, `sweepAll`). REPO_PICK relaunch 제거 → `openOrFocusRepo`(동일 레포 = 기존 창 포커스). 계획: docs/plans/2026-06-22-v2-multi-window.md |
```

- [ ] **Step 6: Commit**

```bash
git add tests/smoke/multi-window-smoke.md docs/V2-BACKLOG.md
git commit -m "docs: multi-window GUI smoke + strike multi-repo backlog item

Change-Track: Large

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Acceptance Checklist

- [ ] `npm run typecheck` (node + web) GREEN after EVERY commit.
- [ ] `npm run test` GREEN after EVERY commit.
- [ ] `registerIpc(ipcMain, contexts: Map<number, IpcContext>)` — single global registration; every non-`APP_PING` handler resolves `const ctx = requireCtx(event)` at the top, then runs its EXISTING body.
- [ ] `requireCtx`/`requireCtxFrom` resolve by `event.sender.id` via an injectable extractor; fail-loud on a missing ctx; the test harness `registerIpcForTest` supplies a `fakeEvent { sender: { id } }`.
- [ ] The `registerIpc` signature change landed in the SAME commit as the test-harness adaptation (all 5 IPC test files re-pointed) AND `src/main/index.ts`'s production call site (build the Map + `registerIpc(ipcMain, contexts)`) — `tsconfig.node` compiles `index.ts`, so leaving it out would red-gate `typecheck:node`.
- [ ] `SESSION_INPUT`/`SESSION_RESIZE` stay synchronous (`requireCtx` lookup is sync, before the `write`/`resize` delegate).
- [ ] `APP_OPEN_EXTERNAL` body UNCHANGED + github-pinned.
- [ ] NO `repoId` in any wire type / contract / preload / signature (`grep -rn "repoId" src/` empty).
- [ ] Renderer + preload + 8 managers VERBATIM except `use-repo.ts` `pick()` doc + `Settings.recentRepos`.
- [ ] `createIpcContext()` unchanged (returns `{ mainWindow: null }`), called PER WINDOW.
- [ ] Per-window `createWindow(repoRoot)`: shares the 3 global stores, sets `repoRoot` + `mainWindow`, captures `const wcId = win.webContents.id` AT CREATION, registers under `wcId` BEFORE loading content, sweeps + deletes via `teardownWindow(contexts, wcId)` on `closed` (NEVER reads `win.webContents.id` inside `closed` — it throws post-destroy on Electron 42.4.0).
- [ ] 5 emitters + `emitQuitWarning`: each reads its own `ctx.mainWindow`; no logic change (quit-warning fans to every window).
- [ ] `repoRoot` per-window + persisted `recentRepos: string[]`; legacy single `repoRoot` seeds `recentRepos`.
- [ ] `SessionStore`/`ScrollbackStore` GLOBAL (keyed by `worktreePath`/`worktreeId`); `SettingsStore` GLOBAL.
- [ ] ONE aggregate `QuitController`: deps = UNION across `ctx.sessionManager`; `sweep` = `sweepAll(contexts)`; re-entrancy (`confirmedQuit`/`sweptOnQuit`) unchanged.
- [ ] `activate` reopens the last-focused repo (or picker); `window-all-closed` unchanged on non-darwin; PATH fix process-global.
- [ ] REPO_PICK: no `app.relaunch()`; validates, pushes `recentRepos`, calls `ctx.openRepo(dir)`.
- [ ] Same repo in two windows = FORBIDDEN (focus existing via `findCtxByRepoRoot`).
- [ ] Explicit tests exist for: `requireCtx` routing, test-harness adaptation, per-window teardown, aggregate quit sweep, `recentRepos` persistence, same-repo focus-guard.
- [ ] `tests/smoke/multi-window-smoke.md` written + executed; backlog item struck.

## Self-Review

**1. Spec coverage.** Every LOCKED decision maps to a task: context registry + requireCtx routing + per-window factory/teardown + aggregate-quit wiring (Task 2, the atomic signature-flip-with-`index.ts` commit), explicit teardown test (Task 3), explicit aggregate-quit test (Task 4), stores global + repoRoot per-window + recentRepos (Tasks 5–7), REPO_PICK no-relaunch + openOrFocusRepo + same-repo focus-guard (Tasks 6–7, 9), renderer pick() doc (Task 8), smoke + backlog (Task 10). The 5 Branch-by-Abstraction steps are the spine (step 1 = Tasks 1–2, step 2 = Task 3, step 3 = Task 4, step 4 = Tasks 5–6, step 5 = Tasks 7–9). The riskiest migration is ONE atomic commit (Task 2): the `registerIpc` signature flip + the harness + ALL 5 IPC test files + `src/main/index.ts`'s production call site land together, so `npm run typecheck` (node+web) is GREEN at that commit — no consumer is left on the old 2-arg signature.

**2. Green-per-commit (typecheck).** Re-audited: `tsconfig.node.json` compiles `src/main` (incl. `index.ts`) + `tests/main` + `tests/helpers`. The signature flip (Task 2) therefore red-gates `index.ts`'s `registerIpc(ipcMain, ctx)` call AND the 5 test files; ALL are flipped in Task 2's single commit (`git add` includes `src/main/index.ts` + all 5 test files). No intermediate commit leaves the `registerIpc` signature and any call site out of sync. Comment-only edits (Task 6 shared-surface JSDoc, Task 8 use-repo doc) keep both `tsconfig.node` and `tsconfig.web` green.

**3. Placeholder scan.** No TBD/TODO; every code step shows complete code (full `registerIpc` rewrite, full `index.ts` body with `wcId` captured at creation, full helper bodies, full test bodies). The one forward-reference (Task 2's REPO_PICK keeps relaunch, de-relaunched in Task 6) is called out explicitly with the exact body to use, so no commit is left red.

**4. Empirical Electron facts respected.** `webContents.id` is captured as `const wcId = win.webContents.id;` IMMEDIATELY after `new BrowserWindow(...)` and used for both `contexts.set(wcId, ctx)` and the `closed` handler (`teardownWindow(contexts, wcId)`) — never read inside `win.on('closed', ...)`, which throws "Object has been destroyed" on Electron 42.4.0. The id is stable across `loadURL`/`reload`, so the empty-gate attach (`webContents.reload()` in `openOrFocusRepo`) does NOT change the contexts key. Per-window IPC routing via `event.sender.id` and per-window emitter targeting via `ctx.mainWindow.webContents.send` are empirically confirmed sound.

**5. Type consistency.** Names are consistent across tasks: `contexts: Map<number, IpcContext>`, `requireCtx`/`requireCtxFrom`, `registerIpcForTest`/`fakeEvent`/`TEST_WC_ID`, `aggregateLiveWorktreeIds`/`aggregateActiveTurnWorktreeIds`/`sweepAll`/`teardownWindow`/`findCtxByRepoRoot`/`pickEmptyGateCtx`, `wcId`, `ctx.openRepo`, `openOrFocusRepo`, `recentRepos`/`KNOWN_ARRAY_KEYS`/`sanitizeStringArray`. Every `registerIpcForTest(ctx)` call passes an `IpcContext`-satisfying literal (NO `ctx as never` — those `as never` partials are reshaped). `IpcContext` gains only `openRepo?` (Task 6) — `createIpcContext()` still returns `{ mainWindow: null }` per the LOCKED constraint. `RepoPickResult` wire type is unchanged (no `repoId`).

**6. Dropped RTL test.** Task 8 adds NO renderer test: `@testing-library/react` is not a dependency and `vitest.config.ts`/`tsconfig.web.json` only collect `tests/renderer/**/*.test.ts` (not `.tsx`), so an RTL `.tsx` test would be uncompilable and never run. `use-repo.ts`'s change is a doc-only comment edit; the open-or-focus BEHAVIOR is covered MAIN-SIDE by `tests/main/open-or-focus-repo.test.ts` (Tasks 7 + 9) — the correct place for that coverage.
