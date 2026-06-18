# Plan: V2 PR/CI Status Panel (gh-backed, per-worktree)

## Goal

Add a read-only, per-worktree **PR/CI status panel** to MangoLove IDEA. When a worktree is
selected, the panel shows — at a glance — whether the branch has an open PR on GitHub, the PR
state/title/draft/review decision, and a collapsed CI summary (passing/failing/pending), with an
"Open in browser" action. Auth reuses the user's `gh` CLI keyring with **zero token handling** in
the app. No-PR / not-pushed are the COMMON path (this repo merges to `main` directly) and render as
calm neutral one-line states, never errors.

## Architecture

A new stateless `GhStatusReader` (mirroring the existing `DiffViewer`): per-worktree, read-only,
constructor-injected with a `ProcessRunner`, a `resolveBranch`/`resolvePath` closure, `repoRoot`,
and `owner/repo`. It runs **cheap LOCAL git pre-checks first** (resolve branch + upstream check) to
make the common states first-class and to skip the network call entirely when a branch is not
pushed. Only when pushed does it spawn `gh` (two read-only calls: `gh pr view`, then `gh pr checks`)
with `cwd = worktree path` AND `-R owner/repo` AND the positional `<branch>`.

The result is a discriminated union `GhStatus` (on `kind`). Two **pure** exported functions —
`classifyGhStatus(code, stdout, stderr)` and `summarizeChecks(rows)` — carry all the
gh-quirk logic and are unit-tested with zero spawning. `gh`-missing is detected via a new additive
`onError(cb)` on `IProcLike` (ENOENT spawn error → deterministic sentinel), since a missing binary
fires a child `error` event with no exit code and would otherwise hang the promise.

Surfaced through the existing strict **additive 4-layer IPC** (channel → register-ipc handler →
contract → preload), consumed by a `useGhStatus(worktreeId)` hook (copied from `use-diff.ts`) and a
`GhStatusPanel` component (copied structurally from `merge-controls.tsx`), mounted in `App.tsx`
right after `MergeControls`. A second tiny additive channel `app:open-external` performs the only
"action" (`shell.openExternal(pr.url)`), read-only otherwise.

**Pull model:** fetch on select + a manual `refresh()`. The result is NEVER cached in main (gh state
changes out-of-band); only the reader is cached on a new `ctx.ghStatusReader?` slot (like
`diffViewer`).

### Token hygiene (LOCKED, non-negotiable)

- NEVER read/store/print/log the gh token.
- NEVER call `gh auth status` (it prints a masked token).
- NEVER set `GH_TOKEN`.
- NEVER write gh stderr verbatim into `LogStore` — classify it into a `GhStatus.kind` FIRST.
- Pass `process.env` through ONLY so gh can reach PATH + the keyring; add nothing token-related.

## Tech Stack

- **Main:** TypeScript (ESM, `verbatimModuleSyntax`), `node:child_process` via the existing
  `ProcessRunner`/`IProcLike` seam, `simple-git` (dynamic `import`, matching `getDiffViewer`),
  Electron `ipcMain` + `shell.openExternal`.
- **Renderer:** React (hooks + functional components), the existing `window.mango` preload bridge.
- **Test:** Vitest, the existing `makeFakeRunner` (tests/helpers/fake-runner.ts) and `makeIpcMain()`
  doubles. Renderer hook gets NO RTL test (`@testing-library/react` is absent — covered by
  `typecheck:web` + a documented Playwright smoke, matching `use-diff`/`use-settings`).
- **External:** `gh` 2.89.0 (empirically verified strings/codes baked into the classifier).

> **REQUIRED SUB-SKILL: superpowers:subagent-driven-development**
> Execute each task below as an isolated unit: write the failing test, watch it fail with the
> expected output, write the minimal COMPLETE implementation, watch it pass, then commit. Do not
> batch tasks. Each task is independently testable and builds on the prior.

---

## File Structure

```
src/
  shared/
    types.ts                         (MODIFY: + GhStatusRequest, GhStatus, GhPrInfo, GhCiSummary, OpenExternalRequest)
    ipc-channels.ts                  (MODIFY: + GH_STATUS, APP_OPEN_EXTERNAL)
    ipc-contract.ts                  (MODIFY: + gh.status, app.openExternal)
  preload/
    index.ts                         (MODIFY: + gh.status, app.openExternal forwards)
  main/
    proc/
      process-runner.ts              (MODIFY: + onError on IProcLike, + spawnArgs non-shell path, wire 'error' event)
    git/
      gh-status-reader.ts            (CREATE: GhStatusReader + classifyGhStatus + summarizeChecks)
    ipc/
      ipc-context.ts                 (MODIFY: + ghStatusReader? slot)
      register-ipc.ts                (MODIFY: + getGhStatusReader, + GH_STATUS handler, + APP_OPEN_EXTERNAL handler)
  renderer/
    hooks/
      use-gh-status.ts               (CREATE: useGhStatus hook)
    components/toolbar/
      gh-status-panel.tsx            (CREATE: GhStatusPanel)
    App.tsx                          (MODIFY: mount <GhStatusPanel> after MergeControls)
tests/
  main/
    process-runner.test.ts           (CREATE or MODIFY: onError/spawnArgs extension)
    gh-classify.test.ts              (CREATE: pure classifyGhStatus + summarizeChecks)
    gh-status-reader.test.ts         (CREATE: reader against fake runner)
    register-gh-ipc.test.ts          (CREATE: IPC wiring + token-hygiene grep assertion)
docs/
  plans/
    2026-06-18-v2-prci-panel.md      (this file)
    V2-BACKLOG.md                    (MODIFY or CREATE: polling / richer per-check list deferred)
```

---

## Task 1 — Shared types + channels + contract (additive type wiring)

No runtime behavior; this is the type-level scaffold every later task imports. The "test" is the
typecheck pass (no logic to TDD yet) plus a tiny compile-only assertion that the union is
exhaustive-friendly.

### Files

- **Modify** `src/shared/types.ts` — append after the Diff viewer block (after line 334, before the
  `// ── Settings (V2 item E) ──` block).
- **Modify** `src/shared/ipc-channels.ts` — append two lines inside the `IPC` const (after the diff
  viewer block at line 48, before the settings block at line 50).
- **Modify** `src/shared/ipc-contract.ts` — add a `gh` group + `openExternal` on `app`, and import
  the new types.

### Step 1.1 — Add the result types

In `src/shared/types.ts`, insert immediately after the `DiffFileRequest` interface (after line 334):

```ts
// ── PR/CI status panel (V2) ──

/** Request the gh-backed PR/CI status for one worktree. */
export interface GhStatusRequest {
  readonly worktreeId: string;
}

/** Ask main to open a URL in the OS default browser (the only "action"). */
export interface OpenExternalRequest {
  readonly url: string;
}

/** Collapsed CI summary derived ONLY from gh's per-check `bucket` field. */
export interface GhCiSummary {
  /** 'none' = a PR with zero reported checks. */
  readonly summary: 'passing' | 'failing' | 'pending' | 'none';
  readonly counts: {
    readonly pass: number;
    readonly fail: number;
    readonly pending: number;
    readonly skipping: number;
    readonly cancel: number;
  };
}

/** PR header for an open/merged/closed PR on the worktree's branch. */
export interface GhPrInfo {
  readonly number: number;
  /** gh `state`: OPEN | MERGED | CLOSED. */
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  /**
   * gh `reviewDecision`: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' (the
   * EMPTY STRING when no review is required — handle it, do not assume one of three).
   */
  readonly reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}

/**
 * Discriminated union on `kind`. The COMMON path here is not-pushed / no-pr (repo
 * merges to main directly); those are calm first-class states, NOT errors.
 *  - gh-missing   : the gh binary is not installed (spawn ENOENT).
 *  - not-authed   : gh is installed but not logged in (exit 4 / 'gh auth login').
 *  - no-remote    : no git/GitHub remote configured.
 *  - not-pushed   : the branch has no upstream — detected LOCALLY, gh never spawned.
 *  - no-pr        : pushed but no PR exists yet.
 *  - open-pr      : a PR exists (state may be OPEN | MERGED | CLOSED); carries pr + ci.
 *  - rate-limited : GitHub API rate limit / HTTP 403.
 *  - error        : anything else; carries a trimmed friendly message.
 */
export type GhStatus =
  | { readonly kind: 'gh-missing' }
  | { readonly kind: 'not-authed' }
  | { readonly kind: 'no-remote' }
  | { readonly kind: 'not-pushed' }
  | { readonly kind: 'no-pr' }
  | { readonly kind: 'open-pr'; readonly pr: GhPrInfo; readonly ci: GhCiSummary }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'error'; readonly message: string };
```

### Step 1.2 — Add the channels

In `src/shared/ipc-channels.ts`, insert after line 48 (after the `DIFF_FILE` line, before the
settings comment block):

```ts

  // PR/CI status panel (V2) — read-only gh-backed status + the open-in-browser action
  GH_STATUS: 'gh:status', // invoke (worktreeId -> GhStatus)
  APP_OPEN_EXTERNAL: 'app:open-external', // invoke (url -> Ack; shell.openExternal)
```

### Step 1.3 — Add the contract

In `src/shared/ipc-contract.ts`, add `GhStatus`, `GhStatusRequest`, `OpenExternalRequest` to the
import block from `./types` (after `AppSettings,` on line 34):

```ts
  GhStatus,
  GhStatusRequest,
  OpenExternalRequest,
```

Add `openExternal` to the `app` group (after `sendQuitDecision` on line 45):

```ts
    /** Open a URL in the OS default browser (read-only action; used by the PR panel). */
    openExternal(req: OpenExternalRequest): Promise<Ack>;
```

Add a new `gh` group after the `settings` group (after line 111, before the closing `}` of
`MangoApi`):

```ts
  gh: {
    /** Read-only PR/CI status for the worktree's branch (gh keyring auth; no token in app). */
    status(req: GhStatusRequest): Promise<GhStatus>;
  };
```

### Verify

```
npm run typecheck
```

Expected: `npm run typecheck` WILL FAIL — and that is correct for this task. Widening `MangoApi`
with the `gh` group + `app.openExternal` makes `src/preload/index.ts` and the `register-ipc.ts`
handlers (which assert `MangoApi`) not satisfy it yet; those are wired in Tasks 5–6. No EXISTING
member changes (purely additive), so nothing already-passing regresses. The real Task-1 gate is that
the SHARED layer itself compiles cleanly — verify with the shared-only check:

```
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "src/shared/(types|ipc-channels|ipc-contract)" || echo "shared types OK"
```

Expected: `shared types OK` (zero errors in the shared files; the only typecheck errors are the
known preload/register-ipc "not satisfying MangoApi yet", resolved in Tasks 5–6). The full
`npm run typecheck` returns to green at Task 6.

### Commit

```
feat(gh): add GhStatus types, channels, and contract for the PR/CI panel
```

---

## Task 2 — ProcessRunner: additive `onError` + non-shell argv spawn (TDD)

Add the seam extension required for deterministic gh-missing detection and an injection-safe argv
spawn for structured gh args. **Backward compatible:** existing consumers
(`ServerManager`/`MergeRunner`) never subscribe to `onError` and keep using `spawn(command, opts)`.

### Files

- **Modify** `src/main/proc/process-runner.ts` — add `onError` to `IProcLike` (line 20-27), wire the
  child `'error'` event in `NodeProcessRunner.spawn` (line 42-58), add a `spawnArgs(argv, opts)`
  method to `ProcessRunner`/`NodeProcessRunner`.
- **Modify** `tests/helpers/fake-runner.ts` — add `emitError` + `onError` so the fake can drive the
  ENOENT path.
- **Create** `tests/main/process-runner.test.ts` — assert the fake's `onError` contract (the real
  spawn is exercised indirectly; the unit-level contract is the fake + interface shape).

### Step 2.1 — Write the failing test

Create `tests/main/process-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeFakeRunner } from '../helpers/fake-runner';

describe('IProcLike onError (gh-missing seam)', () => {
  it('delivers a spawn error to the onError callback', () => {
    const proc = makeFakeRunner();
    let received: Error | null = null;
    proc.onError((e) => {
      received = e;
    });
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', errno: -2 });
    proc.emitError(err);
    expect(received).not.toBeNull();
    expect((received as unknown as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('does not also fire onExit when only an error was emitted', () => {
    const proc = makeFakeRunner();
    let exited = false;
    proc.onExit(() => {
      exited = true;
    });
    proc.emitError(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(exited).toBe(false);
  });
});
```

### Step 2.2 — Run it; watch it fail

```
npx vitest run tests/main/process-runner.test.ts
```

Expected failure: `TypeError: proc.onError is not a function` (the fake has no `onError`/`emitError`
yet).

### Step 2.3 — Minimal COMPLETE implementation

Edit `tests/helpers/fake-runner.ts`. Add `onError`/`emitError` to the interface (after line 11) and
the impl (after the `onExit` line in the returned object):

In the `FakeProcHandle` interface, after `emitExit(...)`:

```ts
  /** Subscribe to a spawn-level error (e.g. ENOENT for a missing binary). */
  onError(cb: (err: Error) => void): void;
  /** Simulate a spawn 'error' event (no exit follows). */
  emitError(err: Error): void;
```

In the returned object, after the `onExit:` line (line 27) add:

```ts
    onError: (cb) => void bus.on('procError', cb),
```

Insert the `emitError` line immediately BEFORE the `killed: () => done,` line (line 35), inside the returned object. NB: use a NON-reserved event name (`procError`, NOT `error`). Node's `EventEmitter` special-cases the reserved `error` event — emitting it with no listener registered THROWS synchronously, which would crash the Task-2 `does not also fire onExit` test (it subscribes only `onExit`). `procError` has no such footgun:

```ts
    emitError: (err) => bus.emit('procError', err),
```

Now edit `src/main/proc/process-runner.ts`.

Add `onError` to `IProcLike` (after `onExit` on line 26):

```ts
  /** Spawn-level failure (e.g. ENOENT for a missing binary). Fires INSTEAD of onExit. */
  onError(cb: (err: Error) => void): void;
```

Add `spawnArgs` to the `ProcessRunner` interface (after the `spawn` method on line 32):

```ts
  /**
   * Spawns an argv array WITHOUT a shell (no shell:true injection surface). Used for
   * structured commands like gh where args (e.g. a branch token) must not be word-split.
   */
  spawnArgs(file: string, args: readonly string[], opts: ProcSpawnOptions): IProcLike;
```

In `NodeProcessRunner`, wire the `'error'` event in the existing `spawn` (add after the `onExit`
line at line 56, inside the returned object):

```ts
      onError: (cb) => void child.on('error', (e: Error) => cb(e)),
```

Then add the `spawnArgs` method to `NodeProcessRunner` (after the `spawn` method closes at line 58):

```ts

  spawnArgs(file: string, args: readonly string[], opts: ProcSpawnOptions): IProcLike {
    const child = spawn(file, [...args], {
      shell: false,
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
      onError: (cb) => void child.on('error', (e: Error) => cb(e)),
    };
  }
```

### Step 2.4 — Run it; watch it pass

```
npx vitest run tests/main/process-runner.test.ts
```

Expected: `2 passed`.

Confirm no regression in existing runner consumers:

```
npx vitest run tests/main/server-manager.test.ts
```

Expected: all existing server-manager tests still pass (they ignore `onError`/`spawnArgs`).

### Commit

```
feat(proc): add onError + non-shell spawnArgs to ProcessRunner (backward compatible)
```

---

## Task 3 — Pure `classifyGhStatus` + `summarizeChecks` (TDD, zero spawning)

The table-driven heart of the feature. Both functions are pure and exported; all gh-quirk knowledge
(exact strings/codes from gh 2.89.0) lives here.

### Files

- **Create** `src/main/git/gh-status-reader.ts` — but in THIS task only the two pure exports +
  needed types (the class shell comes in Task 4). It is fine to land the pure functions first.
- **Create** `tests/main/gh-classify.test.ts`.

### Step 3.1 — Write the failing tests

Create `tests/main/gh-classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  classifyGhStatus,
  summarizeChecks,
  GH_MISSING_SENTINEL,
} from '../../src/main/git/gh-status-reader';
import type { GhStatus } from '../../src/shared/types';

function kind(s: GhStatus): GhStatus['kind'] {
  return s.kind;
}

describe('classifyGhStatus (pure, table-driven, no spawning)', () => {
  it('maps the gh-missing sentinel (spawn ENOENT) to gh-missing', () => {
    expect(kind(classifyGhStatus(GH_MISSING_SENTINEL, '', ''))).toBe('gh-missing');
  });

  it('maps exit 4 to not-authed', () => {
    expect(kind(classifyGhStatus(4, '', 'gh auth login required'))).toBe('not-authed');
  });

  it('maps the not-logged-in stderr to not-authed regardless of code', () => {
    expect(
      kind(classifyGhStatus(1, '', 'You are not logged into any GitHub hosts. To get started')),
    ).toBe('not-authed');
  });

  it('maps no-git-remotes / not-a-github-repo / no-github-host to no-remote', () => {
    expect(kind(classifyGhStatus(1, '', 'no git remotes found'))).toBe('no-remote');
    expect(
      kind(classifyGhStatus(1, '', 'none of the git remotes ... point to a known GitHub host')),
    ).toBe('no-remote');
    expect(kind(classifyGhStatus(1, '', 'not a github repository'))).toBe('no-remote');
  });

  it('maps the no-PR stderr (exit 1) to no-pr', () => {
    expect(
      kind(classifyGhStatus(1, '', 'no pull requests found for branch "feature/login"')),
    ).toBe('no-pr');
  });

  it('maps rate limit / HTTP 403 to rate-limited', () => {
    expect(kind(classifyGhStatus(1, '', 'API rate limit exceeded'))).toBe('rate-limited');
    expect(kind(classifyGhStatus(1, '', 'HTTP 403: rate limit'))).toBe('rate-limited');
  });

  it('falls through to error with a trimmed friendly message', () => {
    const s = classifyGhStatus(1, '', '  fatal: something unexpected happened  \n');
    expect(s.kind).toBe('error');
    if (s.kind === 'error') expect(s.message).toBe('something unexpected happened');
  });
});

describe('summarizeChecks (pure, switches on bucket only)', () => {
  it('returns none for zero checks', () => {
    expect(summarizeChecks([])).toEqual({
      summary: 'none',
      counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 },
    });
  });

  it('any fail bucket => failing (precedence over pending/pass)', () => {
    const out = summarizeChecks([
      { bucket: 'pass' },
      { bucket: 'fail' },
      { bucket: 'pending' },
    ]);
    expect(out.summary).toBe('failing');
    expect(out.counts).toEqual({ pass: 1, fail: 1, pending: 1, skipping: 0, cancel: 0 });
  });

  it('a cancel bucket counts as failing-precedence', () => {
    expect(summarizeChecks([{ bucket: 'pass' }, { bucket: 'cancel' }]).summary).toBe('failing');
  });

  it('pending (no fails) => pending', () => {
    expect(summarizeChecks([{ bucket: 'pass' }, { bucket: 'pending' }]).summary).toBe('pending');
  });

  it('all pass/skipping => passing', () => {
    expect(summarizeChecks([{ bucket: 'pass' }, { bucket: 'skipping' }]).summary).toBe('passing');
  });

  it('ignores unknown bucket values defensively', () => {
    expect(summarizeChecks([{ bucket: 'pass' }, { bucket: 'weird' as never }]).summary).toBe(
      'passing',
    );
  });
});
```

### Step 3.2 — Run it; watch it fail

```
npx vitest run tests/main/gh-classify.test.ts
```

Expected failure: `Failed to resolve import "../../src/main/git/gh-status-reader"` (the module does
not exist yet).

### Step 3.3 — Minimal COMPLETE implementation

Create `src/main/git/gh-status-reader.ts` (pure functions + types only for this task):

```ts
import type { GhCiSummary, GhStatus } from '../../shared/types';

/**
 * Sentinel exit "code" for the gh-MISSING case. gh-missing is NOT a real exit code:
 * Electron's child_process.spawn of a missing binary fires an 'error' event with
 * err.code === 'ENOENT' and NO exit code (a bare shell would give 127, but spawn does
 * not surface that). The reader's onError(ENOENT) path feeds THIS sentinel to the
 * classifier instead of inventing an exit-127 branch.
 */
export const GH_MISSING_SENTINEL = -100;

/** One row of `gh pr checks --json bucket,...`. We switch ONLY on `bucket`. */
export interface GhCheckRow {
  readonly bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
}

/**
 * PURE, table-driven mapping of (exit code, stdout, stderr) to a GhStatus kind.
 * Mirrors classifyGitError in worktree-manager.ts. ZERO spawning, ZERO token reads.
 *
 * IMPORTANT: this is only ever applied when gh ACTUALLY launched (exit-code table),
 * PLUS the GH_MISSING_SENTINEL fed by the reader's onError(ENOENT) path. The exact
 * strings/codes are verified against gh 2.89.0.
 */
export function classifyGhStatus(code: number | null, stdout: string, stderr: string): GhStatus {
  void stdout; // header parsing happens in the reader on the success path; not here.
  if (code === GH_MISSING_SENTINEL) return { kind: 'gh-missing' };

  const err = stderr ?? '';
  // not-authed: exit 4 OR the canonical not-logged-in message.
  if (code === 4 || /not logged into any GitHub hosts|gh auth login/i.test(err)) {
    return { kind: 'not-authed' };
  }
  // no-remote: any of the "no usable GitHub remote" signatures.
  if (/no git remotes found|not a github repository|known GitHub host/i.test(err)) {
    return { kind: 'no-remote' };
  }
  // no-pr: the verified exit-1 stderr from `gh pr view`/`gh pr checks` on a PR-less branch.
  if (/no pull requests found for branch/i.test(err)) {
    return { kind: 'no-pr' };
  }
  // rate-limited: a distinct calm state, never a hard error.
  if (/rate limit|HTTP 403/i.test(err)) {
    return { kind: 'rate-limited' };
  }
  return { kind: 'error', message: trimFriendly(err) };
}

/** Strips a leading 'fatal:'/'error:' prefix and trims (mirrors classifyGitError). */
function trimFriendly(raw: string): string {
  return raw
    .replace(/^(fatal|error):\s*/i, '')
    .trim();
}

/**
 * PURE roll-up of `gh pr checks` rows into a collapsed GhCiSummary, switching ONLY on
 * the pre-bucketed `bucket` field (pass|fail|pending|skipping|cancel) — never on the
 * ~17 raw state/conclusion values. Precedence: any fail/cancel => failing; else any
 * pending => pending; else (pass/skipping) => passing; empty => none.
 */
export function summarizeChecks(rows: readonly GhCheckRow[]): GhCiSummary {
  const counts = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  for (const r of rows) {
    if (r.bucket === 'pass') counts.pass += 1;
    else if (r.bucket === 'fail') counts.fail += 1;
    else if (r.bucket === 'pending') counts.pending += 1;
    else if (r.bucket === 'skipping') counts.skipping += 1;
    else if (r.bucket === 'cancel') counts.cancel += 1;
    // unknown buckets are ignored defensively
  }
  let summary: GhCiSummary['summary'];
  if (rows.length === 0) summary = 'none';
  else if (counts.fail > 0 || counts.cancel > 0) summary = 'failing';
  else if (counts.pending > 0) summary = 'pending';
  else summary = 'passing';
  return { summary, counts };
}
```

### Step 3.4 — Run it; watch it pass

```
npx vitest run tests/main/gh-classify.test.ts
```

Expected: `13 passed` (7 classify + 6 summarize).

### Commit

```
feat(gh): pure classifyGhStatus + summarizeChecks (gh 2.89.0 ground-truth)
```

---

## Task 4 — `GhStatusReader` class (TDD against the fake runner)

The stateless, per-worktree reader mirroring `DiffViewer`. Local pre-checks first; gh only when
pushed; `runToCompletion` buffers + has a JS timeout + kill guard.

### Files

- **Modify** `src/main/git/gh-status-reader.ts` — add the `GhStatusReader` class (keep the pure
  functions from Task 3).
- **Create** `tests/main/gh-status-reader.test.ts`.

### Step 4.1 — Write the failing tests

Create `tests/main/gh-status-reader.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { GhStatusReader } from '../../src/main/git/gh-status-reader';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';
import type { ProcessRunner, IProcLike } from '../../src/main/proc/process-runner';

/** Records each spawnArgs call (file, args, cwd) and hands out queued fakes. */
function makeRunnerFactory(fakes: FakeProcHandle[]) {
  const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
  let i = 0;
  const runner: ProcessRunner = {
    spawn: () => {
      throw new Error('GhStatusReader must use spawnArgs (non-shell), not spawn');
    },
    spawnArgs: (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd });
      const f = fakes[i++];
      if (!f) throw new Error('fake runner ran out of procs');
      return f as unknown as IProcLike;
    },
  };
  return { runner, calls };
}

/** Minimal git double: resolveBranch + resolvePath + upstream check. */
function makeDeps(opts: {
  fakes: FakeProcHandle[];
  branch: string;
  worktreePath: string;
  hasUpstream: boolean;
}) {
  const { runner, calls } = makeRunnerFactory(opts.fakes);
  const reader = new GhStatusReader({
    runner,
    repoRoot: '/repo',
    owner: 'SongJunSub',
    repo: 'mangolove-idea',
    resolveBranch: vi.fn().mockResolvedValue(opts.branch),
    resolvePath: vi.fn().mockResolvedValue(opts.worktreePath),
    hasUpstream: vi.fn().mockResolvedValue(opts.hasUpstream),
    timeoutMs: 50,
  });
  return { reader, calls };
}

const PR_VIEW_JSON = JSON.stringify({
  number: 42,
  title: 'Add login',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/SongJunSub/mangolove-idea/pull/42',
  reviewDecision: '',
});

const CHECKS_JSON = JSON.stringify([
  { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'x' },
  { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'y' },
]);

describe('GhStatusReader', () => {
  it('not-pushed: no upstream short-circuits WITHOUT spawning gh', async () => {
    const { reader, calls } = makeDeps({
      fakes: [],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: false,
    });
    const status = await reader.status({ worktreeId: '/repo/.worktrees/feat' });
    expect(status).toEqual({ kind: 'not-pushed' });
    expect(calls).toHaveLength(0); // gh NEVER spawned
  });

  it('open-pr: parses pr view + pr checks into pr + ci (ci from bucket)', async () => {
    const view = makeFakeRunner();
    const checks = makeFakeRunner();
    const { reader, calls } = makeDeps({
      fakes: [view, checks],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStdout(PR_VIEW_JSON);
    view.emitExit(0);
    checks.emitStdout(CHECKS_JSON);
    checks.emitExit(0);
    const status = await p;

    expect(status.kind).toBe('open-pr');
    if (status.kind === 'open-pr') {
      expect(status.pr).toMatchObject({ number: 42, state: 'OPEN', isDraft: false, reviewDecision: '' });
      expect(status.ci.summary).toBe('failing');
      expect(status.ci.counts).toMatchObject({ pass: 1, fail: 1 });
    }

    // cwd = worktree path, file = gh, args include -R owner/repo AND the POSITIONAL branch.
    expect(calls[0].file).toBe('gh');
    expect(calls[0].cwd).toBe('/repo/.worktrees/feat');
    expect(calls[0].args).toEqual([
      'pr',
      'view',
      'feature/login',
      '-R',
      'SongJunSub/mangolove-idea',
      '--json',
      'number,title,state,isDraft,url,reviewDecision',
    ]);
    expect(calls[1].args.slice(0, 3)).toEqual(['pr', 'checks', 'feature/login']);
  });

  it('pending-checks: a PR with running checks (pr checks exit 8, no rows) => ci.summary pending', async () => {
    // `gh pr checks` exits 8 = "Checks pending" (documented in `gh pr checks --help`) with no
    // completed JSON rows. parseCi maps exit 8 -> ci.summary 'pending' (distinct from exit-1
    // 'no checks reported' -> 'none'). This is the only classifier path with no live capture.
    const view = makeFakeRunner();
    const checks = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view, checks],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStdout(PR_VIEW_JSON);
    view.emitExit(0);
    checks.emitStdout(''); // checks still running: gh exits 8 with no JSON array
    checks.emitExit(8);
    const status = await p;

    expect(status.kind).toBe('open-pr');
    if (status.kind === 'open-pr') {
      expect(status.ci.summary).toBe('pending');
    }
  });

  it('no-pr: pr view exit 1 + no-PR stderr => no-pr, no checks call', async () => {
    const view = makeFakeRunner();
    const { reader, calls } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStderr('no pull requests found for branch "feature/login"');
    view.emitExit(1);
    const status = await p;
    expect(status).toEqual({ kind: 'no-pr' });
    expect(calls).toHaveLength(1); // checks NOT spawned when there is no PR
  });

  it('gh-missing: spawn ENOENT error maps to gh-missing (no hang)', async () => {
    const view = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitError(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const status = await p;
    expect(status).toEqual({ kind: 'gh-missing' });
  });

  it('not-authed: pr view exit 4 maps to not-authed', async () => {
    const view = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStderr('gh auth login');
    view.emitExit(4);
    expect(await p).toEqual({ kind: 'not-authed' });
  });

  it('timeout: a runner that never exits is killed and resolves to error', async () => {
    const view = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const status = await reader.status({ worktreeId: '/repo/.worktrees/feat' });
    expect(status.kind).toBe('error');
    expect(view.killed()).toBe(true);
  });
});
```

### Step 4.2 — Run it; watch it fail

```
npx vitest run tests/main/gh-status-reader.test.ts
```

Expected failure: `GhStatusReader is not a constructor` / no export `GhStatusReader`.

### Step 4.3 — Minimal COMPLETE implementation

Append to `src/main/git/gh-status-reader.ts` (after the pure functions). Add the imports for the new
types at the top of the file (extend the existing import line):

Change the top import to:

```ts
import type { GhCiSummary, GhPrInfo, GhStatus, GhStatusRequest } from '../../shared/types';
import type { IProcLike, ProcessRunner } from '../proc/process-runner';
```

Append the class:

```ts
/** Raw `gh pr view --json number,title,state,isDraft,url,reviewDecision` shape. */
interface GhPrViewRaw {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly reviewDecision: string;
}

/** Result of buffering one gh invocation to completion. */
interface RunResult {
  /** Real exit code, or GH_MISSING_SENTINEL when the spawn fired ENOENT. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Constructor deps — all injectable so the reader is unit-testable with a fake runner. */
export interface GhStatusReaderDeps {
  readonly runner: ProcessRunner;
  readonly repoRoot: string;
  readonly owner: string;
  readonly repo: string;
  /** worktreeId -> branch (copy of DiffViewer.resolveBranch in register-ipc's closure). */
  readonly resolveBranch: (worktreeId: string) => Promise<string>;
  /** worktreeId -> absolute worktree path (= gh cwd). */
  readonly resolvePath: (worktreeId: string) => Promise<string>;
  /** True if the branch has an upstream (no upstream => not-pushed, skip gh). */
  readonly hasUpstream: (worktreeId: string) => Promise<boolean>;
  /** Per-call timeout (default 12_000ms); kills the child + resolves to error. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Read-only, per-worktree PR/CI status over the gh CLI. Mirrors DiffViewer: stateless,
 * constructor-injected, NEVER writes, NEVER touches a token. LOCAL pre-checks first
 * (branch + upstream) make the no-pr/not-pushed COMMON path cheap; gh only spawns when
 * the branch is pushed. The RESULT is never cached (gh state changes out-of-band).
 */
export class GhStatusReader {
  private readonly runner: ProcessRunner;
  private readonly owner: string;
  private readonly repo: string;
  private readonly resolveBranch: (worktreeId: string) => Promise<string>;
  private readonly resolvePath: (worktreeId: string) => Promise<string>;
  private readonly hasUpstream: (worktreeId: string) => Promise<boolean>;
  private readonly timeoutMs: number;

  constructor(deps: GhStatusReaderDeps) {
    this.runner = deps.runner;
    this.owner = deps.owner;
    this.repo = deps.repo;
    this.resolveBranch = deps.resolveBranch;
    this.resolvePath = deps.resolvePath;
    this.hasUpstream = deps.hasUpstream;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Computes the GhStatus for a worktree. Never throws — degrades to a kind. */
  async status(req: GhStatusRequest): Promise<GhStatus> {
    const branch = await this.resolveBranch(req.worktreeId);
    this.assertSafeRef(branch);
    const cwd = await this.resolvePath(req.worktreeId);

    // LOCAL pre-check: no upstream => not-pushed, WITHOUT spawning gh (no API quota).
    if (!(await this.hasUpstream(req.worktreeId))) {
      return { kind: 'not-pushed' };
    }

    const repoSlug = `${this.owner}/${this.repo}`;
    // The branch is the EXPLICIT POSITIONAL arg (gh pr view/checks take it positionally,
    // NOT a --head flag). NEVER call bare `gh pr view -R <repo>` (errors exit 1).
    const viewArgs = [
      'pr',
      'view',
      branch,
      '-R',
      repoSlug,
      '--json',
      'number,title,state,isDraft,url,reviewDecision',
    ];
    const view = await this.runToCompletion('gh', viewArgs, cwd);

    // Any non-success that is NOT a clean JSON header => classify (no-pr/not-authed/...).
    if (view.code !== 0 || !view.stdout.trim().startsWith('{')) {
      return classifyGhStatus(view.code, view.stdout, view.stderr);
    }

    let raw: GhPrViewRaw;
    try {
      raw = JSON.parse(view.stdout) as GhPrViewRaw;
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    const pr = toPrInfo(raw);

    // Only fetch checks when a PR exists.
    const checksArgs = ['pr', 'checks', branch, '-R', repoSlug, '--json', 'name,state,bucket,link'];
    const checks = await this.runToCompletion('gh', checksArgs, cwd);
    const ci = this.parseCi(checks);
    return { kind: 'open-pr', pr, ci };
  }

  /**
   * exit 8 = 'checks pending' is NORMAL (not an error). exit 1 + 'no checks reported'
   * => none. Otherwise parse the rows and summarize on bucket. On any spawn/parse
   * failure for checks we degrade to a 'none' CI rather than dropping the whole PR.
   */
  private parseCi(checks: RunResult): GhCiSummary {
    if (checks.code === GH_MISSING_SENTINEL) {
      return summarizeChecks([]); // unreachable in practice (view would have caught it)
    }
    if (!checks.stdout.trim().startsWith('[')) {
      // exit 8 (pending), exit 1 (no checks), or empty — treat as no usable rows.
      if (checks.code === 8) return { summary: 'pending', counts: empties() };
      return summarizeChecks([]);
    }
    try {
      const rows = JSON.parse(checks.stdout) as { bucket: GhCheckRow['bucket'] }[];
      return summarizeChecks(rows.map((r) => ({ bucket: r.bucket })));
    } catch {
      return summarizeChecks([]);
    }
  }

  /**
   * Spawns gh via the non-shell argv path, buffers stdout/stderr, resolves on exit OR
   * on a spawn 'error' (ENOENT -> GH_MISSING_SENTINEL), and has a JS setTimeout +
   * kill() guard (no macOS `timeout` binary) so a hung/missing gh NEVER hangs the
   * promise. Pass process.env through ONLY for PATH + keyring; nothing token-related.
   */
  private runToCompletion(file: string, args: readonly string[], cwd: string): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const proc: IProcLike = this.runner.spawnArgs(file, args, { cwd, env: process.env });
      let out = '';
      let err = '';
      let settled = false;
      const finish = (r: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        // finish() BEFORE kill(): kill() synchronously emits 'exit' -> onExit -> finish,
        // and finish() is settle-once, so finishing first makes the timeout stderr win
        // (otherwise the exit's empty stderr would settle first and 'gh timed out' is lost).
        finish({ code: null, stdout: out, stderr: 'gh timed out' });
        proc.kill();
      }, this.timeoutMs);
      proc.onStdout((c) => {
        out += c;
      });
      proc.onStderr((c) => {
        err += c;
      });
      proc.onError((e) => {
        const code = (e as NodeJS.ErrnoException).code;
        finish({ code: code === 'ENOENT' ? GH_MISSING_SENTINEL : null, stdout: out, stderr: err });
      });
      proc.onExit((e) => finish({ code: e.code, stdout: out, stderr: err }));
    });
  }

  /** Reject a branch token git/gh could misparse as an OPTION (leading '-'). */
  private assertSafeRef(ref: string): void {
    if (ref.startsWith('-')) throw new Error(`invalid branch ref: ${ref}`);
  }
}

/** Narrows the raw gh state/reviewDecision strings to our typed enums. */
function toPrInfo(raw: GhPrViewRaw): GhPrInfo {
  const state: GhPrInfo['state'] =
    raw.state === 'MERGED' ? 'MERGED' : raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const rd = raw.reviewDecision;
  const reviewDecision: GhPrInfo['reviewDecision'] =
    rd === 'APPROVED' || rd === 'CHANGES_REQUESTED' || rd === 'REVIEW_REQUIRED' ? rd : '';
  return {
    number: raw.number,
    state,
    title: raw.title,
    url: raw.url,
    isDraft: raw.isDraft,
    reviewDecision,
  };
}

function empties(): GhCiSummary['counts'] {
  return { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
}
```

> NOTE: `assertSafeRef` rejects a branch named `-x`; `status()` does not try/catch it, so a malicious
> ref throws inside the reader. The IPC handler (Task 5) wraps `status()` in try/catch and returns
> `{kind:'error'}`, so the renderer never sees a raw throw. The reader's OWN failure modes
> (timeout/ENOENT/no-pr) all resolve to a kind; only the assert/branch-resolution path can throw,
> and that is the handler's job to catch.

### Step 4.4 — Run it; watch it pass

```
npx vitest run tests/main/gh-status-reader.test.ts tests/main/gh-classify.test.ts
```

Expected: all reader tests + classify tests pass (6 reader + 13 classify = 19).

### Commit

```
feat(gh): GhStatusReader — local pre-checks + gh pr view/checks (fake-runner tested)
```

---

## Task 5 — IPC wiring: ctx slot, lazy getter, GH_STATUS + APP_OPEN_EXTERNAL handlers + token-hygiene test

### Files

- **Modify** `src/main/ipc/ipc-context.ts` — add `ghStatusReader?` slot (after `diffViewer?` on
  line 46).
- **Modify** `src/main/ipc/register-ipc.ts` — import `GhStatusReader`, the new types, and `shell`;
  add `getGhStatusReader(ctx)` (copy `getDiffViewer`, lines 293-299); add `GH_STATUS` +
  `APP_OPEN_EXTERNAL` handlers (after the `DIFF_FILE` handler at line 434).
- **Modify** `__mocks__/electron.ts` — add `export const shell = { openExternal: vi.fn() };` (the
  vitest alias mock currently exports app/ipcMain/contextBridge/ipcRenderer/BrowserWindow but NOT
  `shell`; without it the `APP_OPEN_EXTERNAL` handler — `const { shell } = await import('electron')`
  — would throw `shell is undefined` if a test ever invokes it). Adding it lets the wiring test
  optionally invoke the handler and assert `shell.openExternal` was called with `req.url`.
- **Create** `tests/main/register-gh-ipc.test.ts` — IPC routing + try/catch + token-hygiene grep.

### Step 5.1 — Write the failing test

Create `tests/main/register-gh-ipc.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { GhStatusReader } from '../../src/main/git/gh-status-reader';

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
  ctx.sessionStore = { all: () => [] } as never;
  ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
  return ctx;
}

describe('gh IPC wiring', () => {
  it('routes GH_STATUS to the injected ghStatusReader', async () => {
    const reader = {
      status: vi.fn().mockResolvedValue({ kind: 'no-pr' }),
    } as unknown as GhStatusReader;
    const ctx = baseCtx();
    ctx.ghStatusReader = reader;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const out = await handlers.get(IPC.GH_STATUS)!(null, { worktreeId: 'w' });
    expect(out).toEqual({ kind: 'no-pr' });
    expect(reader.status).toHaveBeenCalledWith({ worktreeId: 'w' });
  });

  it('GH_STATUS never throws raw — a reader throw maps to {kind:error}', async () => {
    const reader = {
      status: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as GhStatusReader;
    const ctx = baseCtx();
    ctx.ghStatusReader = reader;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const out = await handlers.get(IPC.GH_STATUS)!(null, { worktreeId: 'w' });
    expect(out).toMatchObject({ kind: 'error', message: 'boom' });
  });

  it('APP_OPEN_EXTERNAL handler is registered (open action)', () => {
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    expect(handlers.has(IPC.APP_OPEN_EXTERNAL)).toBe(true);
  });
});

describe('token hygiene (static)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(resolve(here, '../../', rel), 'utf8');
  const sources = [
    'src/main/git/gh-status-reader.ts',
    'src/main/ipc/register-ipc.ts',
    'src/main/proc/process-runner.ts',
  ].map(read);

  it('never calls `gh auth status`', () => {
    for (const s of sources) expect(s).not.toMatch(/auth\s+status/);
  });

  it('never sets GH_TOKEN', () => {
    for (const s of sources) expect(s).not.toMatch(/GH_TOKEN/);
  });

  it('never writes gh stderr into the LogStore', () => {
    const reader = read('src/main/git/gh-status-reader.ts');
    // The reader must not import or call a LogStore append for gh stderr.
    expect(reader).not.toMatch(/logStore|\.append\(/i);
  });
});
```

### Step 5.2 — Run it; watch it fail

```
npx vitest run tests/main/register-gh-ipc.test.ts
```

Expected failure: `handlers.get(IPC.GH_STATUS)` is `undefined` (`Cannot read properties of undefined`)
— the handler is not registered yet. (`IPC.GH_STATUS` exists from Task 1.)

### Step 5.3 — Minimal COMPLETE implementation

Edit `src/main/ipc/ipc-context.ts`. Add the import (after line 9):

```ts
import type { GhStatusReader } from '../git/gh-status-reader';
```

Add the slot after `diffViewer?` (after line 46):

```ts
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 PR/CI panel). Holds
   * NO live OS process and NO settings-derived command, so it is NOT nulled on
   * SETTINGS_SET. The RESULT is never cached — only the reader.
   */
  ghStatusReader?: GhStatusReader;
```

Edit `src/main/ipc/register-ipc.ts`.

Add to the type import block from `../../shared/types` (after `ConflictInProgressRequest,` on
line 31):

```ts
  GhStatus,
  GhStatusRequest,
  OpenExternalRequest,
```

Add the class import (after the `DiffViewer` import on line 34):

```ts
import { GhStatusReader } from '../git/gh-status-reader';
```

Add the `getGhStatusReader` getter after `getDiffViewer` (after line 299). It copies `getDiffViewer`,
adds a `resolveBranch`/`resolvePath`/`hasUpstream` closure over the WorktreeManager + a fresh
`simpleGit` per worktree path, and derives `owner/repo` from the remote URL:

```ts
/**
 * Resolves the GhStatusReader: prefer ctx (tests inject); else build a real one.
 * Copies getDiffViewer's lazy shape. owner/repo come from the origin remote URL;
 * resolveBranch/resolvePath read WorktreeManager.list() (Worktree.branch / .path);
 * hasUpstream runs a per-worktree
 * `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (no upstream => not-pushed).
 * NEVER reads a token; passes process.env through only for PATH/keyring.
 */
async function getGhStatusReader(ctx: IpcContext): Promise<GhStatusReader> {
  if (ctx.ghStatusReader) return ctx.ghStatusReader;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  const root = simpleGit(repoRoot);
  const remote = (await root.remote(['get-url', 'origin']).catch(() => '')) ?? '';
  const { owner, repo } = parseOwnerRepo(remote.trim());

  const manager = await getWorktreeManager(ctx);
  const pathOf = async (worktreeId: string): Promise<string> => {
    const trees = await manager.list();
    const t = trees.find((x) => x.id === worktreeId);
    if (!t) throw new Error(`unknown worktree ${worktreeId}`);
    return t.path;
  };

  ctx.ghStatusReader = new GhStatusReader({
    runner: new NodeProcessRunner(),
    repoRoot,
    owner,
    repo,
    resolveBranch: async (worktreeId) => {
      const trees = await manager.list();
      const t = trees.find((x) => x.id === worktreeId);
      if (!t) throw new Error(`unknown worktree ${worktreeId}`);
      return t.branch;
    },
    resolvePath: pathOf,
    hasUpstream: async (worktreeId) => {
      const wtPath = await pathOf(worktreeId);
      try {
        await simpleGit(wtPath).raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        return true;
      } catch {
        // exit 128 'fatal: no upstream configured for branch' => not pushed.
        return false;
      }
    },
  });
  return ctx.ghStatusReader;
}

/** Parses an origin URL (ssh or https) into {owner, repo}; empty on no match. */
export function parseOwnerRepo(url: string): { owner: string; repo: string } {
  // git@github.com:owner/repo.git  OR  https://github.com/owner/repo(.git)
  const m = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : { owner: '', repo: '' };
}
```

Add the two handlers after the `DIFF_FILE` handler (after line 434). Import `shell` lazily inside
the open-external handler (matching the `app` lazy-import idiom at line 322):

```ts
  ipcMain.handle(
    IPC.GH_STATUS,
    async (_event: unknown, req: GhStatusRequest): Promise<GhStatus> => {
      // GH_STATUS NEVER throws raw across the boundary — any failure becomes {kind:'error'}.
      try {
        const reader = await getGhStatusReader(ctx);
        return await reader.status(req);
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.APP_OPEN_EXTERNAL,
    async (_event: unknown, req: OpenExternalRequest): Promise<Ack> => {
      try {
        const { shell } = await import('electron');
        await shell.openExternal(req.url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
```

### Step 5.4 — Run it; watch it pass

```
npx vitest run tests/main/register-gh-ipc.test.ts
```

Expected: all 6 tests pass (3 wiring + 3 token-hygiene).

Confirm no IPC regressions:

```
npx vitest run tests/main/register-conflict-ipc.test.ts
```

Expected: still green.

### Commit

```
feat(gh): wire GH_STATUS + APP_OPEN_EXTERNAL IPC (try/catch friendly, token-hygiene asserted)
```

---

## Task 6 — Preload forwards

### Files

- **Modify** `src/preload/index.ts` — add `openExternal` to `app`, add a `gh` group.

### Step 6.1 — Implementation (no new test; covered by typecheck:web + Task 5 contract)

Edit `src/preload/index.ts`. Add `openExternal` to the `app` group (after `sendQuitDecision` on
line 18):

```ts
    openExternal: (req) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, req),
```

Add a `gh` group after the `diff` group (after line 60, before `settings:`):

```ts
  gh: {
    status: (req) => ipcRenderer.invoke(IPC.GH_STATUS, req),
  },
```

### Step 6.2 — Verify

```
npm run typecheck
```

Expected: PASS — `api` now fully satisfies `MangoApi` (the `gh` group + `app.openExternal` close the
gap opened in Task 1).

### Commit

```
feat(gh): preload forwards for gh.status + app.openExternal
```

---

## Task 7 — `useGhStatus` hook

Copied from `use-diff.ts`: `{status, loading, error}` + a `cancelled` guard keyed on `[worktreeId]`
+ a manual `refresh()`.

### Files

- **Create** `src/renderer/hooks/use-gh-status.ts`.

### Step 7.1 — Implementation (no RTL test — `@testing-library/react` absent; covered by typecheck:web + smoke)

Create `src/renderer/hooks/use-gh-status.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { GhStatus } from '../../shared/types';

/** Loads the gh-backed PR/CI status for one worktree, with a manual refresh(). */
export interface UseGhStatus {
  readonly status: GhStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  refresh(): void;
}

/**
 * Fetches GhStatus on select (keyed on worktreeId) with a stale-response guard
 * (gh is a slow network call), plus a manual refresh() because gh state changes
 * out-of-band (CI finishes, PR opened on github.com). Mirrors use-diff.ts.
 */
export function useGhStatus(worktreeId: string | null): UseGhStatus {
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!worktreeId) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.mango.gh
      .status({ worktreeId })
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { status, loading, error, refresh };
}
```

### Step 7.2 — Verify

```
npm run typecheck:web
```

Expected: PASS.

### Commit

```
feat(gh): useGhStatus hook (on-select fetch + manual refresh)
```

---

## Task 8 — `GhStatusPanel` component

Copied structurally from `merge-controls.tsx`: a `data-testid` div, a colored status `<span>`
(crimson=fail/error, amber `#e0a030`=pending, grey `#888`=neutral), an "Open in browser" button
visible ONLY for `open-pr`, and a Refresh button. Every non-`open-pr` kind renders a calm neutral
one-line state.

### Files

- **Create** `src/renderer/components/toolbar/gh-status-panel.tsx`.

### Step 8.1 — Implementation (no RTL test; covered by typecheck:web + smoke)

Create `src/renderer/components/toolbar/gh-status-panel.tsx`:

```ts
import type { GhStatus } from '../../../shared/types';

export interface GhStatusPanelProps {
  readonly selectedId: string | null;
  readonly status: GhStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  onRefresh(): void;
  onOpen(url: string): void;
}

/** Maps a GhStatus to a calm one-line label + a severity color. */
function describe(status: GhStatus): { label: string; color: string } {
  switch (status.kind) {
    case 'gh-missing':
      return { label: 'PR: gh CLI not installed', color: '#888' };
    case 'not-authed':
      return { label: 'PR: gh not signed in (run gh auth login)', color: '#888' };
    case 'no-remote':
      return { label: 'PR: not a GitHub repo', color: '#888' };
    case 'not-pushed':
      return { label: 'PR: branch not pushed', color: '#888' };
    case 'no-pr':
      return { label: 'PR: none yet', color: '#888' };
    case 'rate-limited':
      return { label: 'PR: GitHub rate limit — try again later', color: '#e0a030' };
    case 'error':
      return { label: `PR: ${status.message}`, color: 'crimson' };
    case 'open-pr': {
      const draft = status.pr.isDraft ? ' (draft)' : '';
      const ci =
        status.ci.summary === 'failing'
          ? 'CI ✗'
          : status.ci.summary === 'pending'
            ? 'CI …'
            : status.ci.summary === 'passing'
              ? 'CI ✓'
              : 'CI —';
      const color =
        status.ci.summary === 'failing'
          ? 'crimson'
          : status.ci.summary === 'pending'
            ? '#e0a030'
            : '#888';
      return {
        label: `PR #${status.pr.number} ${status.pr.state}${draft} · ${ci} · ${status.pr.title}`,
        color,
      };
    }
  }
}

/**
 * Read-only PR/CI status line for the selected worktree. Mirrors MergeControls'
 * structure + color idiom. "Open in browser" shows ONLY for an open-pr; every other
 * kind is a calm neutral state (no toast, no console spam) — no-pr/not-pushed are the
 * COMMON path here.
 */
export function GhStatusPanel({
  selectedId,
  status,
  loading,
  error,
  onRefresh,
  onOpen,
}: GhStatusPanelProps): React.JSX.Element {
  if (!selectedId) {
    return (
      <div data-testid="gh-status" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#888' }}>PR: select a worktree</span>
      </div>
    );
  }
  const line = error
    ? { label: `PR: ${error}`, color: 'crimson' }
    : loading || !status
      ? { label: 'PR: loading…', color: '#888' }
      : describe(status);
  const openPr = status && status.kind === 'open-pr' ? status.pr : null;

  return (
    <div data-testid="gh-status" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span data-testid="gh-status-line" style={{ fontSize: 11, color: line.color }}>
        {line.label}
      </span>
      {openPr && (
        <button type="button" data-testid="gh-open" onClick={() => onOpen(openPr.url)}>
          Open in browser
        </button>
      )}
      <button type="button" data-testid="gh-refresh" disabled={loading} onClick={() => onRefresh()}>
        Refresh
      </button>
    </div>
  );
}
```

### Step 8.2 — Verify

```
npm run typecheck:web && npm run lint
```

Expected: PASS (the `switch` over the `GhStatus` union is exhaustive — every `kind` returns, so no
fall-through; if a new kind is added later, typecheck flags the missing arm).

### Commit

```
feat(gh): GhStatusPanel component (calm neutral states + open-pr chip)
```

---

## Task 9 — Mount in App.tsx

### Files

- **Modify** `src/renderer/App.tsx` — import the hook + panel; call `useGhStatus(selectedId)` at the
  App level (line ~41-44, beside the other hooks); mount `<GhStatusPanel>` right after
  `MergeControls` (after line 164).

### Step 9.1 — Implementation

Add imports (after `MergeControls` import on line 15):

```ts
import { GhStatusPanel } from './components/toolbar/gh-status-panel';
import { useGhStatus } from './hooks/use-gh-status';
```

Call the hook at App level (after `const { progress: mergeProgress, ... } = useMerge();` on line 41):

```ts
  const { status: ghStatus, loading: ghLoading, error: ghError, refresh: refreshGh } =
    useGhStatus(selectedId);
```

Mount the panel immediately after the self-closing `<MergeControls … />` element (it ends on line 164 — there is no `</MergeControls>` closing tag), before the next sibling block:

```tsx
      <GhStatusPanel
        selectedId={selectedId}
        status={ghStatus}
        loading={ghLoading}
        error={ghError}
        onRefresh={refreshGh}
        onOpen={(url) => void window.mango.app.openExternal({ url })}
      />
```

### Step 9.2 — Verify

```
npm run typecheck:web && npm run lint
```

Expected: PASS.

### Commit

```
feat(gh): mount GhStatusPanel in App beside MergeControls
```

---

## Task 10 — Full suite + documented Playwright smoke + V2-BACKLOG

### Files

- **Modify or Create** `docs/V2-BACKLOG.md` — record the deferred polling + richer per-check list.
- No new code; this is the gate.

### Step 10.1 — Run the full suite

```
npm run typecheck && npm run typecheck:web && npm run lint && npx vitest run
```

Expected: ALL green. The new tests (`process-runner`, `gh-classify`, `gh-status-reader`,
`register-gh-ipc`) pass; every pre-existing test is unchanged and still passes (the only edit to
existing runtime is the additive `onError`/`spawnArgs`, which existing consumers ignore).

### Step 10.2 — Documented Playwright smoke (no-PR common case)

This repo (branch `main`) has no open PR, so the smoke targets the COMMON calm state. Document (do
NOT block CI on a live network call — gate it behind the existing smoke harness):

```
Manual / Playwright smoke steps:
1. Launch the app (existing Playwright harness).
2. Select the primary worktree.
3. Assert [data-testid="gh-status-line"] is present and its text starts with "PR:".
4. Assert the text is one of the calm states ("PR: none yet" | "PR: branch not pushed"
   | "PR: gh CLI not installed" | "PR: gh not signed in ...") — NOT an error chip.
5. Assert NO error toast and NO console.error were emitted (no error spam on the common path).
6. Assert a [data-testid="gh-refresh"] button is present and clickable.
7. (open-pr path, only when a real PR exists) Assert [data-testid="gh-open"] is present and
   clicking it invokes app.openExternal with the pr.url.
```

### Step 10.3 — V2-BACKLOG

Append to (or create) `docs/V2-BACKLOG.md`:

```md
## PR/CI panel — deferred (post-MVP)

- **Live updates / polling:** add a GH_STATUS_CHANGED event + on-focus or interval polling
  (30–60s while an open-pr is selected) for live CI. Deferred: burns the separate GraphQL
  rate-limit pool (5000/hr) over a long IDE session; pull-only (on-select + manual refresh)
  is enough for MVP and the no-PR common case rarely needs live updates.
- **Richer per-check list:** expose the per-check rows (name/bucket/link) in an expandable
  sub-panel instead of the collapsed passing/failing/pending summary.
- **mergeable / mergeStateStatus:** intentionally OMITTED in MVP (transient UNKNOWN trap +
  meaningless on MERGED/CLOSED). Add behind a "computing…" state with re-poll if surfaced.
- **`git ls-remote` disambiguation:** distinguish "pushed but no PR" from "not pushed" more
  precisely than the @{u} upstream check (no API quota cost).
```

### Commit

```
docs(gh): smoke notes + V2 backlog for PR/CI panel polling/richer checks
```

---

## Migration Strategy

**Additive, no migration.** Every change is a new file or an append-only edit to a shared registry,
exactly how `DiffViewer` (V2 A1) and the conflict resolver were added:

- **New types** (`GhStatus`, `GhStatusRequest`, `GhPrInfo`, `GhCiSummary`, `OpenExternalRequest`) are
  brand-new — no existing type is narrowed or widened. `Worktree` is **NOT touched**: the
  pushed/upstream signal is derived inside `GhStatusReader.hasUpstream`, not added to the shared
  `Worktree` (keeps blast radius minimal; porcelain `git worktree list` lacks upstream anyway).
- **New channels** (`GH_STATUS`, `APP_OPEN_EXTERNAL`), one new `MangoApi.gh` group + `app.openExternal`,
  one preload forward block, one new `ctx.ghStatusReader?` slot, one new lazy getter + two handlers,
  new reader/hook/panel/test files.
- **No persisted state, schema, or settings format changes.** The reader is stateless and never
  caches the RESULT, so there is nothing to migrate and **no `SETTINGS_SET` clearing needed** — the
  reader holds no settings-derived command (unlike `serverManager`/`sessionManager`). It is left
  out of the `SETTINGS_SET` cache-clearing block deliberately.
- **The only change to existing runtime behavior** is the additive `onError` callback + `spawnArgs`
  method on `IProcLike`/`NodeProcessRunner`. Existing consumers (`ServerManager`, `MergeRunner`)
  never subscribe to `onError` and never call `spawnArgs` — **backward compatible**, verified by
  re-running `server-manager.test.ts` in Task 2.
- **No feature flag.** The feature is inert until a worktree is selected and degrades to a calm
  neutral panel for the common no-PR/not-pushed cases — zero risk to existing flows.

Justification for "no migration": there is no stored state, no on-disk format, and no breaking type
change. A pure-additive surface over an isolated, stateless reader cannot strand any existing data
or break any existing producer/consumer.

---

## Acceptance Checklist

- [ ] `classifyGhStatus` is a pure exported function with table-driven tests covering every kind:
      gh-missing (sentinel), not-authed (exit 4 + stderr), no-remote, no-pr, rate-limited (403),
      error fallback (trimmed) — all WITHOUT spawning gh.
- [ ] `summarizeChecks` switches ONLY on `bucket`; precedence fail/cancel > pending > pass; empty =>
      none; unknown buckets ignored.
- [ ] `GhStatusReader` tests (fake runner) prove: open-pr parses pr view + pr checks into the
      GhStatus shape with ci derived from `bucket`; no-pr (exit 1 + stderr) => `kind:'no-pr'` and
      DOES NOT spawn `gh pr checks`; not-pushed (no `@{u}`) => `kind:'not-pushed'` WITHOUT spawning
      gh (asserted: `calls` is empty); gh-missing (ENOENT) => `kind:'gh-missing'` (no hang); timeout
      kills the child and resolves to `error`.
- [ ] gh is spawned via `spawnArgs` (non-shell) with `cwd = worktree path`, `-R owner/repo`, AND the
      POSITIONAL `<branch>` (asserted against recorded argv/cwd). Never bare `gh pr view -R`.
- [ ] `register-gh-ipc.test.ts`: `GH_STATUS` routes to the injected `ctx.ghStatusReader`; a reader
      throw returns `{kind:'error', message}` — never a raw throw; `APP_OPEN_EXTERNAL` handler is
      registered.
- [ ] Token-hygiene test passes: no source calls `gh auth status`, sets `GH_TOKEN`, or writes gh
      stderr into the LogStore.
- [ ] `ProcessRunner.onError` + `spawnArgs` added; existing `server-manager.test.ts` still green.
- [ ] `GhStatusPanel` renders a calm neutral grey line for not-pushed/no-pr/no-remote/gh-missing/
      not-authed, a colored chip for open-pr (crimson fail / amber pending / grey pass), shows
      "Open in browser" ONLY for open-pr (calls `openExternal(pr.url)`), and a Refresh button that
      re-invokes the hook.
- [ ] `useGhStatus` fetches on select (keyed on `[worktreeId]`) with a `cancelled` stale guard +
      `refresh()`.
- [ ] Mounted in `App.tsx` immediately after `MergeControls`, keyed on `selectedId`.
- [ ] `npm run typecheck && npm run typecheck:web && npm run lint && npx vitest run` all green.
- [ ] Documented Playwright smoke for the no-PR common case (no error toast, no console error).
- [ ] V2-BACKLOG records deferred polling + richer per-check list.

## Self-Review

- **Token hygiene is structurally enforced, not just intended.** `runToCompletion` passes
  `process.env` through (PATH + keyring) and adds nothing; the reader never imports a LogStore; gh
  stderr only ever flows into `classifyGhStatus`; a static grep test fails the build if any source
  calls `gh auth status`, sets `GH_TOKEN`, or appends to a LogStore. (Tasks 4, 5.)
- **gh-missing cannot hang.** It is detected via the new `onError(ENOENT)` path mapped to
  `GH_MISSING_SENTINEL`, classified deterministically — not via a non-existent exit-127 branch (which
  `spawn` never surfaces). A timeout + `proc.kill()` guards every other hang (no macOS `timeout`
  binary). Both are unit-tested. (Tasks 2, 4.)
- **The common path is calm.** not-pushed short-circuits BEFORE any gh spawn (asserted: zero runner
  calls); no-pr is a first-class kind, not an error; the panel renders grey one-liners for all
  non-open-pr kinds with no toast/console spam. (Tasks 4, 8.)
- **Correctness traps from the brief are baked in:** branch is the POSITIONAL arg (never `--head`,
  never bare `-R`); `cwd = worktree path` AND `-R owner/repo` both passed; CI derived ONLY from
  `bucket`; `reviewDecision` empty-string handled; `mergeable` omitted; exit 8 treated as pending,
  not error. (Tasks 3, 4.)
- **Backward compatibility verified, not assumed.** The only existing-file runtime edit
  (`onError`/`spawnArgs`) is re-checked against `server-manager.test.ts` in Task 2; the reader is
  left out of the `SETTINGS_SET` clearing block on purpose (no settings-derived command). (Tasks 2, 5.)
- **Risk: `parseOwnerRepo` on an empty/odd remote** yields `{owner:'', repo:''}`, making gh run with
  `-R /`. In practice that surfaces as a gh error classified to `no-remote`/`error` — a calm state,
  not a crash. Acceptable for MVP (this repo's origin is a real GitHub URL); a future hardening could
  short-circuit to `no-remote` when owner/repo are empty.
- **Risk: TDD ordering.** Task 1 leaves preload/register-ipc temporarily not satisfying `MangoApi`
  until Tasks 5–6; the plan calls this out and gives a shared-only typecheck for Task 1, with the
  full typecheck gating Task 6. This is the same additive sequence used for the diff/conflict
  features, so the transient gap is expected and bounded.
