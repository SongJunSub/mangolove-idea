Now I have everything I need. The dirty check should use `status.modified`, `status.staged`, `status.created`, `status.deleted`, `status.renamed`, `status.conflicted` (tracked-file changes) and explicitly ignore `not_added`/untracked (which always includes `.worktrees/`). I have all real code, patterns, types, and verified git behavior. Let me write the full Plan 4 markdown.

# Plan 4 — Merge + Cleanup + Status Sidebar

For agentic workers: **REQUIRED SUB-SKILL: superpowers:subagent-driven-development**

## Goal

Merge a worktree (feature) branch into a target branch (default `main`) gated by the **MangoLove verify hook**, then optionally clean up (remove the feature worktree + delete its branch). Surface live `MERGE_PROGRESS` stages in the renderer; on success the merged worktree disappears from the list. Unify the sidebar so each worktree row shows its **branch + agent status (Plan 2) + server state (Plan 3)** from one aggregated structure.

This implements MVP items **5** (merge + cleanup) and **4** (sidebar status), per roadmap §5 and the Plan 4 stub. It consumes — but does not modify — Plan 2 (`SESSION_STATUS`) and Plan 3 (`SERVER_STATE`) events. It does NOT implement session persistence (Plan 5).

## Architecture

```
renderer                          preload            main
─────────────────────────────     ──────────────     ────────────────────────────────
Toolbar "Merge" button ──merge.run(MergeRequest)──▶ ipcMain.handle(MERGE_RUN)
  (selected worktree)                                  └─▶ MergeRunner.run()
                                                            ├─ verify  (ProcessRunner cmd, cwd=worktree)
useMergeProgress() ◀──merge.onProgress(MergeProgressEvent)──┤  emit per stage via injected emitter
  (live stages map)        (subscribe, already wired)       ├─ checkout target + git.merge(feature)
                                                            │     conflict → git merge --abort
app-store aggregation:                                      └─ cleanup: WorktreeManager.remove + branch -d
  fold worktree list +
  SESSION_STATUS +          ◀── SESSION_STATUS (Plan 2, unchanged)
  SERVER_STATE              ◀── SERVER_STATE   (Plan 3, unchanged)
  → Map<id,{agent,server}>
  → WorktreeList rows (branch + agent dot + server dot)
```

The `MergeRunner` lives in `src/main/git/` and is constructor-injected with a `SimpleGit` (bound to `repoRoot`), the existing `WorktreeManager` (for `worktreeId → branch` resolution + cleanup), a verify-command **ProcessRunner** (Plan 3's `ProcessRunner`, reused), and a `MergeEmitter` (so progress is testable windowless — mirrors `SessionEmitter`/`ServerEmitter`). `register-ipc.ts` lazily builds it from `ctx` exactly like the other managers, and forwards `MERGE_PROGRESS` to the renderer through a window-guarded emitter.

Sidebar aggregation is a **pure reducer** (`aggregateStatus`) plus a thin `useWorktreeStatus` hook, folding the worktree list + the two existing event streams into `Map<worktreeId, {agent, server}>`. The existing agent/server dots keep working; App.tsx feeds the unified map down instead of two separate props.

## Tech Stack

Unchanged from Plans 0–3 (locked in roadmap §0): Electron 42.4.0, React 19.2.7, TypeScript 5.7.3 (ESM, `verbatimModuleSyntax`), `simple-git` 3.36.0, Vitest 4.1.9 (node + jsdom projects, `__mocks__/electron.ts` alias), `electron-vite` 5. No new dependencies.

## File Structure

| Path | New? | Purpose |
|---|---|---|
| `src/main/git/merge-runner.ts` | NEW | `MergeRunner`: verify → merge → cleanup; emits `MERGE_PROGRESS`; aborts on verify-fail/conflict |
| `src/main/ipc/ipc-context.ts` | edit | add optional `mergeRunner?: MergeRunner` (injectable in tests) |
| `src/main/ipc/register-ipc.ts` | edit | `getMergeRunner(ctx)` + `MERGE_RUN` handler + `buildMergeEmitter` (MERGE_PROGRESS) |
| `src/preload/index.ts` | edit | flip `merge.run` from `notYet('4')` to real `ipcRenderer.invoke(IPC.MERGE_RUN, req)` |
| `src/renderer/state/app-store.ts` | NEW | pure `aggregateStatus` reducer + types for unified per-worktree status |
| `src/renderer/hooks/use-worktree-status.ts` | NEW | folds SESSION_STATUS + SERVER_STATE into `Map<id,{agent,server}>` |
| `src/renderer/hooks/use-merge.ts` | NEW | `merge.run` wrapper + live `MERGE_PROGRESS` stage map |
| `src/renderer/components/toolbar/merge-controls.tsx` | NEW | Merge button (selected worktree) + live stage line |
| `src/renderer/components/sidebar/worktree-list.tsx` | edit | accept unified `statuses` map (keep agent + server dots) |
| `src/renderer/components/sidebar/worktree-item.tsx` | edit | read agent + server from the unified row status |
| `src/renderer/App.tsx` | edit | use `useWorktreeStatus` + `useMerge`; mount `MergeControls`; refresh list on merge success |
| `tests/main/merge-runner.test.ts` | NEW | temp git repo + fake verify runner + spy emitter (TDD core) |
| `tests/main/ipc-roundtrip.test.ts` | edit | `MERGE_RUN` delegation test (append a `describe`) |
| `tests/renderer/app-store.test.ts` | NEW | pure `aggregateStatus` reducer tests (TDD) |
| `docs/plans/2026-06-16-mvp-roadmap.md` | edit | mark Plan 4 done + record the smoke recipe |

---

## Binding contract reuse (DO NOT redefine)

From `src/shared/types.ts` / `ipc-channels.ts` / `ipc-contract.ts` — reuse **exactly**:
`MergeRequest { worktreeId, targetBranch, runVerifyHook, cleanup }`, `MergeStage = 'verify'|'merge'|'cleanup'|'done'`, `MergeProgressEvent { worktreeId, stage, ok, message }`, `MergeResult { worktreeId, merged, cleanedUp, error? }`, `IPC.MERGE_RUN`, `IPC.MERGE_PROGRESS`, `MangoApi.merge.run/onProgress`. Also reuse `AgentStatus`, `AgentSession`, `ServerState`, `ServerStatus`, `Worktree`. Do **not** change the `MangoApi` surface — preload `merge.onProgress` is already wired via `subscribe()`; Plan 4 only flips `merge.run`.

### Verified git facts (validated in a throwaway repo before writing this plan)

- Merging feature→target = with the **primary** tree on `targetBranch`, run `git merge <featureBranch>`; fast-forward and real merges both succeed with rc 0.
- `simple-git`'s `git.merge([...])` **throws** on conflict; the error message contains `CONFLICT`/`CONFLICTS:` and the error has a `.git` property. After a throw, `git raw(['merge','--abort'])` cleanly restores the tree.
- Cleanup order **matters**: `git worktree remove <path>` MUST run **before** `git branch -d <feature>` — the branch is "used by worktree" and `branch -d` refuses while the worktree holds it.
- `git.status()` on a clean primary tree reports `isClean() === false` because `.worktrees/feat/` is **untracked** (`not_added`). The dirty-tree gate must therefore inspect only **tracked** changes (`modified/staged/created/deleted/renamed/conflicted`) and ignore `not_added`/untracked.

---

## Design decisions (engineer's call — stated explicitly)

1. **`worktreeId → featureBranch`**: resolve via `WorktreeManager.list()` (the `id` is the worktree path). Find the tree with `t.id === req.worktreeId`; its `branch` is the feature branch and its `path` is the cleanup target. Reject if not found, if it is the **primary** tree (`isPrimary`), or if `branch === targetBranch` (`target==feature`).

2. **Verify hook**: an **injected `ProcessRunner`** (Plan 3's interface, reused) runs a command in the **worktree cwd**; success = exit code `0`. Default command is `process.env.MANGO_VERIFY_CMD ?? 'true'` — a real but harmless pass for MVP (and a smoke seam: set `MANGO_VERIFY_CMD='false'` to exercise the fail path, or a real test command to gate honestly). `runVerifyHook:false` skips verify entirely. The runner is awaited via a small `onExit` promise wrapper (same callback shape as `ServerManager` uses).

3. **Merge safety** (avoid corrupting the user's working state):
   - **Precheck**: the primary tree must be clean of **tracked** changes; if dirty → fail at `merge` stage with a clear message, do nothing.
   - **Checkout**: `git.checkout(targetBranch)` in the primary tree before merging (restores intent if the user was elsewhere; no-op if already there).
   - **Conflict**: catch the `git.merge` throw → `git raw(['merge','--abort'])` (best-effort, swallow abort errors) → emit `{stage:'merge', ok:false}` → return `{merged:false}`. The repo is never left mid-conflict.
   - **Cleanup removes the FEATURE worktree only** (never primary): `WorktreeManager.remove({ worktreeId })` then `git.branch(['-d', featureBranch])`. Cleanup failures are **non-fatal**: the merge already succeeded, so return `{merged:true, cleanedUp:false}` and emit `{stage:'cleanup', ok:false, message}` rather than throwing.

4. **Exact simple-git calls**: `WorktreeManager.list()` (id→branch); `this.git.status()` (dirty precheck); `this.git.checkout(targetBranch)`; `this.git.merge(['--no-edit', featureBranch])`; on conflict `this.git.raw(['merge', '--abort'])`; cleanup `this.worktrees.remove({ worktreeId })` + `this.git.branch(['-d', featureBranch])`.

5. **app-store aggregation**: a **pure** `aggregateStatus(worktrees, agentMap, server)` returning `Map<worktreeId, WorktreeRowStatus>` where `WorktreeRowStatus = { agent: AgentStatus; server: ServerState; ownsServer: boolean }`. `ownsServer` is `server.process.worktreeId === id`; non-owners get `server:'stopped', ownsServer:false`. The hook `useWorktreeStatus` keeps the live `agentMap` + `serverStatus` and recomputes via the reducer. This unifies the two props (`agentStatuses` + `serverState/serverWorktreeId`) the sidebar currently takes.

6. **Renderer Merge UX**: `MergeControls` shows a Merge button for the selected worktree (disabled when none/primary/merging). It calls `merge.run({ worktreeId, targetBranch:'main', runVerifyHook:true, cleanup:true })` and renders the live stage line from `MERGE_PROGRESS`. On `MergeResult.merged === true` it calls the worktrees `refresh()` so the removed worktree disappears.

---

## Tasks

> TDD discipline (red → green → commit) on `MergeRunner`, `aggregateStatus`, and the `MERGE_RUN` IPC delegation. Renderer wiring is verified by typecheck + lint + build + a documented manual smoke (matching the Plan 0–3 strategy — no flaky e2e committed). The existing 95 tests MUST stay green; run `npm test` after every green step.

---

### Task 1 — MergeRunner: skeleton + verify stage (TDD)

**Files:** `src/main/git/merge-runner.ts` (NEW), `tests/main/merge-runner.test.ts` (NEW)

**Step 1.1** — Write the failing test file `tests/main/merge-runner.test.ts`. Reuse `makeTempGitRepo`. Add a fake verify `ProcessRunner` + a spy `MergeEmitter`. Start with the verify-fail and skip-verify cases:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync, writeFileSync } from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import { MergeRunner, type MergeEmitter } from '../../src/main/git/merge-runner';
import { WorktreeManager } from '../../src/main/managers/worktree-manager';
import type { ProcessRunner, IProcLike, ProcExitEvent } from '../../src/main/proc/process-runner';
import type { MergeProgressEvent } from '../../src/shared/types';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

/** Fake verify runner: exits with a fixed code, capturing the command + cwd. */
function makeVerifyRunner(code: number) {
  const calls: { command: string; cwd: string }[] = [];
  const runner: ProcessRunner = {
    spawn(command, opts): IProcLike {
      calls.push({ command, cwd: opts.cwd });
      const exitCbs: ((e: ProcExitEvent) => void)[] = [];
      queueMicrotask(() => exitCbs.forEach((cb) => cb({ code, signal: null })));
      return {
        pid: 4242,
        kill: () => {},
        onStdout: () => {},
        onStderr: () => {},
        onExit: (cb) => void exitCbs.push(cb),
      };
    },
  };
  return { runner, calls };
}

function makeEmitter() {
  const events: MergeProgressEvent[] = [];
  const emitter: MergeEmitter = { emitProgress: (e) => void events.push(e) };
  return { emitter, events };
}

/** Adds a feature worktree with one extra commit; returns its id (path) + branch. */
async function addFeature(repo: TempGitRepo, branch: string, file = 'f.txt') {
  const path = join(realpathSync(repo.dir), '.worktrees', branch.replace(/\W+/g, '-'));
  await repo.git.raw(['worktree', 'add', path, '-b', branch, 'main']);
  const fg = simpleGit(path);
  writeFileSync(join(path, file), `${branch} change\n`);
  await fg.add(file);
  await fg.commit(`${branch} commit`);
  return { id: path, branch };
}

describe('MergeRunner', () => {
  let repo: TempGitRepo;
  let git: SimpleGit;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    // one real file commit so the repo has content to merge into
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    await repo.git.add('base.txt');
    await repo.git.commit('base');
    git = simpleGit(realpathSync(repo.dir));
    worktrees = new WorktreeManager(repo.git, repo.dir);
  });

  afterEach(() => repo.cleanup());

  it('fails at verify when the hook exits non-zero (no merge, no cleanup)', async () => {
    const feat = await addFeature(repo, 'feature/v');
    const { runner } = makeVerifyRunner(1);
    const { emitter, events } = makeEmitter();
    const runner2 = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter, verifyCommand: 'verify' });

    const result = await runner2.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: true,
      cleanup: true,
    });

    expect(result.merged).toBe(false);
    expect(result.cleanedUp).toBe(false);
    expect(result.error).toMatch(/verify/i);
    expect(events.find((e) => e.stage === 'verify')).toMatchObject({ stage: 'verify', ok: false });
    expect(events.some((e) => e.stage === 'merge')).toBe(false);
    // feature worktree still present
    const trees = await worktrees.list();
    expect(trees.map((t) => t.branch)).toContain('feature/v');
  });

  it('runs verify in the worktree cwd with the configured command', async () => {
    const feat = await addFeature(repo, 'feature/cwd');
    const { runner, calls } = makeVerifyRunner(0);
    const { emitter } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter, verifyCommand: 'npm test' });
    await mr.run({ worktreeId: feat.id, targetBranch: 'main', runVerifyHook: true, cleanup: false });
    expect(calls[0]).toEqual({ command: 'npm test', cwd: feat.id });
  });
});
```

**Step 1.2** — Run `npx vitest run tests/main/merge-runner.test.ts` → RED (module missing).

**Step 1.3** — Create `src/main/git/merge-runner.ts` with deps, the emitter interface, `worktreeId→branch` resolution, and the verify stage only (merge/cleanup as TODO emitting `done`):

```ts
import type { SimpleGit } from 'simple-git';
import type { MergeProgressEvent, MergeResult, MergeRequest, MergeStage } from '../../shared/types';
import type { ProcessRunner } from '../proc/process-runner';
import type { WorktreeManager } from '../managers/worktree-manager';

/** Where MergeRunner publishes MERGE_PROGRESS (injected, so tests spy). */
export interface MergeEmitter {
  emitProgress(e: MergeProgressEvent): void;
}

/** Constructor dependencies — all injectable for windowless unit tests. */
export interface MergeRunnerDeps {
  /** SimpleGit bound to the PRIMARY repo root (where targetBranch is checked out). */
  readonly git: SimpleGit;
  /** Resolves worktreeId -> branch/path and performs worktree cleanup. */
  readonly worktrees: WorktreeManager;
  /** Runs the verify command; success = exit code 0. */
  readonly verifyRunner: ProcessRunner;
  readonly emitter: MergeEmitter;
  /** Verify command line; default `process.env.MANGO_VERIFY_CMD ?? 'true'`. */
  readonly verifyCommand?: string;
}

/**
 * Runs the MangoLove merge flow for ONE worktree: verify hook -> merge feature
 * into target (in the primary tree) -> optional cleanup (remove worktree + delete
 * branch). Emits MERGE_PROGRESS per stage through the injected emitter and never
 * leaves the repo mid-conflict (aborts on conflict). All git access is the same
 * simple-git surface WorktreeManager uses, so it is unit-testable on a temp repo.
 */
export class MergeRunner {
  private readonly git: SimpleGit;
  private readonly worktrees: WorktreeManager;
  private readonly verifyRunner: ProcessRunner;
  private readonly emitter: MergeEmitter;
  private readonly verifyCommand: string;

  constructor(deps: MergeRunnerDeps) {
    this.git = deps.git;
    this.worktrees = deps.worktrees;
    this.verifyRunner = deps.verifyRunner;
    this.emitter = deps.emitter;
    this.verifyCommand = deps.verifyCommand ?? process.env.MANGO_VERIFY_CMD ?? 'true';
  }

  /** Executes verify -> merge -> cleanup, emitting progress for each stage. */
  async run(req: MergeRequest): Promise<MergeResult> {
    const { worktreeId, targetBranch } = req;

    // Resolve worktreeId -> feature branch + path via the worktree listing.
    const trees = await this.worktrees.list();
    const feature = trees.find((t) => t.id === worktreeId);
    if (!feature) return this.fail(worktreeId, 'merge', `unknown worktree ${worktreeId}`);
    if (feature.isPrimary) {
      return this.fail(worktreeId, 'merge', 'cannot merge the primary worktree');
    }
    // WorktreeManager reports a detached-HEAD worktree's branch as the literal
    // '(detached)'; merging/deleting that bogus ref errors opaquely — guard early.
    if (feature.branch === '(detached)') {
      return this.fail(worktreeId, 'merge', 'cannot merge a detached-HEAD worktree (no branch)');
    }
    if (feature.branch === targetBranch) {
      return this.fail(worktreeId, 'merge', `feature and target are the same branch (${targetBranch})`);
    }
    const featureBranch = feature.branch;

    // ── verify ──────────────────────────────────────────────────────────────
    if (req.runVerifyHook) {
      const ok = await this.runVerify(feature.path);
      if (!ok) {
        return this.fail(worktreeId, 'verify', `verify hook failed: ${this.verifyCommand}`);
      }
      this.emit(worktreeId, 'verify', true, 'verify passed');
    }

    // merge + cleanup land in Task 2/3.
    this.emit(worktreeId, 'done', true, 'merged');
    return { worktreeId, merged: true, cleanedUp: false };
  }

  /** Runs the verify command in `cwd`; resolves true iff exit code === 0. */
  private runVerify(cwd: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = this.verifyRunner.spawn(this.verifyCommand, { cwd });
      proc.onExit((e) => resolve(e.code === 0));
    });
  }

  private emit(worktreeId: string, stage: MergeStage, ok: boolean, message: string): void {
    this.emitter.emitProgress({ worktreeId, stage, ok, message });
  }

  /** Emits a failed stage and returns a non-merged MergeResult. */
  private fail(worktreeId: string, stage: MergeStage, error: string): MergeResult {
    this.emit(worktreeId, stage, false, error);
    return { worktreeId, merged: false, cleanedUp: false, error };
  }
}
```

**Step 1.4** — Run the test file → GREEN (verify-fail + cwd cases pass). Run full `npm test` → 95 + new pass.

**Step 1.5** — `git add` + commit: `feat(merge): MergeRunner verify stage with injected runner + emitter`.

---

### Task 2 — MergeRunner: merge stage (fast-forward, conflict-abort, safety) (TDD)

**Files:** `src/main/git/merge-runner.ts` (edit), `tests/main/merge-runner.test.ts` (edit)

**Step 2.1** — Append failing tests for merge success, conflict-abort, dirty-primary, and same-branch:

```ts
  it('merges the feature branch into the target (fast-forward) and reaches done', async () => {
    const feat = await addFeature(repo, 'feature/m');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter, verifyCommand: 'true' });

    const result = await mr.run({ worktreeId: feat.id, targetBranch: 'main', runVerifyHook: true, cleanup: false });

    expect(result.merged).toBe(true);
    expect(events.map((e) => e.stage)).toEqual(['verify', 'merge', 'done']);
    // target (main) now contains the feature file
    const log = await repo.git.log();
    expect(log.all.some((c) => c.message.includes('feature/m commit'))).toBe(true);
  });

  it('aborts and fails at merge on a conflict, leaving the tree clean', async () => {
    // diverge: feature edits base.txt one way, main edits it another
    const path = join(realpathSync(repo.dir), '.worktrees', 'cflt');
    await repo.git.raw(['worktree', 'add', path, '-b', 'feature/cflt', 'main']);
    const fg = simpleGit(path);
    writeFileSync(join(path, 'base.txt'), 'feature-version\n');
    await fg.add('base.txt');
    await fg.commit('feat edit');
    writeFileSync(join(repo.dir, 'base.txt'), 'main-version\n');
    await repo.git.add('base.txt');
    await repo.git.commit('main edit');

    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });

    const result = await mr.run({ worktreeId: path, targetBranch: 'main', runVerifyHook: false, cleanup: true });

    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/conflict/i);
    expect(events.find((e) => e.stage === 'merge')).toMatchObject({ ok: false });
    // tree is clean (abort restored it) — no merge-in-progress markers
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
    expect(st.modified).toEqual([]);
  });

  it('refuses to merge when the primary tree has tracked changes', async () => {
    const feat = await addFeature(repo, 'feature/dirty');
    writeFileSync(join(repo.dir, 'base.txt'), 'uncommitted edit\n'); // dirty tracked file
    const { runner } = makeVerifyRunner(0);
    const { emitter } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });
    const result = await mr.run({ worktreeId: feat.id, targetBranch: 'main', runVerifyHook: false, cleanup: false });
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/uncommitted|dirty/i);
  });
```

**Step 2.2** — Run → RED.

**Step 2.3** — In `merge-runner.ts`, replace the `// merge + cleanup land in Task 2/3.` block with the real merge stage (still returning before cleanup):

```ts
    // ── merge ───────────────────────────────────────────────────────────────
    // Safety: the primary tree must be clean of TRACKED changes. Untracked paths
    // (notably the `.worktrees/` dir) are ignored — they are always 'not_added'.
    const status = await this.git.status();
    const trackedDirty =
      status.modified.length +
      status.staged.length +
      status.created.length +
      status.deleted.length +
      status.renamed.length +
      status.conflicted.length;
    if (trackedDirty > 0) {
      return this.fail(worktreeId, 'merge', 'primary worktree has uncommitted changes; commit or stash first');
    }

    try {
      await this.git.checkout(targetBranch);
      await this.git.merge(['--no-edit', featureBranch]);
    } catch (error) {
      // Conflict (or any merge failure): abort so the repo is never left mid-merge.
      try {
        await this.git.raw(['merge', '--abort']);
      } catch {
        // best-effort; if there was nothing to abort git errors — ignore.
      }
      const raw = error instanceof Error ? error.message : String(error);
      const msg = /conflict/i.test(raw)
        ? `merge conflict merging ${featureBranch} into ${targetBranch}`
        : raw.replace(/^fatal:\s*/i, '').trim();
      return this.fail(worktreeId, 'merge', msg);
    }
    this.emit(worktreeId, 'merge', true, `merged ${featureBranch} into ${targetBranch}`);

    // cleanup lands in Task 3.
    this.emit(worktreeId, 'done', true, 'merged');
    return { worktreeId, merged: true, cleanedUp: false };
```

> Note the empty `catch {}` on `merge --abort` is intentional and documented (an abort with nothing to abort throws) — it is NOT an ignored error of the real failure, whose message we already captured. This satisfies the "no empty catch" convention via the explanatory comment.

**Step 2.4** — Run → GREEN. Run `npm test` → all pass.

**Step 2.5** — Commit: `feat(merge): merge stage with conflict-abort + dirty-tree guard`.

---

### Task 3 — MergeRunner: cleanup stage (TDD)

**Files:** `src/main/git/merge-runner.ts` (edit), `tests/main/merge-runner.test.ts` (edit)

**Step 3.1** — Append failing tests for cleanup-on / cleanup-off / non-fatal cleanup:

```ts
  it('cleans up (removes worktree + deletes branch) after a successful merge', async () => {
    const feat = await addFeature(repo, 'feature/clean');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });

    const result = await mr.run({ worktreeId: feat.id, targetBranch: 'main', runVerifyHook: false, cleanup: true });

    expect(result).toMatchObject({ merged: true, cleanedUp: true });
    expect(events.map((e) => e.stage)).toEqual(['merge', 'cleanup', 'done']);
    const trees = await worktrees.list();
    expect(trees.map((t) => t.branch)).not.toContain('feature/clean');
    const branches = await repo.git.branchLocal();
    expect(branches.all).not.toContain('feature/clean');
  });

  it('leaves the worktree in place when cleanup is false', async () => {
    const feat = await addFeature(repo, 'feature/keep');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });
    const result = await mr.run({ worktreeId: feat.id, targetBranch: 'main', runVerifyHook: false, cleanup: false });
    expect(result.cleanedUp).toBe(false);
    expect(events.some((e) => e.stage === 'cleanup')).toBe(false);
    const trees = await worktrees.list();
    expect(trees.map((t) => t.branch)).toContain('feature/keep');
  });
```

**Step 3.2** — Run → RED.

**Step 3.3** — In `merge-runner.ts`, replace the `// cleanup lands in Task 3.` block:

```ts
    // ── cleanup (non-fatal: the merge already succeeded) ──────────────────────
    let cleanedUp = false;
    if (req.cleanup) {
      try {
        // Order matters: remove the worktree FIRST, then delete the branch —
        // `git branch -d` refuses a branch still held by a worktree.
        await this.worktrees.remove({ worktreeId });
        await this.git.branch(['-d', featureBranch]);
        cleanedUp = true;
        this.emit(worktreeId, 'cleanup', true, `removed ${featureBranch}`);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        this.emit(worktreeId, 'cleanup', false, `cleanup failed: ${raw}`);
      }
    }

    this.emit(worktreeId, 'done', true, cleanedUp ? 'merged + cleaned up' : 'merged');
    return { worktreeId, merged: true, cleanedUp };
```

**Step 3.4** — Run → GREEN. `npm test` → all pass.

**Step 3.5** — Commit: `feat(merge): cleanup stage (remove worktree + delete branch, non-fatal)`.

---

### Task 4 — Wire MERGE_RUN + MERGE_PROGRESS in main IPC (TDD on delegation)

**Files:** `src/main/ipc/ipc-context.ts` (edit), `src/main/ipc/register-ipc.ts` (edit), `tests/main/ipc-roundtrip.test.ts` (edit)

**Step 4.1** — Append a failing `describe('registerIpc — merge', …)` to `ipc-roundtrip.test.ts`:

```ts
describe('registerIpc — merge', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('MERGE_RUN delegates to mergeRunner.run and returns the MergeResult', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const result = { worktreeId: '/wt', merged: true, cleanedUp: true };
    const mr = { run: vi.fn(async () => result) };
    registerIpc(ipcMain as never, { mainWindow: null, mergeRunner: mr as never });
    const req = { worktreeId: '/wt', targetBranch: 'main', runVerifyHook: true, cleanup: true };
    const out = await handlers.get('merge:run')!({}, req);
    expect(mr.run).toHaveBeenCalledWith(req);
    expect(out).toEqual(result);
  });
});
```

**Step 4.2** — Run `npx vitest run tests/main/ipc-roundtrip.test.ts` → RED (`mergeRunner` not on context / no handler).

**Step 4.3** — Edit `ipc-context.ts`: import the type and add the field.

```ts
import type { MergeRunner } from '../git/merge-runner';
```
```ts
  /** Lazily constructed in register-ipc; injectable in tests (Plan 4). */
  mergeRunner?: MergeRunner;
```

**Step 4.4** — Edit `register-ipc.ts`. Add imports:

```ts
import { MergeRunner, type MergeEmitter } from '../git/merge-runner';
import type { MergeRequest, MergeResult } from '../../shared/types';
```

Add the emitter builder + lazy getter (mirroring the existing ones):

```ts
/** Forwards MergeRunner progress to the renderer over MERGE_PROGRESS (guarded). */
function buildMergeEmitter(ctx: IpcContext): MergeEmitter {
  return {
    emitProgress: (e) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.MERGE_PROGRESS, e);
    },
  };
}

/**
 * Resolves the MergeRunner: prefer ctx (tests inject); else build a real one.
 * MUST be async: main is ESM (`verbatimModuleSyntax`), so `require` is undefined in
 * module scope — simple-git loads via dynamic `import`, and we reuse the cached,
 * canonicalized `getWorktreeManager` rather than constructing a second WorktreeManager.
 */
async function getMergeRunner(ctx: IpcContext): Promise<MergeRunner> {
  if (ctx.mergeRunner) return ctx.mergeRunner;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  const worktrees = await getWorktreeManager(ctx);
  ctx.mergeRunner = new MergeRunner({
    git: simpleGit(repoRoot),
    worktrees,
    verifyRunner: new NodeProcessRunner(),
    emitter: buildMergeEmitter(ctx),
  });
  return ctx.mergeRunner;
}
```

Register the handler inside `registerIpc(...)` (next to the others):

```ts
  ipcMain.handle(
    IPC.MERGE_RUN,
    async (_event: unknown, req: MergeRequest): Promise<MergeResult> => {
      return (await getMergeRunner(ctx)).run(req);
    },
  );
```

**Step 4.5** — Run `npx vitest run tests/main/ipc-roundtrip.test.ts` → GREEN. Run `npm test` → all green. Run `npm run typecheck:node`.

**Step 4.6** — Commit: `feat(ipc): wire MERGE_RUN + MERGE_PROGRESS to MergeRunner`.

---

### Task 5 — Flip preload merge.run to real

**Files:** `src/preload/index.ts` (edit)

**Step 5.1** — Replace the merge block:

```ts
  merge: {
    run: (req) => ipcRenderer.invoke(IPC.MERGE_RUN, req),
    onProgress: (cb) => subscribe(IPC.MERGE_PROGRESS, cb),
  },
```

**Step 5.1b** — DELETE the now-orphaned `notYet` helper (MANDATORY, not optional). `merge.run` was its
last caller (Plan 2 flipped `session.*`, Plan 3 flipped `server.*`/`logs.*`; all `on*` use `subscribe`).
With it flipped, `notYet` has zero callers, and `tsconfig.node.json` (`noUnusedLocals: true`, includes
`src/preload/**`) + eslint `no-unused-vars: error` make `npm run typecheck`/`lint` FAIL with TS6133 unless
it is removed. Delete the entire function:
```ts
// DELETE these lines from src/preload/index.ts:
function notYet(plan: string): never {
  throw new Error(`mango: not implemented until Plan ${plan}`);
}
```

**Step 5.2** — `npm run typecheck && npm run lint` (preload `index.d.ts` re-exports the contract; `merge.run`
now matches `MangoApi`). Both MUST exit 0 — confirms `merge.run` typechecks AND `notYet` is gone (no TS6133).

**Step 5.3** — Commit: `feat(preload): flip merge.run from notYet('4') to real invoke`.

---

### Task 6 — app-store: pure status aggregation (TDD)

**Files:** `src/renderer/state/app-store.ts` (NEW), `tests/renderer/app-store.test.ts` (NEW)

**Step 6.1** — Write the failing pure-reducer test `tests/renderer/app-store.test.ts`:

```ts
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

const serverOn = (id: string | null, state: ServerStatus['process']['state']): ServerStatus => ({
  process: { worktreeId: id, kind: 'npm', state },
});

describe('aggregateStatus', () => {
  it('defaults every worktree to idle/stopped when no events seen', () => {
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), null);
    expect(map.get('/a')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
    expect(map.get('/b')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
  });

  it('folds the agent status for the matching worktree', () => {
    const agents = new Map<string, AgentStatus>([['/b', 'running']]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], agents, null);
    expect(map.get('/b')!.agent).toBe('running');
    expect(map.get('/a')!.agent).toBe('idle');
  });

  it('assigns the server state ONLY to the owning worktree', () => {
    const map = aggregateStatus(
      [wt('/a', 'main', true), wt('/b', 'feat')],
      new Map(),
      serverOn('/b', 'running'),
    );
    expect(map.get('/b')).toMatchObject({ server: 'running', ownsServer: true });
    expect(map.get('/a')).toMatchObject({ server: 'stopped', ownsServer: false });
  });

  it('treats a null server worktreeId as nobody owning the server', () => {
    const map = aggregateStatus([wt('/a', 'main', true)], new Map(), serverOn(null, 'stopped'));
    expect(map.get('/a')).toMatchObject({ server: 'stopped', ownsServer: false });
  });
});
```

**Step 6.2** — Run `npx vitest run tests/renderer/app-store.test.ts` → RED.

**Step 6.3** — Create `src/renderer/state/app-store.ts`:

```ts
import type { AgentStatus, ServerState, ServerStatus, Worktree } from '../../shared/types';

/** Unified per-worktree status the sidebar row renders (branch lives on Worktree). */
export interface WorktreeRowStatus {
  readonly agent: AgentStatus;
  readonly server: ServerState;
  /** True iff this worktree owns the single running server (Plan 3 invariant). */
  readonly ownsServer: boolean;
}

/**
 * Pure fold: combines the worktree list with the live agent-status map
 * (SESSION_STATUS) and the single ServerStatus (SERVER_STATE) into one
 * Map<worktreeId, WorktreeRowStatus>. Only the server's owning worktree shows a
 * non-stopped server state; everyone else is 'stopped'. No React, no IO — unit
 * tested directly; the useWorktreeStatus hook is the only live caller.
 */
export function aggregateStatus(
  worktrees: readonly Worktree[],
  agentStatuses: ReadonlyMap<string, AgentStatus>,
  server: ServerStatus | null,
): ReadonlyMap<string, WorktreeRowStatus> {
  const serverOwner = server?.process.worktreeId ?? null;
  const serverState = server?.process.state ?? 'stopped';
  const out = new Map<string, WorktreeRowStatus>();
  for (const wt of worktrees) {
    const ownsServer = serverOwner !== null && wt.id === serverOwner;
    out.set(wt.id, {
      agent: agentStatuses.get(wt.id) ?? 'idle',
      server: ownsServer ? serverState : 'stopped',
      ownsServer,
    });
  }
  return out;
}
```

**Step 6.4** — Run → GREEN. `npm test` → all pass.

**Step 6.5** — Commit: `feat(renderer): pure aggregateStatus reducer for unified sidebar status`.

---

### Task 7 — Renderer hooks: useWorktreeStatus + useMerge

**Files:** `src/renderer/hooks/use-worktree-status.ts` (NEW), `src/renderer/hooks/use-merge.ts` (NEW)

**Step 7.1** — Create `use-worktree-status.ts` (subsumes the inline `agentStatuses` effect currently in App.tsx):

```ts
import { useEffect, useMemo, useState } from 'react';
import type { AgentStatus, ServerStatus, Worktree } from '../../shared/types';
import { aggregateStatus, type WorktreeRowStatus } from '../state/app-store';

/**
 * Live unified per-worktree status. Owns the agent-status map (SESSION_STATUS)
 * and the single ServerStatus (SERVER_STATE, seeded from status()), then derives
 * the row map via the pure aggregateStatus reducer. The sidebar reads this map.
 */
export function useWorktreeStatus(
  worktrees: readonly Worktree[],
): ReadonlyMap<string, WorktreeRowStatus> {
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());
  const [server, setServer] = useState<ServerStatus | null>(null);

  useEffect(() => {
    const offStatus = window.mango.session.onStatus((s) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(s.worktreeId, s.status);
        return next;
      });
    });
    let alive = true;
    void window.mango.server.status().then((s) => {
      if (alive) setServer(s);
    });
    const offState = window.mango.server.onState((s) => setServer(s));
    return () => {
      alive = false;
      offStatus();
      offState();
    };
  }, []);

  return useMemo(
    () => aggregateStatus(worktrees, agentStatuses, server),
    [worktrees, agentStatuses, server],
  );
}
```

**Step 7.2** — Create `use-merge.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { MergeProgressEvent, MergeRequest, MergeResult } from '../../shared/types';

/** Live merge progress for the UI: the latest stage event + a busy flag. */
export interface UseMerge {
  readonly progress: MergeProgressEvent | null;
  readonly running: boolean;
  run(req: MergeRequest): Promise<MergeResult>;
}

/**
 * Drives merge.run + the live MERGE_PROGRESS stream. Tracks the latest stage so
 * the toolbar can show "verify… / merge… / cleanup… / done". `running` gates the
 * Merge button. The caller refreshes the worktree list on a merged result.
 */
export function useMerge(): UseMerge {
  const [progress, setProgress] = useState<MergeProgressEvent | null>(null);
  const [running, setRunning] = useState<boolean>(false);

  useEffect(() => {
    const off = window.mango.merge.onProgress((e) => setProgress(e));
    return off;
  }, []);

  const run = useCallback(async (req: MergeRequest): Promise<MergeResult> => {
    setProgress(null);
    setRunning(true);
    try {
      return await window.mango.merge.run(req);
    } finally {
      setRunning(false);
    }
  }, []);

  return { progress, running, run };
}
```

**Step 7.3** — `npm run typecheck:web` → green.

**Step 7.4** — Commit: `feat(renderer): useWorktreeStatus + useMerge hooks`.

---

### Task 8 — Renderer: MergeControls + sidebar unification + App wiring

**Files:** `src/renderer/components/toolbar/merge-controls.tsx` (NEW), `src/renderer/components/sidebar/worktree-list.tsx` (edit), `src/renderer/components/sidebar/worktree-item.tsx` (edit), `src/renderer/App.tsx` (edit)

**Step 8.1** — Create `merge-controls.tsx`:

```ts
import type { MergeProgressEvent, Worktree } from '../../../shared/types';

export interface MergeControlsProps {
  readonly selected: Worktree | null;
  readonly running: boolean;
  readonly progress: MergeProgressEvent | null;
  onMerge(worktree: Worktree): void;
}

/**
 * Merge button for the selected (non-primary) worktree + a live stage line.
 * Runs verify -> merge -> cleanup into 'main' (MVP item 5). Disabled while a
 * merge is in flight, when nothing is selected, or for the primary worktree.
 */
export function MergeControls({
  selected,
  running,
  progress,
  onMerge,
}: MergeControlsProps): React.JSX.Element {
  const canMerge = !!selected && !selected.isPrimary && !running;
  const stageLabel = progress
    ? `${progress.stage}${progress.ok ? '' : ' ✗'}: ${progress.message}`
    : '';

  return (
    <div data-testid="merge-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        type="button"
        disabled={!canMerge}
        onClick={() => selected && onMerge(selected)}
        title={
          !selected
            ? 'select a worktree first'
            : selected.isPrimary
              ? 'cannot merge the primary worktree'
              : 'verify, merge into main, then clean up'
        }
      >
        {running ? 'Merging…' : 'Merge → main'}
      </button>
      {stageLabel && (
        <span
          data-testid="merge-stage"
          style={{ fontSize: 11, color: progress && !progress.ok ? 'crimson' : '#888' }}
        >
          {stageLabel}
        </span>
      )}
    </div>
  );
}
```

**Step 8.2** — Edit `worktree-list.tsx` to take the unified `statuses` map instead of `agentStatuses`/`serverState`/`serverWorktreeId`:

```ts
import type { Worktree } from '../../../shared/types';
import type { WorktreeRowStatus } from '../../state/app-store';
import { WorktreeItem } from './worktree-item';

export interface WorktreeListProps {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly statuses: ReadonlyMap<string, WorktreeRowStatus>;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}
```

In the body, replace the per-item props:

```ts
        {worktrees.map((wt) => {
          const status = statuses.get(wt.id);
          return (
            <WorktreeItem
              key={wt.id}
              worktree={wt}
              selected={wt.id === selectedId}
              agentStatus={status?.agent ?? 'idle'}
              serverState={status?.server ?? 'stopped'}
              ownsServer={status?.ownsServer ?? false}
              onSelect={onSelect}
              onRemove={onRemove}
            />
          );
        })}
```

`worktree-item.tsx` keeps its existing prop shape (`agentStatus`, `serverState`, `ownsServer`) — **no change** to the item, so the agent dot + server dot keep rendering exactly as before.

**Step 8.3** — Edit `App.tsx`: drop the inline `agentStatuses` effect, use `useWorktreeStatus` + `useMerge`, pass `statuses` to the list, and mount `MergeControls`. Key edits:

```ts
import { useWorktreeStatus } from './hooks/use-worktree-status';
import { useMerge } from './hooks/use-merge';
import { MergeControls } from './components/toolbar/merge-controls';
```

Also change the shared-types import line (currently `import type { AgentStatus, AppInfo } from '../shared/types';`)
to drop the now-unused `AgentStatus` and add `Worktree` (used by `onMerge`):
```ts
import type { AppInfo, Worktree } from '../shared/types';
```

Inside `App` — remove the `agentStatuses` `useState` + its `useEffect`; add:

```ts
  const { worktrees, loading, error, create, remove, refresh } = useWorktrees();
  const statuses = useWorktreeStatus(worktrees);
  const { progress: mergeProgress, running: merging, run: runMerge } = useMerge();

  const selectedWorktree = worktrees.find((w) => w.id === selectedId) ?? null;

  const onMerge = useCallback(
    async (worktree: Worktree): Promise<void> => {
      const result = await runMerge({
        worktreeId: worktree.id,
        targetBranch: 'main',
        runVerifyHook: true,
        cleanup: true,
      });
      if (result.merged) {
        if (worktree.id === selectedId) setSelectedId(null);
        await refresh();
      }
    },
    [runMerge, refresh, selectedId],
  );
```

Add `Worktree` to the type import from `../shared/types`. In JSX, add after `ServerControls`:

```tsx
      <MergeControls
        selected={selectedWorktree}
        running={merging}
        progress={mergeProgress}
        onMerge={(wt) => void onMerge(wt)}
      />
```

Replace the `WorktreeList` props block with:

```tsx
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          selectedId={selectedId}
          statuses={statuses}
          onSelect={setSelectedId}
          onRemove={(id) => void remove(id)}
        />
```

**Step 8.4** — `npm run typecheck:web && npm run lint && npm run build`. (Build runs `electron-vite build` over main+preload+renderer — proves the whole renderer wiring compiles.) Fix any unused imports (e.g. the now-removed `AgentStatus` import in App.tsx).

**Step 8.5** — Commit: `feat(renderer): Merge button + unified sidebar status via aggregateStatus`.

---

### Task 9 — Docs + manual/Playwright smoke recipe (no committed e2e infra)

**Files:** `docs/plans/2026-06-16-mvp-roadmap.md` (edit)

**Step 9.1** — Mark Plan 4 done in the roadmap status and append the smoke recipe below. Matching the Plan 0–3 strategy, the smoke is a **documented manual run** (Playwright optional, not committed) using the env seams already in the code:

```
## Plan 4 manual smoke (merge + cleanup + sidebar)
Prereq: a real repo with `main` + at least one feature worktree (create via the toolbar).
1. Build + run:  MANGO_VERIFY_CMD='true' npm run dev
2. Select the feature worktree → its row shows branch + agent dot + (if running) server dot.
3. Click "Merge → main". Observe the live stage line cycle: verify → merge → cleanup → done.
   On success the worktree row disappears (list refreshes); main now contains the feature commits.
4. Fail path:  relaunch with  MANGO_VERIFY_CMD='false'  → Merge stops at "verify ✗"; the
   worktree remains, the repo is untouched (no merge, no cleanup).
5. Conflict path: make divergent edits to the same file on main and the feature, commit both,
   then Merge → stage line shows "merge ✗: merge conflict…"; `git status` in the repo is CLEAN
   (the runner aborted). The worktree remains.
```

> No flaky e2e infra is committed; the Vitest suites (node + jsdom) remain the gate. The smoke is reproducible via the `MANGO_VERIFY_CMD` seam baked into `MergeRunner`.

**Step 9.2** — Commit: `docs(plan4): mark Plan 4 done + record merge/cleanup smoke recipe`.

---

## Plan 4 Acceptance Checklist

- [ ] `src/main/git/merge-runner.ts` exists; `MergeRunner` is constructor-injected with `{ git, worktrees, verifyRunner, emitter, verifyCommand? }` and exposes `run(MergeRequest): Promise<MergeResult>`.
- [ ] Verify stage: `runVerifyHook` runs the injected command in the **worktree cwd**; exit 0 = pass; non-zero emits `{stage:'verify', ok:false}` and returns `{merged:false}` (no merge, no cleanup).
- [ ] Merge stage: dirty **tracked** primary tree is refused; `git.checkout(target)` then `git.merge(['--no-edit', feature])`; conflict triggers `git raw(['merge','--abort'])`, emits `{stage:'merge', ok:false}`, returns `{merged:false}` and leaves the tree clean.
- [ ] Cleanup stage: removes the **feature** worktree (`WorktreeManager.remove`) THEN `git.branch(['-d', feature])`; non-fatal (merge stays successful); `{stage:'cleanup'}` emitted; `cleanedUp` reflects reality.
- [ ] `done` stage emitted last on success; stage order is `verify? → merge → cleanup? → done`.
- [ ] `MERGE_RUN` handler delegates to `MergeRunner.run` (returns `MergeResult`); `MERGE_PROGRESS` forwarded through a window-guarded emitter. `ipc-context.ts` has `mergeRunner?`.
- [ ] `src/preload/index.ts` `merge.run` calls `ipcRenderer.invoke(IPC.MERGE_RUN, req)` (no more `notYet('4')`); `MangoApi` surface unchanged.
- [ ] `aggregateStatus` is pure and folds worktrees + agent map + ServerStatus into `Map<id, {agent, server, ownsServer}>`; only the owning worktree shows a non-stopped server.
- [ ] Sidebar renders branch + agent dot + server dot from the unified `statuses` map; existing dots unchanged.
- [ ] Toolbar Merge button runs verify→merge→cleanup into `main` with `runVerifyHook:true, cleanup:true`, shows live stages, and on success the worktree disappears (list refresh).
- [ ] New tests: `tests/main/merge-runner.test.ts` (verify-fail, verify-cwd, fast-forward, conflict-abort, dirty-tree, cleanup-on/off), `MERGE_RUN` delegation in `ipc-roundtrip.test.ts`, `tests/renderer/app-store.test.ts` (4 reducer cases).
- [ ] `npm test` green (95 prior + new). `npm run typecheck` (node+web) green. `npm run lint` clean. `npm run build` succeeds.
- [ ] No changes to session/server internals (Plan 2/3); no session persistence (Plan 5).

## Self-Review Notes

- **Why the dirty-check ignores `not_added`**: verified that `git.status()` on a clean primary reports `isClean() === false` solely because `.worktrees/` is untracked. Counting only `modified/staged/created/deleted/renamed/conflicted` is the correct "tracked changes" gate; untracked files (including new worktrees) never block a merge.
- **Cleanup ordering is load-bearing**: `git branch -d` refuses a branch held by a worktree ("used by worktree at …"). The plan removes the worktree first; the test asserts both the worktree AND the branch are gone, which only passes with the correct order.
- **Conflict abort is best-effort**: the documented empty `catch {}` around `merge --abort` is intentional (aborting with nothing to abort throws) and does not swallow the real merge error, which is captured before the abort. This honors the "no silent empty catch" convention via the explanatory comment.
- **Cleanup is non-fatal by design**: once `git merge` succeeds the merge is durable; a cleanup hiccup (e.g. a dirty worktree dir) must not report `merged:false`. The runner emits `{stage:'cleanup', ok:false}` but returns `{merged:true, cleanedUp:false}`.
- **`getMergeRunner` reuses `getWorktreeManager`** (async + cached on `ctx`) so MergeRunner and the worktree handlers share one canonicalized `WorktreeManager`, and the dynamic `import('simple-git')` keeps `register-ipc` importable under windowless Vitest. The two `simpleGit(repoRoot)` instances (one for the manager, one for `MergeRunner.git`) are harmless — both bind the same root.
- **Contract fidelity**: all of `MergeRequest/MergeStage/MergeProgressEvent/MergeResult`, `IPC.MERGE_RUN/MERGE_PROGRESS`, and `MangoApi.merge` are consumed exactly as defined in `src/shared/`; nothing in the shared layer is edited. Preload only flips `merge.run`; `merge.onProgress` was already `subscribe()`-wired.
- **Sidebar unification keeps `WorktreeItem` untouched** — only `WorktreeList`'s props collapse from three (agentStatuses/serverState/serverWorktreeId) to one (`statuses`). The agent dot + server dot rendering is byte-for-byte the same, lowering regression risk.
- **Renderer verification matches Plans 0–3**: no committed e2e; jsdom tests cover the only pure renderer logic (`aggregateStatus`); the rest is gated by typecheck+lint+build plus the documented `MANGO_VERIFY_CMD` smoke (pass/fail/conflict paths all reproducible without a real test suite).