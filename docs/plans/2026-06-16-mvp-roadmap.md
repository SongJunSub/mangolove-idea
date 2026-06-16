I now have a fully verified, mutually-compatible version matrix. The stack locks on Vite 7 (electron-vite 5's ceiling), Vitest 4 (supports Vite 7), plugin-react 5 (supports Vite 7), Electron 42, node-pty 1.1.0 + @electron/rebuild 4. I have everything needed to write the contract.

```markdown
# MangoLove IDEA — SHARED ARCHITECTURE CONTRACT & BUILD-ORDER ROADMAP (v1)

> **Status:** LOCKED. This is the single source of truth for plans 0–5.
> Every interface, type, IPC channel name, file path, and version below is **binding**.
> If a later plan needs to change anything here, it must amend THIS document first.
> Date: 2026-06-16 · Target: macOS · Stack: Electron + React + TypeScript.

---

## 0. Version Matrix (VERIFIED against npm, 2026-06-16)

All versions were resolved live from the npm registry and cross-checked for peer-dependency
compatibility. **The critical constraint is the Vite major:** `electron-vite@5` peers
`vite ^5 || ^6 || ^7` — it does **NOT** support Vite 8 yet. Therefore the whole toolchain is
**pinned to the Vite 7 line**, and the React/Vitest plugins are pinned to the versions that peer
Vite 7 (NOT their newest releases, which jumped to Vite 8). Do not bump Vite to 8 until
electron-vite ships a Vite-8 major (currently only `electron-vite@6.0.0-beta`).

| Package | Version | Role | Compatibility note |
|---|---|---|---|
| `electron` | `42.4.0` | runtime | host ABI for native rebuild |
| `electron-vite` | `5.0.0` | scaffold/build | peers `vite ^5\|\|^6\|\|^7`; engines node `^20.19 \|\| >=22.12` |
| `electron-builder` | `26.15.3` | packaging (dev dep, not used until release) | optional for MVP |
| `@electron/rebuild` | `4.0.4` | native rebuild | rebuilds node-pty against Electron 42 ABI |
| `node-pty` | `1.1.0` | PTY (native addon) | **must be rebuilt for Electron ABI** |
| `@xterm/xterm` | `6.0.0` | terminal renderer | current scoped pkg (NOT legacy `xterm`) |
| `@xterm/addon-fit` | `0.11.0` | terminal fit-to-container | only addon used in MVP |
| `simple-git` | `3.36.0` | git worktree ops | wraps system `git` |
| `react` / `react-dom` | `19.2.7` | renderer UI | |
| `vite` | `7.3.5` | bundler | **pinned to 7** (electron-vite 5 ceiling) |
| `@vitejs/plugin-react` | `5.1.0` | React HMR in Vite | peers `vite ^4.2\|\|^5\|\|^6\|\|^7` (NOT v6, which needs Vite 8) |
| `vitest` | `4.1.9` | test runner | peers `vite ^6\|\|^7\|\|^8` — works on Vite 7 |
| `typescript` | `5.7.x`* | types | *use latest 5.7 line; `typescript-eslint@8.61.1` and TS 6.0 interop is not yet broadly settled — pin TS 5.7 for MVP safety |
| `typescript-eslint` | `8.61.1` | lint (flat config) | |
| `eslint` | `9.x`* | lint | *use ESLint 9 line; `typescript-eslint@8` targets ESLint 9 flat config. Do NOT take ESLint 10 until typescript-eslint validates it. |
| `prettier` | `3.8.4` | format | |
| `eslint-config-prettier` | `10.1.8` | disable conflicting lint rules | |
| `@types/node` | `22.19.21` | node types | match electron-vite node engine 22 line |

> **Rationale on the two deliberate down-pins (TS, ESLint):** the absolute-latest `typescript@6.0`
> and `eslint@10` are out, but the lint toolchain (`typescript-eslint@8`) is built and tested against
> **ESLint 9 + TS 5.x**. Adopting TS6/ESLint10 on day 1 of a greenfield is the kind of avoidable
> yak-shave this contract exists to prevent. Pin TS 5.7 + ESLint 9 now; revisit post-MVP.

---

## 1. Tooling Decisions

### 1.1 Scaffolding — **electron-vite** (winner)

**Command:**
```bash
npm create electron-vite@latest mangolove-idea -- --template react-ts
# then inside the repo:
npm install
```

**Why electron-vite over the alternatives, for THIS app:**

- **vs `vite-plugin-electron`** — that plugin bolts Electron onto a single renderer-centric Vite
  config. It is fine for "renderer + a thin main," but our main process is a real Node engine
  (WorktreeManager, SessionManager spawning `node-pty`, ServerManager spawning child processes,
  LogStore). electron-vite treats **main / preload / renderer as three first-class build targets**
  with separate configs in one `electron.vite.config.ts`, which is exactly our three-surface
  architecture. It also gives correct `__dirname`/CJS-vs-ESM handling for the main process and
  **externalizes native deps automatically** (see 1.2) — critical for node-pty.
- **vs `electron-forge + vite`** — Forge is a packaging/distribution framework first; its Vite
  template is younger and its plugin pipeline adds ceremony we don't need for an internal macOS-only
  MVP. We are not shipping signed installers in v1. electron-vite keeps dev-loop friction lowest.

**electron-vite gives us, out of the box:** main-process HMR/restart, preload bundling, renderer
React+HMR, `import.meta.env`, and the `build.rollupOptions.external` / `external dependencies` story
that keeps `node-pty` (and other native/`node:` deps) out of the bundle so they load from
`node_modules` at runtime.

### 1.2 Native module reality — node-pty + @electron/rebuild

> **Correction (empirically verified 2026-06-16):** an earlier draft of this section claimed an
> un-rebuilt `require('node-pty')` throws `NODE_MODULE_VERSION` and called it "the single biggest
> greenfield trap." **That is false for `node-pty@1.1.0`.** node-pty 1.1.0 is an **N-API /
> node-addon-api** addon shipping **ABI-stable prebuilt binaries** (`prebuilds/darwin-arm64/pty.node`).
> It was loaded under plain Node v25.1.0 with **no** `NODE_MODULE_VERSION` error, and loads in
> Electron 42 via the same prebuild **without any rebuild**. The NAN-era ABI trap does not apply here.

`node-pty@1.1.0` is a native addon, but N-API insulates it from Node/Electron ABI churn via its
prebuilds. We still wire `@electron/rebuild` as **cheap defense-in-depth** (not a hard requirement):
it compiles `build/Release/pty.node`, which takes precedence over the prebuild and pins the binary
to exactly this Electron — valuable insurance if a future node-pty drops prebuilds for our arch.

**Wiring (run the rebuild via postinstall — harmless, succeeds, cheap):**

`package.json`:
```jsonc
{
  "scripts": {
    // Runs after every `npm install`. Rebuilds ONLY native modules against the
    // installed Electron's ABI. node-pty is the one that matters for us.
    "postinstall": "electron-rebuild -f -w node-pty",
    "rebuild": "electron-rebuild -f -w node-pty"
  },
  "devDependencies": {
    "@electron/rebuild": "4.0.4",
    "electron": "42.4.0"
  }
}
```
- `electron-rebuild` is the CLI bin shipped by `@electron/rebuild`. `-f` = force, `-w node-pty` =
  rebuild only that module (faster, avoids touching pure-JS deps).
- `@electron/rebuild` auto-detects the installed Electron version and downloads matching headers — no
  manual `node-gyp`/`HOME`/`--target` juggling.

**Two mandatory companion rules (must be honored in Plan 0):**
1. **Externalize node-pty from the bundle.** In `electron.vite.config.ts`, node-pty must be in the
   main build's externals so Vite/Rollup never tries to bundle the `.node` binary. electron-vite's
   `externalizeDepsPlugin()` (default in the main config) handles this — **keep node-pty in
   `dependencies`, NOT `devDependencies`**, so it is resolvable at runtime and excluded from the
   bundle.
2. **Re-run rebuild after any Electron version bump.** Add a note in README; the `rebuild` script is
   the manual escape hatch.

> **CI / fresh-clone gotcha to document:** because `postinstall` invokes `electron-rebuild`, a clone
> with no Electron present (or a pure-CI tool install) would fail. For MVP we always install Electron
> as a dev dep, so this is fine. Unit-test CI (see 1.4) runs **only manager tests that do not import
> node-pty**, so it can skip the Electron download if desired with `ELECTRON_SKIP_BINARY_DOWNLOAD`,
> but the default path is: full install → postinstall rebuild → all green.

### 1.3 xterm package — `@xterm/xterm@6.0.0` (+ `@xterm/addon-fit@0.11.0`)

The terminal is the **SPINE** of the renderer. Use the **scoped** packages — the legacy unscoped
`xterm` / `xterm-addon-fit` packages are deprecated/frozen.

- `@xterm/xterm@6.0.0` — terminal emulator + renderer.
- `@xterm/addon-fit@0.11.0` — the **only** addon in MVP. Resizes the terminal cols/rows to the
  container; its computed `{cols, rows}` is the source of truth we forward to the PTY via the
  `session:resize` IPC channel (see §4).
- **No** other addons in v1 (no search, no web-links, no serialize — serialize is explicitly v2).

### 1.4 Test runner + STRATEGY — **Vitest 4**, main-process-first

**Runner:** `vitest@4.1.9` (peers Vite 7 — verified). One runner, two project configs.

**What we test (high value, non-flaky):**

| Surface | Tested? | How |
|---|---|---|
| **Manager classes** (`WorktreeManager`, `ServerManager`, `LogStore`, `SessionManager` logic) | **YES — unit, headless, CI** | Pure Node. No Electron window. `WorktreeManager` runs against a **real temp git repo** created in `beforeEach` (`git init` in `os.tmpdir()`), exercising real `simple-git` worktree add/list/remove. `LogStore` ring-buffer is pure logic. `ServerManager` command **detection** (gradlew vs npm) is pure logic tested against fixture dirs; actual process spawn is tested with a **fake/echo command**, not a real Spring Boot boot. |
| **SessionManager PTY layer** | **PARTIAL** | The PTY itself (`node-pty`) is injected behind a small `PtyFactory` interface so tests pass a **fake PTY** (an EventEmitter with `write/resize/kill/onData/onExit`). We test session lifecycle/bookkeeping, NOT real terminal I/O. |
| **IPC handler registration** | **YES — light** | `ipcMain.handle` registration is tested by calling the handler functions directly with a mocked `event`, asserting they delegate to the manager. We do **not** boot a real Electron IPC bus in unit tests. |
| **preload contextBridge shape** | **Type-checked only** | Guaranteed by the shared types (§3/§4) + `tsc --noEmit`. No runtime test. |
| **React renderer / components** | **MINIMAL** | Pure presentational logic (e.g. log-level filter function, status formatting) is unit-tested with Vitest + `jsdom`. Component rendering is **manual** for MVP. xterm.js cannot be meaningfully unit-tested without a real DOM/GPU; do not try. |
| **Full-app e2e (Playwright/Spectron-style)** | **NO for MVP** | Explicitly out of scope. Driving a real Electron window that spawns real `claude` PTYs and real Spring Boot servers is flaky and slow. MVP relies on **manual smoke testing** documented per plan ("produces working software" statements in §5). |

**Config shape:** `vitest.config.ts` with two `test.projects`:
- `node` env → `tests/main/**` (managers, IPC handlers). `pool: 'forks'`.
- `jsdom` env → `tests/renderer/**` (pure renderer logic only).

### 1.5 Lint / format — Google TS style (2-space, single quotes, 100 col)

- **ESLint 9 flat config** (`eslint.config.js`) via `typescript-eslint@8.61.1`.
- **Prettier 3.8.4** owns formatting; `eslint-config-prettier@10.1.8` turns off conflicting ESLint
  stylistic rules.
- `.prettierrc.json`:
  ```json
  {
    "tabWidth": 2,
    "useTabs": false,
    "singleQuote": true,
    "semi": true,
    "printWidth": 100,
    "trailingComma": "all"
  }
  ```
- ESLint key rules: `@typescript-eslint/no-explicit-any: error` (any is banned — use `unknown`),
  explicit module boundary types on exported manager methods, `prefer-readonly`.
- Naming (enforced by review + config): types/interfaces `PascalCase`, functions/vars `camelCase`,
  consts `UPPER_SNAKE_CASE`, **files `kebab-case`** (`worktree-manager.ts`), enum members `PascalCase`.

---

## 2. File / Directory Structure (the whole MVP repo tree)

```
mangolove-idea/
├─ electron.vite.config.ts        # 3 build targets: main / preload / renderer (externalizeDeps)
├─ vitest.config.ts               # 2 projects: node (main) + jsdom (renderer-logic)
├─ eslint.config.js               # flat config, typescript-eslint, Google TS style
├─ .prettierrc.json
├─ tsconfig.json                  # base; references the three below
├─ tsconfig.node.json             # main + preload + shared (Node types)
├─ tsconfig.web.json              # renderer + shared (DOM types)
├─ package.json                   # scripts incl. postinstall:electron-rebuild; node-pty in deps
├─ README.md                      # incl. native-rebuild + macOS-only notes
│
├─ src/
│  ├─ main/                       # ── MAIN PROCESS (Node engine) ──
│  │  ├─ index.ts                 # app entry: create BrowserWindow, wire all IPC, before-quit sweep
│  │  ├─ ipc/
│  │  │  ├─ register-ipc.ts       # single place that calls ipcMain.handle/on for ALL channels (§4)
│  │  │  └─ ipc-context.ts        # holds manager singletons + mainWindow ref for emitters
│  │  ├─ managers/
│  │  │  ├─ worktree-manager.ts   # git worktree add/list/remove via simple-git (MVP item 1)
│  │  │  ├─ session-manager.ts    # one PTY per worktree running `claude`; --continue rehydrate (items 2,6)
│  │  │  ├─ server-manager.ts     # start/stop ONE server; detect gradlew vs npm (item 3)
│  │  │  ├─ log-store.ts          # ring buffer + file sink for server stdout/stderr (item 3)
│  │  │  └─ session-store.ts      # persist SessionRecord[] to app userData JSON (item 6)
│  │  ├─ pty/
│  │  │  └─ pty-factory.ts        # thin wrapper over node-pty; injectable for tests (1.4)
│  │  ├─ git/
│  │  │  └─ merge-runner.ts       # merge + cleanup + MangoLove verify hook (item 5)
│  │  └─ util/
│  │     └─ detect-runner.ts      # pure: dir -> 'spring-gradle' | 'npm' | 'unknown'
│  │
│  ├─ preload/                    # ── PRELOAD (contextBridge) ──
│  │  └─ index.ts                 # exposes window.mango.* typed API; NO node access leaks to renderer
│  │
│  ├─ renderer/                   # ── RENDERER (React) ──
│  │  ├─ index.html
│  │  ├─ main.tsx                 # React root
│  │  ├─ App.tsx                  # layout: sidebar | terminal(spine) | log panel | toolbar
│  │  ├─ components/
│  │  │  ├─ sidebar/
│  │  │  │  ├─ worktree-list.tsx        # branch + agent + server status (item 4)
│  │  │  │  └─ worktree-item.tsx
│  │  │  ├─ terminal/
│  │  │  │  └─ agent-terminal.tsx       # xterm.js + addon-fit; binds to session IPC (item 2)
│  │  │  ├─ logs/
│  │  │  │  └─ log-panel.tsx            # live logs, grep + level filter (item 3)
│  │  │  └─ toolbar/
│  │  │     └─ toolbar.tsx              # New worktree / Run / Stop / Merge (items 1,3,5)
│  │  ├─ hooks/
│  │  │  ├─ use-worktrees.ts            # CRUD via window.mango.worktree.*
│  │  │  ├─ use-session.ts              # spawn/input/output/resize/kill wiring
│  │  │  ├─ use-server.ts               # start/stop/status
│  │  │  └─ use-logs.ts                 # subscribe to log stream + client-side filter
│  │  ├─ state/
│  │  │  └─ app-store.ts                # active worktree id, statuses (zustand-style or context)
│  │  └─ lib/
│  │     └─ log-filter.ts               # pure filter fn (UNIT TESTED, 1.4)
│  │
│  └─ shared/                     # ── SHARED (imported by BOTH main & renderer) ──
│     ├─ types.ts                 # ALL interfaces in §3 (BINDING)
│     ├─ ipc-channels.ts          # ALL channel name consts in §4 (BINDING)
│     └─ ipc-contract.ts          # MangoApi shape + per-channel req/res payload types (§4, BINDING)
│
└─ tests/
   ├─ main/
   │  ├─ worktree-manager.test.ts        # against real temp git repo
   │  ├─ server-manager.test.ts          # detect + fake-command spawn
   │  ├─ log-store.test.ts               # ring buffer logic
   │  ├─ session-manager.test.ts         # fake PtyFactory
   │  ├─ detect-runner.test.ts           # pure
   │  └─ ipc-roundtrip.test.ts           # handler delegates to manager (mocked event)
   ├─ renderer/
   │  └─ log-filter.test.ts              # pure filter logic
   └─ helpers/
      ├─ temp-git-repo.ts                # makes/destroys a temp git repo
      └─ fake-pty.ts                     # EventEmitter implementing IPty surface
```

**Single-responsibility rule:** `src/shared/` is the ONLY directory imported by both processes. It
must contain **zero runtime side effects** and **zero node/DOM-only imports** — pure types + string
constants only. This is what keeps main and renderer type-consistent across all plans.

---

## 3. Shared TypeScript Types (`src/shared/types.ts`) — BINDING

> These property names are final. Plans 1–5 reuse them verbatim. No renaming without amending this doc.

```ts
// ─────────────────────────────────────────────────────────────────────────────
// src/shared/types.ts  —  imported by BOTH main and renderer. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

/** A git worktree managed by MangoLove IDEA. */
export interface Worktree {
  /** Stable id (we use the absolute worktree path as the id). */
  readonly id: string;
  /** Absolute filesystem path of the worktree. */
  readonly path: string;
  /** Branch checked out in this worktree, e.g. 'feature/login'. */
  readonly branch: string;
  /** Short HEAD sha of the worktree, if known. */
  readonly head?: string;
  /** True for the repo's primary (main) working copy. */
  readonly isPrimary: boolean;
  /** True if the worktree dir is locked by git. */
  readonly isLocked: boolean;
}

/** Lifecycle state of the embedded agent (claude) PTY for a worktree. */
export type AgentStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

/** A live embedded agent terminal session (one PTY per worktree). */
export interface AgentSession {
  /** Same value as the owning Worktree.id (1:1). */
  readonly worktreeId: string;
  /** OS process id of the PTY's claude process, if alive. */
  readonly pid?: number;
  readonly status: AgentStatus;
  /** True when a turn was in flight (used for quit warning, MVP item 6). */
  readonly hasActiveTurn: boolean;
  /** Was this session spawned with `claude --continue` (rehydrated)? */
  readonly continued: boolean;
}

/** Which local server runtime we detected for a worktree. */
export type ServerKind = 'spring-gradle' | 'npm' | 'unknown';

/** Lifecycle of the single local server (ONE at a time, MVP item 3). */
export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

/** The single running (or last) local server process. */
export interface ServerProcess {
  /** Worktree that owns the currently selected server (null when stopped/none). */
  readonly worktreeId: string | null;
  readonly kind: ServerKind;
  readonly state: ServerState;
  readonly pid?: number;
  /** The resolved command line we ran, e.g. './gradlew bootRun'. */
  readonly command?: string;
  /** Epoch ms when it entered 'running'. */
  readonly startedAt?: number;
  /** Exit code if it stopped/crashed. */
  readonly exitCode?: number | null;
}

/** Convenience snapshot returned by server:status. */
export interface ServerStatus {
  readonly process: ServerProcess;
}

/** Persisted, restart-surviving record per worktree (MVP item 6, session b-lite). */
export interface SessionRecord {
  readonly worktreePath: string;
  readonly branch: string;
  /** True if an agent session existed at last quit (=> spawn `claude --continue`). */
  readonly hadActiveSession: boolean;
  /** Epoch ms of last update. */
  readonly updatedAt: number;
}

/** One line of server log (LogStore ring buffer + file). */
export interface LogLine {
  /** Monotonic sequence number within the current server run. */
  readonly seq: number;
  readonly ts: number;            // epoch ms
  readonly stream: 'stdout' | 'stderr';
  /** Best-effort parsed level; 'raw' when unknown. */
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'raw';
  readonly text: string;
}

// ── Request / response payloads (mirrored in ipc-contract.ts) ──

export interface CreateWorktreeRequest {
  /** Base branch to fork from, e.g. 'main' (MVP item 1: base branch select). */
  readonly baseBranch: string;
  /** New branch name to create + check out in the worktree. */
  readonly newBranch: string;
  /** Optional explicit target dir; default is derived from branch name. */
  readonly path?: string;
}

export interface RemoveWorktreeRequest {
  readonly worktreeId: string;
  /** Force removal even if dirty (passes git --force). */
  readonly force?: boolean;
}

export interface SpawnSessionRequest {
  readonly worktreeId: string;
  /** When true, spawn `claude --continue` instead of fresh `claude`. */
  readonly continueSession: boolean;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionInputRequest {
  readonly worktreeId: string;
  /** Raw bytes from xterm onData to write into the PTY. */
  readonly data: string;
}

export interface SessionResizeRequest {
  readonly worktreeId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionOutputEvent {
  readonly worktreeId: string;
  /** Raw PTY output bytes to feed xterm.write(). */
  readonly data: string;
}

export interface SessionExitEvent {
  readonly worktreeId: string;
  readonly exitCode: number;
  readonly signal?: number;
}

export interface StartServerRequest {
  readonly worktreeId: string;
  /** Optional override; otherwise ServerManager auto-detects (gradlew vs npm). */
  readonly commandOverride?: string;
}

export interface StopServerRequest {
  /** Stops whatever single server is running; id is advisory. */
  readonly worktreeId?: string;
}

export interface MergeRequest {
  /** Worktree (feature) branch to merge. */
  readonly worktreeId: string;
  /** Target branch to merge INTO, e.g. 'main'. */
  readonly targetBranch: string;
  /** Run the MangoLove verify hook before merging (MVP item 5). */
  readonly runVerifyHook: boolean;
  /** Remove the worktree + delete branch after a successful merge. */
  readonly cleanup: boolean;
}

export type MergeStage = 'verify' | 'merge' | 'cleanup' | 'done';

export interface MergeProgressEvent {
  readonly worktreeId: string;
  readonly stage: MergeStage;
  readonly ok: boolean;
  readonly message: string;
}

export interface MergeResult {
  readonly worktreeId: string;
  readonly merged: boolean;
  readonly cleanedUp: boolean;
  /** Present when merged === false. */
  readonly error?: string;
}

/** Asked of the renderer at quit (MVP item 6): are turns in flight? */
export interface QuitWarningEvent {
  /** worktreeIds whose AgentSession.hasActiveTurn is true. */
  readonly activeWorktreeIds: readonly string[];
}

/** Generic OK/err envelope for invoke handlers that don't return data. */
export interface Ack {
  readonly ok: boolean;
  readonly error?: string;
}
```

---

## 4. IPC Contract — `src/shared/ipc-channels.ts` + `src/shared/ipc-contract.ts` — BINDING

### 4.1 Channel name constants (`ipc-channels.ts`)

```ts
// src/shared/ipc-channels.ts  —  the ONLY place channel strings are defined.
export const IPC = {
  // worktree CRUD (renderer -> main, invoke)
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_REMOVE: 'worktree:remove',

  // agent session (mixed)
  SESSION_SPAWN: 'session:spawn',     // invoke
  SESSION_INPUT: 'session:input',     // renderer -> main, fire-and-forget (on)
  SESSION_RESIZE: 'session:resize',   // renderer -> main, fire-and-forget (on)
  SESSION_KILL: 'session:kill',       // invoke
  SESSION_OUTPUT: 'session:output',   // main -> renderer, event
  SESSION_EXIT: 'session:exit',       // main -> renderer, event
  SESSION_STATUS: 'session:status',   // main -> renderer, event (AgentSession changed)

  // server (ONE at a time)
  SERVER_START: 'server:start',       // invoke
  SERVER_STOP: 'server:stop',         // invoke
  SERVER_STATUS: 'server:status',     // invoke (snapshot)
  SERVER_STATE: 'server:state',       // main -> renderer, event (ServerStatus changed)

  // logs
  LOG_LINE: 'log:line',               // main -> renderer, event (one LogLine)
  LOG_SNAPSHOT: 'log:snapshot',       // invoke (full ring buffer for current run)

  // merge + cleanup (MVP item 5)
  MERGE_RUN: 'merge:run',             // invoke
  MERGE_PROGRESS: 'merge:progress',   // main -> renderer, event

  // app quit warning (MVP item 6)
  APP_QUIT_WARNING: 'app:quit-warning',   // main -> renderer, event
  APP_QUIT_DECISION: 'app:quit-decision', // renderer -> main, invoke (user said quit/cancel)
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
```

### 4.2 Full channel table

| Channel const | Direction | Request payload | Response / Event payload |
|---|---|---|---|
| `WORKTREE_LIST` | renderer→main **invoke** | `void` | `Worktree[]` |
| `WORKTREE_CREATE` | renderer→main **invoke** | `CreateWorktreeRequest` | `Worktree` |
| `WORKTREE_REMOVE` | renderer→main **invoke** | `RemoveWorktreeRequest` | `Ack` |
| `SESSION_SPAWN` | renderer→main **invoke** | `SpawnSessionRequest` | `AgentSession` |
| `SESSION_INPUT` | renderer→main **on** (fire-and-forget) | `SessionInputRequest` | — |
| `SESSION_RESIZE` | renderer→main **on** | `SessionResizeRequest` | — |
| `SESSION_KILL` | renderer→main **invoke** | `{ worktreeId: string }` | `Ack` |
| `SESSION_OUTPUT` | main→renderer **event** | — | `SessionOutputEvent` |
| `SESSION_EXIT` | main→renderer **event** | — | `SessionExitEvent` |
| `SESSION_STATUS` | main→renderer **event** | — | `AgentSession` |
| `SERVER_START` | renderer→main **invoke** | `StartServerRequest` | `ServerStatus` |
| `SERVER_STOP` | renderer→main **invoke** | `StopServerRequest` | `ServerStatus` |
| `SERVER_STATUS` | renderer→main **invoke** | `void` | `ServerStatus` |
| `SERVER_STATE` | main→renderer **event** | — | `ServerStatus` |
| `LOG_LINE` | main→renderer **event** | — | `LogLine` |
| `LOG_SNAPSHOT` | renderer→main **invoke** | `void` | `LogLine[]` |
| `MERGE_RUN` | renderer→main **invoke** | `MergeRequest` | `MergeResult` |
| `MERGE_PROGRESS` | main→renderer **event** | — | `MergeProgressEvent` |
| `APP_QUIT_WARNING` | main→renderer **event** | — | `QuitWarningEvent` |
| `APP_QUIT_DECISION` | renderer→main **invoke** | `{ quit: boolean }` | `Ack` |

### 4.3 contextBridge API shape (`window.mango.*`)

Exposed by `src/preload/index.ts` via `contextBridge.exposeInMainWorld('mango', api)`.
Renderer NEVER touches `ipcRenderer` directly — only `window.mango`. Type lives in
`src/shared/ipc-contract.ts` and is the binding surface for all renderer hooks.

```ts
// src/shared/ipc-contract.ts
import type {
  Worktree, CreateWorktreeRequest, RemoveWorktreeRequest, Ack,
  AgentSession, SpawnSessionRequest, SessionInputRequest, SessionResizeRequest,
  SessionOutputEvent, SessionExitEvent,
  ServerStatus, StartServerRequest, StopServerRequest,
  LogLine, MergeRequest, MergeResult, MergeProgressEvent, QuitWarningEvent,
} from './types';

/** Unsubscribe handle returned by every on*() subscriber. */
export type Unsubscribe = () => void;

export interface MangoApi {
  worktree: {
    list(): Promise<Worktree[]>;
    create(req: CreateWorktreeRequest): Promise<Worktree>;
    remove(req: RemoveWorktreeRequest): Promise<Ack>;
  };
  session: {
    spawn(req: SpawnSessionRequest): Promise<AgentSession>;
    sendInput(req: SessionInputRequest): void;          // fire-and-forget
    resize(req: SessionResizeRequest): void;            // fire-and-forget
    kill(worktreeId: string): Promise<Ack>;
    onOutput(cb: (e: SessionOutputEvent) => void): Unsubscribe;
    onExit(cb: (e: SessionExitEvent) => void): Unsubscribe;
    onStatus(cb: (s: AgentSession) => void): Unsubscribe;
  };
  server: {
    start(req: StartServerRequest): Promise<ServerStatus>;
    stop(req: StopServerRequest): Promise<ServerStatus>;
    status(): Promise<ServerStatus>;
    onState(cb: (s: ServerStatus) => void): Unsubscribe;
  };
  logs: {
    snapshot(): Promise<LogLine[]>;
    onLine(cb: (line: LogLine) => void): Unsubscribe;
  };
  merge: {
    run(req: MergeRequest): Promise<MergeResult>;
    onProgress(cb: (e: MergeProgressEvent) => void): Unsubscribe;
  };
  app: {
    onQuitWarning(cb: (e: QuitWarningEvent) => void): Unsubscribe;
    sendQuitDecision(quit: boolean): Promise<Ack>;
  };
}

declare global {
  interface Window {
    readonly mango: MangoApi;
  }
}
```

> **before-quit PTY kill-sweep (CROSS-CUTTING MANDATORY):** independent of any IPC. In
> `src/main/index.ts`, `app.on('before-quit')` MUST call `sessionManager.killAll()` to terminate
> every node-pty child (prevents orphan `claude` processes). The `APP_QUIT_WARNING` round-trip only
> decides *whether* to proceed; the sweep itself is unconditional once quit is confirmed.

---

## 5. Build Order — the 6 plans (dependency graph)

```
Plan 0 (Scaffold + IPC spine)  ── foundation, everything depends on it
   │
   ├─► Plan 1 (Worktree CRUD)
   │       │
   │       ├─► Plan 2 (Agent terminal)         [needs a worktree to attach to]
   │       │       │
   │       │       └─► Plan 5 (Session persistence + quit sweep)  [needs sessions]
   │       │
   │       ├─► Plan 3 (Server start/stop + logs) [needs a worktree dir to run in]
   │       │
   │       └─► Plan 4 (Merge + cleanup)          [needs worktrees]
   │
   └─► Plan 4 (Sidebar status)  — also consumes Plan 2/3 status events
```

> Sidebar status (MVP item 4) is folded into each feature plan's status events plus a thin
> aggregation pass in **Plan 4** (it has nothing to show until 1/2/3 emit). Plans 1, 3, 4 can proceed
> in parallel once Plan 0 lands; Plan 2 unblocks Plan 5.

---

### Plan 0 — Scaffold + IPC Spine
- **id:** `p0-scaffold-ipc`
- **goal:** A launchable Electron window with a working, fully-typed IPC round-trip and node-pty rebuilt.
- **key files:** `electron.vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`,
  `tsconfig*.json`, `package.json` (with `postinstall: electron-rebuild -f -w node-pty`),
  `src/main/index.ts`, `src/main/ipc/register-ipc.ts`, `src/main/ipc/ipc-context.ts`,
  `src/preload/index.ts`, `src/renderer/{index.html,main.tsx,App.tsx}`,
  **ALL of `src/shared/{types.ts,ipc-channels.ts,ipc-contract.ts}`** (the contract from §3/§4 lands here),
  `tests/helpers/{temp-git-repo.ts,fake-pty.ts}`, `tests/main/ipc-roundtrip.test.ts`.
- **dependsOn:** none.
- **produces working software:** App launches a macOS window. A dev "ping" button in `App.tsx` calls a
  real round-trip channel (e.g. `WORKTREE_LIST` returning `[]`) through `window.mango`, proving
  preload contextBridge + typed IPC + main handler registration all work. `npm test` runs green in CI
  headless (managers absent yet, but the IPC-roundtrip + helper tests pass). `require('node-pty')` in
  main loads without ABI error (rebuild verified). **This is the spine — every other plan plugs in here.**

### Plan 1 — Worktree CRUD (MVP item 1)
- **id:** `p1-worktree-crud`
- **goal:** Create / list / remove git worktrees with base-branch selection, surfaced in the sidebar.
- **key files:** `src/main/managers/worktree-manager.ts`, wire `WORKTREE_*` in `register-ipc.ts`,
  `src/renderer/hooks/use-worktrees.ts`, `src/renderer/components/sidebar/{worktree-list,worktree-item}.tsx`,
  `src/renderer/components/toolbar/toolbar.tsx` (New worktree), `tests/main/worktree-manager.test.ts`.
- **dependsOn:** Plan 0.
- **produces working software:** From the UI you pick a base branch, create a worktree on a new branch,
  see it appear in the sidebar list, and remove it — backed by real `simple-git` worktree operations,
  unit-tested against a temp git repo.

### Plan 2 — Embedded Agent Terminal (MVP item 2)
- **id:** `p2-agent-terminal`
- **goal:** One embedded xterm.js terminal per worktree running the `claude` CLI via node-pty.
- **key files:** `src/main/managers/session-manager.ts`, `src/main/pty/pty-factory.ts`,
  wire `SESSION_*` in `register-ipc.ts`, `src/renderer/components/terminal/agent-terminal.tsx`
  (`@xterm/xterm` + `@xterm/addon-fit`), `src/renderer/hooks/use-session.ts`,
  `tests/main/session-manager.test.ts` (fake PtyFactory).
- **dependsOn:** Plan 0, Plan 1.
- **produces working software:** Selecting a worktree spawns `claude` in a real PTY; you type in the
  embedded terminal, see live output, resize works (addon-fit → `session:resize` → pty.resize), and
  killing the session terminates the process. Status events drive the sidebar agent indicator.

### Plan 3 — Local Server Start/Stop + Live Logs (MVP item 3)
- **id:** `p3-server-logs`
- **goal:** Start/stop ONE local server for the active worktree (auto-detect Spring gradlew vs npm) with a live, filterable log panel.
- **key files:** `src/main/managers/server-manager.ts`, `src/main/managers/log-store.ts`,
  `src/main/util/detect-runner.ts`, wire `SERVER_*`/`LOG_*` in `register-ipc.ts`,
  `src/renderer/components/logs/log-panel.tsx`, `src/renderer/lib/log-filter.ts`,
  `src/renderer/hooks/{use-server.ts,use-logs.ts}`,
  `tests/main/{server-manager.test.ts,log-store.test.ts,detect-runner.test.ts}`,
  `tests/renderer/log-filter.test.ts`.
- **dependsOn:** Plan 0, Plan 1.
- **produces working software:** Run/Stop in the toolbar starts the detected server (`./gradlew bootRun`
  or `npm run/start`) for the active worktree; stdout/stderr stream into the log panel with grep + level
  filtering; only one server runs at a time; sidebar shows server state.

### Plan 4 — Merge + Cleanup + Status Sidebar (MVP items 5 & 4)
- **id:** `p4-merge-cleanup-status`
- **goal:** Merge a worktree branch into a target with the MangoLove verify hook, then optionally clean up; aggregate all statuses in the sidebar.
- **key files:** `src/main/git/merge-runner.ts`, wire `MERGE_RUN`/`MERGE_PROGRESS` in `register-ipc.ts`,
  toolbar Merge button, `src/renderer/state/app-store.ts` (status aggregation of branch/agent/server),
  sidebar status badges, `tests/main/merge-runner.test.ts` (temp git repo + fake verify hook).
- **dependsOn:** Plan 0, Plan 1 (consumes Plan 2 & 3 status events for the sidebar).
- **produces working software:** Merge button runs verify → merge → cleanup with live `MERGE_PROGRESS`
  stages shown; on success the worktree/branch are removed. Sidebar shows per-worktree branch + agent +
  server status in one place.

### Plan 5 — Session Persistence b-lite + Quit Sweep (MVP item 6)
- **id:** `p5-session-persistence`
- **goal:** On restart, auto-respawn `claude --continue` per worktree that had a session; warn on quit if a turn is running; guarantee no orphan PTYs.
- **key files:** `src/main/managers/session-store.ts` (persist `SessionRecord[]` to userData JSON),
  hooks into `session-manager.ts` (track `hadActiveSession`/`hasActiveTurn`),
  `app.on('before-quit')` kill-sweep in `src/main/index.ts`, wire `APP_QUIT_WARNING`/`APP_QUIT_DECISION`,
  renderer quit-warning dialog, restart-rehydrate path (`spawn` with `continueSession: true`),
  `tests/main/session-store.test.ts`.
- **dependsOn:** Plan 0, Plan 2.
- **produces working software:** Quit + reopen: worktrees that had an agent get `claude --continue`
  auto-spawned (conversation rehydrated by claude from `~/.claude/projects/...`, app stores no
  conversation state). Quitting mid-turn shows a warning dialog. No `claude` processes survive quit
  (kill-sweep verified). The app stores ONLY `{worktreePath, branch, hadActiveSession}` — never
  conversation content.

---

## 6. Binding invariants (quick reference for all plans)

1. **Vite stays on 7** until electron-vite ships a Vite-8 major. plugin-react ≤ 5.x, vitest 4.x.
2. **node-pty is in `dependencies`** (not dev), externalized from the bundle, and rebuilt via
   `postinstall: electron-rebuild -f -w node-pty`. Never bundle the `.node` binary.
3. **`src/shared/` is types + string consts only** — no runtime, no node-only/DOM-only imports.
4. Renderer talks to main **only via `window.mango`** (the `MangoApi` shape). No raw `ipcRenderer`.
5. **One server, one PTY-per-worktree.** `ServerProcess.worktreeId` is the single-server owner.
6. **App stores no conversation state** — only `SessionRecord`. claude owns rehydration via `--continue`.
7. **before-quit kill-sweep is unconditional** once quit is confirmed (orphan-`claude` prevention).
8. **`any` is banned** (`unknown` or concrete types); files kebab-case; 2-space/single-quote/100-col.

Sources: [electron-vite](https://www.npmjs.com/package/electron-vite) · [@electron/rebuild](https://github.com/electron/rebuild) · [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) · [node-pty](https://github.com/microsoft/node-pty) · [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm) · live `npm view` version checks (2026-06-16).
```