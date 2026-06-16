All design assumptions validated: `shell: true` runs a command string, line splitting with a carried partial buffer works, exit gives `(code, signal)`, and `pid` is a number. I now have everything to author the full plan.

# PLAN 3 — Local Server Start/Stop + Live Logs (MVP item 3)

> **For agentic workers: REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.**
> Execute each Task as an isolated unit: read the listed files, follow the numbered Steps top-to-bottom,
> run the stated verification command, and commit at the marked points. Do red→green→commit on every
> TDD task. Do NOT skip steps because a task "looks like a one-liner."

---

## Goal

Start/stop **ONE** local server for the active worktree, auto-detecting Spring Boot (gradlew) vs npm,
and stream its stdout/stderr into a live, filterable log panel. Run/Stop in the toolbar starts the
detected server (`./gradlew bootRun` or `npm run dev`/`npm start`) for the selected worktree; output
streams to the log panel with grep + level filtering; only one server runs at a time; the sidebar shows
the server state. Plan 3 does **not** implement merge (Plan 4) or session persistence (Plan 5).

## Architecture

Plan 3 mirrors Plan 2's proven seams exactly:

- **`ProcessRunner`** is the child-process analogue of Plan 2's `PtyFactory`. It is an injectable
  interface with a real implementation (`NodeProcessRunner`, `child_process.spawn` with piped
  stdout/stderr) and a **fake** (`tests/helpers/fake-runner.ts`, mirroring `fake-pty.ts`) so
  `ServerManager` is unit-testable without spawning a real gradle/npm server. The adapter normalizes
  onStdout/onStderr/onExit/kill/pid into a tiny `IProcLike` surface — exactly like `IPtyLike`.
- **`detect-runner.ts`** is a PURE function over the filesystem (`node:fs` read-only): it inspects a
  worktree dir and returns `{ kind, command }`. Unit-tested against temp fixture dirs.
- **`LogStore`** is an in-memory bounded ring buffer (cap 5000). It assigns a monotonic `seq` per run,
  does best-effort level parsing via regex, splits chunked stdout/stderr into lines (carrying partial
  lines across chunks), emits `LOG_LINE` through an injected emitter, and `snapshot()` returns the
  buffer. **No file persistence** for MVP — in-memory only (contract §3 keeps `src/shared` pure; a file
  sink is optional/deferred).
- **`ServerManager`** owns at most ONE child process (a single field, not a Map — contract invariant
  §6.5 "one server"). `start()` detects + spawns; if a server is already running it stops the old one
  first (replace-on-start), justified because the product runs exactly one server at a time and the
  toolbar Run for a new worktree must take over. Lifecycle: `stopped → starting → running →
  stopping → stopped|crashed`. cwd resolves via an injected `resolvePath` (backed by
  `WorktreeManager.list()`, identical to Plan 2). It emits `SERVER_STATE` via an injected emitter and
  forwards process output to the `LogStore`. It applies Plan 2's **identity discriminator** lesson:
  a replaced child's late exit must not emit a spurious `crashed`/state event for the new run.
- **Renderer**: `log-filter.ts` is a PURE function (case-insensitive grep substring + min-level
  ordering `error>warn>info>debug>raw`). `log-panel.tsx` renders a simple capped list (NO
  virtualization for MVP) with a grep input + level `<select>`, seeded from `logs.snapshot()` and kept
  live via `logs.onLine`. `use-server.ts` / `use-logs.ts` are the hooks. The toolbar gains Run/Stop for
  the selected worktree; the sidebar gains a server-state indicator. Existing
  Toolbar/WorktreeList/AgentTerminal/ping are preserved.

**Verification strategy** (matches Plan 0–2): pure logic + manager lifecycle + IPC delegation are
unit-tested with fakes (red→green→commit). The renderer log panel is verified by typecheck/lint/build
plus a **documented manual smoke** using a harmless line-emitting command (`commandOverride` /
env seam) — NO real gradle/npm and NO committed flaky e2e infra.

## Tech Stack

Electron 42 (main = ESM, `"type":"module"`), React 19, TypeScript 5.7 (strict, `any` banned),
`node:child_process` (real runner), `node:fs`/`node:path` (detect), Vitest 4 (node + jsdom projects).
Reuses the EXACT binding contract in `src/shared/` (types, channels, `MangoApi`) — nothing there
changes. Mirrors Plan 2's injectable-factory + injected-emitter pattern.

---

## File Structure

| File | New/Edit | Purpose |
|---|---|---|
| `src/main/util/detect-runner.ts` | **new** | PURE: dir → `{ kind, command }` (`ServerKind` + resolved command) |
| `src/main/proc/process-runner.ts` | **new** | `IProcLike` + `ProcessRunner` interface + `NodeProcessRunner` (child_process adapter) |
| `src/main/managers/log-store.ts` | **new** | Ring buffer + level parse + line splitter; emits `LOG_LINE` via injected emitter |
| `src/main/managers/server-manager.ts` | **new** | ONE server; detect+spawn, pipe→LogStore, emit `SERVER_STATE`; stop/killAll/dispose |
| `src/main/ipc/ipc-context.ts` | edit | Add optional `serverManager?` + `logStore?` to `IpcContext` |
| `src/main/ipc/register-ipc.ts` | edit | Wire `SERVER_START/STOP/STATUS` + `LOG_SNAPSHOT` (invoke); build server/log emitters + lazy managers |
| `src/main/index.ts` | edit | Add `before-quit` server kill-sweep (`serverManager.dispose()`) — orphan prevention |
| `src/preload/index.ts` | edit | Flip `server.start/stop/status` + `logs.snapshot` from `notYet('3')` to real invoke |
| `src/renderer/lib/log-filter.ts` | **new** | PURE: filter `LogLine[]` by grep + min level |
| `src/renderer/hooks/use-server.ts` | **new** | start/stop/status + `onState` subscription |
| `src/renderer/hooks/use-logs.ts` | **new** | seed from snapshot + `onLine` live append (capped) |
| `src/renderer/components/logs/log-panel.tsx` | **new** | live log list + grep input + level select |
| `src/renderer/components/toolbar/server-controls.tsx` | **new** | Run/Stop buttons bound to selected worktree |
| `src/renderer/components/sidebar/server-dot.tsx` | **new** | small server-state indicator for the sidebar |
| `src/renderer/App.tsx` | edit | Compose server controls + log panel + sidebar server state; keep existing UI |
| `tests/helpers/fake-runner.ts` | **new** | EventEmitter-backed fake implementing `IProcLike` (mirrors `fake-pty.ts`) |
| `tests/main/detect-runner.test.ts` | **new** | PURE detection against temp fixture dirs |
| `tests/main/log-store.test.ts` | **new** | ring buffer, level parse, chunk splitting |
| `tests/main/server-manager.test.ts` | **new** | lifecycle + replace + pipe-to-LogStore + state events |
| `tests/main/ipc-roundtrip.test.ts` | edit | Add a `describe('registerIpc — server')` block |
| `tests/renderer/log-filter.test.ts` | **new** | PURE filter logic |

---

## Tasks

### Task 1 — `detect-runner.ts` (PURE detection) — TDD

**Files:** `src/main/util/detect-runner.ts` (new), `tests/main/detect-runner.test.ts` (new).

**Design decisions (state in code comments):**
- **Precedence:** `spring-gradle` is checked FIRST (a repo can have both gradlew and a tooling
  `package.json`; the server we run is Spring). Rule: `gradlew` AND (`build.gradle` OR `build.gradle.kts`)
  ⇒ `spring-gradle`, command `'./gradlew bootRun'`.
- Else if `package.json` exists with a string `scripts.dev` ⇒ `npm`, command `'npm run dev'`;
  else string `scripts.start` ⇒ `npm`, command `'npm start'` (dev preferred over start).
- Else ⇒ `unknown`, `command: undefined`.
- PURE over a tiny injectable `FsReader` (`exists` + `readFile`) defaulting to `node:fs` read-only —
  so tests can run against either temp dirs or an injected fake. Never throws on bad JSON (treated as
  no scripts).

**Steps:**

1. Create `tests/main/detect-runner.test.ts`. RED — write tests using a real temp dir
   (`node:os.tmpdir()` + `node:fs`), created in `beforeEach`, removed in `afterEach`:

   ```ts
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { detectRunner } from '../../src/main/util/detect-runner';

   let dir: string;
   beforeEach(() => {
     dir = mkdtempSync(join(tmpdir(), 'mango-detect-'));
   });
   afterEach(() => {
     rmSync(dir, { recursive: true, force: true });
   });

   describe('detectRunner', () => {
     it('detects spring-gradle when gradlew + build.gradle exist', () => {
       writeFileSync(join(dir, 'gradlew'), '#!/bin/sh\n');
       writeFileSync(join(dir, 'build.gradle'), 'plugins {}\n');
       expect(detectRunner(dir)).toEqual({ kind: 'spring-gradle', command: './gradlew bootRun' });
     });

     it('detects spring-gradle with the kotlin build script (build.gradle.kts)', () => {
       writeFileSync(join(dir, 'gradlew'), '');
       writeFileSync(join(dir, 'build.gradle.kts'), '');
       expect(detectRunner(dir).kind).toBe('spring-gradle');
     });

     it('does NOT detect spring-gradle when gradlew is missing', () => {
       writeFileSync(join(dir, 'build.gradle'), '');
       expect(detectRunner(dir).kind).toBe('unknown');
     });

     it('prefers spring-gradle over npm when both are present', () => {
       writeFileSync(join(dir, 'gradlew'), '');
       writeFileSync(join(dir, 'build.gradle'), '');
       writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
       expect(detectRunner(dir).kind).toBe('spring-gradle');
     });

     it('detects npm with a dev script (npm run dev)', () => {
       writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
       expect(detectRunner(dir)).toEqual({ kind: 'npm', command: 'npm run dev' });
     });

     it('falls back to npm start when there is no dev script', () => {
       writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node .' } }));
       expect(detectRunner(dir)).toEqual({ kind: 'npm', command: 'npm start' });
     });

     it('prefers dev over start when both scripts exist', () => {
       writeFileSync(
         join(dir, 'package.json'),
         JSON.stringify({ scripts: { dev: 'vite', start: 'node .' } }),
       );
       expect(detectRunner(dir).command).toBe('npm run dev');
     });

     it('returns unknown for a package.json with no runnable script', () => {
       writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
       expect(detectRunner(dir)).toEqual({ kind: 'unknown', command: undefined });
     });

     it('returns unknown (no throw) for malformed package.json', () => {
       writeFileSync(join(dir, 'package.json'), '{ not json');
       expect(detectRunner(dir).kind).toBe('unknown');
     });

     it('returns unknown for an empty dir', () => {
       expect(detectRunner(dir)).toEqual({ kind: 'unknown', command: undefined });
     });
   });
   ```

2. Run `npx vitest run tests/main/detect-runner.test.ts` → confirm RED (module not found).

3. Create `src/main/util/detect-runner.ts` GREEN:

   ```ts
   import { existsSync, readFileSync } from 'node:fs';
   import { join } from 'node:path';
   import type { ServerKind } from '../../shared/types';

   /** Result of inspecting a worktree dir for a runnable local server. */
   export interface DetectedRunner {
     readonly kind: ServerKind;
     /** Resolved command line to spawn (shell string), or undefined when unknown. */
     readonly command?: string;
   }

   /** Minimal read-only fs surface so detection is injectable in tests. */
   export interface FsReader {
     exists(path: string): boolean;
     readText(path: string): string;
   }

   const NODE_FS_READER: FsReader = {
     exists: (p) => existsSync(p),
     readText: (p) => readFileSync(p, 'utf8'),
   };

   /**
    * PURE: inspects a worktree dir and decides which local server (if any) to run.
    *
    * Precedence (Spring wins — a repo may carry a tooling package.json alongside a
    * gradle server, but the server we boot is Spring):
    *   1. gradlew AND (build.gradle | build.gradle.kts) => spring-gradle, './gradlew bootRun'
    *   2. package.json with scripts.dev   => npm, 'npm run dev'
    *   3. package.json with scripts.start => npm, 'npm start'
    *   4. otherwise                       => unknown (no command)
    * Never throws: malformed package.json is treated as "no scripts".
    */
   export function detectRunner(dir: string, fs: FsReader = NODE_FS_READER): DetectedRunner {
     const has = (file: string): boolean => fs.exists(join(dir, file));

     if (has('gradlew') && (has('build.gradle') || has('build.gradle.kts'))) {
       return { kind: 'spring-gradle', command: './gradlew bootRun' };
     }

     if (has('package.json')) {
       const scripts = readScripts(fs, join(dir, 'package.json'));
       if (typeof scripts.dev === 'string') return { kind: 'npm', command: 'npm run dev' };
       if (typeof scripts.start === 'string') return { kind: 'npm', command: 'npm start' };
     }

     return { kind: 'unknown', command: undefined };
   }

   /** Reads package.json scripts; returns {} on any read/parse error (best-effort). */
   function readScripts(fs: FsReader, pkgPath: string): Record<string, unknown> {
     try {
       const parsed: unknown = JSON.parse(fs.readText(pkgPath));
       if (parsed && typeof parsed === 'object' && 'scripts' in parsed) {
         const s = (parsed as { scripts?: unknown }).scripts;
         if (s && typeof s === 'object') return s as Record<string, unknown>;
       }
     } catch {
       // Malformed package.json => behave as if no scripts. (No empty-catch lint:
       // the comment + fallthrough are intentional.)
       return {};
     }
     return {};
   }
   ```

4. Run `npx vitest run tests/main/detect-runner.test.ts` → GREEN.

5. `npm run lint && npm run typecheck:node`. **Commit:** `test: detect-runner pure server detection (Plan 3)`.

---

### Task 2 — `ProcessRunner` seam + `fake-runner.ts` helper

**Files:** `src/main/proc/process-runner.ts` (new), `tests/helpers/fake-runner.ts` (new).

**Design (mirror `pty-factory.ts` + `fake-pty.ts`):** `IProcLike` is the minimal surface
`ServerManager` depends on; `ProcessRunner.spawn(command, opts)` returns one. The command is a **shell
string** (e.g. `'./gradlew bootRun'`), so `NodeProcessRunner` uses `child_process.spawn(command, {
shell: true, cwd })` with piped stdio. Callbacks (not disposables) match Plan 2's adapter shape.

**Steps:**

1. Create `src/main/proc/process-runner.ts`:

   ```ts
   import { spawn } from 'node:child_process';

   /** Exit payload shared by child_process and the test fake. */
   export interface ProcExitEvent {
     readonly code: number | null;
     readonly signal: string | null;
   }

   /** Options forwarded to the runner (subset we use). */
   export interface ProcSpawnOptions {
     readonly cwd: string;
     readonly env?: NodeJS.ProcessEnv;
   }

   /**
    * Minimal child-process surface ServerManager depends on. Callback-shaped on
    * purpose (mirrors IPtyLike): the real adapter wires Node streams down to these
    * callbacks so the SAME ServerManager runs against the real runner and the fake.
    */
   export interface IProcLike {
     readonly pid: number | undefined;
     /** Best-effort terminate (SIGTERM by default). */
     kill(signal?: NodeJS.Signals): void;
     onStdout(cb: (chunk: string) => void): void;
     onStderr(cb: (chunk: string) => void): void;
     onExit(cb: (e: ProcExitEvent) => void): void;
   }

   /** Factory abstraction so ServerManager is unit-testable with a fake runner. */
   export interface ProcessRunner {
     /** Spawns `command` as a shell line in opts.cwd with piped stdout/stderr. */
     spawn(command: string, opts: ProcSpawnOptions): IProcLike;
   }

   /**
    * Production ProcessRunner over node:child_process. shell:true lets us run a
    * command STRING ('./gradlew bootRun', 'npm run dev'); stdout/stderr are piped
    * and adapted to string callbacks. Servers are non-interactive — we capture
    * output, we do NOT allocate a PTY (that is Plan 2's interactive agent).
    */
   export class NodeProcessRunner implements ProcessRunner {
     spawn(command: string, opts: ProcSpawnOptions): IProcLike {
       const child = spawn(command, {
         shell: true,
         cwd: opts.cwd,
         env: opts.env ?? process.env,
         stdio: ['ignore', 'pipe', 'pipe'],
       });
       child.stdout?.setEncoding('utf8');
       child.stderr?.setEncoding('utf8');
       return {
         pid: child.pid,
         kill: (signal) => void child.kill(signal ?? 'SIGTERM'),
         onStdout: (cb) => void child.stdout?.on('data', (c: string) => cb(c)),
         onStderr: (cb) => void child.stderr?.on('data', (c: string) => cb(c)),
         onExit: (cb) => void child.on('exit', (code, signal) => cb({ code, signal })),
       };
     }
   }
   ```

2. Create `tests/helpers/fake-runner.ts` (mirror `fake-pty.ts`):

   ```ts
   import { EventEmitter } from 'node:events';
   import type { IProcLike } from '../../src/main/proc/process-runner';

   /** Fake IProcLike driven from tests (mirrors FakePtyHandle). */
   export interface FakeProcHandle extends IProcLike {
     emitStdout(chunk: string): void;
     emitStderr(chunk: string): void;
     /** Simulate the child exiting (no-op once killed/exited). */
     emitExit(code: number | null, signal?: string | null): void;
     /** True once kill() was called. */
     readonly killed: () => boolean;
   }

   /** Builds an EventEmitter-backed fake child process for windowless tests. */
   export function makeFakeRunner(pid = 5252): FakeProcHandle {
     const bus = new EventEmitter();
     let done = false;
     return {
       pid,
       kill: () => {
         if (done) return;
         done = true;
         bus.emit('exit', { code: null, signal: 'SIGTERM' });
       },
       onStdout: (cb) => void bus.on('stdout', cb),
       onStderr: (cb) => void bus.on('stderr', cb),
       onExit: (cb) => void bus.on('exit', cb),
       emitStdout: (chunk) => bus.emit('stdout', chunk),
       emitStderr: (chunk) => bus.emit('stderr', chunk),
       emitExit: (code, signal = null) => {
         if (done) return;
         done = true;
         bus.emit('exit', { code, signal });
       },
       killed: () => done,
     };
   }
   ```

3. `npm run lint && npm run typecheck:node` (no runtime test yet; exercised by Tasks 3–4).
   **Commit:** `feat: ProcessRunner seam + fake-runner helper (Plan 3)`.

---

### Task 3 — `LogStore` (ring buffer + level parse + line split) — TDD

**Files:** `src/main/managers/log-store.ts` (new), `tests/main/log-store.test.ts` (new).

**Design decisions:**
- **Cap 5000.** On overflow the oldest line is dropped (FIFO). `snapshot()` returns a copy of the
  current buffer (newest at the end).
- **`seq` is monotonic per run.** `reset()` (called by ServerManager at each `start`) clears the buffer,
  the partial-line carry, and resets `seq` to 0. This satisfies the binding "sequence number within the
  current server run."
- **Level parse (best-effort, anchored to the head of the trimmed line):** regex
  `/\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i` matched against the line; first match maps
  `ERROR→error`, `WARN/WARNING→warn`, `INFO→info`, `DEBUG/TRACE→debug`; no match ⇒ `raw`. stderr with no
  recognizable level defaults to `error` (servers print stack traces to stderr without a level token).
- **Line splitting:** `append(stream, chunk)` concatenates onto a per-stream carry buffer, splits on
  `\n` (stripping a trailing `\r`), emits one `LogLine` per complete line, and keeps the trailing
  partial. `flush()` emits any remaining partials (called on process exit so a final unterminated line
  is not lost). Empty lines are kept (they are real output) but `\r`-only is trimmed.
- Emits each `LogLine` through an injected `LogEmitter` (so tests spy; prod forwards to `LOG_LINE`).

**Steps:**

1. Create `tests/main/log-store.test.ts` RED:

   ```ts
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
       store.append('stdout', 'a\nb\nc\n');
       expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
       expect(lines.map((l) => l.seq)).toEqual([0, 1, 2]);
     });

     it('carries a partial line across chunks', () => {
       const { store, lines } = makeStore();
       store.append('stdout', 'hel');
       store.append('stdout', 'lo\nworld');
       expect(lines.map((l) => l.text)).toEqual(['hello']);
       store.flush();
       expect(lines.map((l) => l.text)).toEqual(['hello', 'world']);
     });

     it('strips a trailing CR (\\r\\n line endings)', () => {
       const { store, lines } = makeStore();
       store.append('stderr', 'oops\r\n');
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
       store.append('stdout', text + '\n');
       expect(lines[0].level).toBe(level);
     });

     it('defaults stderr with no level token to error', () => {
       const { store, lines } = makeStore();
       store.append('stderr', '\tat com.x.Foo(Foo.java:1)\n');
       expect(lines[0].level).toBe('error');
     });
   });

   describe('LogStore ring buffer', () => {
     it('snapshot returns appended lines (newest last)', () => {
       const { store } = makeStore();
       store.append('stdout', 'one\ntwo\n');
       expect(store.snapshot().map((l) => l.text)).toEqual(['one', 'two']);
     });

     it('drops oldest lines past the cap but keeps monotonic seq', () => {
       const { store } = makeStore(3);
       store.append('stdout', 'a\nb\nc\nd\ne\n');
       const snap = store.snapshot();
       expect(snap.map((l) => l.text)).toEqual(['c', 'd', 'e']);
       expect(snap.map((l) => l.seq)).toEqual([2, 3, 4]);
     });

     it('reset clears the buffer, the partial carry, and the seq counter', () => {
       const { store } = makeStore();
       store.append('stdout', 'a\npartial');
       store.reset();
       expect(store.snapshot()).toEqual([]);
       store.append('stdout', 'fresh\n');
       expect(store.snapshot()[0].seq).toBe(0);
       expect(store.snapshot()[0].text).toBe('fresh');
     });
   });
   ```

2. `npx vitest run tests/main/log-store.test.ts` → RED.

3. Create `src/main/managers/log-store.ts` GREEN:

   ```ts
   import type { LogLine } from '../../shared/types';

   /** Where LogStore publishes each line (injected, so tests spy / prod -> LOG_LINE). */
   export interface LogEmitter {
     emitLine(line: LogLine): void;
   }

   const DEFAULT_CAP = 5000;

   /** Head-anchored, best-effort level token regex (Spring/Logback/npm friendly). */
   const LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

   /**
    * In-memory bounded ring buffer of LogLine for ONE server run. Splits chunked
    * stdout/stderr into lines (carrying partials across chunks), best-effort parses
    * a level, assigns a monotonic per-run seq, drops oldest past the cap, and emits
    * every line via the injected LogEmitter. No file persistence in MVP — in-memory
    * only (keeps src/shared pure; a file sink is optional/deferred to a later plan).
    */
   export class LogStore {
     private readonly emitter: LogEmitter;
     private readonly cap: number;
     private buffer: LogLine[] = [];
     private seq = 0;
     private carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

     constructor(emitter: LogEmitter, cap: number = DEFAULT_CAP) {
       this.emitter = emitter;
       this.cap = cap;
     }

     /** Feeds a raw chunk; emits a LogLine for every COMPLETE line in it. */
     append(stream: 'stdout' | 'stderr', chunk: string): void {
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
     reset(): void {
       this.buffer = [];
       this.seq = 0;
       this.carry = { stdout: '', stderr: '' };
     }

     private push(stream: 'stdout' | 'stderr', text: string): void {
       const line: LogLine = {
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

4. `npx vitest run tests/main/log-store.test.ts` → GREEN.

5. `npm run lint && npm run typecheck:node`. **Commit:** `feat: LogStore ring buffer + level parse (Plan 3)`.

---

### Task 4 — `ServerManager` (ONE server, lifecycle, replace, pipe→LogStore) — TDD

**Files:** `src/main/managers/server-manager.ts` (new), `tests/main/server-manager.test.ts` (new).

**Design decisions:**
- **Single field** `current: RunningServer | null` (NOT a Map — contract §6.5).
- **start(req):** (1) if a server is running, stop it first (replace). (2) `reset()` the LogStore.
  (3) resolve cwd via `resolvePath`; if unknown ⇒ emit `crashed` with an error log line and return its
  status (do NOT spawn). (4) detect via injected `detect` (default `detectRunner`); if `unknown` and no
  `commandOverride` ⇒ emit `crashed` + a log line "no runnable server detected" and return. (5) the
  command is `req.commandOverride ?? this.commandOverride ?? detected.command` — the **env/override seam**
  so a smoke can run a harmless line-emitting command without a real server. (6) emit `starting`, spawn,
  wire stdout/stderr→LogStore, wire exit; emit `running` with pid + startedAt.
- **Lifecycle + state:** `stopped → starting → running → stopping → stopped|crashed`. A natural exit
  with code 0 while we did not request stop ⇒ `stopped`; non-zero (or signal) while not stopping ⇒
  `crashed`. Exit during an explicit `stop()` ⇒ `stopped`.
- **Identity discriminator (Plan 2 lesson):** each `RunningServer` carries a unique token; the exit
  handler ignores the event if `this.current !== thisServer` (a replaced/old child must not flip the
  new run's state). On replace, the old server is unmapped (`this.current = null`) BEFORE `kill()`.
- **stop(req):** marks `stopping`, kills; idempotent (no current ⇒ return the current `stopped`
  snapshot). **killAll()/dispose()** kill the child for the before-quit sweep.
- **Emits `SERVER_STATE`** (a full `ServerStatus`) through an injected `ServerEmitter`. `status()`
  returns the current `ServerStatus` (a `stopped`/`unknown`/`null`-worktree snapshot when idle).

**Steps:**

1. Create `tests/main/server-manager.test.ts` RED:

   ```ts
   import { describe, it, expect, vi } from 'vitest';
   import { ServerManager, type ServerEmitter } from '../../src/main/managers/server-manager';
   import { LogStore, type LogEmitter } from '../../src/main/managers/log-store';
   import type { ProcessRunner, IProcLike } from '../../src/main/proc/process-runner';
   import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';
   import type { ServerStatus, LogLine } from '../../src/shared/types';
   import type { DetectedRunner } from '../../src/main/util/detect-runner';

   const WT = '/repo/.worktrees/feat';

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
     };
     return { runner, calls };
   }

   function makeManager(opts: {
     fakes: FakeProcHandle[];
     detect?: (dir: string) => DetectedRunner;
     resolvePath?: (id: string) => Promise<string | undefined>;
     commandOverride?: string;
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
     });
     return { mgr, states, logLines, calls, logStore };
   }

   describe('ServerManager.start', () => {
     it('detects + spawns in the worktree cwd and reaches running', async () => {
       const fake = makeFakeRunner(111);
       const { mgr, states, calls } = makeManager({ fakes: [fake] });
       const status = await mgr.start({ worktreeId: WT });
       expect(calls).toEqual([{ command: 'npm run dev', cwd: WT }]);
       expect(status.process.state).toBe('running');
       expect(status.process.pid).toBe(111);
       expect(status.process.kind).toBe('npm');
       expect(status.process.worktreeId).toBe(WT);
       expect(states.map((s) => s.process.state)).toEqual(['starting', 'running']);
     });

     it('uses commandOverride from the request over detection', async () => {
       const fake = makeFakeRunner();
       const { mgr, calls } = makeManager({ fakes: [fake] });
       await mgr.start({ worktreeId: WT, commandOverride: 'node fake-server.js' });
       expect(calls[0].command).toBe('node fake-server.js');
     });

     it('pipes stdout/stderr into the LogStore', async () => {
       const fake = makeFakeRunner();
       const { mgr, logLines } = makeManager({ fakes: [fake] });
       await mgr.start({ worktreeId: WT });
       fake.emitStdout('INFO up\n');
       fake.emitStderr('ERROR boom\n');
       expect(logLines.map((l) => [l.stream, l.level, l.text])).toEqual([
         ['stdout', 'info', 'INFO up'],
         ['stderr', 'error', 'ERROR boom'],
       ]);
     });

     it('resets the LogStore seq on each start', async () => {
       const a = makeFakeRunner(1);
       const b = makeFakeRunner(2);
       const { mgr, logStore } = makeManager({ fakes: [a, b] });
       await mgr.start({ worktreeId: WT });
       a.emitStdout('first\n');
       await mgr.start({ worktreeId: WT }); // replace -> reset
       b.emitStdout('second\n');
       expect(logStore.snapshot().map((l) => [l.seq, l.text])).toEqual([[0, 'second']]);
     });

     it('crashes (no spawn) when the worktree id is unknown', async () => {
       const { mgr, states, calls } = makeManager({
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
       const status = await mgr.start({ worktreeId: WT });
       expect(calls).toHaveLength(0);
       expect(status.process.state).toBe('crashed');
     });

     it('replaces a running server when start is called again (kills the old child)', async () => {
       const first = makeFakeRunner(1);
       const second = makeFakeRunner(2);
       const { mgr, calls } = makeManager({ fakes: [first, second] });
       await mgr.start({ worktreeId: WT });
       const status = await mgr.start({ worktreeId: '/repo/.worktrees/other' });
       expect(first.killed()).toBe(true);
       expect(calls).toHaveLength(2);
       expect(status.process.pid).toBe(2);
       expect(status.process.worktreeId).toBe('/repo/.worktrees/other');
     });

     it('does NOT emit a crashed state for a server replaced by start (stale exit)', async () => {
       const first = makeFakeRunner(1);
       const second = makeFakeRunner(2);
       const { mgr, states } = makeManager({ fakes: [first, second] });
       await mgr.start({ worktreeId: WT });
       await mgr.start({ worktreeId: WT }); // replace; first's kill fires a stale exit
       // last state must be the NEW run's running, never a stale crashed.
       expect(states.at(-1)?.process.state).toBe('running');
       expect(states.some((s) => s.process.state === 'crashed')).toBe(false);
     });
   });

   describe('ServerManager exit + stop', () => {
     it('marks crashed on a non-zero natural exit', async () => {
       const fake = makeFakeRunner();
       const { mgr, states } = makeManager({ fakes: [fake] });
       await mgr.start({ worktreeId: WT });
       fake.emitExit(1, null);
       expect(states.at(-1)?.process.state).toBe('crashed');
       expect(states.at(-1)?.process.exitCode).toBe(1);
     });

     it('marks stopped on a clean (code 0) natural exit', async () => {
       const fake = makeFakeRunner();
       const { mgr, states } = makeManager({ fakes: [fake] });
       await mgr.start({ worktreeId: WT });
       fake.emitExit(0, null);
       expect(states.at(-1)?.process.state).toBe('stopped');
     });

     it('stop() kills the child and ends at stopped', async () => {
       const fake = makeFakeRunner();
       const { mgr, states } = makeManager({ fakes: [fake] });
       await mgr.start({ worktreeId: WT });
       const status = await mgr.stop({});
       expect(fake.killed()).toBe(true);
       expect(status.process.state).toBe('stopped');
       expect(states.at(-1)?.process.state).toBe('stopped');
     });

     it('stop() with no running server returns a stopped snapshot (idempotent)', async () => {
       const { mgr } = makeManager({ fakes: [] });
       const status = await mgr.stop({});
       expect(status.process.state).toBe('stopped');
       expect(status.process.worktreeId).toBeNull();
     });

     it('status() reflects the current server', async () => {
       const fake = makeFakeRunner(7);
       const { mgr } = makeManager({ fakes: [fake] });
       expect(mgr.status().process.state).toBe('stopped');
       await mgr.start({ worktreeId: WT });
       expect(mgr.status().process.state).toBe('running');
       expect(mgr.status().process.pid).toBe(7);
     });

     it('dispose() kills any running child (before-quit sweep)', async () => {
       const fake = makeFakeRunner();
       const { mgr } = makeManager({ fakes: [fake] });
       await mgr.start({ worktreeId: WT });
       mgr.dispose();
       expect(fake.killed()).toBe(true);
     });
   });
   ```

   > Note: the test imports only published types (`ServerStatus`, `LogLine` from the contract;
   > `DetectedRunner` from `detect-runner`). Do not add any `DetectedRunnerLike` import — no such type exists.

2. `npx vitest run tests/main/server-manager.test.ts` → RED.

3. Create `src/main/managers/server-manager.ts` GREEN:

   ```ts
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

   /** Where ServerManager publishes the single-server state (injected for tests). */
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
     /** Global command override (env seam for the smoke); request override wins. */
     readonly commandOverride?: string;
   }

   /** Internal bookkeeping for the ONE running child. */
   interface RunningServer {
     /** Identity token: the exit handler ignores events from a replaced server. */
     readonly token: object;
     readonly proc: IProcLike;
     readonly worktreeId: string;
     readonly kind: ServerKind;
     readonly command: string;
     readonly startedAt: number;
     /** True once we requested stop (so a following exit reads as 'stopped'). */
     stopping: boolean;
   }

   /**
    * Owns AT MOST ONE local server (contract §6.5). start() detects + spawns the
    * detected/overridden command in the worktree cwd, pipes stdout/stderr into the
    * LogStore, and publishes ServerStatus via the injected emitter. A second start
    * replaces the running server (the product runs exactly one server). Mirrors the
    * Plan-2 identity discriminator so a replaced child's late exit never flips the
    * new run's state. dispose() is the before-quit kill-sweep hook.
    */
   export class ServerManager {
     private readonly runner: ProcessRunner;
     private readonly logStore: LogStore;
     private readonly emitter: ServerEmitter;
     private readonly detect: (dir: string) => DetectedRunner;
     private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
     private readonly commandOverride?: string;
     private current: RunningServer | null = null;
     /** Last process snapshot (so status()/stop() report something when idle). */
     private last: ServerProcess = STOPPED_IDLE;

     constructor(deps: ServerManagerDeps) {
       this.runner = deps.runner;
       this.logStore = deps.logStore;
       this.emitter = deps.emitter;
       this.detect = deps.detect ?? detectRunner;
       this.resolvePath = deps.resolvePath;
       this.commandOverride = deps.commandOverride;
     }

     /** Starts (replacing any running server) the detected/overridden command. */
     async start(req: StartServerRequest): Promise<ServerStatus> {
       this.replaceCurrent(); // stop any existing server first (one at a time)
       this.logStore.reset();

       const cwd = await this.resolvePath(req.worktreeId);
       if (!cwd) {
         return this.crash(req.worktreeId, 'unknown', undefined, `unknown worktree ${req.worktreeId}`);
       }

       const detected = this.detect(cwd);
       const command = req.commandOverride ?? this.commandOverride ?? detected.command;
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
         token: {},
         proc,
         worktreeId: req.worktreeId,
         kind: detected.kind,
         command,
         startedAt: Date.now(),
         stopping: false,
       };
       this.current = server;

       proc.onStdout((chunk) => this.logStore.append('stdout', chunk));
       proc.onStderr((chunk) => this.logStore.append('stderr', chunk));
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

     /** Stops the running server (idempotent). */
     async stop(_req: StopServerRequest): Promise<ServerStatus> {
       const server = this.current;
       if (!server) return { process: this.last };
       server.stopping = true;
       this.current = null;
       this.emitState({
         worktreeId: server.worktreeId,
         kind: server.kind,
         state: 'stopping',
         pid: server.proc.pid,
         command: server.command,
         startedAt: server.startedAt,
       });
       server.proc.kill();
       this.logStore.flush();
       return this.emitState({
         worktreeId: server.worktreeId,
         kind: server.kind,
         state: 'stopped',
         command: server.command,
         exitCode: null,
       });
     }

     /** Current single-server snapshot. */
     status(): ServerStatus {
       return { process: this.last };
     }

     /** Kills the running child (before-quit sweep). */
     killAll(): void {
       const server = this.current;
       this.current = null;
       if (server) server.proc.kill();
     }

     /** Alias for killAll for a future disposer. */
     dispose(): void {
       this.killAll();
     }

     /** Stops the current server (used by start's replace), unmapping BEFORE kill. */
     private replaceCurrent(): void {
       const server = this.current;
       if (!server) return;
       this.current = null; // unmap first so its exit is recognized as stale
       server.stopping = true;
       server.proc.kill();
     }

     private handleExit(server: RunningServer, code: number | null, _signal: string | null): void {
       // Stale-exit guard: only the CURRENT server may flip state. A replaced child
       // (this.current already advanced) is swallowed — Plan 2's identity lesson.
       if (this.current !== server) return;
       this.current = null;
       this.logStore.flush();
       // Clean stop = we asked it to stop (kill) OR it exited 0; anything else is a crash.
       const stoppedCleanly = server.stopping || code === 0;
       this.emitState({
         worktreeId: server.worktreeId,
         kind: server.kind,
         state: stoppedCleanly ? 'stopped' : 'crashed',
         command: server.command,
         exitCode: code,
       });
     }

     private crash(
       worktreeId: string,
       kind: ServerKind,
       pid: number | undefined,
       message: string,
     ): ServerStatus {
       this.logStore.append('stderr', `[mango] ${message}\n`);
       this.logStore.flush();
       return this.emitState({ worktreeId, kind, state: 'crashed', pid, exitCode: null });
     }

     /** Records + publishes a state, returning the ServerStatus for invoke replies. */
     private emitState(partial: {
       worktreeId: string | null;
       kind: ServerKind;
       state: ServerState;
       pid?: number;
       command?: string;
       startedAt?: number;
       exitCode?: number | null;
     }): ServerStatus {
       this.last = { ...partial };
       const status: ServerStatus = { process: this.last };
       this.emitter.emitState(status);
       return status;
     }
   }

   /** The idle/stopped snapshot reported before any server has run. */
   const STOPPED_IDLE: ServerProcess = { worktreeId: null, kind: 'unknown', state: 'stopped' };
   ```

   > Note: `handleExit`'s exit classification is a single `stoppedCleanly = server.stopping || code === 0`
   > (`stopping || exit 0 ⇒ stopped`, else `crashed`). The unused `signal` param is named `_signal` to
   > satisfy `noUnusedParameters` while keeping the onExit callback arity.

4. `npx vitest run tests/main/server-manager.test.ts` → GREEN (the test's imports are already correct —
   no `DetectedRunnerLike`). Re-run after typecheck to confirm still GREEN.

5. `npm run lint && npm run typecheck:node`. **Commit:** `feat: ServerManager one-server lifecycle (Plan 3)`.

---

### Task 5 — Wire IPC (`ipc-context` + `register-ipc` server/log handlers) — TDD

**Files:** `src/main/ipc/ipc-context.ts` (edit), `src/main/ipc/register-ipc.ts` (edit),
`tests/main/ipc-roundtrip.test.ts` (edit).

**Steps:**

1. Edit `src/main/ipc/ipc-context.ts` — add optional manager fields:

   - Add imports:
     ```ts
     import type { ServerManager } from '../managers/server-manager';
     import type { LogStore } from '../managers/log-store';
     ```
   - Inside `IpcContext`, after `sessionManager?`:
     ```ts
       /** Lazily constructed in register-ipc; injectable in tests (Plan 3). */
       serverManager?: ServerManager;
       /** The LogStore backing the running server's logs (Plan 3). */
       logStore?: LogStore;
     ```

2. Edit `tests/main/ipc-roundtrip.test.ts` — add a RED block at the end:

   ```ts
   describe('registerIpc — server + logs', () => {
     function makeIpcMain() {
       const handlers = new Map<string, (...a: unknown[]) => unknown>();
       const ipcMain = {
         handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
         on: vi.fn(),
       };
       return { handlers, ipcMain };
     }

     function fakeServer() {
       const status = { process: { worktreeId: '/wt', kind: 'npm', state: 'running', pid: 9 } };
       return {
         start: vi.fn(async () => status),
         stop: vi.fn(async () => ({ process: { worktreeId: null, kind: 'unknown', state: 'stopped' } })),
         status: vi.fn(() => status),
         dispose: vi.fn(),
       };
     }
     function fakeLogStore() {
       return { snapshot: vi.fn(() => [{ seq: 0, ts: 1, stream: 'stdout', level: 'info', text: 'x' }]) };
     }

     it('SERVER_START delegates to serverManager.start and returns the ServerStatus', async () => {
       const { handlers, ipcMain } = makeIpcMain();
       const sm = fakeServer();
       registerIpc(ipcMain as never, { mainWindow: null, serverManager: sm as never });
       const req = { worktreeId: '/wt' };
       const out = await handlers.get('server:start')!({}, req);
       expect(sm.start).toHaveBeenCalledWith(req);
       expect(out).toMatchObject({ process: { state: 'running', pid: 9 } });
     });

     it('SERVER_STOP delegates to serverManager.stop', async () => {
       const { handlers, ipcMain } = makeIpcMain();
       const sm = fakeServer();
       registerIpc(ipcMain as never, { mainWindow: null, serverManager: sm as never });
       const out = await handlers.get('server:stop')!({}, {});
       expect(sm.stop).toHaveBeenCalledWith({});
       expect(out).toMatchObject({ process: { state: 'stopped' } });
     });

     it('SERVER_STATUS delegates to serverManager.status', async () => {
       const { handlers, ipcMain } = makeIpcMain();
       const sm = fakeServer();
       registerIpc(ipcMain as never, { mainWindow: null, serverManager: sm as never });
       const out = await handlers.get('server:status')!({});
       expect(sm.status).toHaveBeenCalledOnce();
       expect(out).toMatchObject({ process: { state: 'running' } });
     });

     it('LOG_SNAPSHOT returns the LogStore snapshot', async () => {
       const { handlers, ipcMain } = makeIpcMain();
       const ls = fakeLogStore();
       registerIpc(ipcMain as never, { mainWindow: null, logStore: ls as never });
       const out = await handlers.get('log:snapshot')!({});
       expect(ls.snapshot).toHaveBeenCalledOnce();
       expect(out).toEqual([{ seq: 0, ts: 1, stream: 'stdout', level: 'info', text: 'x' }]);
     });
   });
   ```

3. `npx vitest run tests/main/ipc-roundtrip.test.ts` → RED (handlers not registered).

4. Edit `src/main/ipc/register-ipc.ts` GREEN:

   - Extend the type imports from `../../shared/types` to add:
     ```ts
       ServerStatus,
       StartServerRequest,
       StopServerRequest,
       LogLine,
     ```
   - Add new imports:
     ```ts
     import { ServerManager, type ServerEmitter } from '../managers/server-manager';
     import { LogStore, type LogEmitter } from '../managers/log-store';
     import { NodeProcessRunner } from '../proc/process-runner';
     ```
   - Add an emitter builder + lazy getters (mirroring the session ones), placed after
     `getSessionManager`:

     ```ts
     /** Forwards each LogStore line to the renderer over LOG_LINE (window-guarded). */
     function buildLogEmitter(ctx: IpcContext): LogEmitter {
       return {
         emitLine: (line: LogLine) => {
           const win = ctx.mainWindow;
           if (win && !win.isDestroyed()) win.webContents.send(IPC.LOG_LINE, line);
         },
       };
     }

     /** Forwards ServerManager state to the renderer over SERVER_STATE (guarded). */
     function buildServerEmitter(ctx: IpcContext): ServerEmitter {
       return {
         emitState: (status: ServerStatus) => {
           const win = ctx.mainWindow;
           if (win && !win.isDestroyed()) win.webContents.send(IPC.SERVER_STATE, status);
         },
       };
     }

     /** Resolves the LogStore: prefer ctx (tests inject); else lazily build one. */
     function getLogStore(ctx: IpcContext): LogStore {
       if (ctx.logStore) return ctx.logStore;
       ctx.logStore = new LogStore(buildLogEmitter(ctx));
       return ctx.logStore;
     }

     /** Resolves the ServerManager: prefer ctx (tests inject); else build a real one. */
     function getServerManager(ctx: IpcContext): ServerManager {
       if (ctx.serverManager) return ctx.serverManager;
       ctx.serverManager = new ServerManager({
         runner: new NodeProcessRunner(),
         logStore: getLogStore(ctx),
         emitter: buildServerEmitter(ctx),
         resolvePath: async (worktreeId) => {
           const manager = await getWorktreeManager(ctx);
           const trees = await manager.list();
           return trees.find((t) => t.id === worktreeId)?.path;
         },
         // Smoke seam: a harmless line-emitting command can be injected via env so a
         // manual/Playwright smoke runs WITHOUT a real gradle/npm server.
         commandOverride: process.env.MANGO_SERVER_CMD,
       });
       return ctx.serverManager;
     }
     ```

   - Inside `registerIpc`, after the session handlers, add:

     ```ts
       ipcMain.handle(
         IPC.SERVER_START,
         async (_event: unknown, req: StartServerRequest): Promise<ServerStatus> => {
           return getServerManager(ctx).start(req);
         },
       );

       ipcMain.handle(
         IPC.SERVER_STOP,
         async (_event: unknown, req: StopServerRequest): Promise<ServerStatus> => {
           return getServerManager(ctx).stop(req);
         },
       );

       ipcMain.handle(IPC.SERVER_STATUS, async (): Promise<ServerStatus> => {
         return getServerManager(ctx).status();
       });

       ipcMain.handle(IPC.LOG_SNAPSHOT, async (): Promise<LogLine[]> => {
         return getLogStore(ctx).snapshot();
       });
     ```

   > Note: the `LOG_SNAPSHOT` test injects only `logStore` (no serverManager); `getLogStore` returns it
   > directly, so the handler must call `getLogStore(ctx)` (NOT `getServerManager`). The
   > `SERVER_*` tests inject only `serverManager`; `getServerManager` returns it without touching the
   > LogStore. This keeps both injection paths independent (matches the existing session test style).

5. `npx vitest run tests/main/ipc-roundtrip.test.ts` → GREEN. Then `npx vitest run` → **all 48 + new
   tests green**.

6. `npm run lint && npm run typecheck:node`. **Commit:** `feat: wire SERVER_*/LOG_SNAPSHOT IPC (Plan 3)`.

---

### Task 6 — before-quit server kill-sweep in `index.ts`

**Files:** `src/main/index.ts` (edit).

**Steps:**

1. Add a `before-quit` handler that disposes the server (orphan prevention; the session sweep is
   Plan 5, but the server child must die now that Plan 3 can spawn one). After the existing
   `app.on('window-all-closed', ...)`:

   ```ts
   app.on('before-quit', () => {
     // Kill the single local server child so quitting never orphans gradle/npm.
     ctx.serverManager?.dispose();
   });
   ```

2. `npm run typecheck:node && npm run lint`. **Commit:** `feat: dispose server on before-quit (Plan 3)`.

---

### Task 7 — Flip preload `server.*` + `logs.snapshot`

**Files:** `src/preload/index.ts` (edit).

**Steps:**

1. Replace the `server` block:
   ```ts
     server: {
       start: (req) => ipcRenderer.invoke(IPC.SERVER_START, req),
       stop: (req) => ipcRenderer.invoke(IPC.SERVER_STOP, req),
       status: () => ipcRenderer.invoke(IPC.SERVER_STATUS),
       onState: (cb) => subscribe(IPC.SERVER_STATE, cb),
     },
   ```
2. Replace the `logs` block:
   ```ts
     logs: {
       snapshot: () => ipcRenderer.invoke(IPC.LOG_SNAPSHOT),
       onLine: (cb) => subscribe(IPC.LOG_LINE, cb),
     },
   ```
   Do NOT touch the `MangoApi` surface, `merge`, `app`, or `session`. (`notYet` stays used by `merge`,
   so leave the function in place.)

3. `npm run typecheck:node`. **Commit:** `feat: flip preload server.*/logs.snapshot to real IPC (Plan 3)`.

---

### Task 8 — `log-filter.ts` (PURE renderer filter) — TDD

**Files:** `src/renderer/lib/log-filter.ts` (new), `tests/renderer/log-filter.test.ts` (new).

**Design:** filter `LogLine[]` by a case-insensitive grep substring on `text` AND a minimum level using
the ordering `error(4) > warn(3) > info(2) > debug(1) > raw(0)`. A line passes the level gate when its
rank `>=` the selected min rank. `min: 'raw'` passes everything. Empty grep passes the grep gate.

**Steps:**

1. Create `tests/renderer/log-filter.test.ts` RED:

   ```ts
   import { describe, it, expect } from 'vitest';
   import { filterLogs, LEVEL_RANK } from '../../src/renderer/lib/log-filter';
   import type { LogLine } from '../../src/shared/types';

   const lines: LogLine[] = [
     { seq: 0, ts: 0, stream: 'stdout', level: 'debug', text: 'starting up' },
     { seq: 1, ts: 0, stream: 'stdout', level: 'info', text: 'listening on 8080' },
     { seq: 2, ts: 0, stream: 'stderr', level: 'warn', text: 'deprecated API' },
     { seq: 3, ts: 0, stream: 'stderr', level: 'error', text: 'NullPointerException' },
     { seq: 4, ts: 0, stream: 'stdout', level: 'raw', text: 'BANNER' },
   ];

   describe('filterLogs', () => {
     it('returns everything for empty grep + min raw', () => {
       expect(filterLogs(lines, { grep: '', minLevel: 'raw' })).toHaveLength(5);
     });

     it('greps case-insensitively on text', () => {
       const out = filterLogs(lines, { grep: 'NULLpointer', minLevel: 'raw' });
       expect(out.map((l) => l.seq)).toEqual([3]);
     });

     it('gates by minimum level (warn hides info/debug/raw)', () => {
       const out = filterLogs(lines, { grep: '', minLevel: 'warn' });
       expect(out.map((l) => l.level)).toEqual(['warn', 'error']);
     });

     it('combines grep AND level', () => {
       const out = filterLogs(lines, { grep: 'e', minLevel: 'warn' });
       expect(out.map((l) => l.seq)).toEqual([2, 3]);
     });

     it('error is the highest rank, raw the lowest', () => {
       expect(LEVEL_RANK.error).toBeGreaterThan(LEVEL_RANK.warn);
       expect(LEVEL_RANK.raw).toBe(0);
     });
   });
   ```

2. `npx vitest run tests/renderer/log-filter.test.ts` → RED.

3. Create `src/renderer/lib/log-filter.ts` GREEN:

   ```ts
   import type { LogLine } from '../../shared/types';

   /** Ordering for the min-level gate: error highest, raw lowest. */
   export const LEVEL_RANK: Record<LogLine['level'], number> = {
     error: 4,
     warn: 3,
     info: 2,
     debug: 1,
     raw: 0,
   };

   /** Filter criteria from the log panel controls. */
   export interface LogFilter {
     readonly grep: string;
     readonly minLevel: LogLine['level'];
   }

   /**
    * PURE: keep lines whose text contains `grep` (case-insensitive) AND whose level
    * rank is >= the selected minLevel rank. Empty grep + minLevel 'raw' is a no-op.
    */
   export function filterLogs(lines: readonly LogLine[], filter: LogFilter): LogLine[] {
     const needle = filter.grep.toLowerCase();
     const minRank = LEVEL_RANK[filter.minLevel];
     return lines.filter(
       (l) =>
         LEVEL_RANK[l.level] >= minRank &&
         (needle === '' || l.text.toLowerCase().includes(needle)),
     );
   }
   ```

4. `npx vitest run tests/renderer/log-filter.test.ts` → GREEN.

5. `npm run lint && npm run typecheck:web`. **Commit:** `test: log-filter pure renderer filter (Plan 3)`.

---

### Task 9 — Renderer hooks `use-server.ts` + `use-logs.ts`

**Files:** `src/renderer/hooks/use-server.ts` (new), `src/renderer/hooks/use-logs.ts` (new).

**Steps:**

1. Create `src/renderer/hooks/use-server.ts`:

   ```ts
   import { useCallback, useEffect, useState } from 'react';
   import type { ServerStatus } from '../../shared/types';

   /** Return shape of the single-server hook. */
   export interface UseServer {
     readonly status: ServerStatus | null;
     start(worktreeId: string, commandOverride?: string): Promise<void>;
     stop(): Promise<void>;
   }

   /**
    * Drives the ONE local server over window.mango.server. Seeds from status() on
    * mount and stays live via onState. start/stop are thin invoke wrappers; the
    * returned status feeds the toolbar Run/Stop + the sidebar server indicator.
    */
   export function useServer(): UseServer {
     const [status, setStatus] = useState<ServerStatus | null>(null);

     useEffect(() => {
       let alive = true;
       void window.mango.server.status().then((s) => {
         if (alive) setStatus(s);
       });
       const off = window.mango.server.onState((s) => setStatus(s));
       return () => {
         alive = false;
         off();
       };
     }, []);

     const start = useCallback(async (worktreeId: string, commandOverride?: string): Promise<void> => {
       const s = await window.mango.server.start({ worktreeId, commandOverride });
       setStatus(s);
     }, []);

     const stop = useCallback(async (): Promise<void> => {
       const s = await window.mango.server.stop({});
       setStatus(s);
     }, []);

     return { status, start, stop };
   }
   ```

2. Create `src/renderer/hooks/use-logs.ts`:

   ```ts
   import { useEffect, useState } from 'react';
   import type { LogLine } from '../../shared/types';

   /** Max lines held in renderer memory (mirrors the LogStore cap). */
   const MAX_LINES = 5000;

   /**
    * Seeds the live log list from logs.snapshot() on mount and appends every
    * LOG_LINE via onLine, capping the in-memory list. A monotonic-seq guard drops
    * any duplicate that races between the snapshot and the first live line.
    */
   export function useLogs(): readonly LogLine[] {
     const [lines, setLines] = useState<readonly LogLine[]>([]);

     useEffect(() => {
       let alive = true;
       void window.mango.logs.snapshot().then((snap) => {
         if (alive) setLines(snap);
       });
       const off = window.mango.logs.onLine((line) => {
         setLines((prev) => {
           // A NEW run resets seq to 0 — clear the panel and seed the fresh run.
           // This MUST come before the dup check, which would otherwise block seq 0.
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
     }, []);

     return lines;
   }
   ```

   > Note: the `if (line.seq === 0) return [line]` guard (placed BEFORE the dup check) is load-bearing —
   > a server restart resets `LogStore` seq to 0, and without it the `line.seq <= last.seq` dup guard
   > would freeze the panel on the previous run's tail until a snapshot raced in.

3. `npm run typecheck:web && npm run lint`. **Commit:** `feat: use-server + use-logs renderer hooks (Plan 3)`.

---

### Task 10 — Renderer components: `log-panel`, `server-controls`, `server-dot`

**Files:** `src/renderer/components/logs/log-panel.tsx` (new),
`src/renderer/components/toolbar/server-controls.tsx` (new),
`src/renderer/components/sidebar/server-dot.tsx` (new).

**Steps:**

1. Create `src/renderer/components/logs/log-panel.tsx`:

   ```tsx
   import { useMemo, useState } from 'react';
   import type { LogLine } from '../../../shared/types';
   import { filterLogs } from '../../lib/log-filter';

   const LEVEL_OPTIONS: LogLine['level'][] = ['raw', 'debug', 'info', 'warn', 'error'];
   const LEVEL_COLOR: Record<LogLine['level'], string> = {
     error: '#cf222e',
     warn: '#b58900',
     info: '#2ea043',
     debug: '#6e7781',
     raw: '#888',
   };
   /** Cap how many lines we actually render (newest), independent of the buffer. */
   const RENDER_CAP = 1000;

   export interface LogPanelProps {
     readonly lines: readonly LogLine[];
   }

   /** Live server log list with a case-insensitive grep + a min-level select. */
   export function LogPanel({ lines }: LogPanelProps): React.JSX.Element {
     const [grep, setGrep] = useState<string>('');
     const [minLevel, setMinLevel] = useState<LogLine['level']>('raw');

     const visible = useMemo(() => {
       const filtered = filterLogs(lines, { grep, minLevel });
       return filtered.length > RENDER_CAP ? filtered.slice(filtered.length - RENDER_CAP) : filtered;
     }, [lines, grep, minLevel]);

     return (
       <section data-testid="log-panel" style={{ marginTop: 16 }}>
         <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
           <strong style={{ fontSize: 13 }}>Server logs</strong>
           <input
             aria-label="log grep"
             placeholder="filter…"
             value={grep}
             onChange={(e) => setGrep(e.target.value)}
             style={{ flex: 1, fontSize: 12 }}
           />
           <label style={{ fontSize: 12 }}>
             level
             <select
               aria-label="min level"
               value={minLevel}
               onChange={(e) => setMinLevel(e.target.value as LogLine['level'])}
               style={{ marginLeft: 4 }}
             >
               {LEVEL_OPTIONS.map((lvl) => (
                 <option key={lvl} value={lvl}>
                   {lvl}
                 </option>
               ))}
             </select>
           </label>
           <span style={{ fontSize: 11, color: '#888' }}>{visible.length} shown</span>
         </div>
         <div
           style={{
             height: 240,
             overflowY: 'auto',
             background: '#1e1e1e',
             color: '#ddd',
             fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
             fontSize: 12,
             padding: 8,
             borderRadius: 4,
           }}
         >
           {visible.length === 0 ? (
             <div style={{ color: '#666' }}>no log lines</div>
           ) : (
             visible.map((l) => (
               <div key={l.seq} style={{ whiteSpace: 'pre-wrap', color: LEVEL_COLOR[l.level] }}>
                 {l.text}
               </div>
             ))
           )}
         </div>
       </section>
     );
   }
   ```

2. Create `src/renderer/components/toolbar/server-controls.tsx`:

   ```tsx
   import type { ServerStatus } from '../../../shared/types';

   export interface ServerControlsProps {
     readonly selectedId: string | null;
     readonly status: ServerStatus | null;
     onStart(worktreeId: string): void;
     onStop(): void;
   }

   /** Run/Stop for the selected worktree's single local server (MVP item 3). */
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
         <button type="button" disabled={!isRunning && !isBusy} onClick={() => onStop()}>
           Stop
         </button>
         <span style={{ fontSize: 11, color: '#888' }}>server: {state}</span>
       </div>
     );
   }
   ```

3. Create `src/renderer/components/sidebar/server-dot.tsx`:

   ```tsx
   import type { ServerState } from '../../../shared/types';

   const SERVER_COLOR: Record<ServerState, string> = {
     stopped: '#bbb',
     starting: '#d8a657',
     running: '#1f6feb',
     stopping: '#d8a657',
     crashed: '#cf222e',
   };

   export interface ServerDotProps {
     readonly state: ServerState;
   }

   /** Small colored dot showing this worktree's server state in the sidebar. */
   export function ServerDot({ state }: ServerDotProps): React.JSX.Element {
     return (
       <span
         aria-label={`server ${state}`}
         title={`server ${state}`}
         style={{
           width: 8,
           height: 8,
           borderRadius: 2,
           background: SERVER_COLOR[state],
           flex: '0 0 auto',
         }}
       />
     );
   }
   ```

4. `npm run typecheck:web && npm run lint`. **Commit:** `feat: log-panel + server-controls + server-dot (Plan 3)`.

---

### Task 11 — Compose into `App.tsx` (+ sidebar server dot)

**Files:** `src/renderer/App.tsx` (edit), `src/renderer/components/sidebar/worktree-list.tsx` (edit),
`src/renderer/components/sidebar/worktree-item.tsx` (edit).

**Design:** the single server belongs to whichever worktree `status.process.worktreeId` names, so the
sidebar shows a server dot only on that owner row. Thread a `serverState` + `serverWorktreeId` down to
the list/item.

**Steps:**

1. Edit `worktree-item.tsx` — import `ServerDot` + `ServerState`, add two props, render the dot when
   this row owns the server:
   - Add to `WorktreeItemProps`:
     ```ts
       readonly serverState: ServerState;
       readonly ownsServer: boolean;
     ```
   - After the agent dot `<span>`, add:
     ```tsx
       {ownsServer && <ServerDot state={serverState} />}
     ```
   - Import line: `import { ServerDot } from './server-dot';` and add `ServerState` to the type import.

2. Edit `worktree-list.tsx` — add `serverState: ServerState` + `serverWorktreeId: string | null` to
   `WorktreeListProps`, and pass per-row:
   ```tsx
     serverState={serverState}
     ownsServer={wt.id === serverWorktreeId}
   ```
   (Add `ServerState` to the type import.)

3. Edit `App.tsx`:
   - Imports:
     ```ts
     import { useServer } from './hooks/use-server';
     import { useLogs } from './hooks/use-logs';
     import { LogPanel } from './components/logs/log-panel';
     import { ServerControls } from './components/toolbar/server-controls';
     ```
   - Inside `App`, after `useWorktrees(...)`:
     ```ts
     const { status: serverStatus, start: startServer, stop: stopServer } = useServer();
     const logLines = useLogs();
     ```
   - In the toolbar row (next to `<Toolbar .../>`), add:
     ```tsx
     <ServerControls
       selectedId={selectedId}
       status={serverStatus}
       onStart={(id) => void startServer(id)}
       onStop={() => void stopServer()}
     />
     ```
   - Pass to `<WorktreeList>`:
     ```tsx
     serverState={serverStatus?.process.state ?? 'stopped'}
     serverWorktreeId={serverStatus?.process.worktreeId ?? null}
     ```
   - In the right `<section>`, below the `AgentTerminal`/ping block, add:
     ```tsx
     <LogPanel lines={logLines} />
     ```
   - Update the subtitle `<p>` text to mention Plan 3 (e.g. `Plan 3: local server + live logs.`).

4. `npm run typecheck:web && npm run lint && npm run build`. (`build` must succeed — renderer + main +
   preload bundles.) **Commit:** `feat: compose server controls + log panel + sidebar dot (Plan 3)`.

---

### Task 12 — Full verification + documented manual smoke

**Files:** none committed beyond docs already present; this task is verification only.

**Steps:**

1. Run the full suite + checks:
   ```bash
   npm test && npm run typecheck && npm run lint && npm run build
   ```
   All existing 48 tests PLUS the new detect-runner / log-store / server-manager / ipc-server /
   log-filter tests must be green. typecheck (node + web), lint, and build all pass.

2. **Documented manual smoke (NOT committed as e2e):** run the app with the harmless-command env seam
   so no real gradle/npm boots:
   ```bash
   MANGO_SERVER_CMD='node -e "let n=0;const t=setInterval(()=>{console.log(`INFO tick ${n++}`);if(n>50)console.error(`ERROR demo stderr`);},300)"' npm run dev
   ```
   Then: pick a worktree → click **Run** → confirm the log panel streams `INFO tick N` lines with the
   info color, an `ERROR demo stderr` line appears in error color, the grep box filters (`tick`), the
   level select hides `info` when set to `warn`, the sidebar shows the server dot turn blue (running) on
   the owner row, and **Stop** ends it (dot returns to stopped). Quit the app and confirm (via Activity
   Monitor / `ps`) no orphaned child remains (before-quit dispose worked). Record the result in the PR
   description — do NOT add Playwright/Spectron infra (matches the Plan 0–2 strategy).

3. **No commit** (verification only), or an optional docs touch-up commit if the README smoke note is
   updated: `docs: Plan 3 manual smoke note`.

---

## Plan 3 Acceptance Checklist

- [ ] `detectRunner` is PURE, precedence spring-gradle → npm(dev) → npm(start) → unknown, never throws
      on malformed `package.json`; unit-tested against temp fixture dirs.
- [ ] `ProcessRunner`/`IProcLike` seam exists with `NodeProcessRunner` (shell-string `child_process`)
      and `fake-runner.ts` (EventEmitter) mirroring Plan 2's `PtyFactory`/`fake-pty`.
- [ ] `LogStore` is a bounded ring (cap 5000, FIFO overflow), monotonic per-run `seq`, best-effort level
      parse (stated regex), partial-line carry across chunks, `flush()` on exit, in-memory only.
- [ ] `ServerManager` runs ONE server (single field), replace-on-start, lifecycle
      `stopped→starting→running→stopping→stopped|crashed`, cwd via injected `resolvePath`, pipes to
      LogStore, emits `SERVER_STATE`, applies the identity discriminator (no stale state on replace),
      exposes `killAll`/`dispose`.
- [ ] IPC `SERVER_START/STOP/STATUS` + `LOG_SNAPSHOT` (invoke) delegate to the managers; `SERVER_STATE`
      + `LOG_LINE` emit through window-guarded emitters. Reuses the EXACT binding channels/types.
- [ ] `before-quit` disposes the server (no orphan gradle/npm).
- [ ] Preload `server.start/stop/status` + `logs.snapshot` flipped from `notYet('3')` to real invoke;
      `MangoApi` surface unchanged.
- [ ] `log-filter` is PURE (case-insensitive grep + min-level rank error>warn>info>debug>raw);
      unit-tested.
- [ ] `log-panel` (grep + level select, capped render, snapshot+onLine via `use-logs`),
      `server-controls` (Run/Stop for selected worktree via `use-server`), and a sidebar `server-dot`
      on the owner row are composed into `App.tsx`; existing Toolbar/WorktreeList/AgentTerminal/ping
      preserved.
- [ ] `npm test` (existing 48 + new), `npm run typecheck`, `npm run lint`, `npm run build` all green.
- [ ] Manual smoke with `MANGO_SERVER_CMD` documented in the PR; NO real server, NO committed flaky e2e.

## Self-Review Notes

- **Contract fidelity:** Every type (`ServerKind`, `ServerState`, `ServerProcess`, `ServerStatus`,
  `LogLine`, `StartServerRequest`, `StopServerRequest`) and channel (`SERVER_START/STOP/STATUS/STATE`,
  `LOG_LINE/LOG_SNAPSHOT`) is consumed verbatim from `src/shared/`; nothing there is modified. The
  `MangoApi` shape is untouched — only the preload `notYet('3')` stubs flip to invoke.
- **Pattern reuse:** `ProcessRunner`+`fake-runner` mirror `PtyFactory`+`fake-pty`; the injected
  `ServerEmitter`/`LogEmitter` mirror `SessionEmitter`; lazy `getServerManager`/`getLogStore` with
  ctx-injection mirror `getSessionManager`; the identity-token stale-exit guard mirrors Plan 2's
  `handleExit`. register-ipc's window-guarded `webContents.send` matches `buildSessionEmitter`.
- **One-server invariant (§6.5):** a single `current` field, replace-on-start, and a single
  `serverWorktreeId` in the sidebar enforce exactly one server.
- **Testability:** detect (FsReader/temp dirs), LogStore (spy emitter), ServerManager (fake runner +
  spy emitters + injected detect/resolvePath), log-filter (pure) are all windowless. The renderer is
  verified by typecheck/lint/build + a documented manual smoke — consistent with Plan 0–2.
- **Smoke seam:** `commandOverride` on the request AND a `MANGO_SERVER_CMD` env override on the manager
  let a manual/Playwright smoke run a harmless line-emitting command with NO gradle/npm and NO real
  server, so verification is deterministic and non-flaky.
- **Resolved in this revision (were verifier-flagged):** (1) Task 4 test imports only published types — no
  `DetectedRunnerLike`; (2) `handleExit` uses a single `stoppedCleanly = server.stopping || code === 0`
  (no dead `clean`/`void clean`; unused `signal` → `_signal`); (3) `use-logs` resets on `seq === 0` BEFORE
  the dup check so a restart clears the panel. (4) Still applies: `LOG_SNAPSHOT` handler uses `getLogStore`
  (not `getServerManager`) so the log-only injection path in the IPC test passes.
- **Best-effort level parsing** can false-match prose containing "error"/"warn" — acceptable for MVP
  (contract labels it best-effort; the `'plain text' ⇒ raw` test still holds).