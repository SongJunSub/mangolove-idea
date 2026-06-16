Greenfield repo, no package.json yet. The scaffolder would normally create into a new dir, but we already have the repo. I'll write the plan to scaffold into a temp dir and move files in (the standard electron-vite-into-existing-repo approach). Now I have enough to write the plan.

# MangoLove IDEA — Plan 0: Scaffold + IPC Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a launchable Electron + Vite + React + TypeScript app with a fully-typed `app:ping` IPC round-trip through preload `contextBridge`, node-pty rebuilt against Electron's ABI and provably loadable in the main process, and the Vitest + ESLint + Prettier toolchain green.

**Architecture:** Three first-class build targets via `electron-vite` (main / preload / renderer) plus a side-effect-free `src/shared/` layer holding all binding types + IPC channel constants. The renderer talks to main **only** through `window.mango` exposed by the preload `contextBridge`; main registers all handlers in one `register-ipc.ts`. node-pty stays in `dependencies`, is externalized from the bundle, and is rebuilt for the Electron ABI by a `postinstall` hook — proven by a smoke handler that `require`s it and returns its version.

**Tech Stack:** electron 42.4.0, electron-vite 5.0.0, @electron/rebuild 4.0.4, node-pty 1.1.0, react/react-dom 19.2.7, vite 7.3.5, @vitejs/plugin-react 5.1.0, vitest 4.1.9, typescript 5.7.x, eslint 9 + typescript-eslint 8.61.1, prettier 3.8.4, @types/node 22.19.21. Target: macOS.

---

## Scope (Plan 0 ONLY)

IN: project init; the three-target build config; `src/shared/{types.ts,ipc-channels.ts,ipc-contract.ts}` (the FULL contract from §3/§4 — every later plan imports these); preload `window.mango` skeleton with a real `app.ping()`; ONE typed IPC round-trip (`APP_PING`) end-to-end; node-pty native-rebuild + load smoke test; Vitest/ESLint/Prettier setup; one pure-function unit test; one windowless IPC-handler test; a React UI that calls `app.ping()` and shows the result.

OUT (do NOT touch — later plans): WorktreeManager, SessionManager, ServerManager, LogStore, MergeRunner, real PTY spawning, sidebar/terminal/log components, session persistence, quit sweep. We add **one** extra channel `APP_PING` not in the contract's §4 table because the contract's §5 Plan 0 explicitly calls for an `app:ping`-style probe; it lives alongside the binding channels and is the template every later plan copies.

---

## File Structure (created in this plan)

```
mangolove-idea/
├─ package.json                 # scripts incl. postinstall electron-rebuild; node-pty in deps
├─ electron.vite.config.ts      # main / preload / renderer targets
├─ vitest.config.ts             # 2 projects: node + jsdom
├─ eslint.config.js             # flat config, typescript-eslint
├─ .prettierrc.json
├─ tsconfig.json                # base, references the two below
├─ tsconfig.node.json           # main + preload + shared
├─ tsconfig.web.json            # renderer + shared
├─ README.md                    # native-rebuild + macOS notes (appended)
├─ src/
│  ├─ main/
│  │  ├─ index.ts               # BrowserWindow + wire IPC
│  │  ├─ ipc/register-ipc.ts    # ipcMain.handle for APP_PING (+ stubs later)
│  │  ├─ ipc/ipc-context.ts     # singletons + mainWindow ref
│  │  └─ pty/pty-factory.ts     # node-pty require + version probe (smoke for the trap)
│  ├─ preload/index.ts          # contextBridge window.mango
│  ├─ renderer/
│  │  ├─ index.html
│  │  ├─ main.tsx
│  │  ├─ App.tsx
│  │  └─ lib/format-versions.ts # pure fn (unit tested)
│  └─ shared/
│     ├─ types.ts               # ALL §3 types (BINDING)
│     ├─ ipc-channels.ts        # ALL §4 channel consts (BINDING) + APP_PING
│     └─ ipc-contract.ts        # MangoApi (BINDING) + AppInfo
└─ tests/
   ├─ main/ipc-roundtrip.test.ts # APP_PING handler, no window
   ├─ renderer/format-versions.test.ts
   └─ helpers/                   # placeholders created here, filled by later plans
      ├─ temp-git-repo.ts
      └─ fake-pty.ts
```

---

## Task 1: Initialize the project skeleton & pin every dependency

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/package.json`

The repo already exists (git initialized, has README/.gitignore). We do NOT run `npm create electron-vite` into it (it refuses non-empty dirs and would clobber git history). Instead we hand-write the exact `package.json` from the contract's version matrix and add files ourselves. This is deterministic and matches the binding versions precisely.

- [ ] **Step 1: Confirm tooling versions present**

Run:
```bash
node -v && npm -v
```
Expected: any Node satisfying the electron-vite engine floor `^20.19 || >=22.12` — e.g. `20.19+`, `22.x`, or newer such as `25.x`. Node 25 is fine (engines satisfied); no version switch is required. Only if Node is BELOW the floor, switch first (`nvm use 22` for an LTS line). npm `10.x`+.

- [ ] **Step 2: Write `package.json`**

Create `/Users/ltm-luan/Project/mangolove-idea/package.json`:
```json
{
  "name": "mangolove-idea",
  "version": "0.1.0",
  "description": "Local dev orchestrator for parallel git-worktree work beside IntelliJ IDEA.",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "engines": {
    "node": "^20.19.0 || >=22.12.0"
  },
  "scripts": {
    "postinstall": "electron-rebuild -f -w node-pty",
    "rebuild": "electron-rebuild -f -w node-pty",
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck:node": "tsc -p tsconfig.node.json --noEmit",
    "typecheck:web": "tsc -p tsconfig.web.json --noEmit",
    "typecheck": "npm run typecheck:node && npm run typecheck:web",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run"
  },
  "dependencies": {
    "@xterm/addon-fit": "0.11.0",
    "@xterm/xterm": "6.0.0",
    "node-pty": "1.1.0",
    "simple-git": "3.36.0"
  },
  "devDependencies": {
    "@electron/rebuild": "4.0.4",
    "@types/node": "22.19.21",
    "@types/react": "19.2.7",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "5.1.0",
    "electron": "42.4.0",
    "electron-vite": "5.0.0",
    "eslint": "9.39.4",
    "eslint-config-prettier": "10.1.8",
    "jsdom": "27.1.0",
    "prettier": "3.8.4",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "typescript": "5.7.3",
    "typescript-eslint": "8.61.1",
    "vite": "7.3.5",
    "vitest": "4.1.9"
  }
}
```

> Note: `react`/`react-dom` are in `devDependencies` because electron-vite bundles the renderer — they are not loaded from `node_modules` at runtime. `node-pty` MUST stay in `dependencies` (externalized, loaded from disk at runtime, rebuilt by postinstall). The `@types/*` packages are **independently versioned — do NOT assume `react` and `react-dom` share a patch.** Verified-published pins: `@types/react@19.2.7` (exists) + `@types/react-dom@19.2.3` (latest in the 19.2 line; `19.2.7` is NOT published and 404s). Re-check with `npm view @types/react-dom version` if bumping.

- [ ] **Step 3: Pre-empt the postinstall trap for the FIRST install**

`postinstall` runs `electron-rebuild`, which needs `electron` already present. On a clean install, npm installs deps first then runs `postinstall`, so Electron IS present — fine. But if any single dep fails to resolve, the whole install aborts before postinstall. Install with the lifecycle deferred once, then rebuild explicitly so failures are isolated and legible:

Run:
```bash
npm install --ignore-scripts
```
Expected: `added NNN packages` with no `NODE_MODULE_VERSION` noise (scripts skipped, so no rebuild yet). If any version 404s, fix that single pin and re-run before proceeding.

- [ ] **Step 4: Verify Electron resolved at the pinned version**

Run:
```bash
node -e "console.log(require('electron/package.json').version)"
```
Expected: `42.4.0`.

- [ ] **Step 5: Commit the lockfile + manifest (no rebuild yet)**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add package.json package-lock.json && git commit -m "chore: pin Plan-0 dependency matrix (electron-vite 5 / vite 7 / node-pty 1.1)"
```

---

## Task 2: TypeScript project configs (node + web + base)

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/tsconfig.json`
- Create: `/Users/ltm-luan/Project/mangolove-idea/tsconfig.node.json`
- Create: `/Users/ltm-luan/Project/mangolove-idea/tsconfig.web.json`

- [ ] **Step 1: Write base `tsconfig.json`**

Create `/Users/ltm-luan/Project/mangolove-idea/tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

- [ ] **Step 2: Write `tsconfig.node.json` (main + preload + shared + tests)**

Create `/Users/ltm-luan/Project/mangolove-idea/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "outDir": "out/types-node"
  },
  "include": [
    "src/main/**/*.ts",
    "src/preload/**/*.ts",
    "src/shared/**/*.ts",
    "tests/main/**/*.ts",
    "tests/helpers/**/*.ts",
    "electron.vite.config.ts",
    "vitest.config.ts"
  ]
}
```

- [ ] **Step 3: Write `tsconfig.web.json` (renderer + shared)**

Create `/Users/ltm-luan/Project/mangolove-idea/tsconfig.web.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "outDir": "out/types-web"
  },
  "include": [
    "src/renderer/**/*.ts",
    "src/renderer/**/*.tsx",
    "src/shared/**/*.ts",
    "src/preload/index.d.ts",
    "tests/renderer/**/*.ts"
  ]
}
```

> `types: ["node"]` in the web config is intentional: the renderer config also type-checks `src/shared`, which is consumed by main; keeping `node` types available avoids spurious errors on shared files. `src/shared` never *imports* node — it's types only — so this is harmless.

- [ ] **Step 4: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add tsconfig.json tsconfig.node.json tsconfig.web.json && git commit -m "chore: add referenced tsconfig (node + web + base)"
```

---

## Task 3: Lint + format config (Google TS style)

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/.prettierrc.json`
- Create: `/Users/ltm-luan/Project/mangolove-idea/.prettierignore`
- Create: `/Users/ltm-luan/Project/mangolove-idea/eslint.config.js`

- [ ] **Step 1: Write `.prettierrc.json`**

Create `/Users/ltm-luan/Project/mangolove-idea/.prettierrc.json`:
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

- [ ] **Step 2: Write `.prettierignore`**

Create `/Users/ltm-luan/Project/mangolove-idea/.prettierignore`:
```
out
dist
node_modules
package-lock.json
# Prose docs are hand-written Korean (README, design/plan docs incl. CJK-aligned
# tables Prettier would reflow). Exclude from the format gate so `format:check`
# reflects SOURCE formatting only. The pre-existing README.md already violates
# Prettier defaults — without this, Task 10's `format:check` gate fails on prose.
*.md
```

- [ ] **Step 3: Write `eslint.config.js` (flat config)**

Create `/Users/ltm-luan/Project/mangolove-idea/eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['out', 'dist', 'node_modules', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
      '@typescript-eslint/prefer-readonly': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
);
```

> `prefer-readonly` is a type-checked rule requiring `parserOptions.project`; we keep it `off` in Plan 0 to avoid wiring the typed-lint project graph before there are class members to lint. It's reintroduced when managers land. `@eslint/js` ships transitively with `eslint@9.39.4` (verified: `require('@eslint/js/package.json').version === '9.39.4'`), so `import js from '@eslint/js'` works as written; if `eslint .` ever reports it unresolved, add `"@eslint/js": "9.39.4"` (same version as `eslint`) to devDependencies and `npm i --ignore-scripts`.

- [ ] **Step 4: Sanity-check ESLint loads (will report no files yet)**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx eslint --version
```
Expected: `v9.x`. (Running `eslint .` now would pass trivially with no source; we lint for real after Task 5.)

- [ ] **Step 5: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add .prettierrc.json .prettierignore eslint.config.js && git commit -m "chore: add ESLint 9 flat config + Prettier (Google TS style)"
```

---

## Task 4: The BINDING shared contract (`src/shared/`)

This task transcribes §3 and §4 of the architecture contract verbatim. These three files are imported by every later plan. They contain **zero runtime side effects** and **zero node/DOM imports**.

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/shared/types.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/shared/ipc-channels.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/shared/ipc-contract.ts`

- [ ] **Step 1: Write `src/shared/types.ts` (ALL §3 types, verbatim, + AppInfo)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/shared/types.ts`:
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
  readonly ts: number; // epoch ms
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

/**
 * Plan-0 IPC probe payload: proves the typed round-trip + native-rebuild story.
 * Returned by the APP_PING channel. NOT part of any MVP feature — it is the
 * template every later plan's invoke handler copies.
 */
export interface AppInfo {
  /** Electron app version (app.getVersion()). */
  readonly appVersion: string;
  /** process.versions.electron in main. */
  readonly electronVersion: string;
  /** process.versions.node in main. */
  readonly nodeVersion: string;
  /** process.versions.chrome in main. */
  readonly chromeVersion: string;
  /** node-pty package version, resolved by requiring it in main (the ABI trap probe). */
  readonly nodePtyVersion: string;
  /** True if `require('node-pty')` loaded without an ABI mismatch error. */
  readonly nodePtyLoaded: boolean;
}
```

- [ ] **Step 2: Write `src/shared/ipc-channels.ts` (§4.1 verbatim + APP_PING)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/shared/ipc-channels.ts`:
```ts
// src/shared/ipc-channels.ts  —  the ONLY place channel strings are defined.
export const IPC = {
  // Plan-0 probe (renderer -> main, invoke). Template every later channel copies.
  APP_PING: 'app:ping',

  // worktree CRUD (renderer -> main, invoke)
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_REMOVE: 'worktree:remove',

  // agent session (mixed)
  SESSION_SPAWN: 'session:spawn', // invoke
  SESSION_INPUT: 'session:input', // renderer -> main, fire-and-forget (on)
  SESSION_RESIZE: 'session:resize', // renderer -> main, fire-and-forget (on)
  SESSION_KILL: 'session:kill', // invoke
  SESSION_OUTPUT: 'session:output', // main -> renderer, event
  SESSION_EXIT: 'session:exit', // main -> renderer, event
  SESSION_STATUS: 'session:status', // main -> renderer, event (AgentSession changed)

  // server (ONE at a time)
  SERVER_START: 'server:start', // invoke
  SERVER_STOP: 'server:stop', // invoke
  SERVER_STATUS: 'server:status', // invoke (snapshot)
  SERVER_STATE: 'server:state', // main -> renderer, event (ServerStatus changed)

  // logs
  LOG_LINE: 'log:line', // main -> renderer, event (one LogLine)
  LOG_SNAPSHOT: 'log:snapshot', // invoke (full ring buffer for current run)

  // merge + cleanup (MVP item 5)
  MERGE_RUN: 'merge:run', // invoke
  MERGE_PROGRESS: 'merge:progress', // main -> renderer, event

  // app quit warning (MVP item 6)
  APP_QUIT_WARNING: 'app:quit-warning', // main -> renderer, event
  APP_QUIT_DECISION: 'app:quit-decision', // renderer -> main, invoke (user said quit/cancel)
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
```

- [ ] **Step 3: Write `src/shared/ipc-contract.ts` (§4.3 MangoApi verbatim + app.ping)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/shared/ipc-contract.ts`:
```ts
// src/shared/ipc-contract.ts
import type {
  Worktree,
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Ack,
  AgentSession,
  SpawnSessionRequest,
  SessionInputRequest,
  SessionResizeRequest,
  SessionOutputEvent,
  SessionExitEvent,
  ServerStatus,
  StartServerRequest,
  StopServerRequest,
  LogLine,
  MergeRequest,
  MergeResult,
  MergeProgressEvent,
  QuitWarningEvent,
  AppInfo,
} from './types';

/** Unsubscribe handle returned by every on*() subscriber. */
export type Unsubscribe = () => void;

export interface MangoApi {
  app: {
    /** Plan-0 probe: typed round-trip + node-pty load report. */
    ping(): Promise<AppInfo>;
    onQuitWarning(cb: (e: QuitWarningEvent) => void): Unsubscribe;
    sendQuitDecision(quit: boolean): Promise<Ack>;
  };
  worktree: {
    list(): Promise<Worktree[]>;
    create(req: CreateWorktreeRequest): Promise<Worktree>;
    remove(req: RemoveWorktreeRequest): Promise<Ack>;
  };
  session: {
    spawn(req: SpawnSessionRequest): Promise<AgentSession>;
    sendInput(req: SessionInputRequest): void; // fire-and-forget
    resize(req: SessionResizeRequest): void; // fire-and-forget
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
}

declare global {
  interface Window {
    readonly mango: MangoApi;
  }
}
```

> The contract's §4.3 placed `app` last; we keep `app` first here purely for readability of the Plan-0 probe — property order in an interface is not semantically binding. All member names/signatures are verbatim. `app.onQuitWarning`/`sendQuitDecision` are declared now (binding surface) but only **wired** in Plan 5; in Plan 0 the preload exposes safe stubs (Task 7) so `tsc` and the contextBridge shape are correct from day one.

- [ ] **Step 4: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/shared && git commit -m "feat(shared): land BINDING contract (types + ipc channels + MangoApi)"
```

---

## Task 5: Pure renderer fn + its unit test (TDD), and wire Vitest

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/vitest.config.ts`
- Test: `/Users/ltm-luan/Project/mangolove-idea/tests/renderer/format-versions.test.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/renderer/lib/format-versions.ts`

- [ ] **Step 1: Write `vitest.config.ts` (two projects)**

Create `/Users/ltm-luan/Project/mangolove-idea/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/main/**/*.test.ts'],
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.ts'],
        },
      },
    ],
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `/Users/ltm-luan/Project/mangolove-idea/tests/renderer/format-versions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatVersions } from '../../src/renderer/lib/format-versions';
import type { AppInfo } from '../../src/shared/types';

const sample: AppInfo = {
  appVersion: '0.1.0',
  electronVersion: '42.4.0',
  nodeVersion: '22.12.0',
  chromeVersion: '136.0.0.0',
  nodePtyVersion: '1.1.0',
  nodePtyLoaded: true,
};

describe('formatVersions', () => {
  it('renders each version on its own line in a fixed order', () => {
    expect(formatVersions(sample)).toBe(
      [
        'app 0.1.0',
        'electron 42.4.0',
        'node 22.12.0',
        'chrome 136.0.0.0',
        'node-pty 1.1.0 (loaded)',
      ].join('\n'),
    );
  });

  it('marks node-pty as FAILED when it did not load', () => {
    const broken: AppInfo = { ...sample, nodePtyLoaded: false, nodePtyVersion: 'unknown' };
    expect(formatVersions(broken)).toContain('node-pty unknown (FAILED)');
  });
});
```

- [ ] **Step 3: Run the test, watch it fail**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/renderer/format-versions.test.ts
```
Expected: FAIL — `Failed to resolve import ".../format-versions"` (module does not exist yet).

- [ ] **Step 4: Implement the minimal pure function**

Create `/Users/ltm-luan/Project/mangolove-idea/src/renderer/lib/format-versions.ts`:
```ts
import type { AppInfo } from '../../shared/types';

/**
 * Pure formatter for the Plan-0 ping result. One `name version` per line, fixed
 * order; node-pty line is annotated (loaded)/(FAILED) so the ABI trap is visible.
 */
export function formatVersions(info: AppInfo): string {
  const ptyFlag = info.nodePtyLoaded ? 'loaded' : 'FAILED';
  return [
    `app ${info.appVersion}`,
    `electron ${info.electronVersion}`,
    `node ${info.nodeVersion}`,
    `chrome ${info.chromeVersion}`,
    `node-pty ${info.nodePtyVersion} (${ptyFlag})`,
  ].join('\n');
}
```

- [ ] **Step 5: Run the test, watch it pass**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/renderer/format-versions.test.ts
```
Expected: PASS — `2 passed`.

- [ ] **Step 6: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add vitest.config.ts tests/renderer/format-versions.test.ts src/renderer/lib/format-versions.ts && git commit -m "test(renderer): formatVersions pure fn + Vitest two-project config"
```

---

## Task 6: node-pty load probe (the ABI trap) + native rebuild

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/main/pty/pty-factory.ts`

node-pty is our highest-risk native dependency, but the risk is **smaller than the old NAN-era folklore** — verify, don't assume. **Empirically confirmed for `node-pty@1.1.0`:** it ships as **N-API / node-addon-api with prebuilt binaries** (`prebuilds/darwin-arm64/pty.node`), which are **ABI-stable across Node and Electron**. It `require()`s cleanly under both plain Node and Electron 42 **without any rebuild** — an un-rebuilt load does NOT throw `NODE_MODULE_VERSION`. So `electron-rebuild` here is **harmless defense-in-depth**: it compiles a `build/Release/pty.node` that takes precedence over the prebuild, guaranteeing a binary matched to exactly this Electron even if a future node-pty drops prebuilds for our arch. We (a) run the rebuild (it succeeds and is cheap insurance), (b) write a `probeNodePty()` the ping handler calls as a **runtime health check** (is the addon loadable at all?) — NOT as proof that the rebuild specifically ran (it reports `(loaded)` even with no rebuild, because the prebuild works).

- [ ] **Step 1: Run the native rebuild against Electron**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run rebuild
```
Expected: output ending roughly with `✔ Rebuild Complete`. It downloads Electron 42 headers and recompiles `node-pty`. If it errors with `command not found: electron-rebuild`, run `npm install --ignore-scripts` again (the `@electron/rebuild` bin lives in `node_modules/.bin`). If it errors needing Xcode CLT, run `xcode-select --install` then retry.

- [ ] **Step 2: Confirm a rebuilt `.node` binary exists**

Run:
```bash
find /Users/ltm-luan/Project/mangolove-idea/node_modules/node-pty/build -name '*.node'
```
Expected: at least one path like `.../build/Release/pty.node` (the rebuild output that now shadows the shipped `prebuilds/darwin-arm64/pty.node`). Note: `node -e "require('node-pty')"` under plain Node **loads fine** (N-API prebuild, ABI-stable) — it does NOT throw `NODE_MODULE_VERSION`. The rebuild just pins a binary to this exact Electron; it loads in Electron in Task 9 either way.

- [ ] **Step 3: Write `pty-factory.ts` (probe only — no PTY spawning in Plan 0)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/main/pty/pty-factory.ts`:
```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface NodePtyProbe {
  readonly version: string;
  readonly loaded: boolean;
}

/**
 * Plan-0 node-pty health probe. Attempts to load node-pty (an N-API native addon
 * with ABI-stable prebuilds) and report its version. node-pty 1.1.0 normally loads
 * via its prebuild even without a rebuild; a failure in a real Electron run means
 * the addon is genuinely unloadable for this platform/Electron — re-run
 * `npm run rebuild` and check Xcode CLT. Spawning actual PTYs is Plan 2, not here.
 */
export function probeNodePty(): NodePtyProbe {
  try {
    // Touch the addon so an ABI mismatch surfaces as a throw, not a lazy crash.
    require('node-pty');
    const version: string = require('node-pty/package.json').version;
    return { version, loaded: true };
  } catch {
    return { version: 'unknown', loaded: false };
  }
}
```

> We deliberately `require` node-pty (CJS native addon) via `createRequire` rather than `import`, because it must NOT be bundled and is externalized at runtime. We swallow the error into `{ loaded: false }` rather than crashing the app — the UI surfaces "FAILED" so the trap is diagnosable instead of fatal.

- [ ] **Step 4: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/main/pty/pty-factory.ts && git commit -m "feat(main): node-pty rebuilt for Electron ABI + load probe (the trap)"
```

---

## Task 7: Preload contextBridge — `window.mango`

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/preload/index.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/preload/index.d.ts`

Plan 0 implements `app.ping` for real; every other `MangoApi` member is a typed stub that throws a clear "not implemented until Plan N" error or returns an inert unsubscribe. This makes the contextBridge shape complete and `tsc`-correct now, so later plans only fill bodies — they never change the surface.

- [ ] **Step 1: Write `src/preload/index.ts`**

Create `/Users/ltm-luan/Project/mangolove-idea/src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { MangoApi, Unsubscribe } from '../shared/ipc-contract';

/** Subscribe to a main->renderer event channel; returns an unsubscribe handle. */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** Marker for surfaces not yet wired in Plan 0. Keeps the shape complete + honest. */
function notYet(plan: string): never {
  throw new Error(`mango: this API lands in Plan ${plan}, not Plan 0`);
}

const api: MangoApi = {
  app: {
    ping: () => ipcRenderer.invoke(IPC.APP_PING),
    onQuitWarning: (cb) => subscribe(IPC.APP_QUIT_WARNING, cb), // wired in Plan 5
    sendQuitDecision: (quit) => ipcRenderer.invoke(IPC.APP_QUIT_DECISION, { quit }),
  },
  worktree: {
    list: () => ipcRenderer.invoke(IPC.WORKTREE_LIST),
    create: () => notYet('1'),
    remove: () => notYet('1'),
  },
  session: {
    spawn: () => notYet('2'),
    sendInput: () => notYet('2'),
    resize: () => notYet('2'),
    kill: () => notYet('2'),
    onOutput: (cb) => subscribe(IPC.SESSION_OUTPUT, cb),
    onExit: (cb) => subscribe(IPC.SESSION_EXIT, cb),
    onStatus: (cb) => subscribe(IPC.SESSION_STATUS, cb),
  },
  server: {
    start: () => notYet('3'),
    stop: () => notYet('3'),
    status: () => notYet('3'),
    onState: (cb) => subscribe(IPC.SERVER_STATE, cb),
  },
  logs: {
    snapshot: () => notYet('3'),
    onLine: (cb) => subscribe(IPC.LOG_LINE, cb),
  },
  merge: {
    run: () => notYet('4'),
    onProgress: (cb) => subscribe(IPC.MERGE_PROGRESS, cb),
  },
};

contextBridge.exposeInMainWorld('mango', api);
```

> `WORKTREE_LIST` is wired to a real `invoke` now (not `notYet`) because the contract's §5 Plan-0 acceptance lets the renderer prove the round-trip via `worktree:list` returning `[]`. The main handler (Task 8) returns `[]` until Plan 1 supplies a manager. The `app.ping` probe is the primary Plan-0 demo; `worktree:list` is the secondary one named in the contract.

- [ ] **Step 2: Write `src/preload/index.d.ts`**

Create `/Users/ltm-luan/Project/mangolove-idea/src/preload/index.d.ts`:
```ts
// Re-exports the global Window augmentation so the renderer sees window.mango.
import '../shared/ipc-contract';
```

- [ ] **Step 3: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/preload && git commit -m "feat(preload): expose window.mango contextBridge (app.ping real, rest stubbed)"
```

---

## Task 8: Main-process IPC handlers + windowless handler test (TDD)

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/main/ipc/ipc-context.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/main/ipc/register-ipc.ts`
- Test: `/Users/ltm-luan/Project/mangolove-idea/tests/main/ipc-roundtrip.test.ts`

We split the handler **logic** (a pure function `buildAppInfo()`) from `ipcMain.handle` registration, so we can test the logic without booting Electron. This is the windowless-IPC-test pattern from contract §1.4.

- [ ] **Step 1: Write `ipc-context.ts` (singleton holder; empty in Plan 0)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/main/ipc/ipc-context.ts`:
```ts
import type { BrowserWindow } from 'electron';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 0 only needs the window ref; managers are added by later plans.
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
```

- [ ] **Step 2: Write the failing handler-logic test (no window)**

Create `/Users/ltm-luan/Project/mangolove-idea/tests/main/ipc-roundtrip.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildAppInfo, registerIpc } from '../../src/main/ipc/register-ipc';

describe('buildAppInfo', () => {
  it('assembles AppInfo from injected version sources + node-pty probe', () => {
    const info = buildAppInfo(
      { getVersion: () => '0.1.0' },
      {
        electron: '42.4.0',
        node: '22.12.0',
        chrome: '136.0.0.0',
      },
      () => ({ version: '1.1.0', loaded: true }),
    );
    expect(info).toEqual({
      appVersion: '0.1.0',
      electronVersion: '42.4.0',
      nodeVersion: '22.12.0',
      chromeVersion: '136.0.0.0',
      nodePtyVersion: '1.1.0',
      nodePtyLoaded: true,
    });
  });

  it('reports a failed node-pty probe without throwing', () => {
    const info = buildAppInfo(
      { getVersion: () => '0.1.0' },
      { electron: '42.4.0', node: '22.12.0', chrome: '136.0.0.0' },
      () => ({ version: 'unknown', loaded: false }),
    );
    expect(info.nodePtyLoaded).toBe(false);
    expect(info.nodePtyVersion).toBe('unknown');
  });
});

describe('registerIpc', () => {
  it('registers a handler for app:ping that returns AppInfo', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
    };

    registerIpc(ipcMain as never, { mainWindow: null });

    expect(handlers.has('app:ping')).toBe(true);
    const pingResult = (await handlers.get('app:ping')!({})) as { electronVersion: string };
    expect(typeof pingResult.electronVersion).toBe('string');
  });

  it('registers a handler for worktree:list that returns []', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
    };
    registerIpc(ipcMain as never, { mainWindow: null });
    const list = await handlers.get('worktree:list')!({});
    expect(list).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it, watch it fail**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/main/ipc-roundtrip.test.ts
```
Expected: FAIL — cannot resolve `../../src/main/ipc/register-ipc` (not written yet).

- [ ] **Step 4: Implement `register-ipc.ts`**

Create `/Users/ltm-luan/Project/mangolove-idea/src/main/ipc/register-ipc.ts`:
```ts
import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { AppInfo, Worktree } from '../../shared/types';
import { probeNodePty, type NodePtyProbe } from '../pty/pty-factory';
import type { IpcContext } from './ipc-context';

/** Minimal slice of Electron `app` we depend on (keeps the logic testable). */
interface AppLike {
  getVersion(): string;
}

/** Minimal slice of `process.versions` we depend on. */
interface VersionsLike {
  readonly electron?: string;
  readonly node?: string;
  readonly chrome?: string;
}

/**
 * Pure assembler for the Plan-0 ping payload. Injected dependencies make it
 * testable without booting Electron (contract §1.4 windowless IPC test).
 */
export function buildAppInfo(
  app: AppLike,
  versions: VersionsLike,
  probe: () => NodePtyProbe,
): AppInfo {
  const pty = probe();
  return {
    appVersion: app.getVersion(),
    electronVersion: versions.electron ?? 'unknown',
    nodeVersion: versions.node ?? 'unknown',
    chromeVersion: versions.chrome ?? 'unknown',
    nodePtyVersion: pty.version,
    nodePtyLoaded: pty.loaded,
  };
}

/**
 * Registers ALL main-process IPC handlers in one place. Plan 0 wires the
 * `app:ping` probe and a `worktree:list` stub returning []. Later plans add
 * their handlers here, delegating to managers held on `ctx`.
 */
export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  void ctx; // managers attach here in later plans

  ipcMain.handle(IPC.APP_PING, async (): Promise<AppInfo> => {
    // Lazy import of Electron `app` keeps this module importable under plain
    // Node in tests; registerIpc is only CALLED from the real main process.
    const { app } = await import('electron');
    return buildAppInfo(app, process.versions, probeNodePty);
  });

  ipcMain.handle(IPC.WORKTREE_LIST, async (): Promise<Worktree[]> => {
    return []; // real WorktreeManager arrives in Plan 1
  });
}
```

> `buildAppInfo` is the unit under test (pure, injected deps). `registerIpc`'s `app:ping` body uses a dynamic `import('electron')` so importing this module in Vitest's node project never pulls the Electron binary; the test exercises registration + the stub handlers, while the real version-gathering is covered by the `buildAppInfo` tests.

- [ ] **Step 5: Run it, watch it pass**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/main/ipc-roundtrip.test.ts
```
Expected: PASS — `4 passed`.

- [ ] **Step 6: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/main/ipc tests/main/ipc-roundtrip.test.ts && git commit -m "feat(main): register-ipc with app:ping probe + worktree:list stub (TDD)"
```

---

## Task 9: Main entry, renderer UI, build config — launch the window

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/electron.vite.config.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/main/index.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/renderer/index.html`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/renderer/main.tsx`
- Create: `/Users/ltm-luan/Project/mangolove-idea/src/renderer/App.tsx`

- [ ] **Step 1: Write `electron.vite.config.ts` (three targets, externalize deps)**

Create `/Users/ltm-luan/Project/mangolove-idea/electron.vite.config.ts`:
```ts
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps node-pty (and all `dependencies`) OUT of the
    // bundle, so the rebuilt .node binary loads from node_modules at runtime.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
    plugins: [react()],
  },
});
```

- [ ] **Step 2: Write `src/main/index.ts` (BrowserWindow + wire IPC)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/main/index.ts`:
```ts
import { resolve } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';

const ctx = createIpcContext();

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

app.whenReady().then(() => {
  registerIpc(ipcMain, ctx);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

> `sandbox: false` is required so the preload can reach Node built-ins. The before-quit PTY kill-sweep (contract §4) is NOT added in Plan 0 — there are no PTYs yet; it lands in Plan 5. Adding it now would reference a SessionManager that doesn't exist (YAGNI).
>
> **ESM breadcrumb (two coupled facts):** because `package.json` has `"type": "module"`, electron-vite 5 emits the main bundle as ESM (so `import.meta.dirname` is valid here — under a CJS main you'd use `__dirname` instead) **and emits the preload as `out/preload/index.mjs`** (NOT `index.js`) — which is why the `preload:` path above ends in `.mjs`. Verified against a real electron-vite build. If you ever drop `"type": "module"`, both the `import.meta.dirname` usages and the `.mjs` preload path must change together.

- [ ] **Step 3: Write `src/renderer/index.html`**

Create `/Users/ltm-luan/Project/mangolove-idea/src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    />
    <title>MangoLove IDEA</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Write `src/renderer/main.tsx`**

Create `/Users/ltm-luan/Project/mangolove-idea/src/renderer/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Write `src/renderer/App.tsx` (the ping round-trip UI)**

Create `/Users/ltm-luan/Project/mangolove-idea/src/renderer/App.tsx`:
```tsx
import { useCallback, useState } from 'react';
import type { AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPing = useCallback(async () => {
    setError(null);
    try {
      const result = await window.mango.app.ping();
      setInfo(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 0 spine: typed IPC round-trip + node-pty ABI probe.</p>
      <button type="button" onClick={onPing}>
        Ping main
      </button>
      {error && <pre style={{ color: 'crimson' }}>error: {error}</pre>}
      {info && (
        <pre data-testid="ping-result" style={{ marginTop: 16 }}>
          {formatVersions(info)}
        </pre>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Typecheck everything**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck
```
Expected: no output, exit 0. If `React.JSX.Element` errors, ensure `@types/react@19.2.x` is installed; if `import.meta.dirname` errors, confirm `tsconfig.node.json` `target` is `ES2022` and `@types/node@22.x` is present.

- [ ] **Step 7: Lint + format-check the whole source**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run lint && npm run format:check
```
Expected: ESLint exits 0; Prettier reports `All matched files use Prettier code style!`. If Prettier complains, run `npm run format` and re-stage.

- [ ] **Step 8: Production build (proves all three targets bundle)**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run build
```
Expected: electron-vite builds `main`, `preload`, `renderer` into `out/` with no errors, and node-pty is reported as externalized (not bundled).

- [ ] **Step 9: Launch the app and prove the round-trip (manual smoke — THE acceptance)**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run dev
```
Expected: a macOS window titled "MangoLove IDEA" appears. Click **Ping main**. The `<pre>` shows five lines — `app`, `electron`, `node`, `chrome`, `node-pty` — each with a **non-empty** value. The exact numbers are environment-dependent (whatever Chromium/Node Electron 42 embeds, NOT your system Node), so do NOT assert specific versions. Shape only:
```
app <ver>
electron <ver>
node <ver>
chrome <ver>
node-pty <ver> (loaded)
```
The critical assertion is the **`(loaded)`** suffix on the `node-pty` line — it proves the native addon is loadable in the Electron main process (the spine's hardest dependency works). It does NOT by itself prove the rebuild ran (node-pty's prebuild also yields `(loaded)`); it's a health check, not a rebuild receipt. If it shows `(FAILED)`, the addon is genuinely unloadable — run `npm run rebuild` (and `xcode-select --install` if needed), then `npm run dev` again. Quit with Cmd-Q.

- [ ] **Step 10: Add `out/` ignore guard (if missing)**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && grep -qxF 'out' .gitignore || printf '\nout\n' >> .gitignore
```
Expected: `.gitignore` contains `out` and `node_modules` (the existing `.gitignore` likely already ignores `node_modules`; verify).

- [ ] **Step 11: Commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add electron.vite.config.ts src/main/index.ts src/renderer .gitignore && git commit -m "feat: launchable window with app.ping round-trip (node-pty proven loaded)"
```

---

## Task 10: Test-helper placeholders, full green gate, README, final commit

**Files:**
- Create: `/Users/ltm-luan/Project/mangolove-idea/tests/helpers/temp-git-repo.ts`
- Create: `/Users/ltm-luan/Project/mangolove-idea/tests/helpers/fake-pty.ts`
- Modify: `/Users/ltm-luan/Project/mangolove-idea/README.md`

The contract lists these helpers under Plan 0's key files. We create minimal, typed, **used-by-later-plans** skeletons so the file tree matches the contract and `tsc` stays green — without implementing features they belong to.

- [ ] **Step 1: Write `tests/helpers/temp-git-repo.ts` (used by Plan 1+)**

Create `/Users/ltm-luan/Project/mangolove-idea/tests/helpers/temp-git-repo.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

/** A throwaway git repo in os.tmpdir() for manager tests (Plan 1+). */
export interface TempGitRepo {
  readonly dir: string;
  readonly git: SimpleGit;
  cleanup(): void;
}

/**
 * Creates an initialized git repo with one commit on `main` in a temp dir.
 * Caller MUST invoke cleanup() (e.g. in afterEach) to remove it.
 */
export async function makeTempGitRepo(): Promise<TempGitRepo> {
  const dir = mkdtempSync(join(tmpdir(), 'mango-git-'));
  const git = simpleGit(dir);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.email', 'test@mango.local');
  await git.addConfig('user.name', 'Mango Test');
  await git.commit('init', [], { '--allow-empty': null });
  return {
    dir,
    git,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Write `tests/helpers/fake-pty.ts` (used by Plan 2+)**

Create `/Users/ltm-luan/Project/mangolove-idea/tests/helpers/fake-pty.ts`:
```ts
import { EventEmitter } from 'node:events';

/** Minimal IPty surface the SessionManager depends on (Plan 2 injects this). */
export interface FakePtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  /** Test helpers to drive the fake from outside. */
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
}

/** Builds an EventEmitter-backed fake PTY for windowless session tests. */
export function makeFakePty(pid = 4242): FakePtyHandle {
  const bus = new EventEmitter();
  let killed = false;
  return {
    pid,
    write: () => {},
    resize: () => {},
    kill: () => {
      killed = true;
      bus.emit('exit', { exitCode: 0 });
    },
    onData: (cb) => void bus.on('data', cb),
    onExit: (cb) => void bus.on('exit', cb),
    emitData: (data) => bus.emit('data', data),
    emitExit: (exitCode, signal) => {
      if (!killed) bus.emit('exit', { exitCode, signal });
    },
  };
}
```

- [ ] **Step 3: Full test suite green gate**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm test
```
Expected: both projects run; `Test Files  2 passed`, `Tests  6 passed` (2 in format-versions, 4 in ipc-roundtrip). Helper files have no tests yet and that's fine.

- [ ] **Step 4: Final typecheck + lint + format gate**

Run:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck && npm run lint && npm run format:check
```
Expected: all three exit 0.

- [ ] **Step 5: Append native-rebuild + macOS notes to README**

Append to `/Users/ltm-luan/Project/mangolove-idea/README.md`:
```markdown

## Development (Plan 0 — scaffold + IPC spine)

Target platform: **macOS only** for the MVP.

### Setup

```bash
npm install   # runs `postinstall: electron-rebuild -f -w node-pty` automatically
```

### node-pty native module

`node-pty@1.1.0` is an **N-API** native addon shipping **ABI-stable prebuilt binaries**
(`prebuilds/darwin-arm64/pty.node`). It loads in both plain Node and Electron **without a
rebuild** — there is no `NODE_MODULE_VERSION` trap with this version. The rebuild is wired
as cheap insurance, not a hard requirement:

- `postinstall` runs `electron-rebuild -f -w node-pty` after every `npm install`. This
  produces `build/Release/pty.node`, which takes precedence over the prebuild and pins the
  binary to exactly this Electron — useful if a future node-pty ever drops prebuilds for
  our arch.
- After **any Electron version bump**, optionally re-run: `npm run rebuild`.
- Symptom of a genuinely broken addon: the Ping panel shows `node-pty <ver> (FAILED)`.
  Fix: `npm run rebuild` (and `xcode-select --install` if the C++ toolchain is missing).

> `node-pty` keeps native deps OUT of the bundle: it stays in `dependencies` and is
> externalized by electron-vite's `externalizeDepsPlugin()`, loaded from `node_modules`
> at runtime.

### Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Launch the app with HMR (electron-vite). |
| `npm run build` | Bundle main/preload/renderer into `out/`. |
| `npm test` | Vitest (node + jsdom projects). |
| `npm run typecheck` | `tsc --noEmit` for node + web configs. |
| `npm run lint` / `npm run format` | ESLint 9 flat config / Prettier. |
| `npm run rebuild` | Re-rebuild node-pty against Electron (post version bump). |

### Verifying the spine

`npm run dev` → click **Ping main**. You should see `app`, `electron`, `node`, `chrome`
versions and crucially **`node-pty <ver> (loaded)`** — proving the typed IPC round-trip
(`window.mango.app.ping` → `app:ping` handler → preload contextBridge) and the native
rebuild both work.
```

- [ ] **Step 6: Final commit**

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add tests/helpers README.md && git commit -m "chore: test-helper skeletons + Plan-0 README (native-rebuild + spine verify)"
```

---

## Plan 0 Acceptance Checklist (must all be true to call Plan 0 done)

- [ ] `npm run dev` opens a macOS window rendering the React app.
- [ ] Clicking **Ping main** shows real `app/electron/node/chrome` versions via `window.mango.app.ping()` — a full typed IPC round-trip (renderer → preload contextBridge → `app:ping` handler → back).
- [ ] The ping result shows **`node-pty <ver> (loaded)`** — the native addon loads in the Electron main process (the spine's hardest dependency works; health check, not a rebuild receipt).
- [ ] `npm test` is green: `formatVersions` pure-fn test (jsdom project) + `buildAppInfo`/`registerIpc` windowless handler test (node project).
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` all exit 0.
- [ ] `npm run build` bundles all three targets with node-pty externalized.
- [ ] `src/shared/{types.ts,ipc-channels.ts,ipc-contract.ts}` exist with the FULL binding contract (every later plan imports them unchanged).
- [ ] The preload exposes the complete `window.mango` shape (`app.ping` + `worktree.list` real; rest typed stubs) so later plans only fill bodies, never change the surface.

---

## Self-Review Notes

**Spec coverage (Plan 0 scope):** project init (Task 1) ✓; three-target build config (Task 9) ✓; node-pty rebuild + load proof (Tasks 1/6/9) ✓; main/preload/renderer/shared layering (Tasks 4/7/8/9) ✓; one real typed IPC round-trip `app:ping` (Tasks 7/8/9) ✓; test runner + lint/format (Tasks 3/5) ✓; one shared pure-fn test (Task 5) ✓; one windowless IPC-handler test (Task 8) ✓; window renders React + shows ping result (Task 9) ✓; full §3/§4 contract landed in `src/shared/` (Task 4) ✓.

**Type consistency:** `AppInfo` fields (`appVersion/electronVersion/nodeVersion/chromeVersion/nodePtyVersion/nodePtyLoaded`) are identical across `types.ts`, `format-versions.ts`, `format-versions.test.ts`, `register-ipc.ts`, and `ipc-roundtrip.test.ts`. `NodePtyProbe` (`version/loaded`) matches between `pty-factory.ts` and `register-ipc.ts`. `MangoApi` in `ipc-contract.ts` matches what `preload/index.ts` implements. `IPC.APP_PING` string `'app:ping'` matches the test assertion.

**No placeholders:** every code step shows complete file content; every command has expected output. The only intentionally-thin items are the `notYet('N')` preload stubs and the two test-helper skeletons — these are deliberate, typed, and consumed by named later plans (not vague TODOs).

**Deliberate contract deviations (documented inline):** (1) added `APP_PING`/`AppInfo` — required by the contract's own §5 Plan-0 acceptance for an `app:ping`-style probe; (2) `app` placed first in `MangoApi` (member order is non-binding); (3) `prefer-readonly` ESLint rule deferred (needs typed-lint project graph not present until managers land). No type names, channel strings, file paths, or versions from §0–§4 were renamed.