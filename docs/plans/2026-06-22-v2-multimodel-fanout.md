# Multimodel Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send ONE prompt to N parallel "lanes" — each lane is a fresh git worktree (off a base branch) running a headless `claude -p` on a chosen model tier (opus/sonnet/haiku) — then let the user compare the per-lane diffs and SELECT one to merge (the rest are discarded).

**Architecture:** A new run-to-completion helper (`runLane`) spawns `claude -p "<prompt>" --permission-mode acceptEdits --model <tier>` in a worktree cwd via the existing `ProcessRunner.spawnArgs` (mirrors `gh-status-reader.ts#runToCompletion` — `claude -p` needs no TTY, so `child_process` is simpler than `node-pty`). A new `FanoutManager` orchestrates ONE active run: for each model it creates a worktree (reusing `WorktreeManager.create`), spawns `runLane` in that cwd, tracks per-lane status, and emits window-guarded `FANOUT_STATUS` events. On a clean lane exit the manager COMMITS that lane's worktree edits (a headless `claude -p` leaves them uncommitted) so the lane branch HEAD carries them before any merge. `select(laneId)` merges the winner via the existing `MergeRunner.run` then removes every other lane worktree and force-deletes the discarded (loser) lane branches; `abort()` kills running lanes + removes all worktrees + force-deletes ALL lane branches. Per-lane diffs reuse the existing `DIFF_*` IPC + `DiffView` (a lane is a real worktree). All four IPC layers are additive (channels → contract → preload → register-ipc), gated on a lazy `getFanoutManager(ctx)` slot that mirrors `getMergeRunner`.

**Tech Stack:** Electron + React + TypeScript (strict, `verbatimModuleSyntax`), simple-git, node:child_process via `ProcessRunner`, Vitest (windowless unit tests with a fake runner + temp-git-repo worktrees), Monaco DiffEditor (reused), electron-vite build.

## Global Constraints

- **Additive only.** Every existing test, IPC channel, manager, and UI element stays intact. No existing channel/type/handler is renamed or removed; widening is forbidden unless every producer is updated in the same change.
- **TypeScript strict + `verbatimModuleSyntax`:** main is ESM — `require` is undefined in module scope; load `simple-git` via dynamic `import()` (mirror `getMergeRunner`). 2-space indent, single quotes, semicolons, max 100 cols, explicit return types, no `any` (use `unknown`), `interface` over `type` for object shapes, `readonly` on payload fields.
- **Empirically proven (LOCKED):** `claude -p "<prompt>" --permission-mode acceptEdits --model haiku` runs NON-INTERACTIVELY, auto-accepts FILE edits (bash/other tools still gated), prints to stdout, and EXITS — leaving a real git diff in cwd. The fan-out builds on this exactly.
- **Agent binary is injected** via the existing `resolveCommands(...).agentCommand` seam (default `'claude'`) so tests/smokes swap a fake. The prompt is passed as a DISCRETE argv element (never shell-interpolated → use `spawnArgs`, never `spawn`). The model token is guarded `assertSafeRef`-style (reject a leading `-`).
- **Permission default = `acceptEdits`.** A per-run boolean `skipPermissions` (DEFAULT FALSE) adds `--dangerously-skip-permissions` for bash-heavy tasks, surfaced in the UI with a clear "bypasses ALL permission checks" warning.
- **Concurrency cap = 4 lanes** (reject a start with > 4 models, and reject < 1). Lanes run in parallel, each isolated in its own worktree cwd. A lane failure marks THAT lane `failed`; others continue.
- **ONE active run at a time (MVP).** A second `start()` while a run is active is REJECTED (chosen over abort+replace for safety; surfaced in the UI).
- **Never auto-merge.** `select()` and `abort()` are the only mutating paths and are user-initiated. The winner merge reuses `MergeRunner`'s safe-abort/conflict semantics verbatim.
- **Worktree/branch naming:** worktree dir `.worktrees/fanout-<id>-<modelSlug>`, branch `fanout/<id>/<modelSlug>`. `slugModel` maps a model token to a filesystem/branch-safe slug.
- **The renderer task has NO unit test** (`@testing-library/react` is absent in this repo). It gates on `npm run typecheck:web` + `npm run build` + the documented GUI smoke. Every other new unit is TDD.

---

## File Structure

**Create:**
- `src/main/git/fanout-run.ts` — pure helpers (`slugModel`, `buildLaneArgs`, `assertSafeModel`) + the `runLane` run-to-completion headless `claude -p` helper (mirrors `gh-status-reader.ts#runToCompletion`). One responsibility: spawn one lane to completion + record its argv/exit.
- `src/main/git/fanout-manager.ts` — the `FanoutManager` class: owns the ONE active run, orchestrates worktree creation + lane runs + status, COMMITS each lane's edits before merge (the headless run leaves them uncommitted), force-deletes discarded lane branches (losers on `select`, all on `abort`), and implements `start`/`get`/`select`/`abort`. Constructor-injected deps so it is unit-testable.
- `tests/main/fanout-run.test.ts` — TDD for `slugModel`/`assertSafeModel`/`buildLaneArgs` (pure) + `runLane` argv/exit via a fake runner.
- `tests/main/fanout-manager.test.ts` — TDD for `FanoutManager` on a temp repo with a FAKE agent runner (records argv, edits a file) + real `WorktreeManager`/`MergeRunner`.
- `tests/main/register-fanout-ipc.test.ts` — wiring test (mirrors `register-conflict-ipc.test.ts`): the four channels route to the injected `FanoutManager`.
- `src/renderer/hooks/use-fanout.ts` — `useFanout()`: `FANOUT_GET` on mount + `onStatus` subscription + `start`/`select`/`abort`.
- `src/renderer/components/fanout/fanout-view.tsx` — the global Fan-out UI: prompt textarea + model picker + skipPermissions toggle + Start; running lane cards; per-lane `DiffView` + "Use this lane"; Abort.

**Modify:**
- `src/shared/types.ts` — add the fan-out payload/state types (additive).
- `src/shared/ipc-channels.ts` — add the `FANOUT_*` channel strings (additive).
- `src/shared/ipc-contract.ts` — add the `fanout` group to `MangoApi` (additive).
- `src/preload/index.ts` — add the `fanout` bindings (additive).
- `src/main/ipc/ipc-context.ts` — add the `fanoutManager?` slot.
- `src/main/ipc/register-ipc.ts` — add `getFanoutManager` + `buildFanoutEmitter` + the 4 handlers.
- `src/renderer/App.tsx` — mount a top-level "Fan-out" entry (button near the Toolbar → `FanoutView`).
- `docs/V2-BACKLOG.md` — strike through "멀티모델 팬아웃" + link this plan.

---

## Task 1: Shared types + channels + contract + preload (additive)

**Files:**
- Modify: `src/shared/types.ts` (append a `// ── Multimodel fan-out (V2) ──` section)
- Modify: `src/shared/ipc-channels.ts:62-65` (append before the closing `} as const;`)
- Modify: `src/shared/ipc-contract.ts` (add imports + a `fanout` group)
- Modify: `src/preload/index.ts` (add the `fanout` bindings)
- Test: none (pure type/string additions; gated by Task 5's wiring test + `npm run typecheck`)

**Interfaces:**
- Produces (consumed by every later task):
  - `LaneStatus = 'queued' | 'running' | 'done' | 'failed'`
  - `FanoutLane { readonly laneId: string; readonly model: string; readonly worktreeId: string; readonly branch: string; readonly status: LaneStatus; readonly exitCode?: number | null; readonly stdoutTail?: string; readonly error?: string }`
  - `FanoutRun { readonly id: string; readonly prompt: string; readonly base: string; readonly skipPermissions: boolean; readonly lanes: readonly FanoutLane[] }`
  - `FanoutStartRequest { readonly prompt: string; readonly models: readonly string[]; readonly skipPermissions: boolean }`
  - `FanoutStartResult { readonly id: string; readonly lanes: readonly FanoutLane[] }`
  - `FanoutSelectRequest { readonly laneId: string }`
  - `FanoutLaneStatusEvent { readonly id: string; readonly lane: FanoutLane }`
  - Channels `IPC.FANOUT_START/GET/SELECT/ABORT/STATUS`
  - `MangoApi.fanout.{ start, get, select, abort, onStatus }`

- [ ] **Step 1: Add the fan-out types to `src/shared/types.ts`**

Append at the END of `src/shared/types.ts` (after the `RepoPickResult` block):

```typescript
// ── Multimodel fan-out (V2) ──

/** Per-lane lifecycle for a headless claude -p run in a fan-out worktree. */
export type LaneStatus = 'queued' | 'running' | 'done' | 'failed';

/** One lane of a fan-out: a worktree + a headless claude run on one model tier. */
export interface FanoutLane {
  /** Stable id within the run (we use the model slug). */
  readonly laneId: string;
  /** The --model tier token, e.g. 'opus' | 'sonnet' | 'haiku'. */
  readonly model: string;
  /** The worktree this lane runs in (= Worktree.id = absolute path); reused for DIFF_*. */
  readonly worktreeId: string;
  /** The lane's branch, `fanout/<id>/<modelSlug>`. */
  readonly branch: string;
  readonly status: LaneStatus;
  /** Exit code of the claude -p run (present once done/failed). */
  readonly exitCode?: number | null;
  /** Last slice of the lane's stdout (capped) for a quick preview. */
  readonly stdoutTail?: string;
  /** Failure reason (present when status === 'failed'). */
  readonly error?: string;
}

/**
 * The ONE active fan-out run (MVP: a single run at a time). Held on
 * ctx.fanoutManager; a second start() while a run is active is rejected.
 */
export interface FanoutRun {
  /** Short run id (slug-safe); drives the worktree/branch naming. */
  readonly id: string;
  readonly prompt: string;
  /** Base branch every lane worktree forks from + merges back into. */
  readonly base: string;
  /** When true, lanes add --dangerously-skip-permissions (bash-heavy tasks). */
  readonly skipPermissions: boolean;
  readonly lanes: readonly FanoutLane[];
}

export interface FanoutStartRequest {
  readonly prompt: string;
  /** 1..4 model tiers; >4 or <1 is rejected by the manager. */
  readonly models: readonly string[];
  /** Default false; true => --dangerously-skip-permissions on every lane. */
  readonly skipPermissions: boolean;
}

export interface FanoutStartResult {
  readonly id: string;
  readonly lanes: readonly FanoutLane[];
}

export interface FanoutSelectRequest {
  /** The winning lane to merge into base (the rest are discarded). */
  readonly laneId: string;
}

/** main -> renderer per-lane status push (mirrors MergeProgressEvent). */
export interface FanoutLaneStatusEvent {
  readonly id: string;
  readonly lane: FanoutLane;
}
```

- [ ] **Step 2: Add the channel strings to `src/shared/ipc-channels.ts`**

Insert immediately BEFORE the closing `} as const;` (after the `REPO_PICK` line at `src/shared/ipc-channels.ts:64`):

```typescript
  // multimodel fan-out (V2) — one prompt to N claude --model lanes in parallel worktrees
  FANOUT_START: 'fanout:start', // invoke ({prompt, models, skipPermissions} -> {id, lanes})
  FANOUT_GET: 'fanout:get', // invoke (-> FanoutRun | null = current run)
  FANOUT_SELECT: 'fanout:select', // invoke ({laneId} -> MergeResult; merge winner + clean rest)
  FANOUT_ABORT: 'fanout:abort', // invoke (-> Ack; kill running lanes + remove all worktrees)
  FANOUT_STATUS: 'fanout:status', // main -> renderer, event (FanoutLaneStatusEvent)
```

- [ ] **Step 3: Add the `fanout` group to `src/shared/ipc-contract.ts`**

Add to the type import block at the top (append inside the existing `import type { ... } from './types';`):

```typescript
  FanoutRun,
  FanoutStartRequest,
  FanoutStartResult,
  FanoutSelectRequest,
  FanoutLaneStatusEvent,
```

Then add a `fanout` group to the `MangoApi` interface, immediately after the `repo: { ... }` block and before the closing `}` of `MangoApi`:

```typescript
  fanout: {
    /** Start ONE fan-out: N worktrees + N headless claude -p lanes. Rejects if a run is active or models out of [1,4]. */
    start(req: FanoutStartRequest): Promise<FanoutStartResult>;
    /** The current run state, or null when none is active. */
    get(): Promise<FanoutRun | null>;
    /** Merge the winning lane into base + discard the rest. User-initiated only. */
    select(req: FanoutSelectRequest): Promise<MergeResult>;
    /** Kill running lanes + remove every lane worktree. */
    abort(): Promise<Ack>;
    /** Live per-lane status stream (queued -> running -> done|failed). */
    onStatus(cb: (e: FanoutLaneStatusEvent) => void): Unsubscribe;
  };
```

(`MergeResult` and `Ack` are already imported in this file.)

- [ ] **Step 4: Add the `fanout` bindings to `src/preload/index.ts`**

Add a `fanout` group to the `api` object, immediately after the `repo: { ... }` block (`src/preload/index.ts:73-76`) and before the closing `};` of `api`:

```typescript
  fanout: {
    start: (req) => ipcRenderer.invoke(IPC.FANOUT_START, req),
    get: () => ipcRenderer.invoke(IPC.FANOUT_GET),
    select: (req) => ipcRenderer.invoke(IPC.FANOUT_SELECT, req),
    abort: () => ipcRenderer.invoke(IPC.FANOUT_ABORT),
    onStatus: (cb) => subscribe(IPC.FANOUT_STATUS, cb),
  },
```

- [ ] **Step 5: Run typecheck to verify the additive contract compiles**

Run: `npm run typecheck`
Expected: PASS (no errors). The new channels/types/bindings compile; nothing existing regresses.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts src/shared/ipc-contract.ts src/preload/index.ts
git commit -m "feat(fanout): add shared types + FANOUT_* channels + contract + preload"
```

---

## Task 2: Headless lane-run helper (`runLane` + pure arg helpers)

**Files:**
- Create: `src/main/git/fanout-run.ts`
- Test: `tests/main/fanout-run.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner`, `IProcLike` from `src/main/proc/process-runner.ts` (the `spawnArgs` + `onStdout`/`onStderr`/`onExit`/`onError` seam).
- Produces (consumed by Task 3):
  - `export function slugModel(model: string): string` — filesystem/branch-safe slug.
  - `export function assertSafeModel(model: string): void` — throws on a leading `-` or empty token.
  - `export function buildLaneArgs(prompt: string, model: string, skipPermissions: boolean): string[]` — the discrete argv: `['-p', prompt, '--permission-mode', 'acceptEdits', '--model', model, ...(skipPermissions ? ['--dangerously-skip-permissions'] : [])]`.
  - `export interface LaneRunResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }`
  - `export function runLane(deps: { runner: ProcessRunner; agentCommand: string; prompt: string; model: string; cwd: string; skipPermissions: boolean; timeoutMs?: number; onSpawn?: (proc: IProcLike) => void }): Promise<LaneRunResult>` — `onSpawn` is called with the spawned child the instant it starts, so the caller can `kill()` it on abort (the headless run otherwise self-resolves and ignores its flag).

- [ ] **Step 1: Write the failing test**

Create `tests/main/fanout-run.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  slugModel,
  assertSafeModel,
  buildLaneArgs,
  runLane,
} from '../../src/main/git/fanout-run';
import type { ProcessRunner, IProcLike, ProcSpawnOptions } from '../../src/main/proc/process-runner';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';

/** Records every spawnArgs call + hands back a controllable fake child. */
function makeRecordingRunner(handle: FakeProcHandle) {
  const calls: { file: string; args: string[]; opts: ProcSpawnOptions }[] = [];
  const runner: ProcessRunner = {
    spawn: () => {
      throw new Error('runLane must use spawnArgs, never spawn (no shell interpolation)');
    },
    spawnArgs: (file, args, opts): IProcLike => {
      calls.push({ file, args: [...args], opts });
      return handle;
    },
  };
  return { runner, calls };
}

describe('slugModel', () => {
  it('keeps a simple tier as-is', () => {
    expect(slugModel('haiku')).toBe('haiku');
  });
  it('slugs a fully-qualified model id to a branch/fs-safe token', () => {
    expect(slugModel('claude-opus-4-20250514')).toBe('claude-opus-4-20250514');
  });
  it('collapses unsafe characters and trims dashes', () => {
    expect(slugModel('us.anthropic/Sonnet 4')).toBe('us.anthropic-Sonnet-4');
  });
});

describe('assertSafeModel', () => {
  it('rejects a leading dash (option-injection guard)', () => {
    expect(() => assertSafeModel('--dangerously')).toThrow(/invalid model/i);
  });
  it('rejects an empty token', () => {
    expect(() => assertSafeModel('')).toThrow(/invalid model/i);
  });
  it('accepts a normal tier', () => {
    expect(() => assertSafeModel('opus')).not.toThrow();
  });
});

describe('buildLaneArgs', () => {
  it('builds the discrete claude -p argv with acceptEdits + model, prompt NOT interpolated', () => {
    expect(buildLaneArgs('fix the bug; rm -rf /', 'haiku', false)).toEqual([
      '-p',
      'fix the bug; rm -rf /',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'haiku',
    ]);
  });
  it('appends --dangerously-skip-permissions when skipPermissions is true', () => {
    expect(buildLaneArgs('do it', 'opus', true)).toEqual([
      '-p',
      'do it',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'opus',
      '--dangerously-skip-permissions',
    ]);
  });
});

describe('runLane', () => {
  it('spawns the agentCommand with buildLaneArgs in cwd and resolves the exit + stdout tail', async () => {
    const handle = makeFakeRunner();
    const { runner, calls } = makeRecordingRunner(handle);
    let spawned: IProcLike | undefined;
    const p = runLane({
      runner,
      agentCommand: 'fake-claude',
      prompt: 'write a haiku',
      model: 'haiku',
      cwd: '/tmp/lane',
      skipPermissions: false,
      onSpawn: (proc) => {
        spawned = proc;
      },
    });
    handle.emitStdout('working...\ndone\n');
    handle.emitExit(0);
    const result = await p;

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('fake-claude');
    expect(calls[0].args).toEqual([
      '-p',
      'write a haiku',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'haiku',
    ]);
    expect(calls[0].opts.cwd).toBe('/tmp/lane');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('done');
    expect(spawned).toBe(handle);
  });

  it('resolves with the spawn-error code when the binary is missing (ENOENT)', async () => {
    const handle = makeFakeRunner();
    const { runner } = makeRecordingRunner(handle);
    const p = runLane({
      runner,
      agentCommand: 'missing-bin',
      prompt: 'x',
      model: 'opus',
      cwd: '/tmp/lane',
      skipPermissions: false,
    });
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    handle.emitError(enoent);
    const result = await p;
    expect(result.code).toBe(null);
    expect(result.stderr).toMatch(/ENOENT|missing/i);
  });

  it('rejects an unsafe model token before spawning', async () => {
    const handle = makeFakeRunner();
    const { runner, calls } = makeRecordingRunner(handle);
    await expect(
      runLane({
        runner,
        agentCommand: 'fake-claude',
        prompt: 'x',
        model: '-evil',
        cwd: '/tmp/lane',
        skipPermissions: false,
      }),
    ).rejects.toThrow(/invalid model/i);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/fanout-run.test.ts`
Expected: FAIL — "Cannot find module '../../src/main/git/fanout-run'" (the file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/git/fanout-run.ts`:

```typescript
import type { IProcLike, ProcessRunner } from '../proc/process-runner';

/**
 * Maps a model token (a tier like 'haiku' or a full id like
 * 'claude-opus-4-20250514') to a filesystem/branch-safe slug: every run of
 * characters outside [A-Za-z0-9._-] collapses to one '-', leading/trailing
 * dashes are trimmed. Deterministic (mirrors worktree-manager.sanitizeBranchToDir).
 */
export function slugModel(model: string): string {
  return model
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Rejects a model token claude could misparse as an OPTION (leading '-') or an
 * empty token. No shell injection is possible (spawnArgs uses an arg array) — this
 * only guards claude's own arg parsing for the renderer-supplied model (mirrors
 * DiffViewer.assertSafeRef / GhStatusReader.assertSafeRef).
 */
export function assertSafeModel(model: string): void {
  if (model.length === 0 || model.startsWith('-')) {
    throw new Error(`invalid model token: ${model}`);
  }
}

/**
 * The discrete argv for a headless lane run. The prompt is its OWN argv element —
 * NEVER shell-interpolated — so a prompt containing shell metacharacters is inert.
 * Permission default is acceptEdits (auto file edits; bash/other tools still gated);
 * skipPermissions adds --dangerously-skip-permissions for bash-heavy tasks.
 */
export function buildLaneArgs(
  prompt: string,
  model: string,
  skipPermissions: boolean,
): string[] {
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--model', model];
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  return args;
}

/** Result of buffering one headless claude -p run to completion. */
export interface LaneRunResult {
  /** Real exit code, or null when the spawn fired an error (e.g. ENOENT) or timed out. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Constructor-free deps for a single lane run (all injectable for tests). */
export interface RunLaneDeps {
  readonly runner: ProcessRunner;
  /** Agent binary (default 'claude' via resolveCommands.agentCommand); swappable in tests. */
  readonly agentCommand: string;
  readonly prompt: string;
  readonly model: string;
  /** Worktree cwd — the lane's isolated checkout. */
  readonly cwd: string;
  readonly skipPermissions: boolean;
  /** Per-lane timeout; kills the child + resolves to an error (default 30 min). */
  readonly timeoutMs?: number;
  /** Called with the spawned child the instant it starts, so the caller can kill() it
   *  on abort (the headless run otherwise self-resolves and ignores its flag). */
  readonly onSpawn?: (proc: IProcLike) => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Spawns `claude -p "<prompt>" --permission-mode acceptEdits --model <model>` in
 * `cwd` via the non-shell argv path, buffers stdout/stderr, and resolves on exit OR
 * on a spawn 'error' (ENOENT etc.) OR on a timeout (kill + resolve). Mirrors
 * gh-status-reader.ts#runToCompletion — claude -p needs no TTY, so a child_process
 * is simpler than node-pty. The auto-accepted file edits leave a real git diff in cwd.
 */
export function runLane(deps: RunLaneDeps): Promise<LaneRunResult> {
  assertSafeModel(deps.model);
  const args = buildLaneArgs(deps.prompt, deps.model, deps.skipPermissions);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<LaneRunResult>((resolve) => {
    const proc: IProcLike = deps.runner.spawnArgs(deps.agentCommand, args, {
      cwd: deps.cwd,
      env: process.env,
    });
    deps.onSpawn?.(proc);
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: LaneRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      // finish() BEFORE kill(): kill() synchronously emits 'exit' (the fake) — settle
      // the timeout stderr first so it is not lost (mirrors gh-status-reader timing).
      finish({ code: null, stdout: out, stderr: err || 'lane timed out' });
      proc.kill();
    }, timeoutMs);
    proc.onStdout((c) => {
      out += c;
    });
    proc.onStderr((c) => {
      err += c;
    });
    proc.onError((e) => {
      const raw = e instanceof Error ? e.message : String(e);
      finish({ code: null, stdout: out, stderr: err || raw });
    });
    proc.onExit((e) => finish({ code: e.code, stdout: out, stderr: err }));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/fanout-run.test.ts`
Expected: PASS (all `slugModel`/`assertSafeModel`/`buildLaneArgs`/`runLane` cases green).

- [ ] **Step 5: Commit**

```bash
git add src/main/git/fanout-run.ts tests/main/fanout-run.test.ts
git commit -m "feat(fanout): headless runLane helper (claude -p, model/permission/prompt argv)"
```

---

## Task 3: `FanoutManager` core — start (N worktrees + lane runs + status) + concurrency cap

**Files:**
- Create: `src/main/git/fanout-manager.ts` (start/get + the shared run state; select/abort stubbed in this task, fleshed out in Task 4)
- Test: `tests/main/fanout-manager.test.ts`

**Interfaces:**
- Consumes: `WorktreeManager` (`.create({ baseBranch, newBranch, path })` → `Worktree`, `.remove({ worktreeId, force? })`), `MergeRunner` (`.run(MergeRequest)` → `MergeResult`), `runLane`/`slugModel` from Task 2, the fan-out types from Task 1.
- Produces (consumed by Tasks 4 + 5):
  - `export interface FanoutEmitter { emitLaneStatus(e: FanoutLaneStatusEvent): void }`
  - `export interface LaneProc { kill(): void }` and `export type LaneRunner = (deps: { agentCommand: string; prompt: string; model: string; cwd: string; skipPermissions: boolean; onDone: (r: LaneRunResult) => void }) => LaneProc` — a runner FACTORY seam so tests inject a fake that edits a file + records argv, and the production factory wraps `runLane`.
  - `export interface LaneGit { add(files: string[]): Promise<unknown>; diff(options: string[]): Promise<string>; commit(message: string): Promise<unknown>; branch(options: string[]): Promise<unknown> }` — the few git ops the manager runs directly (commit a lane's edits so its branch HEAD carries them before `select()` merges; force-delete a discarded lane branch). A cwd-bound `simple-git` instance satisfies this structurally.
  - `export type GitFactory = (cwd: string) => LaneGit` — builds a git bound to a cwd (a lane worktree for commits, repoRoot for `branch -D`).
  - `export interface FanoutManagerDeps { readonly worktrees: WorktreeManager; readonly merge: MergeRunner; readonly resolveBase: () => Promise<string>; readonly laneRunner: LaneRunner; readonly agentCommand: string; readonly emitter: FanoutEmitter; readonly genId: () => string; readonly gitFactory: GitFactory; readonly repoRoot: string }` — `gitFactory` builds a cwd-bound git (commits a lane's edits, force-deletes a discarded branch); `repoRoot` is the primary repo root, the cwd for `git branch -D` (a worktree cannot delete its own branch).
  - `export class FanoutManager { start(req): Promise<FanoutStartResult>; get(): FanoutRun | null; select(req): Promise<MergeResult>; abort(): Promise<Ack> }`
  - `export const MAX_LANES = 4`

- [ ] **Step 1: Write the failing test**

Create `tests/main/fanout-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync, writeFileSync, existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { WorktreeManager } from '../../src/main/managers/worktree-manager';
import { MergeRunner, type MergeEmitter } from '../../src/main/git/merge-runner';
import {
  FanoutManager,
  type FanoutEmitter,
  type LaneRunner,
  type LaneProc,
} from '../../src/main/git/fanout-manager';
import type { FanoutLaneStatusEvent } from '../../src/shared/types';
import type { ProcessRunner } from '../../src/main/proc/process-runner';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

/** Verify runner stub (MergeRunner needs one; fan-out never runs the hook). */
const noopVerifyRunner: ProcessRunner = {
  spawn: () => {
    throw new Error('verify hook not used by fan-out');
  },
  spawnArgs: () => {
    throw new Error('verify hook not used by fan-out');
  },
};

/**
 * A FAKE lane runner: writes a per-model file into the lane cwd (so each lane
 * produces a real git diff) and records the argv it was "given", then reports
 * exit 0 — WITHOUT committing. The MANAGER owns the commit (mirroring the real
 * runLane, where `claude -p` leaves edits uncommitted), so this exercises the
 * manager's commit-before-merge path rather than masking it. NOT real claude.
 */
function makeFakeLaneRunner() {
  const calls: { model: string; cwd: string; prompt: string; skipPermissions: boolean }[] = [];
  const laneRunner: LaneRunner = ({ model, cwd, prompt, skipPermissions, onDone }) => {
    calls.push({ model, cwd, prompt, skipPermissions });
    // Write the edit ONLY — NO commit. The MANAGER owns the commit (mirroring the real
    // runLane, where `claude -p` leaves edits uncommitted), so this exercises the
    // manager's commit-before-merge path rather than masking it.
    writeFileSync(join(cwd, `lane-${model}.txt`), `${model} did: ${prompt}\n`);
    onDone({ code: 0, stdout: `${model} done`, stderr: '' });
    const proc: LaneProc = { kill: () => {} };
    return proc;
  };
  return { laneRunner, calls };
}

function makeEmitter() {
  const events: FanoutLaneStatusEvent[] = [];
  const emitter: FanoutEmitter = { emitLaneStatus: (e) => void events.push(e) };
  return { emitter, events };
}

/** Polls until the run's lanes all reach a terminal status (done|failed). */
async function waitTerminal(mgr: FanoutManager): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const run = mgr.get();
    if (run && run.lanes.every((l) => l.status === 'done' || l.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('lanes did not reach a terminal status');
}

describe('FanoutManager', () => {
  let repo: TempGitRepo;
  let worktrees: WorktreeManager;
  let merge: MergeRunner;
  let mergeEmitter: MergeEmitter;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    await repo.git.add('base.txt');
    await repo.git.commit('base');
    worktrees = new WorktreeManager(repo.git, repo.dir);
    mergeEmitter = { emitProgress: () => {} };
    merge = new MergeRunner({
      git: simpleGit(realpathSync(repo.dir)),
      worktrees,
      verifyRunner: noopVerifyRunner,
      emitter: mergeEmitter,
      verifyCommand: 'true',
    });
  });

  afterEach(() => repo.cleanup());

  function makeManager(laneRunner: LaneRunner, emitter: FanoutEmitter): FanoutManager {
    let n = 0;
    return new FanoutManager({
      worktrees,
      merge,
      resolveBase: async () => 'main',
      laneRunner,
      agentCommand: 'fake-claude',
      emitter,
      genId: () => `run${(n += 1)}`,
      gitFactory: (cwd) => simpleGit(cwd),
      repoRoot: realpathSync(repo.dir),
    });
  }

  it('start() creates one worktree per model and runs the fake lane in each', async () => {
    const { laneRunner, calls } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);

    const res = await mgr.start({ prompt: 'do it', models: ['opus', 'haiku'], skipPermissions: false });
    expect(res.lanes).toHaveLength(2);
    await waitTerminal(mgr);

    // Two worktrees were created (+ the primary).
    const trees = await worktrees.list();
    expect(trees.filter((t) => t.branch.startsWith('fanout/'))).toHaveLength(2);
    // The fake ran in each lane's cwd with the right model + prompt.
    expect(calls.map((c) => c.model).sort()).toEqual(['haiku', 'opus']);
    expect(calls.every((c) => c.prompt === 'do it')).toBe(true);
    expect(calls.every((c) => existsSync(join(c.cwd, `lane-${c.model}.txt`)))).toBe(true);
  });

  it('transitions each lane queued -> running -> done and emits status events', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter, events } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);

    await mgr.start({ prompt: 'p', models: ['haiku'], skipPermissions: false });
    await waitTerminal(mgr);

    const run = mgr.get();
    expect(run?.lanes[0].status).toBe('done');
    const seq = events.filter((e) => e.lane.laneId === 'haiku').map((e) => e.lane.status);
    expect(seq).toEqual(['running', 'done']); // queued is the start() snapshot; events start at running
  });

  it('rejects more than 4 models', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await expect(
      mgr.start({ prompt: 'p', models: ['a', 'b', 'c', 'd', 'e'], skipPermissions: false }),
    ).rejects.toThrow(/at most 4|max/i);
  });

  it('rejects zero models', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await expect(
      mgr.start({ prompt: 'p', models: [], skipPermissions: false }),
    ).rejects.toThrow(/at least one|>= 1|empty/i);
  });

  it('rejects a second start while a run is active', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await mgr.start({ prompt: 'p', models: ['haiku'], skipPermissions: false });
    await expect(
      mgr.start({ prompt: 'p2', models: ['opus'], skipPermissions: false }),
    ).rejects.toThrow(/active|in progress|already/i);
  });

  it('get() returns null before any run', () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    expect(mgr.get()).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/fanout-manager.test.ts`
Expected: FAIL — "Cannot find module '../../src/main/git/fanout-manager'".

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/git/fanout-manager.ts` (start/get fully implemented; select/abort implemented minimally here and TESTED in Task 4):

```typescript
import type { Ack, FanoutLane, FanoutLaneStatusEvent, FanoutRun, FanoutStartRequest, FanoutStartResult, FanoutSelectRequest, MergeResult } from '../../shared/types';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { MergeRunner } from './merge-runner';
import { slugModel, assertSafeModel, type LaneRunResult } from './fanout-run';

/** Max parallel lanes (LOCKED). A start with more models is rejected. */
export const MAX_LANES = 4;

/** Where FanoutManager publishes FANOUT_STATUS (injected, so tests spy). */
export interface FanoutEmitter {
  emitLaneStatus(e: FanoutLaneStatusEvent): void;
}

/** A live lane process handle the manager can kill on abort. */
export interface LaneProc {
  kill(): void;
}

/**
 * Runner FACTORY seam: starts ONE lane and calls onDone when it finishes. The
 * production factory (register-ipc) wraps runLane; tests inject a fake that edits
 * a file + records argv. Returning a LaneProc lets abort() kill running lanes.
 */
export type LaneRunner = (deps: {
  readonly agentCommand: string;
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly skipPermissions: boolean;
  readonly onDone: (r: LaneRunResult) => void;
}) => LaneProc;

/**
 * The few git ops the manager runs directly: commit a lane's edits (so its branch
 * HEAD carries them before select() merges) and force-delete a discarded lane
 * branch. A cwd-bound simple-git instance satisfies this structurally.
 */
export interface LaneGit {
  add(files: string[]): Promise<unknown>;
  diff(options: string[]): Promise<string>;
  commit(message: string): Promise<unknown>;
  branch(options: string[]): Promise<unknown>;
}

/** Builds a git bound to a cwd (a lane worktree for commits, repoRoot for branch -D). */
export type GitFactory = (cwd: string) => LaneGit;

/** Constructor deps — all injectable for windowless unit tests on a temp repo. */
export interface FanoutManagerDeps {
  readonly worktrees: WorktreeManager;
  readonly merge: MergeRunner;
  /** Resolves the base branch (settings.baseBranch ?? 'main') at start time. */
  readonly resolveBase: () => Promise<string>;
  readonly laneRunner: LaneRunner;
  readonly agentCommand: string;
  readonly emitter: FanoutEmitter;
  /** Generates the short run id (slug-safe). */
  readonly genId: () => string;
  /** Builds a cwd-bound git: commits a lane's edits, force-deletes a discarded branch. */
  readonly gitFactory: GitFactory;
  /** Primary repo root — the cwd for `git branch -D` (a worktree cannot delete its own branch). */
  readonly repoRoot: string;
}

/** Mutable per-lane book-keeping (the public FanoutLane is a readonly snapshot). */
interface LaneState {
  laneId: string;
  model: string;
  worktreeId: string;
  branch: string;
  status: FanoutLane['status'];
  exitCode?: number | null;
  stdoutTail?: string;
  error?: string;
  proc?: LaneProc;
}

const STDOUT_TAIL_BYTES = 2_000;

/**
 * Orchestrates ONE active multimodel fan-out run (MVP). start() creates one
 * worktree per model off the base branch (reusing WorktreeManager) and spawns a
 * headless lane in each cwd via the injected laneRunner, tracking per-lane status
 * (queued -> running -> done|failed) and emitting FANOUT_STATUS. select() merges
 * the winner (MergeRunner) + removes the other lane worktrees; abort() kills running
 * lanes + removes ALL lane worktrees. Constructor-injected so it is unit-testable
 * with a fake agent runner + a real WorktreeManager/MergeRunner on a temp repo.
 */
export class FanoutManager {
  private readonly deps: FanoutManagerDeps;
  private run: { id: string; prompt: string; base: string; skipPermissions: boolean; lanes: LaneState[] } | null = null;

  constructor(deps: FanoutManagerDeps) {
    this.deps = deps;
  }

  /** Starts the fan-out. Rejects if a run is active or models is out of [1, MAX_LANES]. */
  async start(req: FanoutStartRequest): Promise<FanoutStartResult> {
    if (this.run !== null) {
      throw new Error('a fan-out run is already active; abort it before starting another');
    }
    if (req.models.length < 1) {
      throw new Error('fan-out needs at least one model');
    }
    if (req.models.length > MAX_LANES) {
      throw new Error(`fan-out supports at most ${MAX_LANES} models`);
    }
    for (const m of req.models) assertSafeModel(m);

    const base = await this.deps.resolveBase();
    const id = this.deps.genId();
    const lanes: LaneState[] = [];

    // Create every worktree FIRST (sequential — git worktree add mutates the same
    // repo index). A creation failure rejects the whole start and rolls back any
    // worktrees already created, so a failed start never leaves orphans.
    for (const model of req.models) {
      const laneId = slugModel(model);
      const branch = `fanout/${id}/${laneId}`;
      const dir = `.worktrees/fanout-${id}-${laneId}`;
      try {
        const wt = await this.deps.worktrees.create({ baseBranch: base, newBranch: branch, path: dir });
        lanes.push({ laneId, model, worktreeId: wt.id, branch, status: 'queued' });
      } catch (error) {
        await this.rollback(lanes);
        const raw = error instanceof Error ? error.message : String(error);
        throw new Error(`fan-out worktree create failed for ${model}: ${raw}`);
      }
    }

    this.run = { id, prompt: req.prompt, base, skipPermissions: req.skipPermissions, lanes };

    // Spawn every lane in PARALLEL (each in its own worktree cwd — isolated).
    for (const lane of lanes) {
      this.startLane(lane);
    }

    return { id, lanes: lanes.map(toLane) };
  }

  /** Current run snapshot, or null when none is active. */
  get(): FanoutRun | null {
    if (this.run === null) return null;
    return {
      id: this.run.id,
      prompt: this.run.prompt,
      base: this.run.base,
      skipPermissions: this.run.skipPermissions,
      lanes: this.run.lanes.map(toLane),
    };
  }

  /** Merge the winning lane into base + discard the rest. Implemented in Task 4. */
  async select(req: FanoutSelectRequest): Promise<MergeResult> {
    return this.doSelect(req);
  }

  /** Kill running lanes + remove every lane worktree. Implemented in Task 4. */
  async abort(): Promise<Ack> {
    return this.doAbort();
  }

  /** Spawns one lane via the injected runner and wires its terminal status. */
  private startLane(lane: LaneState): void {
    if (this.run === null) return;
    lane.status = 'running';
    this.emit(lane);
    lane.proc = this.deps.laneRunner({
      agentCommand: this.deps.agentCommand,
      prompt: this.run.prompt,
      model: lane.model,
      cwd: lane.worktreeId,
      skipPermissions: this.run.skipPermissions,
      onDone: (r) => {
        void this.onLaneDone(lane, r);
      },
    });
  }

  /**
   * Records a lane's terminal result. On exit 0 it COMMITS the lane's working-tree
   * edits (a headless `claude -p` leaves them uncommitted) so the branch HEAD carries
   * them for select()'s merge — status flips to 'done' only AFTER the commit, so a
   * waiter that sees 'done' can safely merge. A non-zero exit (or a commit failure)
   * marks the lane 'failed'. Emits the final status.
   */
  private async onLaneDone(lane: LaneState, r: LaneRunResult): Promise<void> {
    lane.exitCode = r.code;
    lane.stdoutTail = r.stdout.slice(-STDOUT_TAIL_BYTES);
    lane.proc = undefined;
    if (r.code === 0) {
      try {
        await this.commitLane(lane);
        lane.status = 'done';
      } catch (error) {
        lane.status = 'failed';
        lane.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      lane.status = 'failed';
      lane.error = r.stderr.slice(-STDOUT_TAIL_BYTES) || `lane exited with code ${String(r.code)}`;
    }
    this.emit(lane);
  }

  /**
   * Stages + commits the lane worktree's edits so its branch HEAD advances past base.
   * If the lane made NO edits (claude answered without editing), staging is empty and
   * we skip the commit — the branch stays at base and select() merges nothing, which
   * is correct. Each lane commits in its OWN worktree cwd, so parallel commits do not
   * contend on one index.
   */
  private async commitLane(lane: LaneState): Promise<void> {
    const g = this.deps.gitFactory(lane.worktreeId);
    await g.add(['-A']);
    const staged = await g.diff(['--cached', '--name-only']);
    if (staged.trim().length > 0) {
      await g.commit(`fanout: ${lane.model} lane`);
    }
  }

  /**
   * Force-deletes a discarded lane branch from the PRIMARY repo (a worktree cannot
   * delete its own checked-out branch — so the caller MUST remove the worktree
   * first). Best-effort: -D because the branch is an unmerged throwaway, and a leak
   * is non-fatal. The winner branch is deleted by MergeRunner (cleanup:true), so this
   * only runs for losers/aborts.
   */
  private async deleteBranch(branch: string): Promise<void> {
    try {
      await this.deps.gitFactory(this.deps.repoRoot).branch(['-D', branch]);
    } catch {
      // best-effort: an unmerged throwaway branch; leaking it is non-fatal.
    }
  }

  /** Removes any already-created worktrees during a failed start (best-effort). */
  private async rollback(lanes: LaneState[]): Promise<void> {
    for (const lane of lanes) {
      try {
        await this.deps.worktrees.remove({ worktreeId: lane.worktreeId, force: true });
      } catch {
        // best-effort cleanup of a partial start — ignore.
      }
    }
  }

  private emit(lane: LaneState): void {
    if (this.run === null) return;
    this.deps.emitter.emitLaneStatus({ id: this.run.id, lane: toLane(lane) });
  }

  // ── select/abort bodies (Task 4) ───────────────────────────────────────────
  protected async doSelect(req: FanoutSelectRequest): Promise<MergeResult> {
    throw new Error('not implemented until Task 4');
  }

  protected async doAbort(): Promise<Ack> {
    throw new Error('not implemented until Task 4');
  }
}

/** Projects mutable LaneState to the readonly public FanoutLane snapshot. */
function toLane(s: LaneState): FanoutLane {
  return {
    laneId: s.laneId,
    model: s.model,
    worktreeId: s.worktreeId,
    branch: s.branch,
    status: s.status,
    exitCode: s.exitCode,
    stdoutTail: s.stdoutTail,
    error: s.error,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/fanout-manager.test.ts`
Expected: PASS (start/get/concurrency-cap/second-start-rejection cases green; select/abort are not exercised yet).

- [ ] **Step 5: Commit**

```bash
git add src/main/git/fanout-manager.ts tests/main/fanout-manager.test.ts
git commit -m "feat(fanout): FanoutManager.start — N worktrees + lane runs + status + caps"
```

---

## Task 4: `FanoutManager.select` (merge winner + clean rest) + `abort` (kill + clean all)

**Files:**
- Modify: `src/main/git/fanout-manager.ts` (replace the `doSelect`/`doAbort` stubs with real bodies)
- Test: `tests/main/fanout-manager.test.ts` (append the select/abort cases)

**Interfaces:**
- Consumes: `MergeRunner.run({ worktreeId, targetBranch, runVerifyHook: false, cleanup: true })` → `MergeResult` (winner merge, reusing its conflict/safe-abort path); `WorktreeManager.remove({ worktreeId, force })`.
- Produces: real `select`/`abort` behavior (no new exported names).

- [ ] **Step 1: Write the failing test (append to `tests/main/fanout-manager.test.ts`)**

Append these cases INSIDE the `describe('FanoutManager', ...)` block, after the existing `get() returns null` test:

```typescript
  it('select() merges the chosen lane into base and removes the OTHER lane worktrees', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);

    await mgr.start({ prompt: 'do it', models: ['opus', 'haiku'], skipPermissions: false });
    await waitTerminal(mgr);

    const result = await mgr.select({ laneId: 'haiku' });
    expect(result.merged).toBe(true);
    expect(result.status).toBe('merged');

    // The winner's edit landed on base (main).
    const log = await repo.git.log();
    expect(log.all.some((c) => c.message.includes('fanout: haiku lane'))).toBe(true);

    // Every fan-out worktree is gone (winner cleaned by MergeRunner, loser removed by us).
    const trees = await worktrees.list();
    expect(trees.filter((t) => t.branch.startsWith('fanout/'))).toHaveLength(0);
    // No orphan lane branches remain (winner deleted by MergeRunner, losers by us).
    const branches = await repo.git.branchLocal();
    expect(branches.all.filter((b) => b.startsWith('fanout/'))).toHaveLength(0);
    // The run is cleared after a successful select.
    expect(mgr.get()).toBe(null);
  });

  it('abort() removes ALL lane worktrees and clears the run', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);

    await mgr.start({ prompt: 'p', models: ['opus', 'haiku'], skipPermissions: false });
    await waitTerminal(mgr);

    const ack = await mgr.abort();
    expect(ack.ok).toBe(true);
    const trees = await worktrees.list();
    expect(trees.filter((t) => t.branch.startsWith('fanout/'))).toHaveLength(0);
    // No orphan lane branches remain (none merged → all force-deleted).
    const branches = await repo.git.branchLocal();
    expect(branches.all.filter((b) => b.startsWith('fanout/'))).toHaveLength(0);
    expect(mgr.get()).toBe(null);
  });

  it('select() rejects an unknown laneId', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await mgr.start({ prompt: 'p', models: ['haiku'], skipPermissions: false });
    await waitTerminal(mgr);
    await expect(mgr.select({ laneId: 'nope' })).rejects.toThrow(/unknown lane/i);
  });

  it('select() with no active run rejects', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await expect(mgr.select({ laneId: 'haiku' })).rejects.toThrow(/no active/i);
  });

  it('after abort(), a fresh start() is allowed again', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await mgr.start({ prompt: 'p', models: ['haiku'], skipPermissions: false });
    await waitTerminal(mgr);
    await mgr.abort();
    const res = await mgr.start({ prompt: 'p2', models: ['opus'], skipPermissions: false });
    expect(res.lanes).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/fanout-manager.test.ts`
Expected: FAIL — the new select/abort cases throw "not implemented until Task 4".

- [ ] **Step 3: Replace the `doSelect`/`doAbort` stubs with real bodies**

In `src/main/git/fanout-manager.ts`, replace the entire `// ── select/abort bodies (Task 4) ──` block (the two `protected async` stub methods) with:

```typescript
  // ── select/abort bodies ─────────────────────────────────────────────────────
  /**
   * Merges the winning lane's branch into base via MergeRunner (runVerifyHook:false,
   * cleanup:true — the winner's worktree + branch are removed on success, reusing
   * MergeRunner's conflict/safe-abort path verbatim). On a clean merge, the OTHER
   * lane worktrees are removed and the run is cleared. A conflict/failed result keeps
   * the run (the renderer surfaces it via the returned MergeResult) so the user can
   * retry/abort — we do NOT clean up the losers until the winner truly merged.
   */
  protected async doSelect(req: FanoutSelectRequest): Promise<MergeResult> {
    if (this.run === null) throw new Error('no active fan-out run');
    const winner = this.run.lanes.find((l) => l.laneId === req.laneId);
    if (!winner) throw new Error(`unknown lane ${req.laneId}`);

    const result = await this.deps.merge.run({
      worktreeId: winner.worktreeId,
      targetBranch: this.run.base,
      runVerifyHook: false,
      cleanup: true,
    });

    if (result.status !== 'merged') return result; // keep run; renderer shows conflict/failed

    // Remove every OTHER lane's worktree THEN its branch (the winner's worktree+branch
    // were cleaned by MergeRunner). Worktree-remove must precede branch -D.
    for (const lane of this.run.lanes) {
      if (lane.laneId === winner.laneId) continue;
      try {
        await this.deps.worktrees.remove({ worktreeId: lane.worktreeId, force: true });
      } catch {
        // best-effort: a removal failure does not undo a successful merge.
      }
      await this.deleteBranch(lane.branch);
    }
    this.run = null;
    return result;
  }

  /**
   * Kills any still-running lane processes, then removes EVERY lane worktree
   * (force, so an in-flight edit does not block removal), and clears the run. Never
   * merges. Best-effort per worktree so one failure does not strand the rest.
   */
  protected async doAbort(): Promise<Ack> {
    if (this.run === null) return { ok: true };
    for (const lane of this.run.lanes) {
      try {
        lane.proc?.kill();
      } catch {
        // best-effort kill — continue to worktree removal regardless.
      }
    }
    for (const lane of this.run.lanes) {
      try {
        await this.deps.worktrees.remove({ worktreeId: lane.worktreeId, force: true });
      } catch {
        // best-effort: keep removing the remaining lanes.
      }
      await this.deleteBranch(lane.branch); // none merged → force-delete every lane branch
    }
    this.run = null;
    return { ok: true };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/fanout-manager.test.ts`
Expected: PASS (all start/get/select/abort cases green).

- [ ] **Step 5: Commit**

```bash
git add src/main/git/fanout-manager.ts tests/main/fanout-manager.test.ts
git commit -m "feat(fanout): FanoutManager.select (merge winner + clean rest) + abort (kill + clean all)"
```

---

## Task 5: IPC wiring — ctx slot, `getFanoutManager`, the 4 handlers + the status emitter

**Files:**
- Modify: `src/main/ipc/ipc-context.ts` (add the `fanoutManager?` slot)
- Modify: `src/main/ipc/register-ipc.ts` (imports + `buildFanoutEmitter` + `getFanoutManager` + the 4 handlers; clear the slot on SETTINGS_SET when idle)
- Test: `tests/main/register-fanout-ipc.test.ts`

**Interfaces:**
- Consumes: `FanoutManager` from Task 3/4; `runLane` from Task 2; `resolveCommands(...).agentCommand`; the existing `getWorktreeManager`/`getMergeRunner`/`getSettingsStore`/`requireRepoRoot` helpers; the `FANOUT_*` channels from Task 1.
- Produces: registered handlers `FANOUT_START/GET/SELECT/ABORT` + the `FANOUT_STATUS` emitter wired through `ctx.mainWindow`.

- [ ] **Step 1: Write the failing wiring test**

Create `tests/main/register-fanout-ipc.test.ts` (mirrors `register-conflict-ipc.test.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { FanoutManager } from '../../src/main/git/fanout-manager';

/** Minimal ipcMain double that records handlers by channel (copied from conflict test). */
function makeIpcMain() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, arg: unknown) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  } as unknown as Parameters<typeof registerIpc>[0];
  return { ipcMain, handlers };
}

describe('fanout IPC wiring', () => {
  it('routes the fanout channels to the injected FanoutManager', async () => {
    const lane = { laneId: 'haiku', model: 'haiku', worktreeId: '/w/h', branch: 'fanout/r1/haiku', status: 'done' };
    const manager = {
      start: vi.fn().mockResolvedValue({ id: 'r1', lanes: [lane] }),
      get: vi.fn().mockReturnValue({ id: 'r1', prompt: 'p', base: 'main', skipPermissions: false, lanes: [lane] }),
      select: vi.fn().mockResolvedValue({ worktreeId: '/w/h', merged: true, cleanedUp: true, status: 'merged' }),
      abort: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as FanoutManager;

    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const started = await handlers.get(IPC.FANOUT_START)!(null, {
      prompt: 'p',
      models: ['haiku'],
      skipPermissions: false,
    });
    expect(started).toMatchObject({ id: 'r1' });
    expect(manager.start).toHaveBeenCalledWith({ prompt: 'p', models: ['haiku'], skipPermissions: false });

    const got = await handlers.get(IPC.FANOUT_GET)!(null, undefined);
    expect(got).toMatchObject({ id: 'r1', lanes: [lane] });

    const sel = await handlers.get(IPC.FANOUT_SELECT)!(null, { laneId: 'haiku' });
    expect(sel).toMatchObject({ merged: true, status: 'merged' });
    expect(manager.select).toHaveBeenCalledWith({ laneId: 'haiku' });

    const ab = await handlers.get(IPC.FANOUT_ABORT)!(null, undefined);
    expect(ab).toMatchObject({ ok: true });
    expect(manager.abort).toHaveBeenCalled();
  });

  it('FANOUT_START surfaces a manager rejection as an Error across the boundary', async () => {
    const manager = {
      start: vi.fn().mockRejectedValue(new Error('a fan-out run is already active')),
      get: vi.fn(),
      select: vi.fn(),
      abort: vi.fn(),
    } as unknown as FanoutManager;
    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    await expect(
      handlers.get(IPC.FANOUT_START)!(null, { prompt: 'p', models: ['opus'], skipPermissions: false }),
    ).rejects.toThrow(/already active/i);
  });

  it('SETTINGS_SET clears an idle fanoutManager so a new base/agentCommand applies', async () => {
    const manager = {
      get: vi.fn().mockReturnValue(null), // idle: no active run
    } as unknown as FanoutManager;
    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    await handlers.get(IPC.SETTINGS_SET)!(null, { baseBranch: 'develop' });
    expect(ctx.fanoutManager).toBeUndefined();
  });

  it('SETTINGS_SET keeps the fanoutManager while a run is active', async () => {
    const manager = {
      get: vi.fn().mockReturnValue({ id: 'r1', prompt: 'p', base: 'main', skipPermissions: false, lanes: [] }),
    } as unknown as FanoutManager;
    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    await handlers.get(IPC.SETTINGS_SET)!(null, { baseBranch: 'develop' });
    expect(ctx.fanoutManager).toBe(manager); // NOT nulled while a run is active
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/register-fanout-ipc.test.ts`
Expected: FAIL — `ctx.fanoutManager` is not a known property (typecheck) and the handlers are unregistered (`handlers.get(IPC.FANOUT_START)` is undefined).

- [ ] **Step 3a: Add the `fanoutManager?` slot to `src/main/ipc/ipc-context.ts`**

Add the import near the other manager-type imports (after the `GhStatusReader` import line):

```typescript
import type { FanoutManager } from '../git/fanout-manager';
```

Add this field to the `IpcContext` interface, after the `conflictResolver?` field (`src/main/ipc/ipc-context.ts:71`):

```typescript
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 multimodel fan-out).
   * Owns the ONE active fan-out run. Cleared on SETTINGS_SET only when IDLE (get()
   * === null) so a base/agentCommand change applies on the next start — never nulled
   * while a run is active (mirrors the conflictResolver keep-while-busy discipline).
   */
  fanoutManager?: FanoutManager;
```

- [ ] **Step 3b: Wire the helpers + handlers in `src/main/ipc/register-ipc.ts`**

Add to the `import type { ... } from '../../shared/types';` block:

```typescript
  FanoutStartRequest,
  FanoutStartResult,
  FanoutRun,
  FanoutSelectRequest,
```

Add the value imports near the `import { MergeRunner, type MergeEmitter } from '../git/merge-runner';` line:

```typescript
import { FanoutManager, type FanoutEmitter } from '../git/fanout-manager';
import { runLane } from '../git/fanout-run';
```

Add the emitter builder + the lazy getter, immediately after `getMergeRunner` (`src/main/ipc/register-ipc.ts:317`):

```typescript
/** Forwards FanoutManager lane-status events to the renderer over FANOUT_STATUS (guarded). */
function buildFanoutEmitter(ctx: IpcContext): FanoutEmitter {
  return {
    emitLaneStatus: (e) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.FANOUT_STATUS, e);
    },
  };
}

/**
 * Resolves the FanoutManager: prefer ctx (tests inject); else build a real one.
 * MUST be async (main is ESM): reuses the cached WorktreeManager + MergeRunner and
 * injects a laneRunner that wraps runLane with the resolved agentCommand. resolveBase
 * reads settings.baseBranch (?? 'main') at start time so a base change applies live.
 */
async function getFanoutManager(ctx: IpcContext): Promise<FanoutManager> {
  if (ctx.fanoutManager) return ctx.fanoutManager;
  const repoRoot = requireRepoRoot(ctx); // obtain the non-null repo root EXACTLY as getMergeRunner does
  const worktrees = await getWorktreeManager(ctx);
  const merge = await getMergeRunner(ctx);
  const runner = new NodeProcessRunner();
  const { simpleGit } = await import('simple-git');
  const agentCommand = resolveCommands(getSettingsStore(ctx).get()).agentCommand;
  ctx.fanoutManager = new FanoutManager({
    worktrees,
    merge,
    resolveBase: async () => getSettingsStore(ctx).get().baseBranch ?? 'main',
    agentCommand,
    laneRunner: ({ agentCommand: cmd, prompt, model, cwd, skipPermissions, onDone }) => {
      // Wrap runLane in the LaneProc seam. Capture the child via onSpawn so kill()
      // actually SIGTERMs a still-running headless claude on abort() (not a no-op).
      let child: IProcLike | undefined;
      let killed = false;
      void runLane({
        runner,
        agentCommand: cmd,
        prompt,
        model,
        cwd,
        skipPermissions,
        onSpawn: (p) => {
          child = p;
          if (killed) p.kill();
        },
      }).then((r) => {
        if (!killed) onDone(r);
      });
      return {
        kill: () => {
          killed = true;
          child?.kill();
        },
      };
    },
    emitter: buildFanoutEmitter(ctx),
    genId: () => Date.now().toString(36),
    gitFactory: (cwd: string) => simpleGit(cwd),
    repoRoot,
  });
  return ctx.fanoutManager;
}
```

`requireRepoRoot(ctx)` RETURNS the non-null repo root string (mirrors `getMergeRunner`,
which binds `const repoRoot = requireRepoRoot(ctx);` then `git: simpleGit(repoRoot)`), and
`simple-git` is loaded via `const { simpleGit } = await import('simple-git');` exactly as
`getMergeRunner` does (main is ESM). `IProcLike` is imported from `'../proc/process-runner'`
(add it to the existing `import { NodeProcessRunner } from '../proc/process-runner';` as a
`type` import if absent: `import { NodeProcessRunner, type IProcLike } from '../proc/process-runner';`).

Add the four handlers inside `registerIpc`, immediately after the IPC.MERGE_OWNER handler's closing `});` (between the MERGE_OWNER handler and the IPC.SESSION_RECORDS handler) — do NOT insert inside a handler body:

```typescript
  ipcMain.handle(
    IPC.FANOUT_START,
    async (_event: unknown, req: FanoutStartRequest): Promise<FanoutStartResult> => {
      return (await getFanoutManager(ctx)).start(req);
    },
  );

  ipcMain.handle(IPC.FANOUT_GET, async (): Promise<FanoutRun | null> => {
    // Normalize undefined -> null so the invoke result is an explicit serializable value.
    return (await getFanoutManager(ctx)).get() ?? null;
  });

  ipcMain.handle(
    IPC.FANOUT_SELECT,
    async (_event: unknown, req: FanoutSelectRequest): Promise<MergeResult> => {
      return (await getFanoutManager(ctx)).select(req);
    },
  );

  ipcMain.handle(IPC.FANOUT_ABORT, async (): Promise<Ack> => {
    return (await getFanoutManager(ctx)).abort();
  });
```

Add the idle-clear to the `SETTINGS_SET` handler. Insert this block immediately AFTER the `ctx.diffViewer = undefined;` line (`src/main/ipc/register-ipc.ts:646`):

```typescript
      // The FanoutManager owns the ONE active run. Clearing it mid-run would orphan
      // the live lane children + lose the run state, so clear ONLY when idle (get()
      // === null) — then a base/agentCommand change applies on the next start. While
      // a run is active, KEEP it (mirrors the conflictResolver keep-while-busy rule).
      if (ctx.fanoutManager && ctx.fanoutManager.get() === null) {
        ctx.fanoutManager = undefined;
      }
```

- [ ] **Step 4: Run the wiring test + the full main suite to verify**

Run: `npx vitest run tests/main/register-fanout-ipc.test.ts tests/main/register-conflict-ipc.test.ts`
Expected: PASS (fan-out routing + idle/active clear behave; the conflict wiring test still passes — proves the SETTINGS_SET edit is additive).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/ipc-context.ts src/main/ipc/register-ipc.ts tests/main/register-fanout-ipc.test.ts
git commit -m "feat(fanout): IPC wiring — ctx slot, getFanoutManager, FANOUT_START/GET/SELECT/ABORT + STATUS emitter"
```

---

## Task 6: Renderer — `useFanout` hook + `FanoutView` + top-level App entry

**Files:**
- Create: `src/renderer/hooks/use-fanout.ts`
- Create: `src/renderer/components/fanout/fanout-view.tsx`
- Modify: `src/renderer/App.tsx` (lazy-import `FanoutView` + a top-level "Fan-out" toggle button + the panel)
- Test: NONE (RTL is absent in this repo). Gate: `npm run typecheck:web` + `npm run build` + the documented GUI smoke (Task 7).

**Interfaces:**
- Consumes: `window.mango.fanout.{ start, get, select, abort, onStatus }` (Task 1), the `DiffView` component (`src/renderer/components/diff/diff-view.tsx`, reused per-lane), the `FanoutRun`/`FanoutLane`/`FanoutLaneStatusEvent`/`MergeResult` types.
- Produces: `useFanout()` + `<FanoutView base={...} onMerged={...} />`.

- [ ] **Step 1: Create the `useFanout` hook**

Create `src/renderer/hooks/use-fanout.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import type {
  FanoutLaneStatusEvent,
  FanoutRun,
  FanoutStartRequest,
  MergeResult,
} from '../../shared/types';

/** Drives the ONE active fan-out run: seeds from FANOUT_GET + stays live via onStatus. */
export interface UseFanout {
  readonly run: FanoutRun | null;
  readonly busy: boolean;
  readonly error: string | null;
  start(req: FanoutStartRequest): Promise<void>;
  select(laneId: string): Promise<MergeResult>;
  abort(): Promise<void>;
}

/**
 * Seeds the current run from FANOUT_GET on mount, applies live FANOUT_STATUS
 * lane-status patches, and exposes start/select/abort. A lane patch updates the
 * matching lane in place; an event whose id differs from the current run id is
 * ignored (defensive — only one run exists at a time). The caller refreshes the
 * worktree list after a merged select().
 */
export function useFanout(): UseFanout {
  const [run, setRun] = useState<FanoutRun | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.mango.fanout.get().then((r) => {
      if (alive) setRun(r);
    });
    const off = window.mango.fanout.onStatus((e: FanoutLaneStatusEvent) => {
      setRun((prev) => {
        if (!prev || prev.id !== e.id) return prev;
        return {
          ...prev,
          lanes: prev.lanes.map((l) => (l.laneId === e.lane.laneId ? e.lane : l)),
        };
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useCallback(async (req: FanoutStartRequest): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.mango.fanout.start(req);
      // Seed the run from the start result; live patches arrive via onStatus.
      setRun({ id: res.id, prompt: req.prompt, base: '', skipPermissions: req.skipPermissions, lanes: res.lanes });
      // Reconcile base/prompt from the authoritative get() snapshot.
      const full = await window.mango.fanout.get();
      setRun(full);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const select = useCallback(async (laneId: string): Promise<MergeResult> => {
    setError(null);
    setBusy(true);
    try {
      const result = await window.mango.fanout.select({ laneId });
      if (result.status === 'merged') setRun(null);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  const abort = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await window.mango.fanout.abort();
      setRun(null);
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, error, start, select, abort };
}
```

- [ ] **Step 2: Create the `FanoutView` component**

Create `src/renderer/components/fanout/fanout-view.tsx`:

```typescript
import { lazy, Suspense, useState } from 'react';
import type { FanoutLane, MergeResult } from '../../../shared/types';
import { useFanout } from '../../hooks/use-fanout';

// Reuse the existing Monaco diff view per-lane (a lane is a real worktree).
const DiffView = lazy(() =>
  import('../diff/diff-view').then((m) => ({ default: m.DiffView })),
);

/** The preset model tiers the picker offers (max 4 selectable). */
const PRESET_MODELS = ['opus', 'sonnet', 'haiku'] as const;

export interface FanoutViewProps {
  /** Base branch lanes fork from + merge into (= settings.baseBranch ?? 'main'). */
  readonly base: string;
  /** Called after a lane is successfully merged so the parent refreshes worktrees. */
  readonly onMerged: () => void;
}

const STATUS_COLOR: Record<FanoutLane['status'], string> = {
  queued: '#888',
  running: '#e0a030',
  done: '#3ba55d',
  failed: 'crimson',
};

/**
 * Global Fan-out panel. Idle: a prompt textarea + a model picker (checkboxes, 1..4)
 * + a skipPermissions toggle (off; warns it bypasses ALL permission checks) + Start.
 * Running: one card per lane (model + status). Click a done lane -> its DiffView +
 * "Use this lane" (FANOUT_SELECT). An Abort button tears the whole run down. Not a
 * per-worktree pane — it CREATES N worktrees, so it lives at the app top level.
 */
export function FanoutView({ base, onMerged }: FanoutViewProps): React.JSX.Element {
  const { run, busy, error, start, select, abort } = useFanout();
  const [prompt, setPrompt] = useState('');
  const [models, setModels] = useState<string[]>(['opus', 'haiku']);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectResult, setSelectResult] = useState<MergeResult | null>(null);

  const toggleModel = (m: string): void => {
    setModels((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m);
      if (prev.length >= 4) return prev; // cap at 4 (manager also enforces)
      return [...prev, m];
    });
  };

  const onStart = async (): Promise<void> => {
    setSelectResult(null);
    setSelectedLaneId(null);
    await start({ prompt, models, skipPermissions });
  };

  const onUseLane = async (laneId: string): Promise<void> => {
    const result = await select(laneId);
    setSelectResult(result);
    if (result.status === 'merged') {
      setSelectedLaneId(null);
      onMerged();
    }
  };

  const canStart = prompt.trim().length > 0 && models.length >= 1 && models.length <= 4 && !busy;
  const selectedLane = run?.lanes.find((l) => l.laneId === selectedLaneId) ?? null;

  return (
    <section data-testid="fanout-view" style={{ border: '1px solid #333', borderRadius: 8, padding: 16, marginTop: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Multimodel Fan-out</h2>
      {error && <pre style={{ color: 'crimson', fontSize: 13 }}>error: {error}</pre>}

      {!run ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            data-testid="fanout-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="One prompt, sent to every selected model in its own worktree…"
            rows={4}
            style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#aaa' }}>Models (1–4):</span>
            {PRESET_MODELS.map((m) => (
              <label key={m} style={{ fontSize: 13, display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  data-testid={`fanout-model-${m}`}
                  checked={models.includes(m)}
                  onChange={() => toggleModel(m)}
                />
                {m}
              </label>
            ))}
          </div>
          <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', color: skipPermissions ? 'crimson' : '#aaa' }}>
            <input
              type="checkbox"
              data-testid="fanout-skip-permissions"
              checked={skipPermissions}
              onChange={(e) => setSkipPermissions(e.target.checked)}
            />
            Skip permissions (--dangerously-skip-permissions) — bypasses ALL permission checks, incl. bash. Use only for bash-heavy tasks you trust.
          </label>
          <button type="button" data-testid="fanout-start" disabled={!canStart} onClick={() => void onStart()}>
            Start fan-out
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ fontSize: 12, color: '#888' }}>run {run.id} · base {run.base}</code>
            <button type="button" data-testid="fanout-abort" onClick={() => void abort()} disabled={busy}>
              Abort
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.lanes.map((lane) => (
              <button
                key={lane.laneId}
                type="button"
                data-testid={`fanout-lane-${lane.laneId}`}
                disabled={lane.status !== 'done'}
                onClick={() => setSelectedLaneId(lane.laneId)}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: `1px solid ${selectedLaneId === lane.laneId ? '#094771' : '#333'}`,
                  borderRadius: 6,
                  background: selectedLaneId === lane.laneId ? '#0b2a3f' : 'transparent',
                  color: '#ddd',
                  cursor: lane.status === 'done' ? 'pointer' : 'default',
                  minWidth: 160,
                }}
              >
                <div style={{ fontWeight: 600 }}>{lane.model}</div>
                <div style={{ fontSize: 12, color: STATUS_COLOR[lane.status] }}>{lane.status}</div>
                {lane.error && <div style={{ fontSize: 11, color: 'crimson' }}>{lane.error}</div>}
              </button>
            ))}
          </div>

          {selectResult && selectResult.status !== 'merged' && (
            <pre style={{ color: '#e0a030', fontSize: 12 }}>
              {selectResult.status === 'conflict'
                ? `merge conflict: ${(selectResult.conflicted ?? []).join(', ')}`
                : `merge failed: ${selectResult.error ?? 'unknown'}`}
            </pre>
          )}

          {selectedLane && selectedLane.status === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading diff…</p>}>
                <DiffView key={`fanout-diff-${selectedLane.laneId}`} worktreeId={selectedLane.worktreeId} base={base} />
              </Suspense>
              <button type="button" data-testid="fanout-use-lane" disabled={busy} onClick={() => void onUseLane(selectedLane.laneId)}>
                Use this lane ({selectedLane.model})
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Mount a top-level Fan-out entry in `src/renderer/App.tsx`**

Add the lazy import beside the existing `ConflictView` lazy import (`src/renderer/App.tsx:33-36`):

```typescript
// Lazy so the fan-out panel (which pulls the shared monaco diff chunk per-lane) is
// only fetched when the user opens it; keeps the initial renderer chunk smaller.
const FanoutView = lazy(() =>
  import('./components/fanout/fanout-view').then((m) => ({ default: m.FanoutView })),
);
```

Add the toggle state next to the existing `settingsOpen` state (`src/renderer/App.tsx:58`):

```typescript
  const [fanoutOpen, setFanoutOpen] = useState(false);
```

Add a "Fan-out" button to the toolbar row. Replace the toolbar `div` block (`src/renderer/App.tsx:195-207`) — the block that contains `<Toolbar onCreate={create} />` and the settings `⚙` button — with:

```typescript
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Toolbar onCreate={create} />
        <button
          type="button"
          data-testid="fanout-open"
          aria-pressed={fanoutOpen}
          title="Multimodel fan-out"
          onClick={() => setFanoutOpen((v) => !v)}
        >
          ⑃ Fan-out
        </button>
        <button
          type="button"
          data-testid="settings-open"
          aria-label="settings"
          title="Settings"
          disabled={settingsLoading}
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </div>
      {fanoutOpen && (
        <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading fan-out…</p>}>
          <FanoutView base={baseBranch} onMerged={() => void refresh()} />
        </Suspense>
      )}
```

(`baseBranch`, `refresh`, `Suspense`, and `lazy` are already in scope in `App.tsx`.)

- [ ] **Step 4: Typecheck the web bundle + build (the renderer gate, NO unit test)**

Run: `npm run typecheck:web`
Expected: PASS — `FanoutView`/`useFanout`/`App.tsx` compile; the `window.mango.fanout` calls match the contract from Task 1.

If typecheck:web errors `TS2503: Cannot find namespace 'React'` on the `: React.JSX.Element` return annotation, add `import type * as React from 'react'` to fanout-view.tsx (mirror the working import set in src/renderer/components/diff/diff-view.tsx). Otherwise leave the imports as-is.

Run: `npm run build`
Expected: PASS — electron-vite builds main + preload + renderer with no errors; the fan-out chunk + the shared monaco diff chunk emit.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/use-fanout.ts src/renderer/components/fanout/fanout-view.tsx src/renderer/App.tsx
git commit -m "feat(fanout): useFanout hook + FanoutView (prompt + model picker + lane cards + per-lane DiffView) + App entry"
```

---

## Task 7: Full suite green + documented GUI smoke + backlog strike-through

**Files:**
- Create: `tests/smoke/fanout-smoke.md`
- Modify: `docs/V2-BACKLOG.md` (strike through "멀티모델 팬아웃" + link this plan)
- Test: the whole suite + typecheck + build

- [ ] **Step 1: Run the full suite + typecheck + lint + build**

Run: `npm test`
Expected: PASS — every existing test plus `fanout-run.test.ts`, `fanout-manager.test.ts`, `register-fanout-ipc.test.ts` is green.

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS for all three.

- [ ] **Step 2: Write the GUI smoke doc**

Create `tests/smoke/fanout-smoke.md`:

```markdown
# Multimodel Fan-out — manual GUI smoke

Proves a real 2-lane fan-out end to end: one prompt -> 2 worktrees + 2 headless
claude runs -> 2 diffs -> select one -> merge into base -> losers discarded.

## Preconditions
- A real `claude` on PATH (logged in), OR set `MANGO_AGENT_CMD` to a fake agent that
  edits a file in cwd, prints a line, and exits 0 (proves the wiring without burning tokens).
- A clean primary worktree (no uncommitted tracked changes — the winner merge gates on this).
- `git -C <repo> log --oneline -1` noted (to confirm the merge lands a new commit).

## Steps
1. Launch the app (`npm run dev`) and select the repo.
2. Click **⑃ Fan-out** in the toolbar. The Fan-out panel opens (idle: prompt + model picker + skip-permissions toggle + Start).
3. Type a small prompt, e.g. `Add a one-line note to README.md describing this lane.`
4. Tick exactly two models (e.g. opus + haiku). Leave **Skip permissions OFF**.
5. Click **Start fan-out**. Expect:
   - Two lane cards appear (opus, haiku), each transitioning `running` -> `done`.
   - `git -C <repo> worktree list` shows two new `.worktrees/fanout-<id>-<slug>` worktrees on `fanout/<id>/<slug>` branches.
6. Click the **opus** lane card (done). Its **DiffView** loads — confirm the README edit shows as a real diff vs base.
7. Click the **haiku** lane card — confirm a DIFFERENT diff (each model edited independently).
8. Toggle **Skip permissions ON** on a fresh run only to confirm the red warning copy renders; do NOT leave it on for untrusted prompts.
9. With a done lane selected, click **Use this lane (<model>)**. Expect:
   - The merge runs; the panel clears (run -> null) on `status: 'merged'`.
   - `git -C <repo> log --oneline -1` shows the winner's commit on base.
   - `git -C <repo> worktree list` shows ALL fan-out worktrees gone (winner cleaned by MergeRunner, loser removed by select()).
   - The worktree list refreshes (onMerged -> refresh()).
10. Re-run a fan-out, then click **Abort** while/after lanes run. Expect every fan-out worktree removed and the panel back to idle.

## Pass criteria
- 2 lanes -> 2 distinct diffs; select merges exactly one; the other worktrees vanish; abort tears the whole run down; the rest of the app (terminal/diff/conflict/server/PR panels) is unchanged.
```

- [ ] **Step 3: Strike through the backlog item**

In `docs/V2-BACKLOG.md`, replace the "멀티모델 팬아웃" row (`docs/V2-BACKLOG.md:34`):

```markdown
| ~~**멀티모델 팬아웃**~~ ✅ **완료** | L | Plan 2 | 한 프롬프트를 N개 `claude --model` 레인(opus/sonnet/haiku, 최대 4)에 병렬로 던진다. 각 레인 = 베이스에서 분기한 새 워크트리(`WorktreeManager` 재사용) + 헤드리스 `claude -p "<prompt>" --permission-mode acceptEdits --model <tier>`(run-to-completion `child_process`, gh-status-reader 미러; PTY 아님). 레인별 diff는 기존 `DIFF_*`/`DiffView` 재사용, 승자 머지는 `MergeRunner`(safe-abort/conflict 그대로). `FanoutManager`(주입형, 단일 활성 런, 동시성 4 캡) + `runLane`/`slugModel`/`buildLaneArgs` 순수 헬퍼(페이크 러너 TDD) + `FANOUT_START/GET/SELECT/ABORT`+`FANOUT_STATUS` 4-layer IPC + `useFanout`/`FanoutView`(프롬프트+모델 피커+레인 카드+레인별 DiffView+select/abort). `skipPermissions`(기본 off, `--dangerously-skip-permissions`) 경고 토글. 계획: docs/plans/2026-06-22-v2-multimodel-fanout.md |
```

Also update the recommended-order line (`docs/V2-BACKLOG.md:58`), replacing the "멀티모델 팬아웃" mention:

```markdown
4. **턴 감지 → b-full** · ~~**멀티모델 팬아웃**~~(완료) · **병렬 서버** — 무겁고 재설계 필요, 명확한 수요 후
```

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/fanout-smoke.md docs/V2-BACKLOG.md
git commit -m "docs(fanout): GUI smoke + strike multimodel fan-out off the v2 backlog"
```

---

## Migration Strategy (additive)

- **Zero breaking changes.** Every change is new code or an append: new files (`fanout-run.ts`, `fanout-manager.ts`, `use-fanout.ts`, `fanout-view.tsx`, 3 test files, 1 smoke doc), 5 new `FANOUT_*` channel strings, new `types.ts`/`ipc-contract.ts`/`preload` entries, a new `fanoutManager?` ctx slot, 4 new handlers, and an App.tsx top-level button. No existing channel, type, handler, manager, or UI element is renamed, removed, or re-typed.
- **`SETTINGS_SET` edit is additive + guarded.** The new idle-clear (`if (ctx.fanoutManager && ctx.fanoutManager.get() === null) ctx.fanoutManager = undefined;`) only nulls an IDLE manager, mirroring the existing conflictResolver keep-while-busy discipline. The conflict-IPC wiring test still passes (proves the SETTINGS_SET body stays backward-compatible).
- **Reuse, don't fork.** Per-lane diffs reuse the existing `DIFF_*` IPC + `DiffView` (a lane is a real worktree → `DiffView(lane.worktreeId, base)`); the winner merge reuses `MergeRunner.run` (conflict/safe-abort path unchanged); worktrees reuse `WorktreeManager.create/remove`. No new diff/merge IPC.
- **Headless path is separate from the interactive PTY.** `runLane` is a new run-to-completion `child_process` path (via `ProcessRunner.spawnArgs`); it does NOT touch `SessionManager`/node-pty. The interactive agent terminal is unaffected.
- **No new dependencies.** Uses `simple-git`, `node:child_process` (via the existing `ProcessRunner`), and the existing Monaco diff chunk.
- **Rollout:** the feature is dormant until the user clicks **⑃ Fan-out**. Nothing runs at startup; `getFanoutManager` is lazy. If the binary is missing, a lane resolves `code: null` and is marked `failed` (others continue) — no crash.

## Acceptance Checklist

- [ ] `runLane` spawns `<agentCommand> -p "<prompt>" --permission-mode acceptEdits --model <model>` via `spawnArgs` (never `spawn`), with the prompt as a discrete argv element, in the lane cwd; resolves exit code + stdout tail; ENOENT → `code: null`.
- [ ] `buildLaneArgs` appends `--dangerously-skip-permissions` iff `skipPermissions`; `assertSafeModel` rejects leading-`-`/empty; `slugModel` produces a fs/branch-safe token.
- [ ] `FanoutManager.start` creates one worktree per model (`.worktrees/fanout-<id>-<slug>` on `fanout/<id>/<slug>`), spawns a lane in each cwd, transitions queued→running→done|failed, emits `FANOUT_STATUS`, rolls back partial worktrees on a create failure.
- [ ] `start` rejects `> 4` models, `< 1` model, and a second start while a run is active.
- [ ] `select(laneId)` merges the winner into base via `MergeRunner.run(runVerifyHook:false, cleanup:true)`, removes every OTHER lane worktree, clears the run; a conflict/failed result keeps the run + returns the `MergeResult`.
- [ ] `abort()` kills running lanes + removes ALL lane worktrees + clears the run; a fresh `start()` is then allowed.
- [ ] After `select()`, `git branch --list 'fanout/*'` is empty (no orphan branches) — the winner's branch is removed by `MergeRunner` (cleanup:true), the losers' by `FanoutManager.deleteBranch`; `abort()` likewise leaves no `fanout/*` branches.
- [ ] The winner's edits actually land on base (the merge integrates a NON-EMPTY diff): the manager commits each lane's edits before merge, so the winner branch HEAD is ahead of base and `select()` merges a real change (not a no-op).
- [ ] `FANOUT_START/GET/SELECT/ABORT` route to the injected `FanoutManager`; `FANOUT_GET` normalizes to `null`; `SETTINGS_SET` clears the manager only when idle.
- [ ] `useFanout` seeds from `FANOUT_GET` + applies `onStatus` lane patches; `FanoutView` renders the prompt/model-picker/skip-permissions(off+warning)/Start, lane cards, per-lane `DiffView`, "Use this lane", and Abort, mounted as a top-level App entry. Existing UI intact.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all pass; the GUI smoke (real 2-lane fan-out → 2 diffs → select → merge) passes; the backlog item is struck through.

## Self-Review

**1. Spec coverage:** GOAL (N parallel lanes off base, per-lane diff, select-to-merge) → Tasks 2–6. Headless `claude -p` non-interactive run with acceptEdits + per-run skipPermissions + injected agentCommand + discrete prompt arg + model guard → Task 2 (`runLane`/`buildLaneArgs`/`assertSafeModel`) + Task 5 (laneRunner factory injects `resolveCommands.agentCommand`). `FanoutManager` shape `{id,prompt,base,lanes,skipPermissions}` + start/select/abort + concurrency cap 4 + reject-second-start + constructor-injected deps → Tasks 3–4. ONE active run on `ctx.fanoutManager` lazy getter mirroring `getMergeRunner` → Task 5. Worktree/branch naming `.worktrees/fanout-<id>-<slug>` + `fanout/<id>/<slug>` → Task 3. Additive 4-layer IPC + reuse `DIFF_*` for per-lane diff (no new diff IPC) → Tasks 1 + 5 + 6. Renderer global entry + useFanout + FanoutView + no RTL → Task 6. TDD with fake agent command + temp-repo worktrees; argv asserted via recorded fake-runner calls; pure slug/classify tested → Tasks 2–4. Concurrency/safety (parallel, lane-failure-isolation, user-initiated mutation, reuse MergeRunner conflict path) → Tasks 3–4 + select returning the conflict `MergeResult`. Order (1 types→2 runLane→3 start→4 select/abort→5 IPC→6 UI→7 suite+smoke+backlog) → matches.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". The Task 3 `doSelect`/`doAbort` stubs throw an explicit "not implemented until Task 4" and are REPLACED with full bodies in Task 4 Step 3 (this is a deliberate TDD red-bar, not a placeholder). The Task 5 Step 3b `getFanoutManager` is written ONCE, fully correct (`resolveBase: async () => getSettingsStore(ctx).get().baseBranch ?? 'main'`, `repoRoot` from `requireRepoRoot(ctx)`, `simpleGit` via `await import('simple-git')`, the `onSpawn`-captured child kill, and the `gitFactory`/`repoRoot` deps) — no dead-ternary intermediate, no later corrective sub-step.

**3. Type consistency:** `FanoutLane`/`FanoutRun`/`FanoutStartRequest`/`FanoutStartResult`/`FanoutSelectRequest`/`FanoutLaneStatusEvent`/`LaneStatus` (Task 1) are used identically in Tasks 3–6. `LaneRunResult`/`runLane`/`buildLaneArgs`/`assertSafeModel`/`slugModel` (Task 2) are imported as-named in Task 3 + Task 5. `FanoutEmitter.emitLaneStatus`, `LaneRunner`, `LaneProc`, `FanoutManagerDeps`, `MAX_LANES`, `FanoutManager.{start,get,select,abort}` (Task 3) match Task 4 (bodies) + Task 5 (handlers/wiring test) + Task 6 (`window.mango.fanout`). The `laneRunner` factory signature in Task 3's type matches the call site in Task 5's `getFanoutManager`. `MergeRunner.run`/`WorktreeManager.create({baseBranch,newBranch,path})`/`.remove({worktreeId,force})` signatures match the real classes read from the repo.
