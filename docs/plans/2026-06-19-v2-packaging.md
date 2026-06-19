# V2 Packaging + Distribution + Finder PATH fix + Repo-root picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MangoLove IDEA installable as a Finder-launchable macOS arm64 `.app`/`.dmg` (electron-builder) that actually works outside a dev terminal — fixing the launchd-PATH spawn failures and the `process.cwd() === '/'` repo-root break with a persisted repo-root picker.

**Architecture:** Three additive, independently-shippable changes. (1) **Packaging:** add `electron-builder@26.15.3` as a devDependency plus a `package.json` top-level `build` field and `dist`/`dist:dir` scripts — node-pty's `build/Release/*` (the electron-rebuilt ABI-146 binary *and* its `spawn-helper`) is `asarUnpack`ed, `npmRebuild:false`, ad-hoc mac signing. (2) **PATH fix:** at the top of `app.whenReady()`, guarded by `app.isPackaged && process.platform === 'darwin'`, run the user login shell once to capture its real PATH and merge it into `process.env.PATH` — env-passthrough is already wired everywhere so this single edit fixes `claude`/`gh`/`git`/`npm` spawning. (3) **Repo-root picker:** replace `ctx.repoRoot = process.cwd()` with a `resolveRepoRoot()` helper (persisted `SettingsStore.repoRoot` if a valid git work tree, else `cwd` if valid, else `null`), make `ctx.repoRoot: string | null`, persist `repoRoot` in the existing `SettingsStore`, add REPO_GET/REPO_PICK IPC (pick → `dialog.showOpenDialog` → validate → persist → `app.relaunch(); app.quit()`), and gate the renderer worktree UI behind a `useRepo()` hook + empty-state.

**Tech Stack:** Electron 42.4.0, electron-vite 5.0.0, electron-builder 26.15.3, node-pty 1.1.0 (asarUnpacked), simple-git, React 19, TypeScript 5.7 (ESM, `verbatimModuleSyntax`), Vitest 4.

---

## File Structure

Files **created**:

- `tests/main/resolve-repo-root.test.ts` — unit tests for the pure `resolveRepoRoot()` helper (injected `existsSync`).
- `tests/main/register-repo-ipc.test.ts` — IPC wiring test for REPO_GET / REPO_PICK (mocks `electron`'s `dialog`/`app`).
- `src/renderer/hooks/use-repo.ts` — `useRepo()` renderer hook (REPO_GET on mount + `pick()`).

Files **modified**:

- `package.json` — add `electron-builder` devDep, top-level `build` field, `dist` + `dist:dir` scripts.
- `.gitignore` — confirm `release/` is ignored (already present; verify only).
- `src/main/index.ts` — add `execFileSync` import; add the packaged-darwin PATH-merge block at the top of `whenReady`; replace `ctx.repoRoot = process.cwd()` with `resolveRepoRoot(...)`; export/import the helper.
- `src/main/util/resolve-repo-root.ts` — **create** the pure helper (lives in `util/` beside `detect-runner.ts`).
- `src/main/ipc/ipc-context.ts` — change `repoRoot?: string` → `repoRoot: string | null`.
- `src/main/managers/settings-store.ts` — add `'repoRoot'` to `KNOWN_KEYS`.
- `tests/main/settings-store.test.ts` — extend with a `repoRoot` round-trip + sanitize assertion.
- `src/shared/types.ts` — add `repoRoot?: string` to `AppSettings`; add `RepoPickResult` type.
- `src/shared/ipc-channels.ts` — add `REPO_GET` + `REPO_PICK`.
- `src/shared/ipc-contract.ts` — add `repo: { get; pick }` to `MangoApi`.
- `src/preload/index.ts` — add the `repo` bridge.
- `src/main/ipc/register-ipc.ts` — add REPO_GET/REPO_PICK handlers; null-guard the 5 repoRoot-bound lazy getters.
- `src/renderer/App.tsx` — empty-state when `repoRoot == null`; repo header + worktree UI gated behind `repoRoot`.
- `docs/V2-BACKLOG.md` — strike through the packaging row.

Files **confirmed NO change** (listed for completeness):

- `electron.vite.config.ts` — `externalizeDepsPlugin()` already keeps node-pty external; renderer base/CSP/workers already package-correct.

**Note on tests:** The **packaging config** (Task 1) and the **renderer** (Task 6) have **no unit test** — `@testing-library/react` is absent (no RTL). They are gated instead on `npm run build` / `npm run dist:dir` / `npm run typecheck` and the manual GUI smoke (Task 7). Every other task is TDD.

---

## Task 1: electron-builder dep + `build` field + dist scripts + .gitignore

**No unit test** — packaging config is verified by actually running `npm run build` then `npm run dist:dir` and inspecting `release/`. Gate: `npm run dist:dir` produces an unpacked `.app` whose `app.asar.unpacked` contains node-pty's `build/Release/{pty.node,spawn-helper}`.

**Files:**
- Modify: `package.json` (scripts + top-level `build` field + devDependencies)
- Modify: `.gitignore` (verify `release/`)

- [ ] **Step 1: Install electron-builder as a devDependency**

Run:
```bash
npm i -D electron-builder@latest
```
Expected: `electron-builder` is added to `devDependencies` in `package.json`. The resolved version is **26.15.3** (the current `latest`; `>=26.x` is required for Electron 42's asar/Mach-O layout). The existing `postinstall` (`electron-rebuild -f -w node-pty`) re-runs and re-confirms the ABI-146 arm64 `build/Release/pty.node` — harmless.

Record the resolved version:
```bash
node -p "require('./package.json').devDependencies['electron-builder']"
```
Expected output: a string like `^26.15.3` (or `26.15.3`). Note it in the commit body.

- [ ] **Step 2: Add the top-level `build` field to package.json**

Insert a top-level `"build"` object into `package.json`. Place it AFTER the `"devDependencies"` block (after its closing `}`), as the last top-level key. The exact object:

```json
  "build": {
    "appId": "me.onda.mangolove-idea",
    "productName": "MangoLove IDEA",
    "electronVersion": "42.4.0",
    "directories": {
      "output": "release"
    },
    "files": [
      "out/main/**/*",
      "out/preload/**/*",
      "out/renderer/**/*",
      "package.json"
    ],
    "asar": true,
    "asarUnpack": [
      "**/node_modules/node-pty/build/Release/*"
    ],
    "npmRebuild": false,
    "mac": {
      "identity": null,
      "target": [
        {
          "target": "dmg",
          "arch": ["arm64"]
        }
      ],
      "category": "public.app-category.developer-tools"
    }
  }
```

ALSO add a top-level `"author"` field to package.json (electron-builder warns "author is missed in
the package.json" without it — non-fatal but it wants one for the app metadata). Add it next to the
existing top-level fields (e.g. after `"version"`):

```json
  "author": "JunSub_Dev",
```

Rationale (do NOT deviate):
- `files` enumerates only `out/main` + `out/preload` + `out/renderer` + `package.json` — this ALREADY excludes the non-runtime tsconfig outDirs `out/types-node` and `out/types-web`. Do **not** use a broad `out/**/*` glob (it would package the type trees).
- `asarUnpack: ["**/node_modules/node-pty/build/Release/*"]` covers BOTH `pty.node` AND `spawn-helper`. node-pty `exec`s `spawn-helper`, which cannot run from inside an asar (its loader does the `app.asar` → `app.asar.unpacked` replace). Unpacking only `pty.node` would ENOENT on spawn.
- `npmRebuild: false` — `electron-rebuild`'s postinstall already produced the ABI-146 arm64 binary; letting electron-builder rebuild risks a system-Node ABI break.
- `mac.identity: null` forces an ad-hoc signature, REQUIRED for arm64 Mach-O to execute at all (no Apple cert assumed). `target` is `dmg`/`arm64` only.

- [ ] **Step 3: Add the `dist` and `dist:dir` scripts**

In the `"scripts"` block of `package.json`, add these two entries (place them after `"test": "vitest run"`, adding a comma to that line):

```json
    "dist": "npm run build && electron-builder --mac --arm64",
    "dist:dir": "npm run build && electron-builder --mac --arm64 --dir"
```

`dist` builds the `.dmg`; `dist:dir` builds an unpacked `.app` (fast, for smoke-testing without packing the dmg).

- [ ] **Step 4: Verify `.gitignore` ignores `release/`**

Run:
```bash
grep -n '^release/' .gitignore
```
Expected output: `9:release/` (already present — line 9). If the grep returns nothing, append `release/` under the `# Build output` section. (Verified present in the current repo; this is a confirmation step.)

- [ ] **Step 5: Verify typecheck + the existing suite still pass (config is additive)**

Run:
```bash
npm run typecheck && npm run test
```
Expected: typecheck passes (the `build` field is data, not TS) and all existing Vitest suites pass — the `build` field and scripts do not touch electron-vite dev/build/preview.

- [ ] **Step 6: Smoke-build the unpacked app and verify node-pty is unpacked + executable**

Run:
```bash
npm run dist:dir
```
Expected: `electron-vite build` emits `out/main`, `out/preload`, `out/renderer`, then electron-builder writes `release/mac-arm64/MangoLove IDEA.app` (no dmg, because `--dir`). Then verify the native binary landed unpacked and `spawn-helper` kept its executable bit:
```bash
ls -l "release/mac-arm64/MangoLove IDEA.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/"
```
Expected output: a listing containing `pty.node` AND `spawn-helper`, with `spawn-helper` showing `-rwxr-xr-x` (the `x` bits set). And confirm the type dirs are absent from the archive:
```bash
npx asar list "release/mac-arm64/MangoLove IDEA.app/Contents/Resources/app.asar" | grep -E 'types-node|types-web' || echo "OK: no type dirs in asar"
```
Expected output: `OK: no type dirs in asar`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "$(cat <<'EOF'
chore: add electron-builder packaging (mac arm64 dmg)

electron-builder@26.15.3 devDep + package.json build field +
dist/dist:dir scripts. node-pty build/Release/* asarUnpacked
(pty.node + spawn-helper), npmRebuild:false (ABI-146 already built
by electron-rebuild postinstall), mac.identity:null ad-hoc signing.
files enumerate out/main+preload+renderer (excludes type outDirs).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: PATH fix in index.ts (packaged-darwin only; no-op in dev)

**No unit test** — this is a guarded side-effect on `process.env.PATH` driven by `app.isPackaged` (false in vitest and in `npm run dev`), so there is nothing to unit-test headless. It is gated by `npm run typecheck` (the edit must compile) and verified in the GUI smoke (Task 7: the packaged app's spawned `echo $PATH` contains `/opt/homebrew/bin` and `~/.local/bin`). The `app.isPackaged` guard makes it a literal NO-OP in `npm run dev`.

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add the `execFileSync` import**

In `src/main/index.ts`, change the first import line:

```typescript
import { resolve } from 'node:path';
```
to:
```typescript
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
```

- [ ] **Step 2: Insert the PATH-merge block at the TOP of `whenReady`**

In `src/main/index.ts`, the `app.whenReady().then(() => {` callback currently starts with the `ctx.sessionStore = new SessionStore(...)` construction. Insert the PATH block as the FIRST statement inside that callback, BEFORE any store construction / `registerIpc` / spawn.

Replace:
```typescript
app.whenReady().then(() => {
  // Construct the SessionStore eagerly (we hold the real electron `app` for the
```
with:
```typescript
app.whenReady().then(() => {
  // PATH FIX (packaged macOS only): a Finder-launched .app inherits launchd's
  // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), NOT the user's login-shell
  // PATH — so `claude` (~/.local/bin), `gh`/`git`/`npm` (/opt/homebrew/bin) would
  // ENOENT. Run the login shell once to capture its real PATH and merge it in.
  // env passthrough is already wired in every spawner (pty-factory, process-runner,
  // gh-status-reader), so fixing process.env.PATH once fixes them all. Guarded by
  // app.isPackaged so `npm run dev` (which already has the dev shell PATH) is a
  // literal no-op; try/catch keeps the launchd PATH on any failure (degrade quietly).
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "%s" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (out.trim()) process.env.PATH = out.trim();
    } catch {
      // keep the launchd PATH; spawning degrades gracefully (gh -> gh-missing etc.)
    }
  }
  // Construct the SessionStore eagerly (we hold the real electron `app` for the
```

- [ ] **Step 3: Verify it compiles and the suite still passes**

Run:
```bash
npm run typecheck:node && npm run test
```
Expected: typecheck passes and all existing tests pass. (`app.isPackaged` is `false` under vitest, so the block never runs in tests — no behavior change.)

- [ ] **Step 4: Verify dev is untouched (no-op proof)**

Run:
```bash
grep -n 'app.isPackaged && process.platform' src/main/index.ts
```
Expected output: one line showing the guard `if (app.isPackaged && process.platform === 'darwin') {`. This is the no-op proof for dev (the guard short-circuits when `app.isPackaged` is false).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "$(cat <<'EOF'
fix: merge login-shell PATH in packaged macOS app

Finder-launched .app inherits launchd's minimal PATH so claude/gh/
git/npm ENOENT. At the top of whenReady (packaged darwin only), run
$SHELL -ilc to capture the real PATH and merge into process.env.PATH.
Guarded by app.isPackaged -> literal no-op in npm run dev. try/catch
falls back to the launchd PATH.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `AppSettings.repoRoot` + SettingsStore KNOWN_KEYS (TDD)

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/managers/settings-store.ts`
- Test: `tests/main/settings-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/main/settings-store.test.ts`, add this test inside the `describe('SettingsStore', ...)` block, immediately after the `it('sanitizes to ONLY the 4 known string fields ...')` test (before the corrupt-file test):

```typescript
  it('round-trips repoRoot (a known string key) and sanitizes a non-string repoRoot', () => {
    const store = new SettingsStore(file);
    store.set({ repoRoot: '/Users/me/project' });
    expect(new SettingsStore(file).get()).toEqual({ repoRoot: '/Users/me/project' });
    // a non-string repoRoot from a hand-edited file must be dropped, not surfaced
    writeFileSync(file, JSON.stringify({ repoRoot: 123, baseBranch: 'main' }));
    expect(new SettingsStore(file).load()).toEqual({ baseBranch: 'main' });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run tests/main/settings-store.test.ts -t 'round-trips repoRoot'
```
Expected: FAIL. The first assertion fails — `repoRoot` is NOT in `KNOWN_KEYS` yet, so `set()` drops it and `get()` returns `{}`, not `{ repoRoot: '/Users/me/project' }`.

- [ ] **Step 3: Add `repoRoot` to `AppSettings` and `KNOWN_KEYS`**

In `src/shared/types.ts`, inside the `AppSettings` interface, add the `repoRoot` field after `baseBranch`:

```typescript
export interface AppSettings {
  /** Agent binary to spawn; unset => MANGO_AGENT_CMD ?? 'claude'. */
  readonly agentCommand?: string;
  /** Verify hook command; unset => MANGO_VERIFY_CMD ?? 'true'. */
  readonly verifyCommand?: string;
  /** Server start override; unset => MANGO_SERVER_CMD ?? auto-detection. */
  readonly serverCommand?: string;
  /** Default base branch for merge target + diff; unset => 'main'. */
  readonly baseBranch?: string;
  /**
   * Absolute path of the git repo MangoLove operates on. Set ONLY via the
   * repo-picker flow (REPO_PICK), never surfaced in the Settings modal. Unset =>
   * resolveRepoRoot() falls back to cwd (dev) or null (Finder launch w/ bad cwd).
   */
  readonly repoRoot?: string;
}
```

In `src/main/managers/settings-store.ts`, update the doc comment + `KNOWN_KEYS`:

```typescript
/** The five known AppSettings keys — the ONLY keys ever read/written. */
const KNOWN_KEYS: readonly (keyof AppSettings)[] = [
  'agentCommand',
  'verifyCommand',
  'serverCommand',
  'baseBranch',
  'repoRoot',
];
```

ALSO update the two other "four" mentions in the SAME file so the docs stay consistent with the
now-five keys: the class JSDoc (currently "...sanitized to ONLY the **four** known **string**
fields...") and the `sanitize()` method JSDoc (currently "...EXACTLY the four known STRING
fields...") — change "four" → "five" in both. (Grep the file for "four" to find them.)

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run tests/main/settings-store.test.ts
```
Expected: PASS — the new test plus all pre-existing SettingsStore tests pass. (`repoRoot` is now a known STRING key, so it persists and `sanitize()` drops a non-string `repoRoot`.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/managers/settings-store.ts tests/main/settings-store.test.ts
git commit -m "$(cat <<'EOF'
feat: persist repoRoot in SettingsStore (KNOWN_KEYS)

Add AppSettings.repoRoot (optional string) + 'repoRoot' to the
SettingsStore KNOWN_KEYS so it persists and sanitizes like the other
string fields. Reuses the existing settings store (no new store).
Set only via the repo-picker flow, never in the Settings modal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `resolveRepoRoot()` helper + `ctx.repoRoot: string | null` + index.ts wiring (TDD)

**Files:**
- Create: `src/main/util/resolve-repo-root.ts`
- Modify: `src/main/ipc/ipc-context.ts`
- Modify: `src/main/index.ts`
- Test: `tests/main/resolve-repo-root.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/main/resolve-repo-root.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveRepoRoot } from '../../src/main/util/resolve-repo-root';

describe('resolveRepoRoot', () => {
  // A "valid git work tree" = the dir has a `.git` entry (dir OR file). We model
  // existsSync(join(dir,'.git')) with an injected predicate over a known set.
  function existsFor(validGitDirs: readonly string[]) {
    const gitPaths = new Set(validGitDirs.map((d) => join(d, '.git')));
    return (p: string): boolean => gitPaths.has(p);
  }

  it('returns the PERSISTED repoRoot when it is a valid git work tree', () => {
    const out = resolveRepoRoot({
      persisted: '/Users/me/proj',
      cwd: '/Users/me/other',
      existsSync: existsFor(['/Users/me/proj', '/Users/me/other']),
    });
    expect(out).toBe('/Users/me/proj');
  });

  it('falls back to cwd when persisted is missing/invalid but cwd is a valid git work tree', () => {
    const out = resolveRepoRoot({
      persisted: undefined,
      cwd: '/Users/me/proj',
      existsSync: existsFor(['/Users/me/proj']),
    });
    expect(out).toBe('/Users/me/proj');
  });

  it('falls back to cwd when persisted points at a non-git dir but cwd is valid', () => {
    const out = resolveRepoRoot({
      persisted: '/gone',
      cwd: '/Users/me/proj',
      existsSync: existsFor(['/Users/me/proj']),
    });
    expect(out).toBe('/Users/me/proj');
  });

  it('returns null when BOTH persisted and cwd are invalid (Finder launch, cwd=/)', () => {
    const out = resolveRepoRoot({
      persisted: undefined,
      cwd: '/',
      existsSync: existsFor([]),
    });
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run tests/main/resolve-repo-root.test.ts
```
Expected: FAIL — `Cannot find module '../../src/main/util/resolve-repo-root'` (the helper does not exist yet).

- [ ] **Step 3: Write the minimal helper**

Create `src/main/util/resolve-repo-root.ts`:

```typescript
import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';

/** Inputs for resolveRepoRoot; existsSync is injected so the logic is unit-testable. */
export interface ResolveRepoRootOptions {
  /** The persisted SettingsStore.repoRoot, or undefined when never set. */
  readonly persisted: string | undefined;
  /** process.cwd() — the repo when running via `npm run dev`, '/' on a Finder launch. */
  readonly cwd: string;
  /** Injectable for tests; defaults to node:fs existsSync. */
  readonly existsSync?: (path: string) => boolean;
}

/**
 * A dir is a "valid git work tree" iff it contains a `.git` ENTRY — true for both
 * a primary repo (.git is a directory) and a linked worktree (.git is a file). This
 * is a cheap existence check (no `git` spawn).
 */
function isGitWorkTree(dir: string, exists: (p: string) => boolean): boolean {
  return exists(join(dir, '.git'));
}

/**
 * Resolves the repo MangoLove operates on, in precedence order:
 *   1. the PERSISTED repoRoot, if it is a valid git work tree;
 *   2. else process.cwd(), if IT is a valid git work tree (covers `npm run dev`);
 *   3. else null (Finder launch with cwd='/' and no persisted repo -> renderer
 *      shows the empty-state repo picker).
 */
export function resolveRepoRoot(opts: ResolveRepoRootOptions): string | null {
  const exists = opts.existsSync ?? fsExistsSync;
  if (opts.persisted && isGitWorkTree(opts.persisted, exists)) return opts.persisted;
  if (isGitWorkTree(opts.cwd, exists)) return opts.cwd;
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run tests/main/resolve-repo-root.test.ts
```
Expected: PASS — all four cases.

- [ ] **Step 5: Change `ctx.repoRoot` to `string | null`**

In `src/main/ipc/ipc-context.ts`, change the `repoRoot` field. Keep it OPTIONAL (`?:`) so it
also admits `null` — this is the minimal type change: every existing `IpcContext`-typed test
ctx literal that OMITS `repoRoot` keeps compiling (optional), and the getters treat `undefined`
and `null` identically via `requireRepoRoot`. (Making it required `string | null` would force
adding `repoRoot: null` to ~25 test literals — avoid that churn.)

Replace:
```typescript
  /** Absolute path of the repo MangoLove operates on (set by main/index.ts). */
  repoRoot?: string;
```
with:
```typescript
  /**
   * Absolute path of the repo MangoLove operates on, or null/undefined when no
   * repo is selected (Finder launch with cwd='/' and no persisted repoRoot). Set by
   * main/index.ts via resolveRepoRoot(). The repoRoot-bound getters assert it via
   * requireRepoRoot (throws a friendly error if absent); the renderer gates the
   * worktree UI behind a non-null repoRoot so the assert is defensive.
   */
  repoRoot?: string | null;
```

The factory stays as-is (`repoRoot` optional, so no initializer needed):
```typescript
export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
```

- [ ] **Step 6: Wire `resolveRepoRoot()` into index.ts**

In `src/main/index.ts`, add the helper import after the existing imports (after the `import type { QuitWarningEvent }` line):

```typescript
import { resolveRepoRoot } from './util/resolve-repo-root';
```

Then change the `ctx.repoRoot` assignment. Today `const ctx = createIpcContext();` is at module
level and a separate `ctx.repoRoot = process.cwd();` sets it. KEEP `const ctx = createIpcContext();`
at module level (no repoRoot there — it defaults to undefined), and DELETE the module-level
`ctx.repoRoot = process.cwd();` line. Instead set `ctx.repoRoot` INSIDE `whenReady`, immediately
AFTER the eager `ctx.settingsStore = new SettingsStore(...)` construction, so it reads from the
one already-constructed store (no second SettingsStore, and no `app.getPath('userData')` at module
top-level before the app is ready):

```typescript
  // (inside whenReady, right after ctx.settingsStore is constructed)
  // Finder-launched .app has cwd='/', so cwd is NOT a safe repoRoot. Prefer the
  // persisted repoRoot (SettingsStore), else cwd if it is itself a git work tree
  // (the dev case), else null (renderer shows the repo-picker empty-state). ctx.repoRoot
  // is read LAZILY by the getters, so setting it here (before registerIpc) is in time.
  ctx.repoRoot = resolveRepoRoot({
    persisted: ctx.settingsStore.get().repoRoot,
    cwd: process.cwd(),
  });
```

> NOTE: this runs inside `whenReady` (where `app` is ready and `ctx.settingsStore` already exists),
> avoiding any `app.getPath('userData')` call at module-evaluation time. `resolveRepoRoot` is
> imported at the top of `index.ts` (Step above).

- [ ] **Step 7: Run typecheck + the full suite**

Run:
```bash
npm run typecheck:node && npm run test
```
Expected: typecheck passes. Because `repoRoot` stays OPTIONAL (`repoRoot?: string | null`), every
existing `IpcContext`-typed ctx literal that omits `repoRoot` keeps compiling unchanged — no churn,
no per-literal edits. The repoRoot-bound getters get their null-guard (`requireRepoRoot`) in Task 5;
here in Task 4 they may still read `ctx.repoRoot ?? process.cwd()` and that typechecks against
`string | null | undefined`. All existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/util/resolve-repo-root.ts src/main/ipc/ipc-context.ts src/main/index.ts tests/main/resolve-repo-root.test.ts
git commit -m "$(cat <<'EOF'
feat: resolveRepoRoot helper + ctx.repoRoot: string | null

Replace unconditional ctx.repoRoot=process.cwd() (broken on Finder
launch where cwd='/') with resolveRepoRoot(): persisted repoRoot if a
valid git work tree, else cwd if valid (dev), else null. "valid git
work tree" = existsSync(join(dir,'.git')) (covers primary repo + linked
worktree; no git spawn). ctx.repoRoot is now string | null.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: REPO_GET / REPO_PICK IPC (4 layers) + wiring test + getter null-guards (TDD)

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/types.ts` (`RepoPickResult`)
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/register-ipc.ts` (handlers + getter null-guards)
- Test: `tests/main/register-repo-ipc.test.ts`

- [ ] **Step 1: Write the failing wiring test**

Create `tests/main/register-repo-ipc.test.ts`. It mocks the `electron` module so the handler's `await import('electron')` yields a fake `dialog` + `app`, and uses an injected `existsSync` is not possible across the dynamic import — so the test points `dialog.showOpenDialog` at a directory that really is / is not a git work tree by using a temp dir. We create a real temp dir with a `.git` entry for the valid case.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';

// Hoisted mock state the fake electron module reads. vi.mock is hoisted, so the
// referenced object must be created with vi.hoisted.
const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showOpenDialog: mocks.showOpenDialog },
  app: { relaunch: mocks.relaunch, quit: mocks.quit, getVersion: () => '0.1.0' },
  shell: { openExternal: vi.fn() },
}));

// Import AFTER vi.mock so register-ipc's dynamic import('electron') hits the mock.
const { registerIpc } = await import('../../src/main/ipc/register-ipc');
const { createIpcContext } = await import('../../src/main/ipc/ipc-context');

function makeIpcMain() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, arg: unknown) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  } as unknown as Parameters<typeof registerIpc>[0];
  return { ipcMain, handlers };
}

function baseCtx() {
  const ctx = createIpcContext();
  ctx.settingsStore = { get: () => ({}), set: vi.fn((p: unknown) => p) } as never;
  return ctx;
}

describe('repo IPC wiring', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mango-repo-'));
    mocks.showOpenDialog.mockReset();
    mocks.relaunch.mockReset();
    mocks.quit.mockReset();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('REPO_GET returns ctx.repoRoot', async () => {
    const ctx = baseCtx();
    ctx.repoRoot = '/Users/me/proj';
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_GET)!(null, undefined);
    expect(out).toBe('/Users/me/proj');
  });

  it('REPO_GET returns null when no repo is selected', async () => {
    const ctx = baseCtx(); // repoRoot defaults to null
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    expect(await handlers.get(IPC.REPO_GET)!(null, undefined)).toBeNull();
  });

  it('REPO_PICK returns {canceled:true} when the user cancels the dialog', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: false, canceled: true });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(ctx.settingsStore!.set).not.toHaveBeenCalled();
  });

  it('REPO_PICK rejects a non-git directory with {error}', async () => {
    // dir has NO .git entry -> not a git work tree.
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: false, error: 'not a git repository' });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(ctx.settingsStore!.set).not.toHaveBeenCalled();
  });

  it('REPO_PICK persists a valid repo then relaunches', async () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n'); // a linked-worktree .git FILE counts
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    const out = await handlers.get(IPC.REPO_PICK)!(null, undefined);
    expect(out).toEqual({ ok: true, repoRoot: dir });
    expect(ctx.settingsStore!.set).toHaveBeenCalledWith({ repoRoot: dir });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run tests/main/register-repo-ipc.test.ts
```
Expected: FAIL — `IPC.REPO_GET` / `IPC.REPO_PICK` are `undefined` (channels not added), so `handlers.get(undefined)` is `undefined` and the `!`-call throws `TypeError`.

- [ ] **Step 3: Add the channels**

In `src/shared/ipc-channels.ts`, add a repo block before the closing `} as const;` (after the `scrollback` block):

```typescript
  // repo root (V2 packaging) — pick/persist the git repo MangoLove operates on
  REPO_GET: 'repo:get', // invoke (-> string | null = ctx.repoRoot)
  REPO_PICK: 'repo:pick', // invoke (-> RepoPickResult; persists + relaunches on success)
```

- [ ] **Step 4: Add the `RepoPickResult` type**

In `src/shared/types.ts`, add at the end of the file (after the `AppSettings` interface):

```typescript
// ── Repo root picker (V2 packaging) ──

/**
 * Result of the REPO_PICK flow. On success the main process has ALREADY persisted
 * repoRoot and is about to relaunch — so the renderer rarely observes `ok:true`
 * (the window is replaced). The error/canceled shapes let the renderer keep the
 * empty-state up without a restart.
 */
export type RepoPickResult =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly canceled: true }
  | { readonly ok: false; readonly error: string };
```

- [ ] **Step 5: Add the contract method**

In `src/shared/ipc-contract.ts`, add `RepoPickResult` to the type import (append it to the existing `import type { ... } from './types';` list), then add a `repo` member to `MangoApi` (place it after the `gh` member):

```typescript
  repo: {
    /** The currently-selected repo root, or null when none is set. */
    get(): Promise<string | null>;
    /**
     * Open a native folder picker; on a valid git repo, persist it and relaunch.
     * Returns {canceled} or {error} when nothing was persisted.
     */
    pick(): Promise<RepoPickResult>;
  };
```

- [ ] **Step 6: Add the preload bridge**

In `src/preload/index.ts`, add a `repo` bridge to the `api` object (place it after the `scrollback` member):

```typescript
  repo: {
    get: () => ipcRenderer.invoke(IPC.REPO_GET),
    pick: () => ipcRenderer.invoke(IPC.REPO_PICK),
  },
```

- [ ] **Step 7: Add the handlers + the helper imports in register-ipc.ts**

In `src/main/ipc/register-ipc.ts`, add `RepoPickResult` to the big `import type { ... } from '../../shared/types';` list, and add the node imports near the top of the file (after the existing imports, before `interface AppLike`):

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
```

Then add the two handlers inside `registerIpc(...)`, after the `IPC.SETTINGS_SET` handler block (before the `IPC.SCROLLBACK_GET` handler):

```typescript
  ipcMain.handle(IPC.REPO_GET, async (): Promise<string | null> => {
    return ctx.repoRoot;
  });

  ipcMain.handle(IPC.REPO_PICK, async (): Promise<RepoPickResult> => {
    const { dialog, app } = await import('electron');
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a git repository',
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dir = res.filePaths[0];
    // valid git work tree = a `.git` entry (dir for a primary repo, file for a
    // linked worktree). Cheap existence check, no git spawn — same rule as
    // resolveRepoRoot so the picked dir survives the next-startup resolve.
    if (!existsSync(join(dir, '.git'))) {
      return { ok: false, error: 'not a git repository' };
    }
    getSettingsStore(ctx).set({ repoRoot: dir });
    // UNIFORM restart: read the new repoRoot fresh at startup so every
    // repoRoot-bound manager + the renderer rebuild cleanly (no runtime cache
    // invalidation of worktree/diff/conflict/gh/merge managers).
    app.relaunch();
    app.quit();
    return { ok: true, repoRoot: dir };
  });
```

- [ ] **Step 8: Null-guard the 5 repoRoot-bound lazy getters**

In `src/main/ipc/register-ipc.ts`, replace each `const repoRoot = ctx.repoRoot ?? process.cwd();` (there are FOUR — in `getMergeRunner`, `getDiffViewer`, `getGhStatusReader`, `getConflictResolver`) and the one in `getWorktreeManager` with an explicit non-null assertion that throws a friendly error.

First, add a tiny helper near the top of the file (after the `import { join } from 'node:path';` you added in Step 7, before `interface AppLike`):

```typescript
/**
 * Asserts a repo is selected and returns it. The renderer GATES all worktree ops
 * behind a non-null repoRoot, so this throw is DEFENSIVE only — it surfaces a
 * friendly message if a repoRoot-bound op is somehow invoked with no repo.
 */
function requireRepoRoot(ctx: IpcContext): string {
  if (ctx.repoRoot == null) throw new Error('no repository selected');
  return ctx.repoRoot;
}
```

Then in `getWorktreeManager`, replace:
```typescript
  if (ctx.worktreeManager) return ctx.worktreeManager;
  const repoRoot = ctx.repoRoot ?? process.cwd();
```
with:
```typescript
  if (ctx.worktreeManager) return ctx.worktreeManager;
  const repoRoot = requireRepoRoot(ctx);
```

In `getMergeRunner`, replace:
```typescript
  if (ctx.mergeRunner) return ctx.mergeRunner;
  const repoRoot = ctx.repoRoot ?? process.cwd();
```
with:
```typescript
  if (ctx.mergeRunner) return ctx.mergeRunner;
  const repoRoot = requireRepoRoot(ctx);
```

In `getDiffViewer`, replace:
```typescript
  if (ctx.diffViewer) return ctx.diffViewer;
  const repoRoot = ctx.repoRoot ?? process.cwd();
```
with:
```typescript
  if (ctx.diffViewer) return ctx.diffViewer;
  const repoRoot = requireRepoRoot(ctx);
```

In `getGhStatusReader`, replace:
```typescript
  if (ctx.ghStatusReader) return ctx.ghStatusReader;
  const repoRoot = ctx.repoRoot ?? process.cwd();
```
with:
```typescript
  if (ctx.ghStatusReader) return ctx.ghStatusReader;
  const repoRoot = requireRepoRoot(ctx);
```

In `getConflictResolver`, replace:
```typescript
  if (ctx.conflictResolver) return ctx.conflictResolver;
  const repoRoot = ctx.repoRoot ?? process.cwd();
```
with:
```typescript
  if (ctx.conflictResolver) return ctx.conflictResolver;
  const repoRoot = requireRepoRoot(ctx);
```

> NOTE: these getters all return EARLY when `ctx.<manager>` is already set (tests inject the manager directly), so `requireRepoRoot` only runs on the real lazy-build path. Existing IPC tests inject managers and never hit it.

- [ ] **Step 9: Run the wiring test to verify it passes**

Run:
```bash
npx vitest run tests/main/register-repo-ipc.test.ts
```
Expected: PASS — all five cases (REPO_GET value/null, canceled, non-git, valid+persist+relaunch).

- [ ] **Step 10: Run typecheck + the full suite**

Run:
```bash
npm run typecheck && npm run test
```
Expected: typecheck (node + web) passes and ALL suites pass — including the existing `ipc-roundtrip` / `register-gh-ipc` / `register-conflict-ipc` tests (they inject managers, so `requireRepoRoot` is never reached).

- [ ] **Step 11: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/types.ts src/shared/ipc-contract.ts src/preload/index.ts src/main/ipc/register-ipc.ts tests/main/register-repo-ipc.test.ts
git commit -m "$(cat <<'EOF'
feat: REPO_GET/REPO_PICK IPC + repoRoot-bound getter guards

4-layer repo IPC (channels, contract, preload, handlers). REPO_PICK
opens a native folder picker, validates a .git entry, persists
repoRoot via SettingsStore, then app.relaunch()+quit() for a uniform
restart. REPO_GET returns ctx.repoRoot. The 5 repoRoot-bound lazy
getters now assert via requireRepoRoot (throws 'no repository
selected' when null; defensive — renderer gates the UI).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Renderer `useRepo()` hook + App.tsx empty-state + repo header

**No unit test** — `@testing-library/react` is absent (no RTL). This task is gated on `npm run typecheck:web` (the hook + App edits must compile) and the GUI smoke in Task 7 (empty-state appears when no repo; picking relaunches; header shows the basename + change button).

**Files:**
- Create: `src/renderer/hooks/use-repo.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Create the `useRepo()` hook**

Create `src/renderer/hooks/use-repo.ts` (modeled on `use-settings.ts`):

```typescript
import { useCallback, useEffect, useState } from 'react';

/** Reads the selected repo root and exposes the native picker via window.mango.repo. */
export interface UseRepo {
  /** The currently-selected repo root, or null when none is set. */
  readonly repoRoot: string | null;
  /** True until the initial REPO_GET resolves. */
  readonly loading: boolean;
  /**
   * Open the native folder picker. On a valid git repo, main persists it and
   * relaunches the app (so this promise rarely resolves observably on success).
   */
  pick(): Promise<void>;
}

/** Fetches the repo root once on mount; pick() opens the native picker. */
export function useRepo(): UseRepo {
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.mango.repo
      .get()
      .then((r) => {
        if (alive) setRepoRoot(r);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const pick = useCallback(async (): Promise<void> => {
    // On success main relaunches the app, so we do not update local state here;
    // the fresh process re-reads REPO_GET. On cancel/error the empty-state stays.
    await window.mango.repo.pick();
  }, []);

  return { repoRoot, loading, pick };
}
```

- [ ] **Step 2: Wire `useRepo()` into App.tsx — import + hook call**

In `src/renderer/App.tsx`, add the import after the `useSettings` import:

```typescript
import { useRepo } from './hooks/use-repo';
```

Add the hook call at the TOP of the component body, as the first hook (just after `export function App(): React.JSX.Element {`, before the `useState` calls):

```typescript
  const repo = useRepo();
```

- [ ] **Step 3: Render the empty-state when no repo is selected**

In `src/renderer/App.tsx`, immediately after all the hook calls and the `onPing` callback definition — i.e. right before the existing `return (` of the main render — insert an early return for the empty-state. Place this block directly above `  return (`:

```typescript
  // Repo-picker gate: until a git repo is selected, show a centered empty-state
  // INSTEAD of the worktree UI. While loading the initial REPO_GET, render nothing
  // (avoids a flash of the empty-state before a persisted repo resolves).
  if (repo.loading) {
    return <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }} />;
  }
  if (repo.repoRoot === null) {
    return (
      <main
        style={{
          fontFamily: 'system-ui, sans-serif',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <h1 style={{ margin: 0 }}>MangoLove IDEA</h1>
        <p data-testid="repo-empty-state" style={{ fontSize: 14, color: '#666' }}>
          Select your git repository to begin
        </p>
        <button type="button" data-testid="repo-pick" onClick={() => void repo.pick()}>
          Select repository…
        </button>
      </main>
    );
  }

```

- [ ] **Step 4: Add the repo header (basename + change button) to the main UI**

In `src/renderer/App.tsx`, in the main `return (...)`, replace the existing `<p>` subtitle line:

```typescript
      <h1>MangoLove IDEA</h1>
      <p>Plan 4: merge + cleanup + unified status sidebar.</p>
```
with a header that shows the repo basename + a "change repo" button:

```typescript
      <h1>MangoLove IDEA</h1>
      <div
        data-testid="repo-header"
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}
      >
        <code style={{ fontSize: 13, color: '#444' }}>
          {repo.repoRoot.split('/').filter(Boolean).pop() ?? repo.repoRoot}
        </code>
        <button type="button" data-testid="repo-change" onClick={() => void repo.pick()}>
          change repo
        </button>
      </div>
```

> The worktree list / sidebar / panes below are UNCHANGED. NOTE (honest about the gate): the
> existing hooks (e.g. `useWorktrees`) are called ABOVE the empty-state early-return, so React's
> rules-of-hooks mean their mount effects DO fire even on a no-repo launch — `useWorktrees` issues
> a `worktree.list` while `ctx.repoRoot` is null. That call hits `requireRepoRoot`, which throws
> 'no repository selected'; the `WORKTREE_LIST` invoke then REJECTS, and `useWorktrees`'s own
> `try/catch` (use-worktrees.ts:29 — `catch (e) { setError(...) }`) swallows it into an error state
> that the renderer never shows (the empty-state early-return is what's on screen). So the startup
> guard fires-and-is-caught at the renderer-hook layer — it does NOT crash and the user only ever
> sees the empty-state until they pick a repo. (A cleaner future refactor would extract the
> worktree UI into a child mounted only when `repoRoot !== null` so the probe never fires; out of
> scope here — the caught guard is correct and sufficient for the MVP.) Confirm via the Task 7 GUI
> smoke that a no-repo launch shows ONLY the empty-state with no visible error.

- [ ] **Step 5: Verify the renderer typechecks**

Run:
```bash
npm run typecheck:web
```
Expected: PASS — `window.mango.repo.get/pick` resolve against the `MangoApi.repo` contract added in Task 5; the new hook + App edits compile.

- [ ] **Step 6: Verify the full build succeeds (renderer chunk + main)**

Run:
```bash
npm run build
```
Expected: `electron-vite build` completes with no errors, emitting `out/main`, `out/preload`, `out/renderer`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/hooks/use-repo.ts src/renderer/App.tsx
git commit -m "$(cat <<'EOF'
feat: renderer repo-picker (useRepo hook + empty-state + header)

useRepo() reads REPO_GET on mount and exposes pick(). App.tsx shows a
centered "Select your git repository to begin" empty-state with a pick
button when repoRoot is null; when set, renders the existing UI plus a
header showing the repo basename + a "change repo" button. Worktree UI
only mounts once a repo is selected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full suite + packaging & GUI smoke + V2-BACKLOG strike-through

**Files:**
- Modify: `docs/V2-BACKLOG.md`

- [ ] **Step 1: Run the full automated suite**

Run:
```bash
npm run typecheck && npm run lint && npm run test
```
Expected: typecheck (node + web) passes, ESLint passes, ALL Vitest suites pass (including the new `resolve-repo-root`, `register-repo-ipc`, and the extended `settings-store` tests).

- [ ] **Step 2: Build the unpacked app and run the packaging smoke**

Run:
```bash
npm run dist:dir
```
Expected: emits `release/mac-arm64/MangoLove IDEA.app`. Then re-confirm node-pty unpacking + the absence of type dirs (same as Task 1 Step 6):
```bash
ls -l "release/mac-arm64/MangoLove IDEA.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/"
npx asar list "release/mac-arm64/MangoLove IDEA.app/Contents/Resources/app.asar" | grep -E 'types-node|types-web' || echo "OK: no type dirs in asar"
```
Expected: `pty.node` + `spawn-helper` (+x) present; `OK: no type dirs in asar`.

- [ ] **Step 3: GUI smoke — launch from Finder and exercise the packaged app**

> REQUIRED, NON-SKIPPABLE gate. The PATH-merge and live-PTY-in-a-packaged-app behaviors run ONLY
> when `app.isPackaged` is true, so NO automated/headless check exercises them — the static `--dir`
> package inspection (Step 2) proves the structure but NOT that spawning works end-to-end. Do NOT
> mark packaging complete / strike the backlog on the `--dir` evidence alone; this Finder-launch
> smoke (terminal spawns + gh resolves + repo-picker relaunch) is the only proof of the spawn path.

Manual steps (document the result, do not script):
1. Clear quarantine and open the app:
   ```bash
   xattr -dr com.apple.quarantine "release/mac-arm64/MangoLove IDEA.app"
   open "release/mac-arm64/MangoLove IDEA.app"
   ```
   Expected: the window opens. Because no `repoRoot` is persisted yet and a Finder-launched `cwd` is `/`, the **repo-picker empty-state** ("Select your git repository to begin") is shown.
2. Click **Select repository…**, choose `/Users/ltm-luan/Project/mangolove-idea`. Expected: the app **relaunches** and now shows the main UI with the **repo header** (`mangolove-idea` + "change repo").
3. Create/select a worktree, then confirm the embedded **claude terminal SPAWNS and stays alive** (does not immediately show 'exited'). This proves BOTH the node-pty asarUnpack (PTY runs) AND the PATH fix (`claude` in `~/.local/bin` resolves).
4. Confirm **gh-backed PR/CI status** no longer reports gh-missing (gh in `/opt/homebrew/bin` now resolves) on a pushed branch, and a server start (npm/gradlew) resolves its binary.
5. Click **change repo**, pick a different git repo. Expected: the app relaunches against the new repo (REPO_PICK → persist → relaunch).

If any of 1–5 fails, STOP and debug (superpowers:systematic-debugging) — do not strike through the backlog.

- [ ] **Step 4: Build the distributable dmg**

Run:
```bash
npm run dist
```
Expected: electron-builder emits `release/MangoLove IDEA-0.1.0-arm64.dmg` (and the `.app` under `release/mac-arm64/`).

- [ ] **Step 5: Strike through the packaging row in V2-BACKLOG.md**

In `docs/V2-BACKLOG.md`, in section **E. 앱 기반**, replace the packaging row:

```markdown
| **패키징·배포 (electron-builder)** | M | — | 지금은 `npm run dev` 실행. 서명된 설치본. `electron-builder`는 dev dep로 이미 잡아둠 |
```
with:
```markdown
| ~~**패키징·배포 (electron-builder)**~~ ✅ **완료** | M | — | electron-builder@26.15.3로 mac arm64 dmg 패키징. node-pty `build/Release/*`(pty.node + spawn-helper) asarUnpack, `npmRebuild:false`(ABI-146는 electron-rebuild postinstall 산출), ad-hoc 서명(`mac.identity:null`). Finder 런치 PATH 픽스(packaged darwin: `$SHELL -ilc`로 로그인 셸 PATH 머지 → claude/gh/git/npm 스폰) + repo-root 피커(`resolveRepoRoot`: persisted SettingsStore.repoRoot → cwd → null, REPO_GET/PICK IPC, dialog→검증→persist→relaunch). 계획: docs/plans/2026-06-19-v2-packaging.md |
```

Also append a note to the "멀티레포 / 멀티윈도우" row context is unchanged — leave that row as-is (single-repo remains; this work makes the single repo a *picked* repo, not multi-repo).

- [ ] **Step 6: Commit**

```bash
git add docs/V2-BACKLOG.md
git commit -m "$(cat <<'EOF'
docs: mark packaging/distribution complete in V2-BACKLOG

electron-builder mac arm64 dmg + Finder PATH fix + repo-root picker
shipped (docs/plans/2026-06-19-v2-packaging.md). Full suite + dist:dir
+ GUI smoke passed (terminal spawns, gh resolves, repo-picker relaunch).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Migration Strategy (additive — `npm run dev` untouched)

Every change is additive and guarded so the dev workflow is byte-for-byte unchanged:

1. **electron-builder install + `build` field + `dist`/`dist:dir` scripts** — electron-vite `dev`/`build`/`preview` ignore the `build` field; the new scripts are opt-in. The install re-runs the existing `postinstall` (`electron-rebuild`), re-confirming the ABI-146 node-pty binary (harmless).
2. **PATH fix** — guarded by `app.isPackaged && process.platform === 'darwin'`. In `npm run dev` and in vitest, `app.isPackaged` is `false`, so the block is a literal no-op; the dev shell PATH/cwd behavior is preserved exactly.
3. **`resolveRepoRoot()`** — in dev, `process.cwd()` IS the project repo (which has a `.git` entry), so `resolveRepoRoot` returns `cwd` exactly as the old `ctx.repoRoot = process.cwd()` did. No persisted `repoRoot` is needed for dev; the only behavior change is on a packaged Finder launch (cwd `/`), where it correctly returns `null` → the renderer shows the picker.
4. **`AppSettings.repoRoot` + KNOWN_KEYS** — purely additive; existing settings files lacking `repoRoot` load identically.
5. **REPO_GET/REPO_PICK IPC** — new channels; no existing channel changes. The 5 repoRoot-bound getter null-guards only fire on the real lazy-build path with a null repoRoot, which the renderer gate prevents.
6. **Renderer empty-state + header** — in dev (`repoRoot !== null`) the empty-state branch is never taken; the only visible addition is the small repo header. Existing worktree/terminal/diff/merge/settings UI is unchanged.

Rollout order: `npm run build` → `npm run dist:dir` (seconds, unpacked `.app`) to smoke-test → `npm run dist` for the dmg. `out/` and `release/` stay gitignored.

---

## Acceptance Checklist

- [ ] `electron-builder@26.15.3` is in `devDependencies`; the resolved version is recorded in the Task 1 commit body.
- [ ] `package.json` has the top-level `build` field with `appId:"me.onda.mangolove-idea"`, `productName:"MangoLove IDEA"`, `electronVersion:"42.4.0"`, `directories.output:"release"`, `files:["out/main/**/*","out/preload/**/*","out/renderer/**/*","package.json"]`, `asar:true`, `asarUnpack:["**/node_modules/node-pty/build/Release/*"]`, `npmRebuild:false`, `mac.identity:null`, `mac.target:[{target:"dmg",arch:["arm64"]}]`, `mac.category:"public.app-category.developer-tools"`.
- [ ] `dist` and `dist:dir` scripts exist; `.gitignore` ignores `release/`.
- [ ] `npm run dist:dir` produces `release/mac-arm64/MangoLove IDEA.app`; its `app.asar.unpacked/.../node-pty/build/Release/` contains `pty.node` + `spawn-helper` (+x); `out/types-node`/`out/types-web` are absent from `app.asar`.
- [ ] `npm run dist` produces `release/MangoLove IDEA-0.1.0-arm64.dmg`.
- [ ] `src/main/index.ts` imports `execFileSync`; the packaged-darwin PATH-merge block is the FIRST statement in `whenReady`, guarded by `app.isPackaged && process.platform === 'darwin'`, with `timeout:5000` + try/catch.
- [ ] `AppSettings.repoRoot?: string` exists; `'repoRoot'` is in `SettingsStore.KNOWN_KEYS`; the settings-store test asserts repoRoot round-trip + non-string sanitize.
- [ ] `resolveRepoRoot()` returns persisted-if-valid → cwd-if-valid → null; unit-tested with injected `existsSync` for all three branches.
- [ ] `ctx.repoRoot` is typed `string | null`; `createIpcContext()` seeds `repoRoot: null`; `index.ts` sets it via `resolveRepoRoot`.
- [ ] REPO_GET returns `ctx.repoRoot`; REPO_PICK opens `dialog.showOpenDialog({properties:["openDirectory"]})`, returns `{ok:false,canceled:true}` on cancel, `{ok:false,error:"not a git repository"}` on a non-`.git` dir, and on a valid dir persists `{repoRoot:dir}` + calls `app.relaunch()` + `app.quit()`; wiring test covers all four.
- [ ] All 4 IPC layers wired (channels, contract `repo:{get,pick}`, preload, register-ipc handlers); the 5 repoRoot-bound getters throw `"no repository selected"` when `repoRoot` is null.
- [ ] `useRepo()` hook exists; App.tsx shows the empty-state (`repo-empty-state` + `repo-pick`) when `repoRoot===null && !loading`, and the repo header (`repo-header` basename + `repo-change`) plus the existing UI when set.
- [ ] `npm run typecheck` + `npm run lint` + `npm run test` all pass.
- [ ] GUI smoke (Task 7 Step 3) passed: empty-state → pick → relaunch → header; terminal spawns and stays alive; gh resolves; change-repo relaunches.
- [ ] `docs/V2-BACKLOG.md` packaging row struck through.
- [ ] `npm run dev` is unchanged (PATH block is a no-op via `app.isPackaged`; `resolveRepoRoot` returns cwd in dev; empty-state branch never taken).

---

## Self-Review

**1. Spec coverage** — every locked decision maps to a task:
- (1) PACKAGING → Task 1 (dep + build field + scripts + .gitignore + asarUnpack/npmRebuild/identity exactly as specified; `files` excludes type dirs).
- (2) PATH FIX → Task 2 (execFileSync import; `app.isPackaged && darwin` block at top of whenReady; `$SHELL -ilc 'printf "%s" "$PATH"'`; timeout 5000; try/catch; no-op in dev).
- (3) REPO-ROOT RESOLUTION → Task 4 (`resolveRepoRoot` persisted→cwd→null; `.git` existsSync rule; `ctx.repoRoot: string | null`).
- (4) PERSIST repoRoot → Task 3 (`AppSettings.repoRoot` + KNOWN_KEYS; reuses SettingsStore; NOT in the modal).
- (5) ctx.repoRoot TYPE → Task 4 (type change) + Task 5 (getter null-guards throwing `"no repository selected"`).
- (6) REPO IPC → Task 5 (REPO_GET/REPO_PICK; dialog/validate/persist/relaunch+quit; 4 layers; RepoPickResult).
- (7) RENDERER → Task 6 (`useRepo()`; empty-state instead of worktree UI; header basename + change button; gated mounting).
- (8) TESTS → Task 3 (settings round-trip), Task 4 (resolveRepoRoot injected existsSync), Task 5 (REPO_GET/PICK wiring with mocked dialog + relaunch/quit); renderer + packaging explicitly NO unit test (typecheck:web + dist:dir + GUI smoke), as instructed.
- Task order matches the required order (1→2→3→4→5→6→7).

**2. Placeholder scan** — no `TBD`/`TODO`/"implement later"/"add appropriate…"; every code step shows complete code; every command has expected output; every commit has a message. The "NO unit test" gating is stated explicitly for Tasks 1, 2, and 6.

**3. Type consistency** — `resolveRepoRoot(ResolveRepoRootOptions)` signature is identical across Task 4 def, its test, and the `index.ts` call (`{persisted, cwd}`). `RepoPickResult` union (`{ok:true,repoRoot}` | `{ok:false,canceled:true}` | `{ok:false,error}`) is identical in `types.ts`, the contract, and the wiring test assertions. `ctx.repoRoot: string | null` is consistent in `ipc-context.ts`, `createIpcContext()`, `index.ts`, `requireRepoRoot`, and REPO_GET. Channel names `REPO_GET`/`REPO_PICK` (`'repo:get'`/`'repo:pick'`) and method names `repo.get()`/`repo.pick()` match across channels, contract, preload, handlers, and `useRepo`. `KNOWN_KEYS` includes `'repoRoot'` consistent with `AppSettings.repoRoot`.

`IpcContext.repoRoot` is kept OPTIONAL (`repoRoot?: string | null`), so NO existing test ctx literal needs editing — an omitted `repoRoot` is `undefined`, which `requireRepoRoot` treats exactly like `null`. This avoids the broad churn of adding `repoRoot: null` to ~25 literals + the 3 `IpcContext`-typed ctx objects in `ipc-roundtrip.test.ts`.
