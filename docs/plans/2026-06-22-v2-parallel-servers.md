# Parallel Per-Worktree Dev Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run ONE dev server PER worktree CONCURRENTLY (each worktree gets its own running server + its own partitioned log buffer + its own detected URL), replacing today's at-most-one-server contract.

**Architecture:** Converge `ServerManager` and `LogStore` onto the `SessionManager` Map-per-worktree model (already the exact target shape: `Map<worktreeId, …>`, scoped replace with an identity guard, `killAll()` iterates all, an idle notification that fires only when the LAST live unit goes away). The keystone is stamping `worktreeId` onto every `LogLine` so snapshot/onLine/detection/renderer-list all demux by worktree. We migrate via **Branch by Abstraction** for the managers (Map registry) + a thin TRANSIENT additive/optional shim on the shared-type & contract boundary, so `npm run typecheck` stays GREEN at every commit. The shim is removed in the final CLEANUP task.

**THE GREEN-PER-COMMIT INVARIANT (the spine of this plan):** EVERY task's commit MUST pass `npm run typecheck` (node AND web) AND its targeted vitest. This is NOT optional polish — `tsc -p tsconfig.node.json --noEmit` COMPILES `tests/main/**` + `tests/helpers/**`, `tsc -p tsconfig.web.json --noEmit` COMPILES `tests/renderer/**`, and `src/shared/**` is in BOTH graphs. So (a) any change to a manager/store SIGNATURE breaks its unit test at COMPILE time (not just runtime — there is no "old tests fail only at runtime" escape hatch); and (b) any change to a SHARED type (`LogLine`, `StopServerRequest`) or the renderer-facing CONTRACT breaks BOTH node and web consumers at once. Two tools enforce the invariant: (1) **additive / OPTIONAL evolution on the cross-graph boundary** — `LogLine.worktreeId` lands OPTIONAL, `StopServerRequest.worktreeId` STAYS optional, contract `status(worktreeId?)`/`snapshot(worktreeId?)` params become OPTIONAL and `statusAll()` is ADDED — so every old call site keeps compiling during migration; (2) **lockstep test rewrites on the manager boundary** — a manager's unit test is rewritten IN THE SAME task that changes that manager's signature, never half-migrated. Because `vitest run` type-ERASES via esbuild (it does NOT type-check), a type-only change's red→green gate is `npm run typecheck:web`/`:node`, NEVER vitest. The final CLEANUP task tightens `LogLine.worktreeId` + `StopServerRequest.worktreeId` back to REQUIRED once every producer sets them and every consumer reads them.

We migrate in 7 sequenced commits (type seam → LogStore partition → ServerManager Map → SERVER_STATUS_ALL handler → renderer flip {5a is one commit; 5c is a standalone test} → CLEANUP tighten-to-required → full-suite + smoke + backlog), each a typecheck-green + targeted-vitest-green rollback point; T1–T4 keep the app shippable-as-singular (renderer still shows one), T5 is the only visible-UX flip.

**Tech Stack:** Electron + React + TypeScript, Vitest (windowless main-side unit tests with injected fakes), electron-vite, `tsc` project typechecks. No new dependencies.

## Global Constraints

- TypeScript — Google TS Style: 2-space indent, max 100 cols, semicolons, single quotes, `interface` over `type`, no `any`, explicit return types, `readonly` where possible. Files kebab-case.
- **GREEN-PER-COMMIT INVARIANT (overrides every other gate):** every task's commit MUST pass `npm run typecheck` (node AND web — `tsc` compiles `tests/main`, `tests/helpers`, `tests/renderer`, and `src/shared` in BOTH graphs) AND its targeted vitest. Achieve it via additive/optional shared-type+contract evolution (the migration shim) + lockstep test rewrites; NEVER leave a commit typecheck-red. If a signature change ripples to another consumer in the same graph, fold that consumer into the SAME commit.
- TDD for every main-side BEHAVIOR unit (`LogStore`, `ServerManager`): write a failing test → run it → minimal COMPLETE impl → run it passes → commit. The two pure renderer modules that HAVE tests today (`detect-server-url`, `app-store/aggregateStatus`) keep TDD. **For a TYPE-ONLY change (Task 1 seam, Task 6 tighten) the red→green gate is `npm run typecheck:web`/`:node` (a TS error), NOT `vitest run`** — vitest type-erases via esbuild and cannot observe a type-only change.
- Renderer hooks/components have NO `@testing-library/react` harness in this repo. Renderer tasks gate on `npm run typecheck:web` + `npm run build` (NOT a renderer unit test), EXCEPT the pure modules above which keep Vitest TDD.
- `src/shared/types.ts` stays side-effect free (imported by BOTH main and renderer).
- Command source stays HARDENED: server command comes only from `commandOverride` (env seam) OR auto-detection — never a renderer-supplied request field. `detectRunner`/`resolveCommands` are UNCHANGED.
- Mirror `src/main/managers/session-manager.ts` EXACTLY for the Map pattern: scoped replace UNMAPs before kill (lines 107–112), `handleExit` guards by identity `this.sessions.get(worktreeId) !== session` (line 206), `killAll()` iterates all live (186–199), `notifyIfIdle()` fires only when `liveWorktreeIds().length === 0` (219–221).
- Conventional Commits for every commit; each task's `-m` string ends with a `Change-Track: Large` trailer; NO backticks anywhere in the `-m` string.
- Run unit tests with `npx vitest run <path>` (the `test` script is `vitest run`).
- **D1** ONE `LogStore` instance, internal `Map` partition (not N instances).
- **D2** BOTH `server.status(worktreeId)` AND `server.statusAll(): Record<string, ServerStatus>` (onState = delta, statusAll = mount rehydrate).
- **D3** NO cap on concurrent servers; per-worktree 5000-line ring.
- **D4** NO port injection — rely on dev-server auto-increment (Vite 5173→5174, Next) + per-worktree detection. Documented limitation: a runner that does NOT auto-increment needs a user-set per-worktree PORT. `detect-runner`/`resolveCommands` hardening UNCHANGED.
- **D5** Sidebar: each worktree row shows its own `ServerDot` (already supported, N dots); toolbar shows the SELECTED worktree's state.
- **D6** `logs.onLine` filtering is RENDERER-side: one `LOG_LINE` channel carries `LogLine.worktreeId`, `useLogs(worktreeId)` filters.
- **D7** NO quit-warning for servers (trivially restarted unlike agent turns); the quit-sweep `dispose()` still kills ALL so no orphans. The `QuitController` active-turn warning is UNCHANGED.
- **D8** `STOPPED_IDLE`: renderer defaults ABSENT map entries to `'stopped'`; main emits only non-null-`worktreeId` snapshots (no global `worktreeId:null` snapshot).

---

## File Structure

**Modified — shared (Task 1, ADDITIVE/OPTIONAL — tightened in Task 6 CLEANUP):**
- `src/shared/types.ts` — add `readonly worktreeId?: string` to `LogLine` (**OPTIONAL** so the un-touched `tests/renderer/log-filter.test.ts` literals + every old producer still compile in BOTH graphs); KEEP `StopServerRequest.worktreeId` OPTIONAL (so the old `mgr.stop({})` node test still compiles until Task 3 rewrites it); add `LogSnapshotRequest { worktreeId }`; comment `ServerProcess.worktreeId`.
- `src/shared/ipc-channels.ts` — add `SERVER_STATUS_ALL: 'server:status-all'`; refresh the SERVER_* / LOG_* comments (per-worktree).
- `src/shared/ipc-contract.ts` — make `server.status(worktreeId?)` + `logs.snapshot(worktreeId?)` params **OPTIONAL** (so the renderer's old no-arg `server.status()`/`logs.snapshot()` calls still compile until Task 5a flips them), ADD `server.statusAll(): Promise<Record<string, ServerStatus>>` (new method, no conflict), `server.stop(req)` unchanged (req.worktreeId already optional).

**Modified — main managers:**
- `src/main/managers/log-store.ts` (Step 2) — single buffer/seq/carry → `private readonly partitions = new Map<string, Partition>()`; `append(worktreeId,…)` / `flush(worktreeId)` / `snapshot(worktreeId)` / `reset(worktreeId)` / add `removeWorktree(worktreeId)`; `push` stamps `worktreeId`; cap 5000 PER worktree.
- `src/main/managers/server-manager.ts` (Step 3) — `current: RunningServer | null` → `private readonly servers = new Map<string, RunningServer>()`; `last: ServerProcess` → `Map<string, ServerProcess>`; scoped replace + per-worktree `logStore.reset(worktreeId)`; `append(worktreeId,…)`; `stop(req.worktreeId)`; `status(worktreeId)` + `statusAll()`; `liveServerWorktreeIds()` + `hasAnyLiveServer()`; `killAll`/`dispose` loop all; identity-guarded `handleExit`; `notifyIfServerIdle()` gated on `liveServerWorktreeIds().length === 0`.

**Modified — main IPC (Step 4):**
- `src/main/ipc/register-ipc.ts` — `LOG_SNAPSHOT` accepts `worktreeId` (Task 2); `SERVER_STATUS` reads `worktreeId` + the `SETTINGS_SET` serverCommand defer guard flips `hasLiveServer()` → `liveServerWorktreeIds().length === 0` (Task 3, folded in so the node graph stays green); `SERVER_STOP` forwards `req` (unchanged); add `SERVER_STATUS_ALL` handler → `statusAll()` (Task 4); `getServerManager`/`getLogStore` stay ONE lazy instance; `APP_QUIT_DECISION` `dispose()` already kills ALL (loop verified).
- `src/preload/index.ts` (Task 1) — forward `worktreeId` on `server.status`/`logs.snapshot`; add `server.statusAll()`; `onState`/`onLine` stay single-channel.
- `src/main/ipc/ipc-context.ts` (Task 4) — UNCHANGED slots (single `serverManager?`/`logStore?`/`serverSettingsDirty?`); doc comments touched only for clarity.

**Modified — renderer (Task 5a — the ONE renderer-flip commit; the whole web chain is interdependent and cannot be split without leaving `typecheck:web` red):**
- `src/renderer/state/app-store.ts` (TDD) — `aggregateStatus` takes a `ReadonlyMap<string, ServerStatus>`; `ownsServer` = this worktree has a non-stopped record.
- `src/renderer/hooks/use-server.ts` — hold `Map<worktreeId, ServerStatus>`; seed via `statusAll()` on mount; update from `onState` keyed by `process.worktreeId`; `start(id)`/`stop(id)`.
- `src/renderer/hooks/use-logs.ts` — `useLogs(worktreeId)` filters `onLine` by `line.worktreeId`; `snapshot(worktreeId)`; per-worktree `seq===0` reset + `MAX_LINES` cap.
- `src/renderer/hooks/use-worktree-status.ts` — receives the whole server map.
- `src/renderer/components/logs/log-panel.tsx` — composite react row key `key={\`${l.worktreeId}:${l.seq}\`}` (variable is `l`, not `line`).
- `src/renderer/lib/detect-server-url.ts` — STAYS pure; only its INPUT becomes the selected worktree's filtered slice (its demux regression test is Task 5c, TDD-preserved).
- `src/renderer/components/toolbar/server-controls.tsx` — binds the SELECTED worktree (disabled only when THIS worktree is running); `onStop(worktreeId)`.
- `src/renderer/App.tsx` — wires the selected worktree's status/logs/url + the whole map to `useWorktreeStatus`; `BrowserPane` URL feed per selected.
- `src/renderer/components/sidebar/{worktree-item,worktree-list}.tsx`, `server-dot.tsx`, `browser-pane.tsx` — UNCHANGED (already per-worktree / N dots / per-selectedId).

**Modified — CLEANUP (Task 6) — tighten the transient shim + quit comment:**
- `src/shared/types.ts` — tighten `LogLine.worktreeId?` → `readonly worktreeId: string` (REQUIRED) and `StopServerRequest.worktreeId?` → REQUIRED, now that every producer stamps it (LogStore.push) and every producer/consumer passes it (ServerManager.stop, renderer). Contract optional params on `status`/`snapshot` MAY stay optional (harmless, no consumer relies on the no-arg form after the flip).
- `src/main/index.ts` — add a 1-line comment at the quit-sweep noting servers are swept but intentionally NOT warned (D7). `QuitController` logic UNCHANGED.

**Modified — tests REWRITTEN per-worktree (in lockstep with the signature they cover):**
- `tests/main/log-store.test.ts` (Task 2 — rewritten in the SAME commit that partitions LogStore)
- `tests/main/server-manager.test.ts` (Task 3 — rewritten in the SAME commit that converts ServerManager to a Map)
- `tests/renderer/app-store.test.ts` (Task 5a — rewritten in the SAME commit that flips `aggregateStatus` to a map)
- `tests/renderer/detect-server-url.test.ts` (Task 1 `line()` helper gains `worktreeId`; Task 5c adds a demux case; assertions UNCHANGED)
- `tests/renderer/log-filter.test.ts` — UNCHANGED (its `LogLine` literals omit `worktreeId`; this is exactly WHY Task 1 lands the field OPTIONAL — an untouched web-graph file must keep compiling; Task 6 CLEANUP does NOT touch it either, because an optional→required tighten of `LogLine.worktreeId` would TS2741 these literals, so CLEANUP MUST add `worktreeId` to these literals in the same commit — see Task 6).

**Created:**
- `tests/smoke/parallel-server-smoke.md` (final task) — documented two-worktree concurrent GUI smoke.

**Modified — docs:**
- `docs/V2-BACKLOG.md` (final task) — strike "병렬 서버" off.

---

## Task 1: Type seam (ADDITIVE/OPTIONAL) — LogLine.worktreeId?, LogSnapshotRequest, SERVER_STATUS_ALL, optional contract params, statusAll()

**Files:**
- Modify: `src/shared/types.ts:73-82` (LogLine — **OPTIONAL** field), `:44-56` (ServerProcess comment). `StopServerRequest` STAYS optional (no edit to `:140-143` yet — tightened in Task 6).
- Modify: `src/shared/ipc-channels.ts:21-29`
- Modify: `src/shared/ipc-contract.ts:75-84` (optional params + add `statusAll`)
- Modify: `src/preload/index.ts:36-45`
- Modify: `src/main/managers/log-store.ts` (stamp the single worktree to keep OLD managers compiling)
- Modify: `src/main/managers/server-manager.ts` (pass a worktreeId to append/reset/flush to keep compiling)

**Interfaces:**
- Produces: `LogLine.worktreeId?: string` (**OPTIONAL** this task); `LogSnapshotRequest { worktreeId: string }`; `IPC.SERVER_STATUS_ALL = 'server:status-all'`; `MangoApi.server.status(worktreeId?)`, `MangoApi.server.statusAll(): Promise<Record<string, ServerStatus>>`, `MangoApi.logs.snapshot(worktreeId?)`. `StopServerRequest.worktreeId` UNCHANGED (already optional).

**Why ADDITIVE/OPTIONAL (the green-per-commit invariant):** `LogLine.worktreeId` is added OPTIONAL because both graphs compile literals that omit it — `tests/renderer/log-filter.test.ts:5-10` (web graph) has 5 `LogLine` literals with no `worktreeId`, and `LogStore.push` (node graph) hasn't been partitioned yet. A REQUIRED add here would TS2741 those literals and break BOTH `typecheck:web` and `typecheck:node`. Contract `status`/`snapshot` params go OPTIONAL because the renderer still calls `server.status()` / `logs.snapshot()` no-arg (`src/renderer/hooks/use-server.ts:21`, `use-logs.ts:17` — web graph) until Task 5a; a REQUIRED-param add would break `typecheck:web`. `StopServerRequest.worktreeId` stays optional because the un-rewritten node test calls `mgr.stop({})` (`tests/main/server-manager.test.ts:167,175,205`) until Task 3. Nothing else changes signatures here, so this commit is typecheck-green in BOTH graphs. The OLD singular managers keep compiling by stamping/threading the single run's worktreeId. **The gate is `npm run typecheck`, NOT the vitest suite** — a type-only seam can never be red-gated by `vitest run` (esbuild type-erases).

- [ ] **Step 1: Write the failing typecheck (the red gate is `typecheck:web`, NOT vitest)**

The smallest change that forces `LogLine.worktreeId` to exist is making a web-graph `LogLine` literal reference it. Replace the helper at `tests/renderer/detect-server-url.test.ts:6-8`:

```typescript
/** Builds a LogLine with sane defaults; only `text` matters for detection. */
function line(seq: number, text: string): LogLine {
  return { worktreeId: '/wt', seq, ts: 0, stream: 'stdout', level: 'info', text };
}
```

- [ ] **Step 2: Run the typecheck to verify it fails (TS2353, via typecheck:web)**

Run: `npm run typecheck:web`
Expected: FAIL — TS2353 `Object literal may only specify known properties, and 'worktreeId' does not exist in type 'LogLine'` at the new helper (the field is not on `LogLine` yet). Do NOT use `vitest run` as the red gate here — vitest type-erases via esbuild and would NOT report this TS error.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/types.ts`, add `worktreeId` to `LogLine` as **OPTIONAL** (replace lines 73-82). It is tightened to REQUIRED in Task 6 once every producer stamps it:

```typescript
/** One line of server log (LogStore ring buffer + file). */
export interface LogLine {
  /**
   * Worktree that produced this line (every line self-attributes; renderer demuxes).
   * OPTIONAL during the V2 migration so un-partitioned producers + the untouched
   * log-filter.test.ts literals keep compiling; Task 6 CLEANUP tightens to required.
   */
  readonly worktreeId?: string;
  /** Monotonic sequence number within THIS worktree's current server run. */
  readonly seq: number;
  readonly ts: number; // epoch ms
  readonly stream: 'stdout' | 'stderr';
  /** Best-effort parsed level; 'raw' when unknown. */
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'raw';
  readonly text: string;
}
```

In `src/shared/types.ts`, ADD `LogSnapshotRequest` (insert after the `StopServerRequest` block at line 143). Do NOT touch `StopServerRequest` — its `worktreeId` STAYS optional this task (the un-rewritten `mgr.stop({})` node test depends on it); Task 6 tightens it:

```typescript
/** Asks for one worktree's log ring buffer snapshot. */
export interface LogSnapshotRequest {
  readonly worktreeId: string;
}
```

In `src/shared/types.ts`, refresh the `ServerProcess.worktreeId` doc comment (replace line 45-46):

```typescript
  /** Worktree that owns THIS server snapshot (always set for an emitted state). */
  readonly worktreeId: string | null;
```

In `src/shared/ipc-channels.ts`, replace the server block (lines 21-29):

```typescript
  // server (ONE per worktree, concurrent)
  SERVER_START: 'server:start', // invoke (worktreeId)
  SERVER_STOP: 'server:stop', // invoke (worktreeId)
  SERVER_STATUS: 'server:status', // invoke (worktreeId -> ServerStatus)
  SERVER_STATUS_ALL: 'server:status-all', // invoke (-> Record<worktreeId, ServerStatus>) mount rehydrate
  SERVER_STATE: 'server:state', // main -> renderer, event (one worktree's ServerStatus changed)

  // logs
  LOG_LINE: 'log:line', // main -> renderer, event (one LogLine, carries worktreeId)
  LOG_SNAPSHOT: 'log:snapshot', // invoke (worktreeId -> that worktree's ring buffer)
```

In `src/shared/ipc-contract.ts`, add `LogSnapshotRequest` to the type imports (after `StopServerRequest,` at line 15) and replace the `server` + `logs` groups (lines 75-84). `status`/`snapshot` params are **OPTIONAL** so the renderer's old no-arg calls (`use-server.ts:21`, `use-logs.ts:17`) keep compiling until Task 5a flips them; `statusAll()` is purely additive:

```typescript
  server: {
    start(req: StartServerRequest): Promise<ServerStatus>;
    stop(req: StopServerRequest): Promise<ServerStatus>;
    /**
     * Snapshot for ONE worktree's server (absent => stopped). worktreeId is OPTIONAL
     * during the V2 migration so the renderer's old no-arg status() compiles; Task 5a
     * passes it; main reads it once it relies on it (Task 4).
     */
    status(worktreeId?: string): Promise<ServerStatus>;
    /** All known worktree server snapshots, keyed by worktreeId (mount rehydrate). */
    statusAll(): Promise<Record<string, ServerStatus>>;
    onState(cb: (s: ServerStatus) => void): Unsubscribe;
  };
  logs: {
    /** The ring buffer for ONE worktree's server run (worktreeId optional until Task 5a). */
    snapshot(worktreeId?: string): Promise<LogLine[]>;
    onLine(cb: (line: LogLine) => void): Unsubscribe;
  };
```

In `src/preload/index.ts`, replace the `server` + `logs` bindings (lines 36-45). The forwarders accept an optional `worktreeId` and pass it through; the main handlers (still no-arg-tolerant until Task 4) ignore it for now:

```typescript
  server: {
    start: (req) => ipcRenderer.invoke(IPC.SERVER_START, req),
    stop: (req) => ipcRenderer.invoke(IPC.SERVER_STOP, req),
    status: (worktreeId) => ipcRenderer.invoke(IPC.SERVER_STATUS, { worktreeId }),
    statusAll: () => ipcRenderer.invoke(IPC.SERVER_STATUS_ALL),
    onState: (cb) => subscribe(IPC.SERVER_STATE, cb),
  },
  logs: {
    snapshot: (worktreeId) => ipcRenderer.invoke(IPC.LOG_SNAPSHOT, { worktreeId }),
    onLine: (cb) => subscribe(IPC.LOG_LINE, cb),
  },
```

Keep the OLD managers compiling against the new `LogLine` shape. In `src/main/managers/log-store.ts`, `push` must stamp a worktreeId — thread a single one through `append`/`flush`/`reset` for now. Replace the class body fields + methods minimally (lines 27-78) so it still has ONE buffer but every line carries a `worktreeId`:

```typescript
  private readonly emitter: LogEmitter;
  private readonly cap: number;
  private worktreeId = '';
  private buffer: LogLine[] = [];
  private seq = 0;
  private carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

  constructor(emitter: LogEmitter, cap: number = DEFAULT_CAP) {
    this.emitter = emitter;
    this.cap = cap;
  }

  /** Feeds a raw chunk for a worktree; emits a LogLine per COMPLETE line. */
  append(worktreeId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    this.worktreeId = worktreeId;
    const combined = this.carry[stream] + chunk;
    const parts = combined.split('\n');
    this.carry[stream] = parts.pop() ?? '';
    for (const part of parts) {
      this.push(stream, part.endsWith('\r') ? part.slice(0, -1) : part);
    }
  }

  /** Emits any buffered partials (call on process exit so the last line survives). */
  flush(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const partial = this.carry[stream];
      this.carry[stream] = '';
      if (partial.length > 0) this.push(stream, partial);
    }
  }

  /** Returns a shallow copy of the current ring (newest last). */
  snapshot(): LogLine[] {
    return [...this.buffer];
  }

  /** Clears the buffer, partials, and seq for a NEW run. */
  reset(worktreeId: string): void {
    this.worktreeId = worktreeId;
    this.buffer = [];
    this.seq = 0;
    this.carry = { stdout: '', stderr: '' };
  }

  private push(stream: 'stdout' | 'stderr', text: string): void {
    const line: LogLine = {
      worktreeId: this.worktreeId,
      seq: this.seq++,
      ts: Date.now(),
      stream,
      level: this.parseLevel(stream, text),
      text,
    };
    this.buffer.push(line);
    if (this.buffer.length > this.cap) this.buffer.shift();
    this.emitter.emitLine(line);
  }
```

In `src/main/managers/server-manager.ts`, update the call sites so they pass `worktreeId`. Replace line 83 `this.logStore.reset();` with `this.logStore.reset(req.worktreeId);`. Replace lines 116-117:

```typescript
    proc.onStdout((chunk) => this.logStore.append(server.worktreeId, 'stdout', chunk));
    proc.onStderr((chunk) => this.logStore.append(server.worktreeId, 'stderr', chunk));
```

But `server` is declared after; instead reset is fine and the append lambdas reference `req.worktreeId`. Replace lines 116-117 with (using `req.worktreeId`, in scope):

```typescript
    proc.onStdout((chunk) => this.logStore.append(req.worktreeId, 'stdout', chunk));
    proc.onStderr((chunk) => this.logStore.append(req.worktreeId, 'stderr', chunk));
```

In `src/main/managers/server-manager.ts`, the `crash` helper also appends — it has `worktreeId` in scope. Replace line 214 `this.logStore.append('stderr', …)`:

```typescript
    this.logStore.append(worktreeId, 'stderr', `[mango] ${message}\n`);
```

In `src/main/ipc/register-ipc.ts`, `getLogStore`'s `LOG_SNAPSHOT` handler (lines 559-561) calls `snapshot()` with no arg — still valid (one buffer). Leave it; Step 4 makes it per-worktree.

- [ ] **Step 4: Run the gate to verify it passes (typecheck node+web, both green)**

Run: `npm run typecheck && npx vitest run tests/renderer/detect-server-url.test.ts`
Expected: `typecheck:node` + `typecheck:web` BOTH PASS (the field/params are OPTIONAL + `statusAll` is additive, so EVERY existing call site still compiles in BOTH graphs — `log-filter.test.ts` literals, `server-manager.test.ts`'s `mgr.stop({})`, the renderer's no-arg `status()`/`snapshot()`, the singular managers stamping the threaded worktreeId). detect-server-url PASS (10 tests). The whole `vitest run` suite ALSO stays green here (the optional shim means no test is even compile-broken), but the AUTHORITATIVE gate for this type-seam task is `npm run typecheck` — vitest cannot red-gate a type-only change.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts src/shared/ipc-contract.ts src/preload/index.ts src/main/managers/log-store.ts src/main/managers/server-manager.ts tests/renderer/detect-server-url.test.ts
git commit -m "feat(server): add optional LogLine.worktreeId + per-worktree IPC type seam

Stamp every LogLine with its worktreeId (OPTIONAL during migration), add
LogSnapshotRequest + SERVER_STATUS_ALL, and widen the server/logs contract with
optional status(worktreeId?)/snapshot(worktreeId?) params + an additive statusAll().
Additive/optional so both typecheck graphs stay green; Task 6 tightens to required.
Singular managers still compile by threading the single run's worktreeId.

Change-Track: Large"
```

---

## Task 2: Partition LogStore into Map<worktreeId, partition>

**Files:**
- Modify: `src/main/managers/log-store.ts` (full rewrite of state + methods)
- Modify: `src/main/managers/server-manager.ts` (already passes worktreeId from Task 1; flush becomes per-worktree)
- Modify: `src/main/ipc/register-ipc.ts` (the `LOG_SNAPSHOT` handler — `snapshot()` now needs a worktreeId; update it in THIS commit so the node graph stays green)
- Test: `tests/main/log-store.test.ts` (REWRITE per-worktree, in this same commit)

**Interfaces:**
- Consumes: `LogLine.worktreeId` (Task 1), `LogSnapshotRequest` (Task 1).
- Produces: `LogStore.append(worktreeId, stream, chunk)`, `LogStore.flush(worktreeId)`, `LogStore.snapshot(worktreeId): LogLine[]`, `LogStore.reset(worktreeId)`, `LogStore.removeWorktree(worktreeId): void`. Per-worktree implicit-create partition `{ buffer, seq, carry }`; cap 5000 PER worktree; `seq` per-worktree-monotonic.

**Green-per-commit note:** Making `snapshot(worktreeId)` REQUIRED-arg breaks the OLD `register-ipc.ts:559-560` `LOG_SNAPSHOT` handler (calls `.snapshot()` no-arg → TS2554 in the node graph). To keep `npm run typecheck` green this commit, the `LOG_SNAPSHOT` handler MUST be updated here to read `req.worktreeId` (the `LogSnapshotRequest` type already exists from Task 1). This is the minimal coherent slice; the rest of the IPC surface (SERVER_STATUS + the SETTINGS_SET guard) is reconciled in Task 3, and the additive SERVER_STATUS_ALL handler in Task 4. `server-manager.ts`'s `flush()` call sites (lines 145/194/215) were already threaded a worktreeId in Task 1, so they need no further edit here.

- [ ] **Step 1: Write the failing test**

Replace the ENTIRE contents of `tests/main/log-store.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/log-store.test.ts`
Expected: FAIL — the rewritten test calls `store.snapshot(A)` / `store.flush(A)` / `store.removeWorktree(A)` against the Task-1 single-buffer `LogStore` (whose `snapshot()` takes no arg and which has no `flush(worktreeId)`/`removeWorktree`), and the per-worktree-isolation assertions fail. (vitest type-erases, so these surface as runtime failures here; the authoritative green check is Step 4's `npm run typecheck` + vitest BOTH green.)

- [ ] **Step 3: Write minimal implementation**

Replace the ENTIRE contents of `src/main/managers/log-store.ts`:

```typescript
import type { LogLine } from '../../shared/types';

/** Where LogStore publishes each line (injected, so tests spy / prod -> LOG_LINE). */
export interface LogEmitter {
  emitLine(line: LogLine): void;
}

const DEFAULT_CAP = 5000;

/**
 * Best-effort level token regex (Spring/Logback/npm friendly). Matches the level
 * word ANYWHERE in the line (not head-anchored), so prose containing "error" can
 * false-match — an intentionally cheap filter aid, not authoritative parsing.
 */
const LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

/** One worktree's independent ring + split state. */
interface Partition {
  buffer: LogLine[];
  seq: number;
  carry: Record<'stdout' | 'stderr', string>;
}

/**
 * In-memory bounded ring buffer of LogLine, PARTITIONED per worktree (V2 parallel
 * servers). One instance owns a Map<worktreeId, Partition> (implicit-create), so N
 * worktrees each run a concurrent server with an independent buffer + monotonic seq
 * + partial-line carry, capped at DEFAULT_CAP lines EACH. Splits chunked
 * stdout/stderr into lines (carrying partials across chunks), best-effort parses a
 * level, stamps every line with its worktreeId, and emits via the injected
 * LogEmitter. No file persistence in MVP — in-memory only.
 */
export class LogStore {
  private readonly emitter: LogEmitter;
  private readonly cap: number;
  private readonly partitions = new Map<string, Partition>();

  constructor(emitter: LogEmitter, cap: number = DEFAULT_CAP) {
    this.emitter = emitter;
    this.cap = cap;
  }

  /** Returns the worktree's partition, creating an empty one on first touch. */
  private partition(worktreeId: string): Partition {
    let p = this.partitions.get(worktreeId);
    if (!p) {
      p = { buffer: [], seq: 0, carry: { stdout: '', stderr: '' } };
      this.partitions.set(worktreeId, p);
    }
    return p;
  }

  /** Feeds a raw chunk for one worktree; emits a LogLine per COMPLETE line. */
  append(worktreeId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    const p = this.partition(worktreeId);
    const combined = p.carry[stream] + chunk;
    const parts = combined.split('\n');
    p.carry[stream] = parts.pop() ?? '';
    for (const part of parts) {
      this.push(worktreeId, p, stream, part.endsWith('\r') ? part.slice(0, -1) : part);
    }
  }

  /** Emits one worktree's buffered partials (call on its process exit). */
  flush(worktreeId: string): void {
    const p = this.partition(worktreeId);
    for (const stream of ['stdout', 'stderr'] as const) {
      const partial = p.carry[stream];
      p.carry[stream] = '';
      if (partial.length > 0) this.push(worktreeId, p, stream, partial);
    }
  }

  /** Shallow copy of one worktree's ring (newest last); [] if unseen. */
  snapshot(worktreeId: string): LogLine[] {
    return [...(this.partitions.get(worktreeId)?.buffer ?? [])];
  }

  /** Clears ONE worktree's buffer, partials, and seq for a NEW run. */
  reset(worktreeId: string): void {
    this.partitions.set(worktreeId, { buffer: [], seq: 0, carry: { stdout: '', stderr: '' } });
  }

  /** Drops a worktree's partition entirely (e.g. on worktree removal). */
  removeWorktree(worktreeId: string): void {
    this.partitions.delete(worktreeId);
  }

  private push(
    worktreeId: string,
    p: Partition,
    stream: 'stdout' | 'stderr',
    text: string,
  ): void {
    const line: LogLine = {
      worktreeId,
      seq: p.seq++,
      ts: Date.now(),
      stream,
      level: this.parseLevel(stream, text),
      text,
    };
    p.buffer.push(line);
    if (p.buffer.length > this.cap) p.buffer.shift();
    this.emitter.emitLine(line);
  }

  private parseLevel(stream: 'stdout' | 'stderr', text: string): LogLine['level'] {
    const m = LEVEL_RE.exec(text);
    if (m) {
      const token = m[1].toUpperCase();
      if (token === 'ERROR') return 'error';
      if (token === 'WARN' || token === 'WARNING') return 'warn';
      if (token === 'INFO') return 'info';
      return 'debug'; // DEBUG | TRACE
    }
    // stderr without a level token is almost always an error/stack trace.
    return stream === 'stderr' ? 'error' : 'raw';
  }
}
```

In `src/main/managers/server-manager.ts`, `flush()` is now per-worktree. The OLD ServerManager calls `this.logStore.flush()` at lines 145, 194, 215. Update each to pass the worktree in scope: line 145 (in `stop`, `server.worktreeId`) → `this.logStore.flush(server.worktreeId);`; line 194 (in `handleExit`, `server.worktreeId`) → `this.logStore.flush(server.worktreeId);`; line 215 (in `crash`, `worktreeId`) → `this.logStore.flush(worktreeId);`. (Task 3 rewrites this file wholesale, but this keeps it compiling now.) NOTE: if Task 1 already threaded `worktreeId` into these three `flush()` calls, they are already correct — verify, don't double-edit.

In `src/main/ipc/register-ipc.ts`, update the `LOG_SNAPSHOT` handler (lines 559-561) so it passes a worktreeId (keeps the NODE graph green now that `snapshot` requires one). Add `LogSnapshotRequest` to the type imports from `'../../shared/types'` (after `StopServerRequest,`), then replace:

```typescript
  ipcMain.handle(IPC.LOG_SNAPSHOT, async (): Promise<LogLine[]> => {
    return getLogStore(ctx).snapshot();
  });
```

with:

```typescript
  ipcMain.handle(
    IPC.LOG_SNAPSHOT,
    async (_event: unknown, req: LogSnapshotRequest): Promise<LogLine[]> => {
      return getLogStore(ctx).snapshot(req.worktreeId);
    },
  );
```

(The `SERVER_STATUS`/`SERVER_STOP` handlers are NOT touched here — `status()`/`stop(req)` keep their current arity until Task 3 changes them; they stay green this commit.)

- [ ] **Step 4: Run the gate (typecheck node+web AND vitest log-store, both green)**

Run: `npx vitest run tests/main/log-store.test.ts && npm run typecheck`
Expected: log-store vitest PASS (all describe blocks: splitting/level/partition/cap/reset/removeWorktree/flush). `typecheck:node` + `typecheck:web` BOTH PASS — `register-ipc` is green (LOG_SNAPSHOT now passes a worktreeId), `server-manager.ts` is green (flush threaded), and the rewritten `log-store.test.ts` compiles against the new partitioned signatures. The un-rewritten `server-manager.test.ts` still COMPILES (it calls `mgr.stop({})`/`mgr.status()` — valid arity until Task 3) so it is NOT a typecheck blocker; because it only ever exercises ONE worktree, the singular impl over a partitioned store is transparent, so it likely also stays green at RUNTIME — but its true per-worktree rewrite + authoritative gate is Task 3. AUTHORITATIVE GATE FOR THIS TASK: the targeted `log-store` vitest + `npm run typecheck` BOTH green.

- [ ] **Step 5: Commit**

```bash
git add src/main/managers/log-store.ts src/main/managers/server-manager.ts src/main/ipc/register-ipc.ts tests/main/log-store.test.ts
git commit -m "feat(logs): partition LogStore per worktree

Replace the single ring buffer/seq/carry with a Map<worktreeId, partition>
(implicit-create), per-worktree append/flush/snapshot/reset + removeWorktree, and a
5000-line cap PER worktree so one worktree overflowing never evicts another. Update
the LOG_SNAPSHOT IPC handler to pass a worktreeId in the same commit (keeps the node
graph green). Tests rewritten for two-worktree isolation.

Change-Track: Large"
```

---

## Task 3: Convert ServerManager to Map<worktreeId, RunningServer> (true concurrency) + reconcile its register-ipc callers

**Files:**
- Modify: `src/main/managers/server-manager.ts` (full rewrite)
- Modify: `src/main/ipc/register-ipc.ts` — `SERVER_STATUS` reads `req.worktreeId`; `SERVER_STOP` already passes `req` (now `stop` reads `req.worktreeId` internally); the `SETTINGS_SET` serverCommand defer guard flips `hasLiveServer()` → `liveServerWorktreeIds().length === 0`. **These edits are folded into THIS commit so the node graph stays green** (a Map conversion removes `status()` no-arg + `hasLiveServer`, which the OLD register-ipc calls). Do NOT leave register-ipc red.
- Test: `tests/main/server-manager.test.ts` (REWRITE per-worktree, in this same commit)

**Interfaces:**
- Consumes: partitioned `LogStore` (Task 2); `LogLine.worktreeId`, `StopServerRequest.worktreeId` (Task 1, still optional — `stop` reads it, falls back to a stopped snapshot when absent).
- Produces: `ServerManager.start(req): Promise<ServerStatus>` (scoped replace of `servers.get(worktreeId)` + `logStore.reset(worktreeId)`); `stop(req): Promise<ServerStatus>` (stops `req.worktreeId` only); `status(worktreeId: string): ServerStatus`; `statusAll(): Record<string, ServerStatus>`; `liveServerWorktreeIds(): string[]`; `hasAnyLiveServer(): boolean`; `killAll(): void` (all); `dispose(): void` (all). `notifyIfServerIdle()` fires `onIdle` only when `liveServerWorktreeIds().length === 0`. This is the BEHAVIORAL PIVOT to true concurrency — a second `start()` for a DIFFERENT worktree no longer kills the first.

**Green-per-commit note:** The Map conversion changes `status()` → `status(worktreeId: string)` (required) and renames `hasLiveServer()` → `liveServerWorktreeIds()`. The OLD `register-ipc.ts:555-557` (`status()` no-arg) and `:768` (`hasLiveServer()`) would then TS-error in the node graph. So this commit ALSO edits those two register-ipc sites (SERVER_STATUS → `status(req.worktreeId)`, the SETTINGS_SET guard → `liveServerWorktreeIds().length === 0`). The `SERVER_STOP` handler already forwards `req` (`stop(req)`) — `req.worktreeId` is optional, and the new `stop` reads it / returns a stopped snapshot if absent — so that handler is unchanged. `SERVER_STATUS_ALL` handler + preload `statusAll` forwarder remain Task 4 (purely additive). After this commit the WHOLE node graph typechecks and the full main vitest suite is green.

- [ ] **Step 1: Write the failing test**

Replace the ENTIRE contents of `tests/main/server-manager.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ServerManager, type ServerEmitter } from '../../src/main/managers/server-manager';
import { LogStore, type LogEmitter } from '../../src/main/managers/log-store';
import type { ProcessRunner, IProcLike } from '../../src/main/proc/process-runner';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';
import type { ServerStatus, LogLine } from '../../src/shared/types';
import type { DetectedRunner } from '../../src/main/util/detect-runner';

const A = '/repo/.worktrees/a';
const B = '/repo/.worktrees/b';

function makeRunnerFactory(fakes: FakeProcHandle[]) {
  const calls: { command: string; cwd: string }[] = [];
  let i = 0;
  const runner: ProcessRunner = {
    spawn: (command, opts) => {
      calls.push({ command, cwd: opts.cwd });
      const f = fakes[i++];
      if (!f) throw new Error('fake runner ran out of procs');
      return f as unknown as IProcLike;
    },
    spawnArgs: () => {
      throw new Error('spawnArgs not used by ServerManager');
    },
  };
  return { runner, calls };
}

function makeManager(opts: {
  fakes: FakeProcHandle[];
  detect?: (dir: string) => DetectedRunner;
  resolvePath?: (id: string) => Promise<string | undefined>;
  commandOverride?: string;
  onIdle?: () => void;
}) {
  const states: ServerStatus[] = [];
  const logLines: LogLine[] = [];
  const serverEmitter: ServerEmitter = { emitState: (s) => void states.push(s) };
  const logEmitter: LogEmitter = { emitLine: (l) => void logLines.push(l) };
  const logStore = new LogStore(logEmitter);
  const { runner, calls } = makeRunnerFactory(opts.fakes);
  const mgr = new ServerManager({
    runner,
    logStore,
    emitter: serverEmitter,
    detect: opts.detect ?? (() => ({ kind: 'npm', command: 'npm run dev' })),
    resolvePath: opts.resolvePath ?? (async (id) => id),
    commandOverride: opts.commandOverride,
    onIdle: opts.onIdle,
  });
  return { mgr, states, logLines, calls, logStore };
}

describe('ServerManager.start (per worktree)', () => {
  it('detects + spawns in the worktree cwd and reaches running', async () => {
    const fake = makeFakeRunner(111);
    const { mgr, states, calls } = makeManager({ fakes: [fake] });
    const status = await mgr.start({ worktreeId: A });
    expect(calls).toEqual([{ command: 'npm run dev', cwd: A }]);
    expect(status.process.state).toBe('running');
    expect(status.process.pid).toBe(111);
    expect(status.process.kind).toBe('npm');
    expect(status.process.worktreeId).toBe(A);
    expect(states.map((s) => s.process.state)).toEqual(['starting', 'running']);
  });

  it('uses the env command override (deps) over detection', async () => {
    const fake = makeFakeRunner();
    const { mgr, calls } = makeManager({ fakes: [fake], commandOverride: 'node fake-server.js' });
    await mgr.start({ worktreeId: A });
    expect(calls[0].command).toBe('node fake-server.js');
  });

  it('pipes stdout/stderr into the LogStore stamped with the worktreeId', async () => {
    const fake = makeFakeRunner();
    const { mgr, logLines } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: A });
    fake.emitStdout('INFO up\n');
    fake.emitStderr('ERROR boom\n');
    expect(logLines.map((l) => [l.worktreeId, l.stream, l.level, l.text])).toEqual([
      [A, 'stdout', 'info', 'INFO up'],
      [A, 'stderr', 'error', 'ERROR boom'],
    ]);
  });

  it('resets ONLY that worktree LogStore seq on restart of the same worktree', async () => {
    const a1 = makeFakeRunner(1);
    const a2 = makeFakeRunner(2);
    const { mgr, logStore } = makeManager({ fakes: [a1, a2] });
    await mgr.start({ worktreeId: A });
    a1.emitStdout('first\n');
    await mgr.start({ worktreeId: A }); // replace SAME worktree -> reset(A)
    a2.emitStdout('second\n');
    expect(logStore.snapshot(A).map((l) => [l.seq, l.text])).toEqual([[0, 'second']]);
  });

  it('crashes (no spawn) when the worktree id is unknown', async () => {
    const { mgr, calls } = makeManager({
      fakes: [makeFakeRunner()],
      resolvePath: async () => undefined,
    });
    const status = await mgr.start({ worktreeId: '/nope' });
    expect(calls).toHaveLength(0);
    expect(status.process.state).toBe('crashed');
  });

  it('crashes (no spawn) when detection is unknown and no override', async () => {
    const { mgr, calls } = makeManager({
      fakes: [makeFakeRunner()],
      detect: () => ({ kind: 'unknown', command: undefined }),
    });
    const status = await mgr.start({ worktreeId: A });
    expect(calls).toHaveLength(0);
    expect(status.process.state).toBe('crashed');
  });
});

describe('ServerManager TRUE CONCURRENCY', () => {
  it('runs two worktrees at once — starting B does NOT kill A', async () => {
    const a = makeFakeRunner(1);
    const b = makeFakeRunner(2);
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    expect(a.killed()).toBe(false);
    expect(b.killed()).toBe(false);
    expect(mgr.status(A).process.state).toBe('running');
    expect(mgr.status(B).process.state).toBe('running');
    expect(mgr.liveServerWorktreeIds().sort()).toEqual([A, B].sort());
  });

  it('restarting the SAME worktree kills only that worktree old child', async () => {
    const a1 = makeFakeRunner(1);
    const a2 = makeFakeRunner(2);
    const { mgr, states } = makeManager({ fakes: [a1, a2] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: A }); // replace SAME worktree
    expect(a1.killed()).toBe(true);
    // last state for A is the NEW run's running, never a stale crashed.
    expect(states.at(-1)?.process.state).toBe('running');
    expect(states.some((s) => s.process.state === 'crashed')).toBe(false);
  });

  it('statusAll returns every worktree snapshot keyed by worktreeId', async () => {
    const a = makeFakeRunner(1);
    const b = makeFakeRunner(2);
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    const all = mgr.statusAll();
    expect(all[A].process.state).toBe('running');
    expect(all[B].process.state).toBe('running');
    expect(all[A].process.worktreeId).toBe(A);
  });
});

describe('ServerManager exit + stop (per worktree)', () => {
  it('marks crashed on a non-zero natural exit', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: A });
    fake.emitExit(1, null);
    expect(states.at(-1)?.process.state).toBe('crashed');
    expect(states.at(-1)?.process.exitCode).toBe(1);
  });

  it('marks stopped on a clean (code 0) natural exit', async () => {
    const fake = makeFakeRunner();
    const { mgr, states } = makeManager({ fakes: [fake] });
    await mgr.start({ worktreeId: A });
    fake.emitExit(0, null);
    expect(states.at(-1)?.process.state).toBe('stopped');
  });

  it('stop(req) kills only that worktree child and ends at stopped', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    const status = await mgr.stop({ worktreeId: A });
    expect(a.killed()).toBe(true);
    expect(b.killed()).toBe(false);
    expect(status.process.state).toBe('stopped');
    expect(mgr.status(B).process.state).toBe('running');
  });

  it('stop() with no running server for that worktree returns a stopped snapshot', async () => {
    const { mgr } = makeManager({ fakes: [] });
    const status = await mgr.stop({ worktreeId: A });
    expect(status.process.state).toBe('stopped');
    expect(status.process.worktreeId).toBe(A);
  });

  it('status(worktreeId) reflects that worktree current server', async () => {
    const fake = makeFakeRunner(7);
    const { mgr } = makeManager({ fakes: [fake] });
    expect(mgr.status(A).process.state).toBe('stopped');
    await mgr.start({ worktreeId: A });
    expect(mgr.status(A).process.state).toBe('running');
    expect(mgr.status(A).process.pid).toBe(7);
  });

  it('dispose() kills ALL running children (before-quit sweep)', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    mgr.dispose();
    expect(a.killed()).toBe(true);
    expect(b.killed()).toBe(true);
  });
});

describe('ServerManager onIdle (fires only on the LAST live server)', () => {
  it('does NOT fire onIdle while another worktree server is still live', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [a, b], onIdle });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    await mgr.stop({ worktreeId: A }); // B still live
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires onIdle exactly once when the LAST live server stops', async () => {
    const a = makeFakeRunner();
    const b = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [a, b], onIdle });
    await mgr.start({ worktreeId: A });
    await mgr.start({ worktreeId: B });
    await mgr.stop({ worktreeId: A });
    await mgr.stop({ worktreeId: B }); // last one
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('fires onIdle when the LAST server exits naturally (clean or crash)', async () => {
    const fake = makeFakeRunner();
    const onIdle = vi.fn();
    const { mgr } = makeManager({ fakes: [fake], onIdle });
    await mgr.start({ worktreeId: A });
    fake.emitExit(1, null);
    expect(onIdle).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/server-manager.test.ts`
Expected: FAIL — `status(A)`/`statusAll()`/`liveServerWorktreeIds()` don't exist on the singular manager, `stop({worktreeId:A})` kills the wrong child / `start(B)` kills A (the old `replaceCurrent` global kill).

- [ ] **Step 3: Write minimal implementation**

Replace the ENTIRE contents of `src/main/managers/server-manager.ts`:

```typescript
import type {
  ServerKind,
  ServerState,
  ServerProcess,
  ServerStatus,
  StartServerRequest,
  StopServerRequest,
} from '../../shared/types';
import type { IProcLike, ProcessRunner } from '../proc/process-runner';
import { detectRunner, type DetectedRunner } from '../util/detect-runner';
import type { LogStore } from './log-store';

/** Where ServerManager publishes one worktree's server state (injected for tests). */
export interface ServerEmitter {
  emitState(status: ServerStatus): void;
}

/** Constructor dependencies — all injectable for windowless unit tests. */
export interface ServerManagerDeps {
  readonly runner: ProcessRunner;
  readonly logStore: LogStore;
  readonly emitter: ServerEmitter;
  /** Worktree dir detection; default detectRunner. Injectable for tests. */
  readonly detect?: (dir: string) => DetectedRunner;
  /** Resolves worktreeId -> absolute cwd (undefined if not a managed worktree). */
  readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  /** Global command override from the main-side env seam (MANGO_SERVER_CMD). */
  readonly commandOverride?: string;
  /**
   * Fired when the LAST live server child goes away (stop or natural exit), i.e.
   * the manager transitions from busy -> idle ACROSS ALL worktrees. register-ipc
   * uses this to perform a settings edit that was DEFERRED while busy: clearing
   * ctx.serverManager so the next start rebuilds with the new serverCommand.
   * Optional => no-op. Mirrors SessionManager.notifyIfIdle (fires only at 0 live).
   */
  readonly onIdle?: () => void;
}

/** Internal per-worktree bookkeeping for ONE running child. */
interface RunningServer {
  readonly proc: IProcLike;
  readonly worktreeId: string;
  readonly kind: ServerKind;
  readonly command: string;
  readonly startedAt: number;
  /** True once we requested stop (so a following exit reads as 'stopped'). */
  stopping: boolean;
}

/**
 * Owns ONE local server PER worktree, CONCURRENTLY (V2 parallel servers). Mirrors
 * SessionManager: a Map<worktreeId, RunningServer>, a scoped replace that UNMAPS
 * before kill so a replaced child's late exit reads as stale, killAll/dispose that
 * iterate ALL live children, and an onIdle that fires only when the LAST live
 * server (across worktrees) goes away. start() detects + spawns the
 * detected/overridden command in the worktree cwd, pipes stdout/stderr into that
 * worktree's LogStore partition, and publishes ServerStatus via the injected
 * emitter. Command source stays hardened (override or detection, never a renderer
 * field). NO port injection — relies on dev-server auto-increment + per-worktree
 * log detection of the actual printed port (D4 known limitation: a runner that
 * does NOT auto-increment needs a user-set per-worktree PORT).
 */
export class ServerManager {
  private readonly runner: ProcessRunner;
  private readonly logStore: LogStore;
  private readonly emitter: ServerEmitter;
  private readonly detect: (dir: string) => DetectedRunner;
  private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  private readonly commandOverride?: string;
  private readonly onIdle?: () => void;
  /** Live children, keyed by worktreeId (true concurrency). */
  private readonly servers = new Map<string, RunningServer>();
  /** Last process snapshot PER worktree (so status()/stop() report when idle). */
  private readonly last = new Map<string, ServerProcess>();

  constructor(deps: ServerManagerDeps) {
    this.runner = deps.runner;
    this.logStore = deps.logStore;
    this.emitter = deps.emitter;
    this.detect = deps.detect ?? detectRunner;
    this.resolvePath = deps.resolvePath;
    this.commandOverride = deps.commandOverride;
    this.onIdle = deps.onIdle;
  }

  /** Starts (replacing only THIS worktree's server) the detected/overridden command. */
  async start(req: StartServerRequest): Promise<ServerStatus> {
    this.replace(req.worktreeId); // stop only this worktree's existing server
    this.logStore.reset(req.worktreeId); // reset only this worktree's log ring

    const cwd = await this.resolvePath(req.worktreeId);
    if (!cwd) {
      return this.crash(req.worktreeId, 'unknown', undefined, `unknown worktree ${req.worktreeId}`);
    }

    const detected = this.detect(cwd);
    // Command source (hardened): main-side env seam (operator-controlled) OR
    // auto-detection — never a renderer-supplied request field.
    const command = this.commandOverride ?? detected.command;
    if (!command) {
      return this.crash(req.worktreeId, detected.kind, undefined, 'no runnable server detected');
    }

    this.emitState({
      worktreeId: req.worktreeId,
      kind: detected.kind,
      state: 'starting',
      command,
    });

    const proc = this.runner.spawn(command, { cwd });
    const server: RunningServer = {
      proc,
      worktreeId: req.worktreeId,
      kind: detected.kind,
      command,
      startedAt: Date.now(),
      stopping: false,
    };
    this.servers.set(req.worktreeId, server);

    proc.onStdout((chunk) => this.logStore.append(server.worktreeId, 'stdout', chunk));
    proc.onStderr((chunk) => this.logStore.append(server.worktreeId, 'stderr', chunk));
    proc.onExit((e) => this.handleExit(server, e.code, e.signal));

    return this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'running',
      pid: proc.pid,
      command: server.command,
      startedAt: server.startedAt,
    });
  }

  /** Stops one worktree's server (idempotent). */
  async stop(req: StopServerRequest): Promise<ServerStatus> {
    const server = this.servers.get(req.worktreeId);
    if (!server) return this.status(req.worktreeId);
    server.stopping = true;
    this.servers.delete(req.worktreeId);
    this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'stopping',
      pid: server.proc.pid,
      command: server.command,
      startedAt: server.startedAt,
    });
    server.proc.kill();
    this.logStore.flush(server.worktreeId);
    const status = this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: 'stopped',
      command: server.command,
      exitCode: null,
    });
    // busy -> idle only when this was the LAST live server (mirror notifyIfIdle).
    this.notifyIfServerIdle();
    return status;
  }

  /** Snapshot for ONE worktree (its last emitted state, or a stopped default). */
  status(worktreeId: string): ServerStatus {
    return { process: this.last.get(worktreeId) ?? stoppedFor(worktreeId) };
  }

  /** Every known worktree's snapshot, keyed by worktreeId (mount rehydrate, D2). */
  statusAll(): Record<string, ServerStatus> {
    const out: Record<string, ServerStatus> = {};
    for (const [worktreeId, process] of this.last) {
      out[worktreeId] = { process };
    }
    return out;
  }

  /** Worktrees with a LIVE server child (used by the live-apply guard). */
  liveServerWorktreeIds(): string[] {
    return [...this.servers.keys()];
  }

  /** True iff ANY worktree has a live server child. */
  hasAnyLiveServer(): boolean {
    return this.servers.size > 0;
  }

  /** Kills EVERY running child (before-quit sweep). */
  killAll(): void {
    for (const server of this.servers.values()) {
      server.stopping = true;
      server.proc.kill();
    }
    this.servers.clear();
  }

  /** Alias for killAll for the disposer. */
  dispose(): void {
    this.killAll();
  }

  /** Stops one worktree's server (used by start's replace), UNMAPPING before kill. */
  private replace(worktreeId: string): void {
    const server = this.servers.get(worktreeId);
    if (!server) return;
    this.servers.delete(worktreeId); // unmap first so its exit is recognized as stale
    server.stopping = true;
    server.proc.kill();
  }

  private handleExit(server: RunningServer, code: number | null, _signal: string | null): void {
    // Stale-exit guard (identity, mirror SessionManager): only the CURRENT mapped
    // server for this worktree may flip state. A replaced child (already unmapped)
    // is swallowed.
    if (this.servers.get(server.worktreeId) !== server) return;
    this.servers.delete(server.worktreeId);
    this.logStore.flush(server.worktreeId);
    // Clean stop = we asked it to stop (kill) OR it exited 0; anything else is a crash.
    const stoppedCleanly = server.stopping || code === 0;
    this.emitState({
      worktreeId: server.worktreeId,
      kind: server.kind,
      state: stoppedCleanly ? 'stopped' : 'crashed',
      command: server.command,
      exitCode: code,
    });
    this.notifyIfServerIdle();
  }

  /** Fires onIdle exactly when the LAST live server (any worktree) has gone away. */
  private notifyIfServerIdle(): void {
    if (this.liveServerWorktreeIds().length === 0) this.onIdle?.();
  }

  private crash(
    worktreeId: string,
    kind: ServerKind,
    pid: number | undefined,
    message: string,
  ): ServerStatus {
    this.logStore.append(worktreeId, 'stderr', `[mango] ${message}\n`);
    this.logStore.flush(worktreeId);
    return this.emitState({ worktreeId, kind, state: 'crashed', pid, exitCode: null });
  }

  /** Records + publishes one worktree's state, returning its ServerStatus. */
  private emitState(partial: {
    worktreeId: string;
    kind: ServerKind;
    state: ServerState;
    pid?: number;
    command?: string;
    startedAt?: number;
    exitCode?: number | null;
  }): ServerStatus {
    const process: ServerProcess = { ...partial };
    this.last.set(partial.worktreeId, process);
    const status: ServerStatus = { process };
    this.emitter.emitState(status);
    return status;
  }
}

/** A stopped snapshot for a worktree that has never run a server. */
function stoppedFor(worktreeId: string): ServerProcess {
  return { worktreeId, kind: 'unknown', state: 'stopped' };
}
```

Now reconcile the two register-ipc callers the Map conversion would break (SAME commit). In `src/main/ipc/register-ipc.ts`, replace the `SERVER_STATUS` handler (lines 555-557):

```typescript
  ipcMain.handle(IPC.SERVER_STATUS, async (): Promise<ServerStatus> => {
    return getServerManager(ctx).status();
  });
```

with (now reads a worktreeId; the renderer already forwards `{ worktreeId }` from Task 1's preload):

```typescript
  ipcMain.handle(
    IPC.SERVER_STATUS,
    async (_event: unknown, req: { worktreeId: string }): Promise<ServerStatus> => {
      return getServerManager(ctx).status(req.worktreeId);
    },
  );
```

In `src/main/ipc/register-ipc.ts`, flip the SETTINGS_SET serverCommand defer guard (lines 768-773). Replace:

```typescript
      if (!(ctx.serverManager?.hasLiveServer() ?? false)) {
        ctx.serverSettingsDirty = false;
        ctx.serverManager = undefined; // idle: serverCommand applies on next start
      } else {
        ctx.serverSettingsDirty = true; // busy: onIdle clears it after the server stops
      }
```

with (same predicate shape as the sessionManager guard above it — 0 live === idle):

```typescript
      if ((ctx.serverManager?.liveServerWorktreeIds().length ?? 0) === 0) {
        ctx.serverSettingsDirty = false;
        ctx.serverManager = undefined; // idle (no live server anywhere): applies on next start
      } else {
        ctx.serverSettingsDirty = true; // busy: onIdle clears it after the LAST server stops
      }
```

The `SERVER_STOP` handler (lines 548-553) already forwards `req` to `stop(req)` — the new `stop` reads `req.worktreeId` (optional) and returns a stopped snapshot if absent — so it needs NO edit. The `LOG_SNAPSHOT` handler was already made per-worktree in Task 2. `SERVER_STATUS_ALL` handler + preload `statusAll` forwarder are the only server-IPC surface left for Task 4 (purely additive). `getServerManager`/`getLogStore` stay ONE lazy ctx instance (no change).

- [ ] **Step 4: Run the gate (server-manager + log-store vitest AND full typecheck, all green)**

Run: `npx vitest run tests/main/server-manager.test.ts tests/main/log-store.test.ts && npm run typecheck`
Expected: server-manager vitest PASS (start/true-concurrency/exit+stop/onIdle describe blocks), log-store vitest still PASS. `typecheck:node` + `typecheck:web` BOTH PASS — register-ipc is fully reconciled in THIS commit (SERVER_STATUS reads a worktreeId, the SETTINGS_SET guard uses `liveServerWorktreeIds()`, SERVER_STOP/LOG_SNAPSHOT already correct), so the node graph is green; the web graph is untouched and stays green. Running the FULL `vitest run` here is ALSO green now (every rewritten suite is per-worktree; the renderer is still singular but its tests don't exercise the changed managers). AUTHORITATIVE GATE: the two targeted suites + `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/main/managers/server-manager.ts src/main/ipc/register-ipc.ts tests/main/server-manager.test.ts
git commit -m "feat(server): per-worktree concurrent ServerManager + reconcile IPC callers

Replace the at-most-one current server with a Map<worktreeId, RunningServer>:
scoped replace (unmap-before-kill) + per-worktree logStore.reset, stop(worktreeId)
that touches only that worktree, status(worktreeId)/statusAll(), liveServerWorktreeIds
/hasAnyLiveServer, killAll/dispose looping ALL, an identity-guarded handleExit, and
an onIdle gated on the LAST live server. Reconcile register-ipc SERVER_STATUS +
the SETTINGS_SET defer guard in the same commit so the node graph stays green.
Mirrors SessionManager. Tests rewritten for true concurrency.

Change-Track: Large"
```

---

## Task 4: Add the SERVER_STATUS_ALL handler + preload statusAll forwarder (purely additive)

**Files:**
- Modify: `src/main/ipc/register-ipc.ts` — ADD the `SERVER_STATUS_ALL` handler (the STOP/STATUS/LOG_SNAPSHOT/guard edits already landed in Tasks 2 + 3); verify `:840-842` dispose sweep loops ALL.
- Modify: `src/preload/index.ts` — verify the `statusAll` forwarder added in Task 1 is present (no further edit unless it was deferred).
- Modify: `src/main/ipc/ipc-context.ts` (doc comments only; slots unchanged)

**Interfaces:**
- Consumes: `ServerManager.statusAll()` (Task 3); `IPC.SERVER_STATUS_ALL` (Task 1).
- Produces: the `SERVER_STATUS_ALL` invoke handler. `getServerManager`/`getLogStore` stay ONE lazy instance on ctx.

**Green-per-commit note:** This task is PURELY ADDITIVE — it only ADDS the `SERVER_STATUS_ALL` handler (a new channel that nothing yet calls until Task 5a's `useServer` mount seed). The cross-graph signature reconciliations (SERVER_STATUS reads worktreeId, LOG_SNAPSHOT reads worktreeId, SETTINGS_SET guard) ALREADY happened in Tasks 2 + 3, so the node graph entered this task green and stays green. There is no "failing-first" type unit here (an additive handler can't red-gate); the gate is `npm run typecheck` + full `vitest run` staying green.

- [ ] **Step 1: (no failing-first — additive handler)**

There is no dedicated unit test (the IPC registration is integration-shaped, no windowless harness in this repo) and no red gate (an additive channel doesn't break anything). Confirm the starting state is green: run `npm run typecheck` and expect PASS (Tasks 2+3 already reconciled register-ipc).

- [ ] **Step 2: (n/a)**

- [ ] **Step 3: Write minimal implementation**

In `src/main/ipc/register-ipc.ts`, ADD the `SERVER_STATUS_ALL` handler next to the existing `SERVER_STATUS` handler (which already reads a worktreeId from Task 3):

```typescript
  ipcMain.handle(
    IPC.SERVER_STATUS_ALL,
    async (): Promise<Record<string, ServerStatus>> => {
      return getServerManager(ctx).statusAll();
    },
  );
```

Verify the `statusAll` forwarder in `src/preload/index.ts` is present (it was added in Task 1's `server` block: `statusAll: () => ipcRenderer.invoke(IPC.SERVER_STATUS_ALL)`). If Task 1 added it, no edit; otherwise add it now.

The `APP_QUIT_DECISION` sweep already calls `ctx.serverManager?.dispose()` (line 841) which now loops ALL — no change needed; verify by reading the line. `getServerManager`/`getLogStore` already return ONE lazy ctx instance — no change.

In `src/main/ipc/ipc-context.ts`, update the `logStore?` doc comment (line 35) to reflect partitioning (optional polish):

```typescript
  /** The single LogStore (Map<worktreeId, partition>) backing every worktree's server logs. */
  logStore?: LogStore;
```

- [ ] **Step 4: Run the gate (full typecheck AND full vitest, all green)**

Run: `npm run typecheck && npx vitest run`
Expected: `typecheck:node` + `typecheck:web` BOTH PASS. Full Vitest suite PASS (log-store + server-manager rewritten green from Tasks 2+3; every other suite untouched-green). The added channel compiles and is reachable; nothing else moved.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/register-ipc.ts src/preload/index.ts src/main/ipc/ipc-context.ts
git commit -m "feat(server): add the SERVER_STATUS_ALL IPC handler (mount rehydrate)

Add the additive SERVER_STATUS_ALL invoke handler returning statusAll(); the
STOP/STATUS/LOG_SNAPSHOT worktreeId reads + the SETTINGS_SET guard flip already
landed in the partition + Map commits. The quit-sweep dispose() already loops ALL.

Change-Track: Large"
```

At this commit the app is still shippable-as-singular: the renderer continues to call the old single-server hooks (no-arg `status()`/`snapshot()` still compile against the optional contract params), but the main side is fully per-worktree. Tasks 5a + 5c flip the renderer.

---

## Task 5a: Flip the renderer to per-worktree — aggregateStatus map (TDD) + hooks/components/App in ONE commit

**Why ONE commit (green-per-commit invariant):** the web graph is a tight chain — `aggregateStatus(…, server: ServerStatus | null)` (app-store.ts) ← `use-worktree-status.ts:13,31` ← `App.tsx:49,52` ← `useServer().status` (use-server.ts). Flipping `aggregateStatus`'s 3rd param to a `ReadonlyMap` immediately mistypes `use-worktree-status.ts`'s call AND `App.tsx`'s `useWorktreeStatus(worktrees, serverStatus)` AND the old `useServer` `{ status }` shape. None of these can be split into separate commits without leaving `typecheck:web` RED. So this single commit does the app-store TDD pivot AND re-wires every web consumer that touches it: `use-server.ts` (map), `use-logs.ts` (worktreeId), `use-worktree-status.ts` (map param), `server-controls.tsx` (selected worktree), `App.tsx` (wiring), and the `log-panel.tsx` row key. `detect-server-url.ts` internals are unchanged (only its INPUT is re-anchored by `useLogs(selectedId)`); its demux regression test is the standalone Task 5c. The app-store pure-module keeps TDD (failing test first); the rest of the renderer has NO unit harness, so it gates on `npm run typecheck:web` + `npm run build` after the impl.

**Files:**
- Modify: `src/renderer/state/app-store.ts` (TDD — the failing-test-first step below)
- Modify: `src/renderer/hooks/use-server.ts`, `src/renderer/hooks/use-logs.ts`, `src/renderer/hooks/use-worktree-status.ts`
- Modify: `src/renderer/components/toolbar/server-controls.tsx`, `src/renderer/components/logs/log-panel.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/app-store.test.ts` (REWRITE, in this same commit)

**Interfaces:**
- Consumes: `MangoApi.server.statusAll()`/`status(worktreeId?)`/`stop(req)`, `MangoApi.logs.snapshot(worktreeId?)`, `LogLine.worktreeId` (Task 1); the partitioned/Map main side (Tasks 2-4).
- Produces: `aggregateStatus(worktrees, agentStatuses, servers: ReadonlyMap<string, ServerStatus>): ReadonlyMap<string, WorktreeRowStatus>` (`ownsServer` = non-`'stopped'` record; ABSENT entries default to `'stopped'`/`ownsServer:false`, D8; `WorktreeRowStatus` shape UNCHANGED); `useServer(): { servers: ReadonlyMap<string, ServerStatus>; start(id); stop(id) }`; `useLogs(worktreeId): readonly LogLine[]`; `useWorktreeStatus(worktrees, servers map)`; `ServerControls` props `{ selectedId, status, onStart, onStop(worktreeId) }`.

### Part 1 — app-store TDD pivot (failing test first)

- [ ] **Step 1: Write the failing test**

Replace the ENTIRE contents of `tests/renderer/app-store.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { aggregateStatus } from '../../src/renderer/state/app-store';
import type { Worktree, AgentStatus, ServerStatus } from '../../src/shared/types';

const wt = (id: string, branch: string, isPrimary = false): Worktree => ({
  id,
  path: id,
  branch,
  isPrimary,
  isLocked: false,
});

const serverOn = (id: string, state: ServerStatus['process']['state']): ServerStatus => ({
  process: { worktreeId: id, kind: 'npm', state },
});

describe('aggregateStatus (per-worktree server map)', () => {
  it('defaults every worktree to idle/stopped when no events seen', () => {
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), new Map());
    expect(map.get('/a')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
    expect(map.get('/b')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
  });

  it('folds the agent status for the matching worktree', () => {
    const agents = new Map<string, AgentStatus>([['/b', 'running']]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], agents, new Map());
    expect(map.get('/b')!.agent).toBe('running');
    expect(map.get('/a')!.agent).toBe('idle');
  });

  it('shows EACH worktree its OWN server state concurrently', () => {
    const servers = new Map<string, ServerStatus>([
      ['/a', serverOn('/a', 'running')],
      ['/b', serverOn('/b', 'crashed')],
    ]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), servers);
    expect(map.get('/a')).toMatchObject({ server: 'running', ownsServer: true });
    expect(map.get('/b')).toMatchObject({ server: 'crashed', ownsServer: true });
  });

  it('a stopped record is NOT owning (ownsServer false, server stopped)', () => {
    const servers = new Map<string, ServerStatus>([['/a', serverOn('/a', 'stopped')]]);
    const map = aggregateStatus([wt('/a', 'main', true)], new Map(), servers);
    expect(map.get('/a')).toMatchObject({ server: 'stopped', ownsServer: false });
  });

  it('an absent record defaults to stopped/not-owning (D8)', () => {
    const servers = new Map<string, ServerStatus>([['/a', serverOn('/a', 'running')]]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), servers);
    expect(map.get('/b')).toMatchObject({ server: 'stopped', ownsServer: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/app-store.test.ts`
Expected: FAIL — `aggregateStatus` still takes `server: ServerStatus | null`, not a `Map`; calls with a `Map` mistype and the concurrent-state assertions fail.

- [ ] **Step 3: Write minimal implementation**

Replace the ENTIRE contents of `src/renderer/state/app-store.ts`:

```typescript
import type { AgentStatus, ServerState, ServerStatus, Worktree } from '../../shared/types';

/** Unified per-worktree status the sidebar row renders (branch lives on Worktree). */
export interface WorktreeRowStatus {
  readonly agent: AgentStatus;
  readonly server: ServerState;
  /** True iff THIS worktree has a non-stopped (live/transitioning/crashed) server. */
  readonly ownsServer: boolean;
}

/**
 * Pure fold: combines the worktree list with the live agent-status map
 * (SESSION_STATUS) and the per-worktree server-status map (SERVER_STATE deltas +
 * SERVER_STATUS_ALL seed) into one Map<worktreeId, WorktreeRowStatus>. Each worktree
 * shows ITS OWN server state concurrently (V2 parallel servers); a worktree with no
 * record — or a 'stopped' record — is stopped/not-owning (D8). No React, no IO —
 * unit tested directly; useWorktreeStatus is the only live caller.
 */
export function aggregateStatus(
  worktrees: readonly Worktree[],
  agentStatuses: ReadonlyMap<string, AgentStatus>,
  servers: ReadonlyMap<string, ServerStatus>,
): ReadonlyMap<string, WorktreeRowStatus> {
  const out = new Map<string, WorktreeRowStatus>();
  for (const wt of worktrees) {
    const serverState = servers.get(wt.id)?.process.state ?? 'stopped';
    const ownsServer = serverState !== 'stopped';
    out.set(wt.id, {
      agent: agentStatuses.get(wt.id) ?? 'idle',
      server: serverState,
      ownsServer,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the app-store test to verify it passes (TDD green)**

Run: `npx vitest run tests/renderer/app-store.test.ts`
Expected: PASS (all 5 tests). DO NOT COMMIT YET — at this instant `typecheck:web` is RED (`use-worktree-status.ts:31` still passes a single `server` to the now-map `aggregateStatus`). Proceed to Part 2 in the SAME working tree; the commit happens once the whole renderer chain is flipped and `typecheck:web` + `build` are green.

### Part 2 — flip the hooks, components, and App (no unit harness; gates on typecheck:web + build)

- [ ] **Step 5: Write the renderer implementation (same working tree, no commit between)**

Replace the ENTIRE contents of `src/renderer/hooks/use-server.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import type { ServerStatus } from '../../shared/types';

/** Return shape of the per-worktree server hook. */
export interface UseServer {
  /** Live per-worktree server snapshots, keyed by worktreeId. */
  readonly servers: ReadonlyMap<string, ServerStatus>;
  start(worktreeId: string): Promise<void>;
  stop(worktreeId: string): Promise<void>;
}

/**
 * Drives the per-worktree dev servers over window.mango.server. Seeds the whole map
 * from statusAll() on mount and stays live via onState (each delta is keyed by
 * process.worktreeId). start/stop are thin invoke wrappers. The returned map feeds
 * the toolbar (selected worktree) + the sidebar dots (all worktrees).
 */
export function useServer(): UseServer {
  const [servers, setServers] = useState<ReadonlyMap<string, ServerStatus>>(new Map());

  useEffect(() => {
    let alive = true;
    void window.mango.server.statusAll().then((all) => {
      if (!alive) return;
      setServers(new Map(Object.entries(all)));
    });
    const off = window.mango.server.onState((s) => {
      const id = s.process.worktreeId;
      if (id === null) return; // main never emits a null-worktree snapshot (D8); guard anyway
      setServers((prev) => {
        const next = new Map(prev);
        next.set(id, s);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useCallback(async (worktreeId: string): Promise<void> => {
    const s = await window.mango.server.start({ worktreeId });
    const id = s.process.worktreeId ?? worktreeId;
    setServers((prev) => new Map(prev).set(id, s));
  }, []);

  const stop = useCallback(async (worktreeId: string): Promise<void> => {
    const s = await window.mango.server.stop({ worktreeId });
    const id = s.process.worktreeId ?? worktreeId;
    setServers((prev) => new Map(prev).set(id, s));
  }, []);

  return { servers, start, stop };
}
```

Replace the ENTIRE contents of `src/renderer/hooks/use-logs.ts`:

```typescript
import { useEffect, useState } from 'react';
import type { LogLine } from '../../shared/types';

/** Max lines held in renderer memory per worktree (mirrors the LogStore cap). */
const MAX_LINES = 5000;

/**
 * Seeds ONE worktree's live log list from logs.snapshot(worktreeId) on mount and
 * appends every LOG_LINE whose worktreeId matches via onLine (renderer-side demux,
 * D6), capping the in-memory list. A per-worktree seq===0 reset clears on a fresh
 * run; a monotonic-seq guard drops a duplicate racing between snapshot and the first
 * live line. Re-subscribes when worktreeId changes.
 */
export function useLogs(worktreeId: string | null): readonly LogLine[] {
  const [lines, setLines] = useState<readonly LogLine[]>([]);

  useEffect(() => {
    if (worktreeId === null) {
      setLines([]);
      return;
    }
    let alive = true;
    setLines([]); // clear stale lines from the previously selected worktree
    void window.mango.logs.snapshot(worktreeId).then((snap) => {
      if (alive) setLines(snap);
    });
    const off = window.mango.logs.onLine((line) => {
      if (line.worktreeId !== worktreeId) return; // demux: only THIS worktree's lines
      setLines((prev) => {
        // A NEW run for THIS worktree resets seq to 0 — clear + seed the fresh run.
        if (line.seq === 0) return [line];
        const last = prev[prev.length - 1];
        if (last && line.seq <= last.seq) return prev; // dup / pre-reset straggler
        const next = prev.length >= MAX_LINES ? prev.slice(1) : prev.slice();
        next.push(line);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [worktreeId]);

  return lines;
}
```

Replace the ENTIRE contents of `src/renderer/hooks/use-worktree-status.ts`:

```typescript
import { useEffect, useMemo, useState } from 'react';
import type { AgentStatus, ServerStatus, Worktree } from '../../shared/types';
import { aggregateStatus, type WorktreeRowStatus } from '../state/app-store';

/**
 * Live unified per-worktree status. Owns ONLY the agent-status map (SESSION_STATUS)
 * and derives the row map via the pure aggregateStatus reducer. The per-worktree
 * server map is passed in from useServer (the sole SERVER_STATE subscriber) so we
 * don't open a second redundant server subscription. The sidebar reads this map.
 */
export function useWorktreeStatus(
  worktrees: readonly Worktree[],
  servers: ReadonlyMap<string, ServerStatus>,
): ReadonlyMap<string, WorktreeRowStatus> {
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());

  useEffect(() => {
    const offStatus = window.mango.session.onStatus((s) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(s.worktreeId, s.status);
        return next;
      });
    });
    return () => {
      offStatus();
    };
  }, []);

  return useMemo(
    () => aggregateStatus(worktrees, agentStatuses, servers),
    [worktrees, agentStatuses, servers],
  );
}
```

Replace the ENTIRE contents of `src/renderer/components/toolbar/server-controls.tsx`:

```typescript
import type { ServerStatus } from '../../../shared/types';

export interface ServerControlsProps {
  readonly selectedId: string | null;
  /** The SELECTED worktree's server snapshot (or null when it has never run). */
  readonly status: ServerStatus | null;
  onStart(worktreeId: string): void;
  onStop(worktreeId: string): void;
}

/** Run/Stop for the SELECTED worktree's server (each worktree runs its own, V2). */
export function ServerControls({
  selectedId,
  status,
  onStart,
  onStop,
}: ServerControlsProps): React.JSX.Element {
  const state = status?.process.state ?? 'stopped';
  const isBusy = state === 'starting' || state === 'stopping';
  const isRunning = state === 'running';

  return (
    <div data-testid="server-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        type="button"
        disabled={!selectedId || isRunning || isBusy}
        onClick={() => selectedId && onStart(selectedId)}
        title={selectedId ? 'start the detected server' : 'select a worktree first'}
      >
        Run
      </button>
      <button
        type="button"
        disabled={!selectedId || (!isRunning && !isBusy)}
        onClick={() => selectedId && onStop(selectedId)}
      >
        Stop
      </button>
      <span style={{ fontSize: 11, color: '#888' }}>server: {state}</span>
    </div>
  );
}
```

Now wire `src/renderer/App.tsx`. Replace the server/logs/status wiring lines (49-52):

```typescript
  const { servers, start: startServer, stop: stopServer } = useServer();
  const selectedServer = selectedId ? (servers.get(selectedId) ?? null) : null;
  const logLines = useLogs(selectedId);
  const detectedServerUrl = detectServerUrl(logLines);
  const statuses = useWorktreeStatus(worktrees, servers);
```

Replace the `<ServerControls …>` block (lines 228-233):

```typescript
      <ServerControls
        selectedId={selectedId}
        status={selectedServer}
        onStart={(id) => void startServer(id)}
        onStop={(id) => void stopServer(id)}
      />
```

`logLines` is now the selected worktree's slice; `detectServerUrl(logLines)` already feeds `BrowserPane detectedUrl={detectedServerUrl}` (line 324) and `LogPanel lines={logLines}` (line 361) per-selected — no further change. `BrowserPane` already remounts per `key={`browser-${selectedId}`}` (line 324) — unchanged. `WorktreeList`/`WorktreeItem`/`ServerDot` already render N dots from `statuses` (lines 249-257) — unchanged.

In `src/renderer/components/logs/log-panel.tsx`, the real file (verified at lines 73-74) maps the visible lines with the variable **`l`** and renders `key={l.seq}`. Now that lines carry a (possibly cross-run-reused after a reset) per-worktree `seq`, make the React key composite. Change line 74:

```typescript
            <div key={l.seq} style={{ whiteSpace: 'pre-wrap', color: LEVEL_COLOR[l.level] }}>
```

to (note the variable is `l`, NOT `line`):

```typescript
            <div key={`${l.worktreeId}:${l.seq}`} style={{ whiteSpace: 'pre-wrap', color: LEVEL_COLOR[l.level] }}>
```

`logLines` is now the selected worktree's slice; `detectServerUrl(logLines)` already feeds `BrowserPane detectedUrl={detectedServerUrl}` (line 324) and `LogPanel lines={logLines}` (line 361) per-selected — no further change. `BrowserPane` already remounts per `key={`browser-${selectedId}`}` (line 324) — unchanged. `WorktreeList`/`WorktreeItem`/`ServerDot` already render N dots from `statuses` (lines 249-257) — unchanged.

- [ ] **Step 6: Run the gate (typecheck:web + build, both green) — then COMMIT**

Run: `npm run typecheck:web && npm run build && npx vitest run tests/renderer/app-store.test.ts`
Expected: `typecheck:web` PASS (app-store map + use-server/use-logs/use-worktree-status/server-controls/App/log-panel type-consistent end-to-end — the chain that was RED after Part 1 is now whole), `npm run build` PASS (electron-vite emits main + preload + renderer with no errors), app-store vitest PASS (5). Also sanity-run `npm run typecheck:node` (should be untouched-green — the renderer flip never touches the node graph). This is the FIRST point in Task 5a where the web graph is green again, so it is the ONLY commit for the whole flip.

- [ ] **Step 7: Commit (the whole renderer flip as ONE commit)**

```bash
git add src/renderer/state/app-store.ts tests/renderer/app-store.test.ts src/renderer/hooks/use-server.ts src/renderer/hooks/use-logs.ts src/renderer/hooks/use-worktree-status.ts src/renderer/components/toolbar/server-controls.tsx src/renderer/App.tsx src/renderer/components/logs/log-panel.tsx
git commit -m "feat(renderer): flip server + logs UI to per-worktree

aggregateStatus folds a ReadonlyMap<worktreeId, ServerStatus> (each worktree shows
its own concurrent state, ownsServer = non-stopped record, absent => stopped, D8;
tests rewritten). useServer holds that map seeded by statusAll() + onState deltas;
useLogs(worktreeId) demuxes LOG_LINE by line.worktreeId with a per-worktree seq
reset/cap; useWorktreeStatus + App feed the whole map; ServerControls binds the
selected worktree (stop(worktreeId)); LogPanel keys rows by worktreeId:seq. The whole
web chain flips in ONE commit so typecheck:web is never left red. Sidebar now shows
each worktree its own concurrent ServerDot.

Change-Track: Large"
```

---

## Task 5c: Re-anchor detect-server-url input to the selected worktree slice (TDD-preserved)

**Files:**
- Modify: `src/renderer/lib/detect-server-url.ts` (INTERNALS UNCHANGED — only its input is now a filtered slice)
- Test: `tests/renderer/detect-server-url.test.ts` (already gained `worktreeId` in Task 1; add a demux-confirming case)

**Interfaces:**
- Consumes: `LogLine.worktreeId` (Task 1); `useLogs(worktreeId)` slice (Task 5a).
- Produces: `detectServerUrl(lines)` UNCHANGED signature/behavior. The test proves that when fed ONLY one worktree's lines, it detects that worktree's URL (no cross-worktree bleed).

- [ ] **Step 1: Write the failing test**

Append this `it` block inside the existing `describe('detectServerUrl', …)` in `tests/renderer/detect-server-url.test.ts` (the `line()` helper already stamps `worktreeId: '/wt'` from Task 1; add a per-worktree variant helper above the new test):

```typescript
  it('detects the URL of the slice it is fed (per-worktree demux upstream)', () => {
    // useLogs(worktreeId) feeds detectServerUrl ONLY the selected worktree's lines,
    // so a different worktree's URL in another partition can never bleed in here.
    const aLine = (seq: number, text: string): LogLine => ({
      worktreeId: '/a',
      seq,
      ts: 0,
      stream: 'stdout',
      level: 'info',
      text,
    });
    const aOnly = [aLine(0, 'VITE ready'), aLine(1, '  ➜  Local:   http://localhost:5174/')];
    expect(detectServerUrl(aOnly)).toBe('http://localhost:5174/');
  });
```

- [ ] **Step 2: Run test + typecheck to confirm the demux contract holds**

Run: `npx vitest run tests/renderer/detect-server-url.test.ts && npm run typecheck:web`
Expected: vitest PASS with the new case counted (11 tests); `typecheck:web` PASS. This is NOT a red→green TDD step — `detectServerUrl` already passes a one-worktree slice (its internals never changed), and `LogLine.worktreeId` already exists (optional, Task 1) so the inline `aLine` literal compiles. NOTE: do NOT expect `vitest run` to report a TYPE error if the field were missing — vitest type-erases via esbuild; the field's existence is a `typecheck:web` (TS2353) concern, already settled in Task 1. This task only ADDS a regression test pinning the per-worktree demux contract; the "failing-first" is structural (the test could not have existed before the `worktreeId` field).

- [ ] **Step 3: Write minimal implementation**

No production change. Confirm `src/renderer/lib/detect-server-url.ts` is byte-for-byte unchanged (its input is re-anchored by `useLogs(selectedId)` in Task 5a, not by this file).

- [ ] **Step 4: Run test + typecheck to verify it passes (both green)**

Run: `npx vitest run tests/renderer/detect-server-url.test.ts && npm run typecheck`
Expected: detect-server-url vitest PASS (11 tests); `typecheck:node` + `typecheck:web` BOTH PASS (test-only addition, no production signature moved).

- [ ] **Step 5: Commit**

```bash
git add tests/renderer/detect-server-url.test.ts
git commit -m "test(server): pin detectServerUrl per-worktree demux contract

Add a regression test proving detectServerUrl resolves the URL of the single
worktree slice it is fed (useLogs(worktreeId) does the demux upstream). No
production change to the pure detector.

Change-Track: Large"
```

---

## Task 6: CLEANUP — tighten the transient shim to REQUIRED + quit-sweep comment (D7)

This is the task that REMOVES the transient optionals introduced in Task 1, now that every producer stamps `worktreeId` (LogStore.push) and every producer/consumer passes it (ServerManager.stop, the renderer flip). Tightening `LogLine.worktreeId?` → required would TS2741 the un-touched `tests/renderer/log-filter.test.ts` literals (web graph), so this commit MUST also add `worktreeId` to those literals in lockstep — that is exactly the kind of cross-graph tighten that has to land as one coherent commit.

**Files:**
- Modify: `src/shared/types.ts` — tighten `LogLine.worktreeId?` → `readonly worktreeId: string`; tighten `StopServerRequest.worktreeId?` → `readonly worktreeId: string`.
- Modify: `tests/renderer/log-filter.test.ts` — add `worktreeId` to the 5 `LogLine` literals (web graph) so the required tighten compiles.
- Modify: `src/main/index.ts:61-64` (the QuitController `sweep`) — add the D7 comment.
- Modify: `src/main/ipc/register-ipc.ts:840-842` (the APP_QUIT_DECISION sweep) — add the D7 comment.

**Interfaces:**
- Consumes: every producer now stamps `worktreeId` (Task 2 `LogStore.push`) + passes it (Task 3 `stop`, Task 5 renderer); `ServerManager.dispose()` kills ALL (Task 3).
- Produces: `LogLine.worktreeId: string` (REQUIRED) + `StopServerRequest.worktreeId: string` (REQUIRED); the transient migration optionals are gone. The contract `status(worktreeId?)`/`snapshot(worktreeId?)` optional params MAY stay (no consumer relies on the no-arg form after the flip; tightening them is harmless cleanup if desired). Plus the D7 quit-sweep comment. No behavior change.

- [ ] **Step 1: Write the failing typecheck (the red gate is `npm run typecheck`)**

Tighten `src/shared/types.ts` FIRST (the smallest red-producing change). Change `LogLine.worktreeId?` to `readonly worktreeId: string` and `StopServerRequest.worktreeId?` to `readonly worktreeId: string`.

- [ ] **Step 2: Run the typecheck to verify it fails (TS2741, both graphs)**

Run: `npm run typecheck`
Expected: FAIL — `typecheck:web` TS2741 on `tests/renderer/log-filter.test.ts:6-10` (`Property 'worktreeId' is missing` on the 5 `LogLine` literals). Confirm there are NO other consumers still omitting `worktreeId` (if a producer surfaces, it was missed in Tasks 2/3/5 — fix it here). `vitest run` would NOT surface this (type-erased), so use `npm run typecheck` as the gate.

- [ ] **Step 3: Write minimal implementation**

In `tests/renderer/log-filter.test.ts`, add `worktreeId` to the 5 `LogLine` literals (lines 6-10). Each becomes e.g. `{ worktreeId: '/wt', seq: 0, ts: 0, stream: 'stdout', level: 'debug', text: 'starting up' }` (any stable id; `filterLogs` ignores it). The `worktreeId` value is irrelevant to these level/grep assertions — they remain UNCHANGED.

In `src/main/index.ts`, replace the `sweep` closure (lines 61-64):

```typescript
  sweep: () => {
    ctx.sessionManager?.killAll(); // orphan-claude prevention (binding invariant §7).
    // Servers are swept (dispose kills EVERY worktree child, no orphans) but
    // intentionally NOT quit-warned (D7): a dev server is trivially restarted,
    // unlike an in-flight agent turn. Only the agent-turn warning above gates quit.
    ctx.serverManager?.dispose();
  },
```

In `src/main/ipc/register-ipc.ts`, annotate the APP_QUIT_DECISION sweep (lines 840-842). Replace:

```typescript
      ctx.confirmedQuit = true;
      ctx.sessionManager?.killAll(); // PTY kill-sweep: no orphan claude survives.
      ctx.serverManager?.dispose(); // keep Plan 3's server cleanup.
      ctx.requestQuit?.(); // index.ts wires this to app.quit().
```

with:

```typescript
      ctx.confirmedQuit = true;
      ctx.sessionManager?.killAll(); // PTY kill-sweep: no orphan claude survives.
      // dispose() now kills EVERY worktree's server child (Map loop); servers are
      // swept on quit but never quit-warned (D7) — trivially restarted, unlike turns.
      ctx.serverManager?.dispose();
      ctx.requestQuit?.(); // index.ts wires this to app.quit().
```

- [ ] **Step 4: Run the gate to verify it passes (typecheck node+web AND full vitest, all green)**

Run: `npm run typecheck && npx vitest run`
Expected: `typecheck:node` + `typecheck:web` BOTH PASS — `LogLine.worktreeId` + `StopServerRequest.worktreeId` are now REQUIRED and every literal/call site supplies them (the `log-filter.test.ts` literals updated in lockstep; LogStore.push stamps it; ServerManager.stop reads `req.worktreeId`; the renderer passes it). Full Vitest suite PASS (the tightening is type-only; the added `worktreeId` on the log-filter literals doesn't change its level/grep assertions; the quit-sweep edit is comment-only). If `typecheck` still reports a missing `worktreeId` anywhere, a producer was missed upstream — fix it in this commit (the CLEANUP is the backstop).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts tests/renderer/log-filter.test.ts src/main/index.ts src/main/ipc/register-ipc.ts
git commit -m "refactor(server): tighten worktreeId to required + note D7 quit-sweep

Remove the migration shim: LogLine.worktreeId and StopServerRequest.worktreeId are
now REQUIRED (every producer stamps/passes it). Update the log-filter.test.ts
literals in lockstep. Add the D7 comment at both quit-sweep sites (servers are swept
by dispose() but intentionally not quit-warned — trivially restarted, unlike turns).

Change-Track: Large"
```

---

## Task 7: Full suite + documented two-worktree concurrent GUI smoke + strike backlog

**Files:**
- Create: `tests/smoke/parallel-server-smoke.md`
- Modify: `docs/V2-BACKLOG.md` (strike "병렬 서버")

**Interfaces:**
- Consumes: the whole migrated stack.
- Produces: a runnable manual GUI smoke + the backlog crossed off.

- [ ] **Step 1: Run the full suite + typecheck + build (the real gate)**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: typecheck (node+web) PASS; Vitest ALL suites PASS (log-store + server-manager + app-store + detect-server-url green; everything else untouched-green); build PASS.

- [ ] **Step 2: Write the smoke doc**

Create `tests/smoke/parallel-server-smoke.md`:

```markdown
# Parallel per-worktree dev servers — GUI smoke (V2)

Proves TWO worktrees each run their OWN dev server CONCURRENTLY, each pane shows its
OWN logs + URL, stopping one leaves the other running, and quit/dispose kills both.

## Setup
- Use the env command seam so no real gradle/npm server is needed. Pick a harmless
  line-emitting command that prints a distinct localhost URL, e.g. a tiny node
  one-liner per worktree. Set it once before launching:
  - `export MANGO_SERVER_CMD='node -e "let p=5173+Math.floor(Math.random()*2);console.log(`Local:   http://localhost:${p}/`);setInterval(()=>console.log(`tick ${p} `+Date.now()),1000)"'`
  - (The override is global, but each worktree spawns its OWN child + its OWN log
    partition, so the printed port still demuxes per pane. For a deterministic
    two-port demo, instead run the app from `npm run dev` and set a fixed port per
    worktree via a per-worktree `.env`/script if your runner reads one.)
- Launch: `npm run dev`. Select your git repo if prompted.
- Ensure at least TWO worktrees exist (create a second via the toolbar if needed):
  call them **WT-A** (primary/main) and **WT-B** (a feature branch).

## Steps
1. Select **WT-A** → click **Run**. Expect: ServerControls shows `server: running`;
   WT-A's sidebar row shows a colored ServerDot (running). The Browser tab auto-fills
   WT-A's `http://localhost:51xx/`.
2. Select **WT-B** → click **Run**. Expect: WT-B reaches `server: running` WITHOUT
   stopping WT-A. BOTH sidebar rows now show a running ServerDot SIMULTANEOUSLY.
3. With **WT-B** selected, open **Logs** + **Browser**. Expect: the log panel shows
   ONLY WT-B's lines (its `tick` cadence + its port); the Browser URL bar holds
   WT-B's URL — NOT WT-A's. Re-select **WT-A**: its pane shows WT-A's OWN logs + URL.
   (Per-worktree partition + renderer demux: no cross-bleed.)
4. With **WT-A** selected, click **Stop**. Expect: WT-A → `server: stopped`, its dot
   greys out, BUT **WT-B's** dot stays running and its server keeps ticking
   (selecting WT-B still streams its logs). Stopping one leaves the other running.
5. Restart **WT-A** (Run again) so BOTH are running. Quit the app (Cmd-Q). Expect:
   no quit-warning fires FOR THE SERVERS (D7 — agent-turn warning is separate); the
   before-quit sweep `dispose()` kills BOTH server children. Verify no orphan node
   processes survive (`ps aux | grep -F 'http://localhost'` shows none from the app).

## Pass criteria
- Two servers run concurrently (step 2), each pane is correctly demuxed (step 3),
  independent stop (step 4), and a clean two-child quit-sweep with no orphans + no
  server quit-warning (step 5).

## Known limitation (D4)
No port injection. We rely on the dev server's own auto-increment (Vite 5173→5174,
Next) so concurrent worktrees land on distinct ports, and per-worktree log detection
picks each ACTUAL printed port. A runner that does NOT auto-increment will collide on
a fixed port — that needs a user-set per-worktree PORT (out of scope here).
```

- [ ] **Step 3: Strike the backlog item**

In `docs/V2-BACKLOG.md`, under section `## D. 인프라`, replace the `병렬 서버` row:

Find:
```markdown
| **병렬 서버 (포트/DB 격리)** | L | Plan 3 | MVP가 "서버 한 번에 하나"로 의도적으로 피한 가장 어려운 부분. 포트/DB/미들웨어 격리 |
```

Replace with:
```markdown
| ~~**병렬 서버 (per-worktree 동시 서버)**~~ ✅ **완료(MVP)** | L | Plan 3 | 워크트리마다 자기 dev 서버를 동시 실행. ServerManager를 SessionManager 모델로 수렴(Map<worktreeId, RunningServer>, scoped replace + identity guard, killAll/dispose 전부 순회, LAST-live onIdle), LogStore를 per-worktree 파티션(Map, 5000줄 ring 각), LogLine.worktreeId 키스톤으로 snapshot/onLine/detect/렌더 리스트 demux. 포트/DB 격리는 미적용 — dev 서버 auto-increment(Vite 5173→5174)에 의존, per-worktree 로그 감지가 실제 포트 픽업(D4 한계: auto-increment 안 하는 러너는 사용자 지정 PORT 필요). 계획: docs/plans/2026-06-22-v2-parallel-servers.md |
```

Also update the `## 🎯 권장 진행 순서` line 4 if it lists `병렬 서버` as pending — change `**병렬 서버**` to `~~**병렬 서버**~~(완료)`:

Find (line 4 of the 권장 진행 순서):
```markdown
4. **턴 감지 → b-full** · ~~**멀티모델 팬아웃**~~(완료) · **병렬 서버** — 무겁고 재설계 필요, 명확한 수요 후
```
Replace with:
```markdown
4. **턴 감지 → b-full** · ~~**멀티모델 팬아웃**~~(완료) · ~~**병렬 서버**~~(완료) — 무겁고 재설계 필요, 명확한 수요 후
```

- [ ] **Step 4: Verify the suite is still green after doc edits**

Run: `npm run typecheck && npx vitest run`
Expected: PASS (doc-only edits; no code touched in this step).

- [ ] **Step 5: Commit**

```bash
git add tests/smoke/parallel-server-smoke.md docs/V2-BACKLOG.md
git commit -m "docs(server): add parallel-server smoke + strike backlog item

Document the two-worktree concurrent GUI smoke (each pane its own logs + URL,
independent stop, two-child quit-sweep, D4 port limitation) and mark 병렬 서버 done
in the V2 backlog.

Change-Track: Large"
```

---

## Migration Strategy — Branch by Abstraction + a transient additive/optional shim

**Why this approach (and the corrected premise):** this change touches 4 IPC layers (types/channels/contract, preload, register-ipc handlers) + 2 managers (LogStore, ServerManager) + several renderer files. The original premise — that the `LogLine.worktreeId` + status-map seam is "not additive" and that old singular tests "fail only at runtime" — is FALSE under this repo's tsconfigs: `tsc -p tsconfig.node.json --noEmit` COMPILES `tests/main/**` + `tests/helpers/**`, `tsc -p tsconfig.web.json --noEmit` COMPILES `tests/renderer/**`, and `src/shared/**` is in BOTH graphs. So a REQUIRED `LogLine.worktreeId` add breaks BOTH graphs at COMPILE time (e.g. `tests/renderer/log-filter.test.ts`'s 5 literals, `tests/main/server-manager.test.ts`'s `mgr.stop({})`), and `vitest run` (esbuild, type-erased) can NEVER be the red-gate for a type-only change. The fix is **Branch by Abstraction for the managers (a Map registry) + a thin TRANSIENT additive/optional shim on the shared-type & contract boundary** so `npm run typecheck` (node AND web) stays GREEN at every commit:

- `LogLine.worktreeId` lands **OPTIONAL** (Task 1); `LogStore.push` stamps it once partitioned (Task 2); the renderer reads it optional (Task 5a); the CLEANUP task (Task 6) tightens it to REQUIRED after every producer/consumer is migrated.
- `StopServerRequest.worktreeId` STAYS optional through migration (main `stop` reads it / returns a stopped snapshot if absent; the renderer passes it at the flip); CLEANUP makes it required.
- The renderer-facing contract gets an ADDED `statusAll()` (no conflict) and OPTIONAL `status(worktreeId?)`/`snapshot(worktreeId?)` params so the renderer's old no-arg calls keep compiling until the flip; CLEANUP may keep the optional params (harmless).
- Tests are **REWRITTEN IN LOCKSTEP** with the manager signature they cover (log-store.test.ts in Task 2, server-manager.test.ts in Task 3, app-store.test.ts in Task 5a) — never a half-migrated test left in either graph. Where a signature change ripples to a non-test consumer in the same graph (e.g. `register-ipc`'s `snapshot()`/`status()`/`hasLiveServer()`, or the web chain `aggregateStatus`→`use-worktree-status`→`App`→`useServer`), that consumer is folded into the SAME commit so the graph never goes red.

A Compatibility Layer would add throwaway dual APIs nobody keeps; Module-by-Module risks a half-migrated cross-contamination state (a partitioned LogStore feeding a singular ServerManager that resets the wrong partition). The shim is the minimal transient seam that keeps the build green per commit and is fully removed in CLEANUP.

**The 7 commits ARE the task spine; each is a `npm run typecheck`-green (node AND web) + targeted-vitest-green rollback point:**

1. **Type seam — ADDITIVE/OPTIONAL (Task 1)** — `LogLine.worktreeId?` (optional), `LogSnapshotRequest`, `SERVER_STATUS_ALL`, contract `statusAll()` + optional `status(worktreeId?)`/`snapshot(worktreeId?)`; `StopServerRequest.worktreeId` stays optional. OLD managers compile by threading the single run's worktreeId. **Red-gate:** `npm run typecheck:web` (TS2353 on the detect-server-url helper) — NOT vitest. **Rollback point:** `npm run typecheck` (node+web) green; `detect-server-url` vitest green. EVERY existing suite still COMPILES (that is the point of optional).
2. **Partition LogStore (Task 2)** — `Map<worktreeId, partition>`; `append/snapshot/reset/flush(worktreeId)` + `removeWorktree`; rewrite `log-store.test.ts` AND update `register-ipc`'s `LOG_SNAPSHOT` handler (now needs a worktreeId) in the SAME commit. **Rollback point:** `npx vitest run tests/main/log-store.test.ts` + `npm run typecheck` (node+web) green.
3. **Convert ServerManager to Map (Task 3)** — scoped replace, identity guard, `liveServerWorktreeIds`, gated `notifyIfServerIdle`, kill-ALL `dispose`, per-worktree `last` + `statusAll`. Rewrite `server-manager.test.ts` per-worktree AND reconcile `register-ipc`'s `SERVER_STATUS` (→ `status(req.worktreeId)`) + `SETTINGS_SET` guard (→ `liveServerWorktreeIds().length === 0`) in the SAME commit so the node graph stays green. **BEHAVIORAL PIVOT to true concurrency** (drop the global `replaceCurrent` kill). **Rollback point:** `npx vitest run tests/main/server-manager.test.ts tests/main/log-store.test.ts` + `npm run typecheck` (node+web) green.
4. **Add SERVER_STATUS_ALL handler — additive (Task 4)** — the new channel + preload forwarder; verify dispose sweep loops ALL. (STOP/STATUS/LOG_SNAPSHOT/guard already reconciled in Tasks 2-3.) **Rollback point:** `npm run typecheck` + full `npx vitest run` FULLY green. App is shippable-as-singular here (renderer still shows one via the optional no-arg contract).
5. **Flip renderer — ONE commit (Tasks 5a + 5c)** — Task 5a does the `aggregateStatus` map (TDD) AND `useServer` map + `useLogs(worktreeId)` + `useWorktreeStatus(map)` + App wiring + `ServerControls` per-selected + `log-panel` composite key in a SINGLE commit (the web chain is interdependent — splitting leaves `typecheck:web` red). Task 5c adds the `detectServerUrl` per-worktree demux regression test (standalone, no production change). **The ONLY visible-UX flip.** **Rollback point (5a):** `npm run typecheck:web && npm run build` + `app-store` vitest green; (5c): `detect-server-url` vitest + `npm run typecheck` green.
6. **CLEANUP — tighten the shim to REQUIRED + D7 comment (Task 6)** — `LogLine.worktreeId` + `StopServerRequest.worktreeId` → REQUIRED, update the `log-filter.test.ts` literals in lockstep, add the D7 quit-sweep comment. **Red-gate:** `npm run typecheck` (TS2741 on log-filter literals). **Rollback point:** `npm run typecheck` + full `npx vitest run` green; the transient optionals are gone.
7. **Full suite + smoke + backlog (Task 7)** — `npm run typecheck && npx vitest run && npm run build` all green; the two-worktree GUI smoke doc; strike 병렬 서버. **Rollback point:** full green.

**Boundary-coherence (each producer↔consumer pair changes in lockstep — pin in review):**
1. `LogLine.worktreeId` stamp in `LogStore.push` (Task 2) ↔ `useLogs(worktreeId)` filter (Task 5a) — explicit test: log-store "splits … + worktreeId".
2. per-worktree `seq===0` reset (Task 3 `logStore.reset(worktreeId)`) ↔ use-logs panel reset scoped to `line.worktreeId` (Task 5a) — explicit test: server-manager "resets ONLY that worktree LogStore seq".
3. `SERVER_STATE` `process.worktreeId` ↔ sidebar dots / `aggregateStatus` key by it; `STOPPED_IDLE` null is never a key (D8) — explicit test: app-store "each worktree its OWN server state".
4. `logs.snapshot(worktreeId)` handler (Task 2) ↔ BrowserPane URL detect per-worktree (Task 5a) + the demux regression (Task 5c) — explicit test: detect-server-url "detects the URL of the slice it is fed".
5. onIdle-on-LAST (Task 3 `notifyIfServerIdle`) ↔ deferred serverCommand clear ↔ SETTINGS_SET guard (SAME predicate `liveServerWorktreeIds().length === 0`, Task 3) — explicit test: server-manager "does NOT fire onIdle while another worktree server is still live" + "fires … on the LAST".
6. `dispose()` kill-ALL (Task 3) ↔ quit sweep call sites (Task 6 comment-only; correctness = loop all) — explicit test: server-manager "dispose() kills ALL running children".
7. `StopServerRequest.worktreeId` (optional in Task 1, REQUIRED in Task 6) ↔ main `stop(req.worktreeId)` (Task 3) ↔ renderer `stop({ worktreeId })` (Task 5a) — explicit test: server-manager "stop(req) kills only that worktree child".
8. `statusAll()` shape (Task 3 impl, Task 4 handler) ↔ `useServer` mount seed (Task 5a) — explicit test: server-manager "statusAll returns every worktree snapshot keyed by worktreeId".

**UNCHANGED subsystems (do NOT touch):** merge/diff/fanout/session (SessionManager is the model, untouched); `APP_OPEN_EXTERNAL`; detected-command + env-override hardening (`detectRunner`/`resolveCommands`); `buildServerEmitter`/`SERVER_STATE` mechanics (payload already carries `worktreeId` in `process`); `BrowserPane` internals (per-`selectedId` remount + sticky override); `ServerDot`/`WorktreeItem` gating (already N dots); `detectServerUrl` internals (only its INPUT becomes per-worktree filtered); single-instance ctx caching (`getServerManager`/`getLogStore` stay ONE lazy instance); `handleExit` identity-guard MECHANISM.

---

## Acceptance Checklist

- [ ] `LogLine` carries `worktreeId` (OPTIONAL Tasks 1-5, REQUIRED after Task 6); `StopServerRequest.worktreeId` (OPTIONAL Tasks 1-5, REQUIRED after Task 6); `LogSnapshotRequest` + `SERVER_STATUS_ALL` exist; the contract exposes `server.status(worktreeId?)`, `server.statusAll()`, `logs.snapshot(worktreeId?)`.
- [ ] `LogStore` partitions per worktree (Map, implicit-create), 5000-line ring EACH, `append/flush/snapshot/reset(worktreeId)` + `removeWorktree`; one worktree overflowing never evicts another.
- [ ] `ServerManager` runs ONE server PER worktree CONCURRENTLY: starting B does not kill A; restarting the SAME worktree kills only that child + resets only that log partition; `stop(worktreeId)` is scoped; `status(worktreeId)`/`statusAll()` work; `dispose()`/`killAll()` kill ALL; `onIdle` fires only on the LAST live server.
- [ ] IPC handlers read `worktreeId` (LOG_SNAPSHOT in Task 2; STATUS in Task 3; STOP forwards `req`; STATUS_ALL added in Task 4); the SETTINGS_SET serverCommand guard uses `liveServerWorktreeIds().length === 0` (Task 3); preload forwards `worktreeId` + exposes `statusAll()` (Task 1).
- [ ] Renderer (flipped in ONE commit, Task 5a): `useServer` holds a per-worktree map seeded by `statusAll()` + `onState` deltas; `useLogs(worktreeId)` demuxes by `line.worktreeId`; `aggregateStatus` takes the map; `ServerControls` binds the selected worktree; `log-panel` keys rows by `worktreeId:seq`; sidebar shows each worktree its own concurrent `ServerDot`; the browser pane URL + log panel are the selected worktree's slice.
- [ ] D7: servers are swept by `dispose()` on quit (no orphans) but NOT quit-warned; the `QuitController` agent-turn warning is unchanged; a comment documents this at both quit-sweep sites.
- [ ] **GREEN-PER-COMMIT:** `npm run typecheck` (node AND web) + the task's targeted vitest are green at EVERY task's commit (not just the final one); the transient `LogLine.worktreeId?`/`StopServerRequest.worktreeId?` optionals are tightened to required in Task 6.
- [ ] `npm run typecheck` + `npx vitest run` + `npm run build` all green at the final commit.
- [ ] `tests/smoke/parallel-server-smoke.md` exists and documents the two-worktree concurrent flow; `docs/V2-BACKLOG.md` strikes 병렬 서버.

## Self-Review

**1. Green-per-commit invariant (re-derived against the REAL tsconfigs):** Verified `tsconfig.node.json` includes `src/main`, `src/preload`, `src/shared`, `tests/main`, `tests/helpers`, `__mocks__`, configs; `tsconfig.web.json` includes `src/renderer`, `src/shared`, `src/preload/index.d.ts`, `tests/renderer`; `typecheck = typecheck:node && typecheck:web`; `test = vitest run` (esbuild, type-erased). Each task's commit passes `npm run typecheck` (BOTH graphs) + its targeted vitest:
  - T1 — green because `LogLine.worktreeId?` (optional) + optional contract params + additive `statusAll()` break NO existing literal/call site in either graph (confirmed consumers: `tests/renderer/log-filter.test.ts` 5 literals, `tests/main/server-manager.test.ts` `mgr.stop({})`, renderer no-arg `status()`/`snapshot()`); red-gate is `typecheck:web` (TS2353), not vitest.
  - T2 — `snapshot(worktreeId)` becomes required, so `register-ipc`'s `LOG_SNAPSHOT` is updated in the SAME commit; `log-store.test.ts` rewritten in the SAME commit; node+web green.
  - T3 — `status(worktreeId)`/`liveServerWorktreeIds` change, so `register-ipc`'s `SERVER_STATUS` + `SETTINGS_SET` guard are reconciled in the SAME commit; `server-manager.test.ts` rewritten in the SAME commit; node+web green.
  - T4 — purely additive channel; green.
  - T5a — the whole web chain (`aggregateStatus`→`use-worktree-status`→`App`→`useServer`/`useLogs`/`server-controls`/`log-panel`) flips in ONE commit so `typecheck:web` is never left red; `app-store.test.ts` rewritten (TDD) in the SAME commit; `npm run build` green.
  - T5c — test-only; green.
  - T6 — tightening to required is gated by `typecheck` (TS2741 on log-filter literals), fixed in the SAME commit; node+web green.
  - T7 — final full green.

**2. Spec coverage:** ServerManager Map + scoped replace + identity guard + liveServerWorktreeIds + gated onIdle + kill-ALL + per-worktree last + statusAll → Task 3; LogStore partition + append/flush/snapshot/reset(worktreeId) + removeWorktree + per-worktree cap + worktreeId stamp → Task 2; shared types/channels/contract (additive/optional) → Task 1; preload → Task 1; register-ipc LOG_SNAPSHOT → Task 2; register-ipc SERVER_STATUS + SETTINGS_SET guard → Task 3; SERVER_STATUS_ALL handler + dispose sweep verify → Task 4; renderer useServer/useLogs/aggregateStatus/App/ServerControls/log-panel → Task 5a; detect-server-url demux test → Task 5c; tighten-to-required CLEANUP + D7 comment → Task 6; full suite + smoke + backlog → Task 7. All 8 LOCKED DECISIONS resolved (D1 one instance/Map — Task 2; D2 status+statusAll — Tasks 1/3/4; D3 no concurrency cap, per-worktree ring — Tasks 2/3; D4 no port injection, documented — Task 3 doc + Task 7 smoke; D5 sidebar N dots / toolbar selected — Task 5a; D6 renderer-side demux — Task 5a; D7 no server quit-warning — Task 6; D8 absent=stopped, no null-key emit — Task 5a). The four explicitly-required tests exist: per-worktree seq/cap/reset (Task 2 "caps the ring PER worktree", "reset clears ONLY that worktree" + Task 3 "resets ONLY that worktree"), the `LogLine.worktreeId` stamp (Task 2 "splits … + worktreeId"), onIdle-on-LAST gating (Task 3 onIdle describe), dispose-kill-ALL (Task 3 "dispose() kills ALL").

**3. Placeholder scan:** No TBD/TODO/"similar to above"/"add error handling". Every code step shows COMPLETE code (full-file replacements for the rewritten managers/hooks/components; exact anchored edits for App.tsx/register-ipc/index.ts/log-panel.tsx). The one production no-op (detect-server-url Task 5c) is explicitly justified (its input is re-anchored upstream).

**4. Type/name consistency (incl. the optional→required transition):** `worktreeId?` is OPTIONAL on `LogLine` + `StopServerRequest` from Task 1 through Task 5, then tightened to REQUIRED `worktreeId: string` in Task 6 (every producer/consumer migrated by then; the log-filter.test.ts literals updated in lockstep so the tighten compiles). `LogSnapshotRequest.worktreeId` is required from the start (no old consumer). `ServerManager.liveServerWorktreeIds()` (NOT `hasLiveServer`) is the name used consistently in Task 3 (def + SETTINGS_SET guard reconcile). `notifyIfServerIdle()` gated on `liveServerWorktreeIds().length === 0` (Task 3). `statusAll(): Record<string, ServerStatus>` matches contract (Task 1) ↔ impl (Task 3) ↔ handler (Task 4) ↔ preload (Task 1) ↔ useServer `Object.entries(all)` (Task 5a). `LogStore.append(worktreeId, stream, chunk)` arity matches all call sites. `SERVER_STATUS_ALL` channel (Task 1) ↔ handler (Task 4) ↔ preload (Task 1) ↔ contract `statusAll` (Task 1). `aggregateStatus(worktrees, agentStatuses, servers: ReadonlyMap<string, ServerStatus>)` matches Task 5a def ↔ `useWorktreeStatus`/App callers (same commit). `ServerControls.onStop(worktreeId)` matches App's `(id) => stopServer(id)`. `useLogs(worktreeId: string | null)` matches App's `useLogs(selectedId)`. `log-panel.tsx` key fix uses the ACTUAL variable `l` (`key={\`${l.worktreeId}:${l.seq}\`}`), not `line`.

**5. CLEANUP removes the transient optionals:** Task 6 tightens `LogLine.worktreeId?` → `worktreeId: string` and `StopServerRequest.worktreeId?` → `worktreeId: string`, updating `tests/renderer/log-filter.test.ts` literals in the same commit so the required tighten is `typecheck`-green. The contract `status(worktreeId?)`/`snapshot(worktreeId?)` optional params are explicitly allowed to remain (no consumer relies on the no-arg form post-flip; keeping them is harmless). No transient optional survives un-noted.
