# V2 — Merge Conflict Resolution UI

**Goal:** When `MergeRunner.run()` hits a *true* merge conflict, stop aborting: pause the merge in progress (leave `MERGE_HEAD`), surface the conflicted files in a contextual Monaco pane, and let the user resolve them per-file (use ours / use theirs / manual edit) and then either **Continue merge** (creates the merge commit, only on explicit click) or **Abort merge** (`git merge --abort`). State is always recomputed from `MERGE_HEAD` + `git.status()` so it survives `SETTINGS_SET` cache-clears and app restart.

**Architecture:** Branch by Abstraction on the existing merge state machine. The unconditional abort in the `merge-runner.ts` catch (`102-114`, inside the `try/catch` at `99-114`) becomes a **two-way fork**: a non-conflict throw keeps the existing `git merge --abort` + `fail()` verbatim; a true conflict (confirmed via `git.status().conflicted` non-empty, NOT `/conflict/i`) takes a NEW pause-and-report branch that returns `status:'conflict'` + `conflicted[]`. A new stateless `ConflictResolver` class (bound to the primary `repoRoot` SimpleGit) performs all resolution git plumbing; truth is recomputed from `MERGE_HEAD`/`git.status()` per call (no durable in-memory merge state). It lives on its OWN `IpcContext` slot and is exempt from the `SETTINGS_SET` null-out while `inProgress()`. The renderer gets a lazy `ConflictView` (single editable `monaco.editor.create`, plaintext, over the working-tree file with raw `<<<<<<< ======= >>>>>>>` markers) mounted as a contextual pane that only appears while a merge is in progress for the selected worktree. All new IPC is additive (reuse `MERGE_PROGRESS` for a new `conflict` `MergeStage` + a `status` discriminant on `MergeResult`; add `merge:conflicts`/`merge:read-conflict`/`merge:resolve`/`merge:continue`/`merge:abort` invoke channels).

**Tech Stack:** Electron + React + TypeScript; `simple-git@3.36.0`; `monaco-editor@0.55.1` (NO merge editor exists — do not attempt one; plaintext single editor, `editor.worker` only, stays in the existing ~7 MB lazy chunk); `vitest` for main-process temp-repo tests; `electron-vite`. TypeScript follows the Google TS style already in the repo (2-space indent, single quotes, semicolons, `interface` over `type`, explicit return types, no `any`).

**REQUIRED SUB-SKILL: superpowers:subagent-driven-development** — execute each task below as an independent, TDD-driven subagent unit. Each task is self-contained: it lists exact files (Create/Modify with line anchors), a failing test first, the expected failing output, the minimal implementation with COMPLETE code, the passing run with expected output, and a commit message. Do not batch tasks; complete and commit one before starting the next.

---

## Locked design decisions (do NOT re-litigate)

1. **Migration = Branch by Abstraction.** The `run()` catch (`merge-runner.ts:102-114`) forks: non-conflict throw keeps `git merge --abort` + `fail()` verbatim (preserve a clean-tree test); a true conflict (`git.status().conflicted` non-empty) takes a NEW pause-and-report branch that leaves `MERGE_HEAD` and returns `status:'conflict'` + `conflicted[]`.
2. **Resolution UX** = a single editable `monaco.editor.create` (`readOnly:false`, `plaintext`) over the working-tree file WITH raw markers, plus per-file **Use ours (main/target)**, **Use theirs (feature)**, **Mark resolved (manual)**, a global **Continue merge** (enabled only when zero conflicts remain) and an always-available **Abort merge**. monaco 0.55.1 has NO merge editor.
3. **State** = a NEW `ConflictResolver` class bound to the primary `repoRoot` SimpleGit; truth ALWAYS recomputed from `MERGE_HEAD` + `git.status()` per call. Own `IpcContext` slot; NOT nulled on `SETTINGS_SET` while `inProgress()`.
4. **Plumbing** (simple-git 3.36.0): list = `git.status().conflicted`; read 3 versions = `git show :1:path` (base) / `:2:path` (ours=target/main) / `:3:path` (theirs=feature) reusing an extended `showOrEmpty` (also swallow `/not at stage \d|does not exist/`); acceptOurs/Theirs = `git checkout --ours|--theirs -- <path>` then `git add <path>`; manual = write file + `git add`; continue = guard `status().conflicted` empty THEN `git commit --no-edit` (NEVER `merge --continue`); abort = `git merge --abort`; inProgress = `git rev-parse --verify MERGE_HEAD` (NO `-q` — with `-q`, simple-git suppresses stderr and resolves instead of throwing, so it would never report "absent").
5. **IPC** = reuse `MERGE_PROGRESS` for a new `conflict` `MergeStage` (detection, no new emitter) + a `status` discriminant on `MergeResult`; add invoke channels `merge:conflicts`, `merge:read-conflict`, `merge:resolve`, `merge:continue`, `merge:abort`. Wire all 4 layers.
6. **Safety** = `continue()` is the ONLY path that creates the merge commit, runs ONLY on explicit user click; `run()` NEVER auto-continues. Cleanup (worktree remove THEN `git branch -d`, order load-bearing, non-fatal) is extracted into a shared helper and runs ONLY after a completed merge OR a user-confirmed `continue()` whose post-state shows zero conflicts and no `MERGE_HEAD`. A second `MERGE_RUN` while `MERGE_HEAD` exists early-returns `status:'conflict'`.
7. **Robustness (MVP)** = on app start / worktree (re)select, if `inProgress()`, surface the conflict pane (resume/abort). modify/delete + add/add + rename conflicts lack some index stages: detect porcelain DU/UD/DD/AU/UA/AA, DISABLE ours/theirs content buttons when a stage is absent, offer manual-edit + keep-file (`git add`) / remove-file (`git rm`).
8. **UI mount** = contextual pane shown ONLY while a merge-in-progress exists for the selected worktree (via `inProgress()`); normal Terminal|Diff UX unchanged otherwise. The conflict editor disposes model + editor + content/command disposables on unmount and on file switch, stays in the lazy chunk, keeps plaintext.

---

## File Structure

```
src/
  shared/
    types.ts                          (MODIFY)  + 'conflict' stage, ConflictedFile, ConflictFileVersions, MergeResult.status/conflicted, request payloads
    ipc-channels.ts                   (MODIFY)  + MERGE_CONFLICTS/READ_CONFLICT/RESOLVE/CONTINUE/ABORT
    ipc-contract.ts                   (MODIFY)  + merge.conflicts/readConflict/resolve/continue/abort + new MergeResult shape
  main/
    git/
      merge-runner.ts                 (MODIFY)  two-way fork in catch + extracted cleanupWorktree helper + inProgress early-return
      conflict-resolver.ts            (CREATE)  stateless resolver class
    ipc/
      ipc-context.ts                  (MODIFY)  + conflictResolver slot
      register-ipc.ts                 (MODIFY)  getConflictResolver factory + 5 handlers + MERGE_RUN inProgress guard + SETTINGS_SET exemption
  preload/
    index.ts                          (MODIFY)  + merge.conflicts/readConflict/resolve/continue/abort bindings
  renderer/
    hooks/
      use-conflicts.ts                (CREATE)  conflict-state hook
    components/
      diff/
        conflict-view.tsx             (CREATE)  lazy editable monaco pane
      toolbar/
        merge-controls.tsx            (MODIFY)  surface 'conflict' state on the stage line
    App.tsx                           (MODIFY)  contextual conflict pane + onMerge conflict branch + restart resume
tests/
  main/
    merge-runner.test.ts              (MODIFY)  split the conflict test (non-conflict abort vs conflict pause)
    conflict-resolver.test.ts         (CREATE)  temp-repo tests (UU + modify/delete missing-stage)
docs/
  V2-BACKLOG.md                       (CREATE/APPEND)  deferred 3-way editor, syntax highlighting, etc.
```

---

## Task 1 — Shared types, channels, contract (additive)

Pure type/string additions shared by main + renderer. No behavior yet; `tsc` is the test.

**Files**

- Modify `src/shared/types.ts` — append after `MergeResult` (line 165-171) and after the `MergeStage` union (line 156).
- Modify `src/shared/ipc-channels.ts` — extend the `// merge + cleanup (MVP item 5)` block (lines 31-33).
- Modify `src/shared/ipc-contract.ts` — extend the `merge:` slice (lines 65-68), import the new types (lines 17-19 area).

**Step 1.1 — write the failing check.** There is no unit test for pure types; the failing signal is `tsc`. First add the contract usage that references not-yet-existing types so the typecheck fails.

In `src/shared/ipc-contract.ts`, replace the `merge` block (lines 65-68):

```ts
  merge: {
    run(req: MergeRequest): Promise<MergeResult>;
    onProgress(cb: (e: MergeProgressEvent) => void): Unsubscribe;
    /** Conflicted paths for the in-progress merge in the primary tree (empty if none). */
    conflicts(req: ConflictListRequest): Promise<ConflictedFile[]>;
    /** Base/ours/theirs/working contents + missing-stage flags for one conflicted file. */
    readConflict(req: ConflictReadRequest): Promise<ConflictFileVersions>;
    /** Resolve one file: 'ours' | 'theirs' | 'manual' (content) | 'keep' | 'remove'. */
    resolve(req: ConflictResolveRequest): Promise<MergeResult>;
    /** Create the merge commit (rejected unless zero conflicts remain). User-driven only. */
    continue(req: ConflictContinueRequest): Promise<MergeResult>;
    /** `git merge --abort`: restore the target branch, drop MERGE_HEAD. */
    abort(req: ConflictAbortRequest): Promise<MergeResult>;
  };
```

And extend the type import list (lines 17-26) to add the new names:

```ts
  MergeRequest,
  MergeResult,
  MergeProgressEvent,
  ConflictedFile,
  ConflictFileVersions,
  ConflictListRequest,
  ConflictReadRequest,
  ConflictResolveRequest,
  ConflictContinueRequest,
  ConflictAbortRequest,
  QuitWarningEvent,
```

**Run it (fails):**

```
npm run typecheck
```

Expected output (the new names don't exist yet):

```
src/shared/ipc-contract.ts: error TS2304: Cannot find name 'ConflictListRequest'.
src/shared/ipc-contract.ts: error TS2304: Cannot find name 'ConflictedFile'.
... (TS2304 for each new type)
```

**Step 1.2 — minimal implementation.** In `src/shared/types.ts`:

Replace the `MergeStage` line (156):

```ts
export type MergeStage = 'verify' | 'merge' | 'conflict' | 'cleanup' | 'done';
```

Replace the `MergeResult` interface (165-171):

```ts
/**
 * Outcome of a merge attempt. `status` discriminates the paused-conflict case.
 * NOTE: `status` is a REQUIRED field — this is a deliberate required-field WIDENING
 * of MergeResult, not a backward-optional addition. It is safe because every
 * producer is updated in the same change (run/fail/continue/abort all set it in
 * Tasks 2-3) and the existing merge-runner tests assert via field access /
 * toMatchObject (never a whole-object .toEqual), so no existing assertion regresses.
 */
export interface MergeResult {
  readonly worktreeId: string;
  readonly merged: boolean;
  readonly cleanedUp: boolean;
  /**
   * 'merged'  — merge commit created (merged === true).
   * 'conflict'— merge is PAUSED in the primary tree (MERGE_HEAD present); resolve then continue/abort.
   * 'failed'  — non-conflict failure; tree was auto-aborted to a clean state (merged === false).
   */
  readonly status: 'merged' | 'conflict' | 'failed';
  /** Conflicted paths, present when status === 'conflict'. */
  readonly conflicted?: readonly string[];
  /** Present when status === 'failed'. */
  readonly error?: string;
}

/** Which index stages a conflicted path has (modify/delete & add/add lack some). */
export interface ConflictedFile {
  readonly path: string;
  /** Porcelain unmerged XY code: UU, AA, DU, UD, DD, AU, UA. */
  readonly code: string;
  /** Stage :2 (ours/target) present — false for an add/add-missing or theirs-only case. */
  readonly hasOurs: boolean;
  /** Stage :3 (theirs/feature) present. */
  readonly hasTheirs: boolean;
}

/** The four blob views for one conflicted file (absent stages return ''). */
export interface ConflictFileVersions {
  readonly path: string;
  readonly code: string;
  /** Stage :1 — common ancestor; '' if absent (e.g. add/add). */
  readonly base: string;
  /** Stage :2 — OURS = the TARGET branch (e.g. main); '' if absent (e.g. ours deleted). */
  readonly ours: string;
  /** Stage :3 — THEIRS = the FEATURE branch; '' if absent (e.g. theirs deleted). */
  readonly theirs: string;
  /** The working-tree file with git's raw <<<<<<< ======= >>>>>>> markers. */
  readonly working: string;
  readonly hasOurs: boolean;
  readonly hasTheirs: boolean;
}

export interface ConflictListRequest {
  readonly worktreeId: string;
}

export interface ConflictReadRequest {
  readonly worktreeId: string;
  readonly path: string;
}

export interface ConflictResolveRequest {
  readonly worktreeId: string;
  readonly path: string;
  /**
   * 'ours'   — checkout --ours + add (target/main version).
   * 'theirs' — checkout --theirs + add (feature version).
   * 'manual' — write `content` + add.
   * 'keep'   — git add the working file as-is (modify/delete: keep the file).
   * 'remove' — git rm the path (modify/delete: drop the file).
   */
  readonly choice: 'ours' | 'theirs' | 'manual' | 'keep' | 'remove';
  /** Required when choice === 'manual'. */
  readonly content?: string;
  /** Target branch (so the resolver can run cleanup with the right feature branch). */
  readonly targetBranch: string;
}

export interface ConflictContinueRequest {
  readonly worktreeId: string;
  readonly targetBranch: string;
  /** Remove the worktree + delete the feature branch after the commit (mirrors MergeRequest). */
  readonly cleanup: boolean;
}

export interface ConflictAbortRequest {
  readonly worktreeId: string;
}
```

In `src/shared/ipc-channels.ts`, replace the merge block (31-33):

```ts
  // merge + cleanup (MVP item 5) + conflict resolution (V2)
  MERGE_RUN: 'merge:run', // invoke
  MERGE_PROGRESS: 'merge:progress', // main -> renderer, event (now also the 'conflict' stage)
  MERGE_CONFLICTS: 'merge:conflicts', // invoke (worktreeId -> ConflictedFile[])
  MERGE_READ_CONFLICT: 'merge:read-conflict', // invoke (worktreeId, path -> ConflictFileVersions)
  MERGE_RESOLVE: 'merge:resolve', // invoke (resolve one file -> MergeResult)
  MERGE_CONTINUE: 'merge:continue', // invoke (commit --no-edit + optional cleanup -> MergeResult)
  MERGE_ABORT: 'merge:abort', // invoke (merge --abort -> MergeResult)
```

**Run it (passes):**

```
npm run typecheck
```

Expected output:

```
> tsc -p tsconfig.node.json --noEmit
> tsc -p tsconfig.web.json --noEmit
```

(no errors, exit 0)

**Commit:** `feat(merge): add conflict types, channels, contract surface`

---

## Task 2 — ConflictResolver class (TDD, temp-repo)

The stateless resolver. All git plumbing for resolution. Tested in isolation on a temp repo (no Electron, no IPC).

**Files**

- Create `src/main/git/conflict-resolver.ts`.
- Create `tests/main/conflict-resolver.test.ts`.

**Step 2.1 — write the failing test** (`tests/main/conflict-resolver.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import { ConflictResolver } from '../../src/main/git/conflict-resolver';
import { WorktreeManager } from '../../src/main/managers/worktree-manager';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

/** Seeds a content conflict (UU) on base.txt: feature edits one way, main another. */
async function seedContentConflict(repo: TempGitRepo, git: SimpleGit): Promise<string> {
  writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
  await repo.git.add('base.txt');
  await repo.git.commit('base');
  const path = join(realpathSync(repo.dir), '.worktrees', 'cflt');
  await repo.git.raw(['worktree', 'add', path, '-b', 'feature/cflt', 'main']);
  const fg = simpleGit(path);
  writeFileSync(join(path, 'base.txt'), 'feature-version\n');
  await fg.add('base.txt');
  await fg.commit('feat edit');
  writeFileSync(join(repo.dir, 'base.txt'), 'main-version\n');
  await repo.git.add('base.txt');
  await repo.git.commit('main edit');
  await git.checkout('main');
  // Start the merge so MERGE_HEAD exists + base.txt is conflicted.
  await git.merge(['--no-edit', 'feature/cflt']).catch(() => undefined);
  return path;
}

/** Seeds a modify/delete conflict (DU): main deletes file.txt, feature modifies it. */
async function seedModifyDelete(repo: TempGitRepo, git: SimpleGit): Promise<string> {
  writeFileSync(join(repo.dir, 'file.txt'), 'one\n');
  await repo.git.add('file.txt');
  await repo.git.commit('add file');
  const path = join(realpathSync(repo.dir), '.worktrees', 'md');
  await repo.git.raw(['worktree', 'add', path, '-b', 'feature/md', 'main']);
  const fg = simpleGit(path);
  writeFileSync(join(path, 'file.txt'), 'one\ntwo\n'); // feature modifies
  await fg.add('file.txt');
  await fg.commit('feat modify');
  await repo.git.rm(['file.txt']); // main deletes
  await repo.git.commit('main delete');
  await git.checkout('main');
  await git.merge(['--no-edit', 'feature/md']).catch(() => undefined);
  return path;
}

describe('ConflictResolver', () => {
  let repo: TempGitRepo;
  let git: SimpleGit;
  let worktrees: WorktreeManager;
  let resolver: ConflictResolver;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    git = simpleGit(realpathSync(repo.dir));
    worktrees = new WorktreeManager(repo.git, repo.dir);
    resolver = new ConflictResolver({ git, worktrees });
  });

  afterEach(() => repo.cleanup());

  it('inProgress() reflects MERGE_HEAD', async () => {
    expect(await resolver.inProgress()).toBe(false);
    await seedContentConflict(repo, git);
    expect(await resolver.inProgress()).toBe(true);
  });

  it('list() returns the conflicted file with UU code and both stages', async () => {
    await seedContentConflict(repo, git);
    const files = await resolver.list();
    expect(files).toEqual([{ path: 'base.txt', code: 'UU', hasOurs: true, hasTheirs: true }]);
  });

  it('read() returns ours=target, theirs=feature, and the marker working text', async () => {
    await seedContentConflict(repo, git);
    const v = await resolver.read('base.txt');
    expect(v.ours).toBe('main-version\n');
    expect(v.theirs).toBe('feature-version\n');
    expect(v.working).toContain('<<<<<<<');
    expect(v.working).toContain('>>>>>>>');
    expect(v.hasOurs).toBe(true);
    expect(v.hasTheirs).toBe(true);
  });

  it('acceptOurs writes the target version + stages it (conflict cleared)', async () => {
    await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'ours' });
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('main-version\n');
    expect(await resolver.list()).toEqual([]);
  });

  it('acceptTheirs writes the feature version + stages it', async () => {
    await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'theirs' });
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('feature-version\n');
    expect(await resolver.list()).toEqual([]);
  });

  it('resolveManual writes the provided content + stages it', async () => {
    await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'manual', content: 'merged!\n' });
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('merged!\n');
    expect(await resolver.list()).toEqual([]);
  });

  it('continue() is rejected while a conflict remains and creates no commit', async () => {
    await seedContentConflict(repo, git);
    const before = (await repo.git.log()).total;
    const res = await resolver.continue({ worktreeId: '', targetBranch: 'main', cleanup: false });
    expect(res.status).toBe('conflict');
    expect((await repo.git.log()).total).toBe(before);
    expect(await resolver.inProgress()).toBe(true);
  });

  it('continue() creates exactly one merge commit when all resolved (tree clean, no MERGE_HEAD)', async () => {
    const wtPath = await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'ours' });
    const before = (await repo.git.log()).total;
    const res = await resolver.continue({
      worktreeId: wtPath,
      targetBranch: 'main',
      cleanup: false,
    });
    expect(res.merged).toBe(true);
    expect(res.status).toBe('merged');
    // continue() creates the merge commit (2 parents). That ALSO makes the feature
    // commit reachable from HEAD for the first time (it was only held by MERGE_HEAD
    // while paused), so log().total grows by 2 — the merge commit + the now-reachable
    // feature commit — not 1.
    expect((await repo.git.log()).total).toBe(before + 2);
    // Robust intent check: HEAD is a real merge commit (sha + 2 parents = 3 tokens).
    const parents = (await repo.git.raw(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/);
    expect(parents.length).toBe(3);
    expect(await resolver.inProgress()).toBe(false);
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
  });

  it('continue(cleanup) removes the worktree THEN deletes the feature branch', async () => {
    const wtPath = await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'ours' });
    const res = await resolver.continue({
      worktreeId: wtPath,
      targetBranch: 'main',
      cleanup: true,
    });
    expect(res).toMatchObject({ merged: true, cleanedUp: true });
    const branches = await repo.git.branchLocal();
    expect(branches.all).not.toContain('feature/cflt');
  });

  it('abort() drops MERGE_HEAD and restores the target version', async () => {
    await seedContentConflict(repo, git);
    const res = await resolver.abort({ worktreeId: '' });
    expect(res.status).toBe('failed');
    expect(await resolver.inProgress()).toBe(false);
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('main-version\n');
  });

  it('list() flags a modify/delete (DU) as missing the deleted stage', async () => {
    await seedModifyDelete(repo, git);
    const files = await resolver.list();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('file.txt');
    // main deleted (stage 2 absent), feature modified (stage 3 present).
    expect(files[0].hasOurs).toBe(false);
    expect(files[0].hasTheirs).toBe(true);
  });

  it('read() of a modify/delete returns ours="" without throwing', async () => {
    await seedModifyDelete(repo, git);
    const v = await resolver.read('file.txt');
    expect(v.ours).toBe('');
    expect(v.theirs).toBe('one\ntwo\n');
    expect(v.hasOurs).toBe(false);
  });

  it("resolve 'keep' stages the working file and clears the conflict (modify/delete)", async () => {
    await seedModifyDelete(repo, git);
    await resolver.resolve({ path: 'file.txt', choice: 'keep' });
    expect(await resolver.list()).toEqual([]);
    expect(existsSync(join(repo.dir, 'file.txt'))).toBe(true);
  });

  it("resolve 'remove' git-rm's the path and clears the conflict (modify/delete)", async () => {
    await seedModifyDelete(repo, git);
    await resolver.resolve({ path: 'file.txt', choice: 'remove' });
    expect(await resolver.list()).toEqual([]);
    expect(existsSync(join(repo.dir, 'file.txt'))).toBe(false);
  });
});
```

**Run it (fails):**

```
npx vitest run tests/main/conflict-resolver.test.ts
```

Expected output:

```
Error: Failed to resolve import "../../src/main/git/conflict-resolver" ...
 FAIL  tests/main/conflict-resolver.test.ts [ ... ]
```

**Step 2.2 — minimal implementation** (`src/main/git/conflict-resolver.ts`). COMPLETE code:

```ts
import type { SimpleGit } from 'simple-git';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConflictedFile,
  ConflictFileVersions,
  ConflictResolveRequest,
  ConflictContinueRequest,
  ConflictAbortRequest,
  MergeResult,
} from '../../shared/types';
import type { WorktreeManager } from '../managers/worktree-manager';

/** Constructor dependencies — injectable so the resolver is unit-testable on a temp repo. */
export interface ConflictResolverDeps {
  /** SimpleGit bound to the PRIMARY repo root (where MERGE_HEAD + the conflict live). */
  readonly git: SimpleGit;
  /** Used only by continue(cleanup) to remove the merged worktree (remove BEFORE branch -d). */
  readonly worktrees: WorktreeManager;
}

/**
 * Resolves an in-progress merge conflict in the PRIMARY tree. STATELESS: every call
 * recomputes truth from MERGE_HEAD + git.status(), so it survives the SETTINGS_SET
 * cache-clear and even an app restart. NEVER auto-continues — continue() is the only
 * path that creates the merge commit and runs only on explicit user action.
 */
export class ConflictResolver {
  private readonly git: SimpleGit;
  private readonly worktrees: WorktreeManager;

  constructor(deps: ConflictResolverDeps) {
    this.git = deps.git;
    this.worktrees = deps.worktrees;
  }

  /** True while a merge is paused (`.git/MERGE_HEAD` present). */
  async inProgress(): Promise<boolean> {
    try {
      // NB: do NOT pass `-q`. With `-q`, git still exits non-zero when MERGE_HEAD
      // is absent but SUPPRESSES stderr, and simple-git only rejects a raw task
      // when stderr is non-empty — so `-q` would RESOLVE with '' and inProgress()
      // would be true in every state. Without `-q`, rev-parse writes
      // "fatal: Needed a single revision" to stderr -> simple-git rejects -> catch.
      await this.git.raw(['rev-parse', '--verify', 'MERGE_HEAD']);
      return true;
    } catch {
      return false; // MERGE_HEAD absent -> rev-parse throws -> not in progress.
    }
  }

  /** Conflicted paths with porcelain code + which index stages are present. */
  async list(): Promise<ConflictedFile[]> {
    const status = await this.git.status();
    const paths = status.conflicted;
    if (paths.length === 0) return [];
    // `git ls-files -u` lists one row per present stage: "<mode> <sha> <stage>\t<path>".
    const lsOut = await this.git.raw(['ls-files', '-u']);
    const stagesByPath = new Map<string, Set<number>>();
    for (const line of lsOut.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const stage = Number(meta[meta.length - 1]);
      const p = line.slice(tab + 1);
      const set = stagesByPath.get(p) ?? new Set<number>();
      set.add(stage);
      stagesByPath.set(p, set);
    }
    return paths.map((path) => {
      const stages = stagesByPath.get(path) ?? new Set<number>();
      const hasBase = stages.has(1);
      const hasOurs = stages.has(2);
      const hasTheirs = stages.has(3);
      return { path, code: codeFor(hasBase, hasOurs, hasTheirs), hasOurs, hasTheirs };
    });
  }

  /** base/:1, ours/:2 (target), theirs/:3 (feature) blobs + the working-tree marker text. */
  async read(path: string): Promise<ConflictFileVersions> {
    this.assertSafeRef(path);
    const files = await this.list();
    const entry = files.find((f) => f.path === path);
    const hasOurs = entry?.hasOurs ?? false;
    const hasTheirs = entry?.hasTheirs ?? false;
    const base = await this.showOrEmpty(`:1:${path}`);
    const ours = await this.showOrEmpty(`:2:${path}`);
    const theirs = await this.showOrEmpty(`:3:${path}`);
    // Working-tree text (with the raw <<<<<<< ======= >>>>>>> markers) lives ONLY on
    // disk — a conflicted file has no stage-0 index entry, so `git show :0:path`
    // would always error. Read it straight from the file.
    const working = await this.readWorking(path);
    return {
      path,
      code: entry?.code ?? 'UU',
      base,
      ours,
      theirs,
      working,
      hasOurs,
      hasTheirs,
    };
  }

  /** Resolve ONE file. Never creates a commit. */
  async resolve(req: Pick<ConflictResolveRequest, 'path' | 'choice' | 'content'>): Promise<void> {
    this.assertSafeRef(req.path);
    switch (req.choice) {
      case 'ours':
        await this.git.raw(['checkout', '--ours', '--', req.path]);
        await this.git.add(req.path);
        break;
      case 'theirs':
        await this.git.raw(['checkout', '--theirs', '--', req.path]);
        await this.git.add(req.path);
        break;
      case 'manual':
        writeFileSync(join(await this.repoRoot(), req.path), req.content ?? '');
        await this.git.add(req.path);
        break;
      case 'keep':
        await this.git.add(req.path);
        break;
      case 'remove':
        await this.git.raw(['rm', '-f', '--', req.path]);
        break;
      default: {
        const never: never = req.choice;
        throw new Error(`unknown resolve choice: ${String(never)}`);
      }
    }
  }

  /**
   * Create the merge commit. REJECTED (no commit) while any conflict remains.
   * Uses `git commit --no-edit` (the prepared MERGE_MSG) — NEVER `merge --continue`,
   * which opens an interactive editor and hangs. cleanup (worktree remove THEN
   * branch -d) is non-fatal and runs only after the commit succeeds + no MERGE_HEAD.
   */
  async continue(req: ConflictContinueRequest): Promise<MergeResult> {
    const remaining = await this.list();
    if (remaining.length > 0) {
      return {
        worktreeId: req.worktreeId,
        merged: false,
        cleanedUp: false,
        status: 'conflict',
        conflicted: remaining.map((f) => f.path),
      };
    }
    if (!(await this.inProgress())) {
      return {
        worktreeId: req.worktreeId,
        merged: false,
        cleanedUp: false,
        status: 'failed',
        error: 'no merge in progress',
      };
    }
    await this.git.raw(['commit', '--no-edit']);

    let cleanedUp = false;
    if (req.cleanup) {
      const feature = await this.featureBranch(req.worktreeId);
      try {
        // Order matters: remove the worktree FIRST, then delete the branch —
        // `git branch -d` refuses a branch still held by a worktree.
        await this.worktrees.remove({ worktreeId: req.worktreeId });
        if (feature && feature !== req.targetBranch) await this.git.branch(['-d', feature]);
        cleanedUp = true;
      } catch {
        cleanedUp = false; // non-fatal: the merge commit already exists.
      }
    }
    return { worktreeId: req.worktreeId, merged: true, cleanedUp, status: 'merged' };
  }

  /** `git merge --abort`: restore the target branch, drop MERGE_HEAD. */
  async abort(req: ConflictAbortRequest): Promise<MergeResult> {
    await this.git.raw(['merge', '--abort']);
    return {
      worktreeId: req.worktreeId,
      merged: false,
      cleanedUp: false,
      status: 'failed',
      error: 'merge aborted',
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Absolute path of the primary repo's working tree. */
  private async repoRoot(): Promise<string> {
    return (await this.git.raw(['rev-parse', '--show-toplevel'])).trim();
  }

  /** Reads the working-tree file (with conflict markers); '' if it was removed. */
  private async readWorking(path: string): Promise<string> {
    try {
      const { readFileSync } = await import('node:fs');
      return readFileSync(join(await this.repoRoot(), path), 'utf8');
    } catch {
      return '';
    }
  }

  /** Maps worktreeId -> feature branch via the worktree listing (for cleanup). */
  private async featureBranch(worktreeId: string): Promise<string | undefined> {
    const trees = await this.worktrees.list();
    return trees.find((t) => t.id === worktreeId)?.branch;
  }

  /**
   * `git show <spec>`; returns '' when the path is absent at that ref OR the index
   * stage does not exist (modify/delete & add/add lack some of :1/:2/:3).
   */
  private async showOrEmpty(spec: string): Promise<string> {
    try {
      return await this.git.show([spec]);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/does not exist|exists on disk, but not in|no such path|not at stage \d/i.test(raw)) {
        return '';
      }
      throw error;
    }
  }

  /** Reject a path git could misparse as an OPTION (leading '-'). */
  private assertSafeRef(path: string): void {
    if (path.startsWith('-')) throw new Error(`invalid path: ${path}`);
  }
}

/** Derives a porcelain-ish XY code from which stages are present. */
function codeFor(hasBase: boolean, hasOurs: boolean, hasTheirs: boolean): string {
  if (hasOurs && hasTheirs) return hasBase ? 'UU' : 'AA';
  if (hasTheirs && !hasOurs) return 'DU'; // ours deleted, theirs modified
  if (hasOurs && !hasTheirs) return 'UD'; // theirs deleted, ours modified
  return 'DD';
}
```

**Run it (passes):**

```
npx vitest run tests/main/conflict-resolver.test.ts
```

Expected output:

```
 ✓ tests/main/conflict-resolver.test.ts (14 tests)
Test Files  1 passed (1)
     Tests  14 passed (14)
```

**Commit:** `feat(merge): add stateless ConflictResolver (git plumbing + temp-repo tests)`

---

## Task 3 — MergeRunner two-way fork + shared cleanup helper (split the conflict test)

The Branch-by-Abstraction migration. The catch forks; cleanup is extracted; a second run while `MERGE_HEAD` exists early-returns. The existing conflict test is SPLIT.

**Files**

- Modify `src/main/git/merge-runner.ts` — the catch (102-114, inside the try/catch 99-114), the cleanup block (117-133), and `fail()`/`run()` return shapes (135-162). Add an injected `inProgress` check at the top of `run()`.
- Modify `tests/main/merge-runner.test.ts` — split the conflict test (140-170); update `MergeResult` shape expectations.

**Step 3.1 — write the failing/updated tests** in `tests/main/merge-runner.test.ts`.

Replace the single conflict test (lines 140-170) with TWO tests:

```ts
  it('PAUSES on a real conflict: leaves MERGE_HEAD + conflicted files, returns status conflict', async () => {
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

    const result = await mr.run({
      worktreeId: path,
      targetBranch: 'main',
      runVerifyHook: false,
      cleanup: true,
    });

    expect(result.merged).toBe(false);
    expect(result.status).toBe('conflict');
    expect(result.conflicted).toContain('base.txt');
    expect(result.cleanedUp).toBe(false); // cleanup must NOT run while a merge is in progress
    expect(events.find((e) => e.stage === 'conflict')).toMatchObject({ stage: 'conflict' });
    expect(events.some((e) => e.stage === 'cleanup')).toBe(false);
    // merge is LEFT in progress
    const inProgress = await repo.git
      .raw(['rev-parse', '--verify', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);
    expect(inProgress).toBe(true);
    const st = await repo.git.status();
    expect(st.conflicted).toContain('base.txt');
  });

  it('AUTO-ABORTS a non-conflict merge failure, leaving the tree clean (status failed)', async () => {
    const feat = await addFeature(repo, 'feature/badref');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });

    // A non-existent target branch makes checkout throw — a NON-conflict failure.
    const result = await mr.run({
      worktreeId: feat.id,
      targetBranch: 'no-such-branch',
      runVerifyHook: false,
      cleanup: false,
    });

    expect(result.merged).toBe(false);
    expect(result.status).toBe('failed');
    expect(events.find((e) => e.stage === 'merge')).toMatchObject({ ok: false });
    // tree is clean (auto-abort restored it) — no merge-in-progress markers
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
    expect(st.modified).toEqual([]);
    const inProgress = await repo.git
      .raw(['rev-parse', '--verify', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);
    expect(inProgress).toBe(false);
  });

  it('re-surfaces an existing in-progress merge instead of tripping the dirty-tree gate', async () => {
    const path = join(realpathSync(repo.dir), '.worktrees', 'cflt2');
    await repo.git.raw(['worktree', 'add', path, '-b', 'feature/cflt2', 'main']);
    const fg = simpleGit(path);
    writeFileSync(join(path, 'base.txt'), 'feature2\n');
    await fg.add('base.txt');
    await fg.commit('feat edit');
    writeFileSync(join(repo.dir, 'base.txt'), 'main2\n');
    await repo.git.add('base.txt');
    await repo.git.commit('main edit');

    const { runner } = makeVerifyRunner(0);
    const { emitter } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });

    await mr.run({ worktreeId: path, targetBranch: 'main', runVerifyHook: false, cleanup: false });
    // A SECOND run while MERGE_HEAD exists must re-surface, not error on uncommitted changes.
    const second = await mr.run({
      worktreeId: path,
      targetBranch: 'main',
      runVerifyHook: false,
      cleanup: false,
    });
    expect(second.status).toBe('conflict');
    expect(second.conflicted).toContain('base.txt');
  });
```

Also update the existing successful-merge expectations to assert the new `status` field. In the `'merges the feature branch...'` test (the `it()` block at line 114) add after `expect(result.merged).toBe(true);` (line 133):

```ts
    expect(result.status).toBe('merged');
```

In `'cleans up ... after a successful merge'` (line 201) the `toMatchObject({ merged: true, cleanedUp: true })` already passes (status is additive); no change needed.

**Run it (fails):**

```
npx vitest run tests/main/merge-runner.test.ts
```

Expected output (run() doesn't pause/early-return yet; `status` is undefined):

```
 FAIL  tests/main/merge-runner.test.ts > MergeRunner > PAUSES on a real conflict ...
   expected undefined to be 'conflict'
 FAIL  tests/main/merge-runner.test.ts > MergeRunner > re-surfaces an existing in-progress merge ...
   expected 'failed'/undefined ... 'conflict'
```

**Step 3.2 — implementation.** In `src/main/git/merge-runner.ts`:

Replace the dirty-tree gate + merge + catch + cleanup region (lines 80-143). The new region, COMPLETE:

```ts
    // ── re-surface an in-progress merge ───────────────────────────────────────
    // If MERGE_HEAD already exists (a prior run paused on a conflict, possibly
    // across an app restart), do NOT re-run from the top (the conflicted tree would
    // trip the dirty-tree gate with a confusing 'uncommitted changes'). Re-report it.
    if (await this.inProgress()) {
      const conflicted = (await this.git.status()).conflicted;
      this.emit(worktreeId, 'conflict', false, `resume merge: ${conflicted.length} conflict(s)`);
      return { worktreeId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
    }

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
      return this.fail(
        worktreeId,
        'merge',
        'primary worktree has uncommitted changes; commit or stash first',
      );
    }

    try {
      await this.git.checkout(targetBranch);
      await this.git.merge(['--no-edit', featureBranch]);
    } catch (error) {
      // Branch by Abstraction: a TRUE conflict (confirmed via status().conflicted,
      // NOT the brittle /conflict/i message) PAUSES the merge in progress for the
      // resolution UI. Any other throw keeps the original safe-abort path verbatim.
      const conflicted = (await this.git.status()).conflicted;
      if (conflicted.length > 0) {
        this.emit(
          worktreeId,
          'conflict',
          false,
          `merge conflict: ${conflicted.length} file(s) need resolution`,
        );
        return { worktreeId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
      }
      // Non-conflict failure: abort so the repo is never left mid-merge.
      try {
        await this.git.raw(['merge', '--abort']);
      } catch {
        // best-effort; if there was nothing to abort git errors — ignore.
      }
      const raw = error instanceof Error ? error.message : String(error);
      const msg = raw.replace(/^fatal:\s*/i, '').trim();
      return this.fail(worktreeId, 'merge', msg);
    }
    this.emit(worktreeId, 'merge', true, `merged ${featureBranch} into ${targetBranch}`);

    // ── cleanup (non-fatal: the merge already succeeded) ──────────────────────
    let cleanedUp = false;
    let cleanupFailed = false;
    if (req.cleanup) {
      const result = await this.cleanupWorktree(worktreeId, featureBranch);
      cleanedUp = result.cleanedUp;
      cleanupFailed = result.failed;
      this.emit(worktreeId, 'cleanup', !cleanupFailed, result.message);
    }

    // The final `done` must not mask a failed cleanup: a requested-but-failed
    // cleanup reports ok:false so the UI's stage line surfaces it (merged stands).
    const doneMessage = cleanedUp
      ? 'merged + cleaned up'
      : cleanupFailed
        ? 'merged, but cleanup failed'
        : 'merged';
    this.emit(worktreeId, 'done', !cleanupFailed, doneMessage);
    return { worktreeId, merged: true, cleanedUp, status: 'merged' };
  }

  /** True while a merge is paused in the primary tree (`.git/MERGE_HEAD` present). */
  private async inProgress(): Promise<boolean> {
    try {
      // No `-q` — see ConflictResolver.inProgress(): `-q` suppresses stderr so
      // simple-git resolves instead of throwing, making this always true.
      await this.git.raw(['rev-parse', '--verify', 'MERGE_HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Shared cleanup: remove the worktree FIRST, then delete the branch (order is
   * load-bearing — `git branch -d` refuses a branch still held by a worktree).
   * Non-fatal: returns the outcome so callers (happy-path merge AND a user-driven
   * post-resolution continue) can report ok:false without flipping merged:false.
   */
  async cleanupWorktree(
    worktreeId: string,
    featureBranch: string,
  ): Promise<{ cleanedUp: boolean; failed: boolean; message: string }> {
    try {
      await this.worktrees.remove({ worktreeId });
      await this.git.branch(['-d', featureBranch]);
      return { cleanedUp: true, failed: false, message: `removed ${featureBranch}` };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      return { cleanedUp: false, failed: true, message: `cleanup failed: ${raw}` };
    }
  }
```

Update `fail()` (158-162) to set the discriminant:

```ts
  /** Emits a failed stage and returns a non-merged MergeResult. */
  private fail(worktreeId: string, stage: MergeStage, error: string): MergeResult {
    this.emit(worktreeId, stage, false, error);
    return { worktreeId, merged: false, cleanedUp: false, status: 'failed', error };
  }
```

**Run it (passes):**

```
npx vitest run tests/main/merge-runner.test.ts
```

Expected output:

```
 ✓ tests/main/merge-runner.test.ts (9 tests)
Test Files  1 passed (1)
```

**Commit:** `feat(merge): fork run() into auto-abort vs pause-on-conflict + shared cleanup helper`

---

## Task 4 — IPC wiring (context slot, factory, handlers, MERGE_RUN guard, SETTINGS_SET exemption)

**Files**

- Modify `src/main/ipc/ipc-context.ts` — add the slot (after line 45).
- Modify `src/main/ipc/register-ipc.ts` — import `ConflictResolver` (line 26 area), `getConflictResolver` factory (after `getDiffViewer` at 290), 5 handlers (after `DIFF_FILE` at 391), MERGE_RUN inProgress guard (372-377), SETTINGS_SET exemption (411-412).

**Step 4.1 — write the failing test.** Extend `tests/main/conflict-resolver.test.ts` is unit-only; the IPC wiring is integration. Add a focused factory test inline in a new file `tests/main/register-conflict-ipc.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { ConflictResolver } from '../../src/main/git/conflict-resolver';

/** Minimal ipcMain double that records handlers by channel. */
function makeIpcMain() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, arg: unknown) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  } as unknown as Parameters<typeof registerIpc>[0];
  return { ipcMain, handlers };
}

describe('conflict IPC wiring', () => {
  it('routes the 5 conflict channels to the injected ConflictResolver', async () => {
    const resolver = {
      list: vi.fn().mockResolvedValue([{ path: 'a.txt', code: 'UU', hasOurs: true, hasTheirs: true }]),
      read: vi.fn().mockResolvedValue({ path: 'a.txt' }),
      resolve: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue({ worktreeId: 'w', merged: true, cleanedUp: false, status: 'merged' }),
      abort: vi.fn().mockResolvedValue({ worktreeId: 'w', merged: false, cleanedUp: false, status: 'failed' }),
      inProgress: vi.fn().mockResolvedValue(true),
    } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const files = await handlers.get(IPC.MERGE_CONFLICTS)!(null, { worktreeId: 'w' });
    expect(files).toEqual([{ path: 'a.txt', code: 'UU', hasOurs: true, hasTheirs: true }]);

    await handlers.get(IPC.MERGE_RESOLVE)!(null, {
      worktreeId: 'w',
      path: 'a.txt',
      choice: 'ours',
      targetBranch: 'main',
    });
    expect(resolver.resolve).toHaveBeenCalledWith({ path: 'a.txt', choice: 'ours', content: undefined });

    const cont = await handlers.get(IPC.MERGE_CONTINUE)!(null, {
      worktreeId: 'w',
      targetBranch: 'main',
      cleanup: false,
    });
    expect(cont).toMatchObject({ merged: true, status: 'merged' });

    const abort = await handlers.get(IPC.MERGE_ABORT)!(null, { worktreeId: 'w' });
    expect(abort).toMatchObject({ status: 'failed' });
  });

  it('SETTINGS_SET keeps the conflictResolver while a merge is in progress', async () => {
    const resolver = { inProgress: vi.fn().mockResolvedValue(true) } as unknown as ConflictResolver;
    const ctx = createIpcContext();
    ctx.conflictResolver = resolver;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    await handlers.get(IPC.SETTINGS_SET)!(null, { baseBranch: 'develop' });
    expect(ctx.conflictResolver).toBe(resolver); // NOT nulled while inProgress()
  });
});
```

**Run it (fails):**

```
npx vitest run tests/main/register-conflict-ipc.test.ts
```

Expected output:

```
 FAIL  tests/main/register-conflict-ipc.test.ts
   handlers.get(IPC.MERGE_CONFLICTS) is not a function (undefined)
   ... and TS: 'conflictResolver' does not exist on IpcContext
```

**Step 4.2 — implementation.** In `src/main/ipc/ipc-context.ts`, add after line 9 import:

```ts
import type { ConflictResolver } from '../git/conflict-resolver';
```

And add the slot after line 45 (`diffViewer?`):

```ts
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 merge conflict).
   * STATEFUL only in the sense that it owns the in-progress merge — it is NOT nulled
   * on SETTINGS_SET while inProgress() (it recomputes truth from MERGE_HEAD per call).
   */
  conflictResolver?: ConflictResolver;
```

In `src/main/ipc/register-ipc.ts`:

Add the import after line 26 (`import { DiffViewer }`):

```ts
import { ConflictResolver } from '../git/conflict-resolver';
```

Add the type imports (lines 17-24 area) inside the `from '../../shared/types'` block:

```ts
  ConflictedFile,
  ConflictFileVersions,
  ConflictListRequest,
  ConflictReadRequest,
  ConflictResolveRequest,
  ConflictContinueRequest,
  ConflictAbortRequest,
```

Add the factory after `getDiffViewer` (after line 290):

```ts
/**
 * Resolves the ConflictResolver: prefer ctx (tests inject); else build a real one
 * bound to the PRIMARY repoRoot (where MERGE_HEAD lives). Reuses the cached
 * WorktreeManager exactly like getMergeRunner. STATELESS — it recomputes truth from
 * MERGE_HEAD/git.status() per call — so it is safe to cache across settings changes.
 */
async function getConflictResolver(ctx: IpcContext): Promise<ConflictResolver> {
  if (ctx.conflictResolver) return ctx.conflictResolver;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  const worktrees = await getWorktreeManager(ctx);
  ctx.conflictResolver = new ConflictResolver({ git: simpleGit(repoRoot), worktrees });
  return ctx.conflictResolver;
}
```

Replace the `MERGE_RUN` handler (372-377) to add the in-progress guard:

```ts
  ipcMain.handle(
    IPC.MERGE_RUN,
    async (_event: unknown, req: MergeRequest): Promise<MergeResult> => {
      // Re-surface an in-progress merge instead of running run() from the top
      // (which would trip the dirty-tree gate on the conflicted target tree).
      const resolver = await getConflictResolver(ctx);
      if (await resolver.inProgress()) {
        const conflicted = (await resolver.list()).map((f) => f.path);
        return { worktreeId: req.worktreeId, merged: false, cleanedUp: false, status: 'conflict', conflicted };
      }
      return (await getMergeRunner(ctx)).run(req);
    },
  );
```

Add the 5 handlers after the `DIFF_FILE` handler (after line 391):

```ts
  ipcMain.handle(
    IPC.MERGE_CONFLICTS,
    async (_event: unknown, _req: ConflictListRequest): Promise<ConflictedFile[]> => {
      return (await getConflictResolver(ctx)).list();
    },
  );

  ipcMain.handle(
    IPC.MERGE_READ_CONFLICT,
    async (_event: unknown, req: ConflictReadRequest): Promise<ConflictFileVersions> => {
      return (await getConflictResolver(ctx)).read(req.path);
    },
  );

  ipcMain.handle(
    IPC.MERGE_RESOLVE,
    async (_event: unknown, req: ConflictResolveRequest): Promise<MergeResult> => {
      const resolver = await getConflictResolver(ctx);
      await resolver.resolve({ path: req.path, choice: req.choice, content: req.content });
      const conflicted = (await resolver.list()).map((f) => f.path);
      return {
        worktreeId: req.worktreeId,
        merged: false,
        cleanedUp: false,
        status: 'conflict',
        conflicted,
      };
    },
  );

  ipcMain.handle(
    IPC.MERGE_CONTINUE,
    async (_event: unknown, req: ConflictContinueRequest): Promise<MergeResult> => {
      return (await getConflictResolver(ctx)).continue(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_ABORT,
    async (_event: unknown, req: ConflictAbortRequest): Promise<MergeResult> => {
      return (await getConflictResolver(ctx)).abort(req);
    },
  );
```

In `SETTINGS_SET` (after line 412 `ctx.diffViewer = undefined;`), add the exemption:

```ts
      // The ConflictResolver owns the in-progress merge. It recomputes truth from
      // MERGE_HEAD/git.status() per call, so nulling it would only re-bind a fresh
      // SimpleGit — harmless — BUT while a merge is in progress we keep the same
      // instance to mirror the sessionManager 'keep-while-busy' discipline and to
      // guarantee the resolution capability is never dropped mid-conflict.
      if (!(await ctx.conflictResolver?.inProgress())) {
        ctx.conflictResolver = undefined; // idle: rebuilt on next conflict call
      }
```

> Note: the `SETTINGS_SET` handler is already `async`, so `await` here is valid.

**Run it (passes):**

```
npx vitest run tests/main/register-conflict-ipc.test.ts && npm run typecheck
```

Expected output:

```
 ✓ tests/main/register-conflict-ipc.test.ts (2 tests)
...
> tsc -p tsconfig.node.json --noEmit
> tsc -p tsconfig.web.json --noEmit
(no errors)
```

**Commit:** `feat(merge): wire conflict IPC handlers + getConflictResolver + SETTINGS_SET exemption`

---

## Task 5 — Preload bindings

**Files**

- Modify `src/preload/index.ts` — extend the `merge:` slice (lines 45-48).

**Step 5.1 — failing check.** The contract (Task 1) already declares the 5 methods, so the preload object no longer satisfies `MangoApi` until they're added. `tsc` is the test.

**Run it (fails):**

```
npm run typecheck
```

Expected output:

```
src/preload/index.ts: error TS2741: Property 'conflicts' is missing in type ... but required in type 'MangoApi["merge"]'.
```

**Step 5.2 — implementation.** Replace the `merge` block (45-48) in `src/preload/index.ts`:

```ts
  merge: {
    run: (req) => ipcRenderer.invoke(IPC.MERGE_RUN, req),
    onProgress: (cb) => subscribe(IPC.MERGE_PROGRESS, cb),
    conflicts: (req) => ipcRenderer.invoke(IPC.MERGE_CONFLICTS, req),
    readConflict: (req) => ipcRenderer.invoke(IPC.MERGE_READ_CONFLICT, req),
    resolve: (req) => ipcRenderer.invoke(IPC.MERGE_RESOLVE, req),
    continue: (req) => ipcRenderer.invoke(IPC.MERGE_CONTINUE, req),
    abort: (req) => ipcRenderer.invoke(IPC.MERGE_ABORT, req),
  },
```

**Run it (passes):**

```
npm run typecheck
```

Expected output: no errors, exit 0.

**Commit:** `feat(merge): expose conflict resolution methods over preload`

---

## Task 6 — use-conflicts hook (renderer state)

**Files**

- Create `src/renderer/hooks/use-conflicts.ts`.

**Step 6.1 — testing note (no RTL unit test).** `@testing-library/react` is NOT a dependency of this repo (verified against `package.json`), and `tests/renderer/` holds ONLY pure-function tests (`app-store`, `format-versions`, `log-filter`) — no hook is unit-tested with RTL. The existing `use-settings` / `use-diff` / `use-merge` hooks follow this precedent: they are covered by `npm run typecheck:web` (signatures) and the Playwright smoke. Do the SAME for `useConflicts` — do NOT add an RTL test and do NOT add `@testing-library/react` as a dependency. This hook is a thin wrapper over `window.mango.merge.*` plus local state; its behavior is exercised by the Task 9 documented Playwright smoke and its types by `typecheck:web`. There is therefore no failing-test step for this task; go straight to the implementation and gate on `typecheck:web` + `lint`.

**Step 6.2 — implementation** (`src/renderer/hooks/use-conflicts.ts`). COMPLETE code:

```ts
import { useCallback, useEffect, useState } from 'react';
import type {
  ConflictedFile,
  ConflictFileVersions,
  MergeResult,
} from '../../shared/types';

type Choice = 'ours' | 'theirs' | 'manual' | 'keep' | 'remove';

/** Drives the conflict-resolution surface for one worktree's in-progress merge. */
export interface UseConflicts {
  readonly files: ConflictedFile[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly inProgress: boolean;
  refresh(): Promise<void>;
  read(path: string): Promise<ConflictFileVersions>;
  resolve(path: string, choice: Choice, targetBranch: string, content?: string): Promise<MergeResult>;
  continueMerge(targetBranch: string, cleanup: boolean): Promise<MergeResult>;
  abort(): Promise<MergeResult>;
}

export function useConflicts(worktreeId: string): UseConflicts {
  const [files, setFiles] = useState<ConflictedFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState<boolean>(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.mango.merge.conflicts({ worktreeId });
      setFiles(list);
      setInProgress(list.length > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const read = useCallback(
    (path: string): Promise<ConflictFileVersions> =>
      window.mango.merge.readConflict({ worktreeId, path }),
    [worktreeId],
  );

  const resolve = useCallback(
    async (path: string, choice: Choice, targetBranch: string, content?: string): Promise<MergeResult> => {
      const res = await window.mango.merge.resolve({ worktreeId, path, choice, content, targetBranch });
      await refresh();
      return res;
    },
    [worktreeId, refresh],
  );

  const continueMerge = useCallback(
    async (targetBranch: string, cleanup: boolean): Promise<MergeResult> => {
      const res = await window.mango.merge.continue({ worktreeId, targetBranch, cleanup });
      if (res.status === 'merged') setInProgress(false);
      else await refresh();
      return res;
    },
    [worktreeId, refresh],
  );

  const abort = useCallback(async (): Promise<MergeResult> => {
    const res = await window.mango.merge.abort({ worktreeId });
    setInProgress(false);
    setFiles([]);
    return res;
  }, [worktreeId]);

  return { files, loading, error, inProgress, refresh, read, resolve, continueMerge, abort };
}
```

**Verify (no RTL test — per Step 6.1):**

```
npm run typecheck:web && npm run lint
```

Expected: both exit 0. The hook's runtime behavior is covered by the Task 9 Playwright smoke (real `window.mango.merge.*` round-trip); its signatures are covered here by `typecheck:web`. Do NOT create `tests/renderer/use-conflicts.test.ts` and do NOT add `@testing-library/react`.

**Commit:** `feat(merge): add useConflicts renderer hook`

---

## Task 7 — ConflictView lazy component

A single editable Monaco editor over the working-tree marker text, per-file ours/theirs/manual buttons (disabled when a stage is absent), keep/remove for missing-stage files, Continue (gated), Abort. Mirrors DiffView's dispose discipline; stays in the lazy chunk (imports `monaco-env`).

**Files**

- Create `src/renderer/components/diff/conflict-view.tsx`.

**Step 7.1 — failing check.** Monaco components are not unit-tested in this repo (DiffView has none); the test is `tsc` + the Task 9 Playwright smoke. First create the file with a deliberate reference to the lazy import so the build resolves.

**Step 7.2 — implementation** (`src/renderer/components/diff/conflict-view.tsx`). COMPLETE code:

```tsx
import './../../monaco-env';
import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { ConflictFileVersions } from '../../../shared/types';
import { useConflicts } from '../../hooks/use-conflicts';

export interface ConflictViewProps {
  readonly worktreeId: string;
  /** Merge target branch (e.g. 'main'); passed to resolve/continue. */
  readonly targetBranch: string;
  /** Remove worktree + delete branch after a successful continue (mirrors the merge flow). */
  readonly cleanup: boolean;
  /** Called after a successful Continue or Abort so App can clear selection + refresh. */
  onResolved(merged: boolean): void;
}

/**
 * Contextual merge-conflict pane: a changed-file list + a SINGLE editable Monaco
 * editor over the working-tree file WITH git's raw <<<<<<< ======= >>>>>>> markers.
 * Per-file Use ours (target) / Use theirs (feature) / Mark resolved (manual) + global
 * Continue (enabled only when zero conflicts remain) + always-available Abort.
 * monaco 0.55.1 has NO merge editor — this is the supported single-editor approach.
 * Disposes model + editor + content disposable on unmount and on every file switch
 * (mirrors DiffView). Plaintext only, so just editor.worker loads (lazy chunk).
 */
export function ConflictView({
  worktreeId,
  targetBranch,
  cleanup,
  onResolved,
}: ConflictViewProps): React.JSX.Element {
  const { files, loading, error, resolve, continueMerge, abort, refresh } = useConflicts(worktreeId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [versions, setVersions] = useState<ConflictFileVersions | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // Create the editable editor once on mount; dispose on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      readOnly: false,
      automaticLayout: true,
      theme: 'vs-dark',
      minimap: { enabled: false },
    });
    editorRef.current = editor;
    return () => {
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Load the selected conflicted file's working-tree marker text into a fresh model.
  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    setFileError(null);
    void (async () => {
      try {
        const v = await window.mango.merge.readConflict({ worktreeId, path: selectedPath });
        if (cancelled) return;
        setVersions(v);
        const editor = editorRef.current;
        if (!editor) return;
        const prev = editor.getModel();
        const model = monaco.editor.createModel(v.working, 'plaintext');
        editor.setModel(model);
        prev?.dispose();
      } catch (e) {
        if (!cancelled) setFileError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPath, worktreeId]);

  const onResolveChoice = async (
    path: string,
    choice: 'ours' | 'theirs' | 'manual' | 'keep' | 'remove',
  ): Promise<void> => {
    setBusy(true);
    try {
      const content =
        choice === 'manual' ? (editorRef.current?.getModel()?.getValue() ?? '') : undefined;
      await resolve(path, choice, targetBranch, content);
      if (path === selectedPath) {
        setSelectedPath(null);
        setVersions(null);
        editorRef.current?.getModel()?.dispose();
        editorRef.current?.setModel(monaco.editor.createModel('', 'plaintext'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onContinue = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await continueMerge(targetBranch, cleanup);
      if (res.status === 'merged') onResolved(true);
      else await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onAbort = async (): Promise<void> => {
    setBusy(true);
    try {
      await abort();
      onResolved(false);
    } finally {
      setBusy(false);
    }
  };

  const hasConflicts = files.length > 0;

  return (
    <div data-testid="conflict-view" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong style={{ color: '#e0a030', fontSize: 13 }}>
          Merge conflict — {files.length} file(s) to resolve
        </strong>
        <button
          type="button"
          data-testid="conflict-continue"
          disabled={hasConflicts || busy}
          onClick={() => void onContinue()}
          title={hasConflicts ? 'resolve all conflicts first' : 'create the merge commit'}
        >
          Continue merge
        </button>
        <button type="button" data-testid="conflict-abort" disabled={busy} onClick={() => void onAbort()}>
          Abort merge
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, height: 460 }}>
        <ul
          style={{
            width: 260,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            overflowY: 'auto',
            fontSize: 13,
            borderRight: '1px solid #333',
          }}
        >
          {loading && <li style={{ color: '#888' }}>Loading conflicts…</li>}
          {error && <li style={{ color: 'crimson' }}>error: {error}</li>}
          {!loading && !error && files.length === 0 && (
            <li style={{ color: '#888' }}>No conflicts remaining — Continue merge.</li>
          )}
          {files.map((f) => (
            <li key={f.path} style={{ marginBottom: 6 }}>
              <button
                type="button"
                data-testid="conflict-file"
                onClick={() => setSelectedPath(f.path)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 6px',
                  background: selectedPath === f.path ? '#5a3a14' : 'transparent',
                  color: '#ddd',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'ui-monospace, Menlo, monospace',
                }}
              >
                <span style={{ opacity: 0.7, marginRight: 6 }}>{f.code}</span>
                {f.path}
              </button>
              <div style={{ display: 'flex', gap: 4, padding: '2px 6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  data-testid="conflict-ours"
                  disabled={busy || !f.hasOurs}
                  title={f.hasOurs ? 'use the target (main) version' : 'no target version (missing stage)'}
                  onClick={() => void onResolveChoice(f.path, 'ours')}
                >
                  Use ours (target)
                </button>
                <button
                  type="button"
                  data-testid="conflict-theirs"
                  disabled={busy || !f.hasTheirs}
                  title={f.hasTheirs ? 'use the feature version' : 'no feature version (missing stage)'}
                  onClick={() => void onResolveChoice(f.path, 'theirs')}
                >
                  Use theirs (feature)
                </button>
                <button
                  type="button"
                  data-testid="conflict-manual"
                  disabled={busy || selectedPath !== f.path}
                  title="stage the edited buffer as the resolution"
                  onClick={() => void onResolveChoice(f.path, 'manual')}
                >
                  Mark resolved (manual)
                </button>
                {(!f.hasOurs || !f.hasTheirs) && (
                  <>
                    <button
                      type="button"
                      data-testid="conflict-keep"
                      disabled={busy}
                      title="keep the file (git add)"
                      onClick={() => void onResolveChoice(f.path, 'keep')}
                    >
                      Keep file
                    </button>
                    <button
                      type="button"
                      data-testid="conflict-remove"
                      disabled={busy}
                      title="remove the file (git rm)"
                      onClick={() => void onResolveChoice(f.path, 'remove')}
                    >
                      Remove file
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {fileError && <p style={{ color: 'crimson', fontSize: 13 }}>error: {fileError}</p>}
          {!selectedPath && !fileError && (
            <p style={{ color: '#888', fontSize: 13 }}>
              Select a conflicted file to edit its markers, or use the per-file buttons.
            </p>
          )}
          {versions && !versions.hasOurs !== !versions.hasTheirs && (
            <p style={{ color: '#e0a030', fontSize: 12 }}>
              Missing index stage ({versions.code}) — content ours/theirs unavailable; edit manually
              or keep/remove the file.
            </p>
          )}
          <div ref={hostRef} style={{ width: '100%', height: 420, borderRadius: 4 }} />
        </div>
      </div>
    </div>
  );
}
```

**Run it (passes):**

```
npm run typecheck && npm run lint
```

Expected output: no errors from either; exit 0.

**Commit:** `feat(merge): add lazy editable ConflictView (single-editor markers + per-file actions)`

---

## Task 8 — App.tsx contextual conflict pane + onMerge conflict branch + restart resume

**Files**

- Modify `src/renderer/App.tsx` — lazy import (after line 27), `conflictWorktreeId` state (after line 43), REPLACE the reset-to-terminal effect (50-52) with the probe-folding reset (single authority, no race), `onMerge` conflict branch (62-76), contextual pane render (after the Diff block ~166-170), pass `mergeProgress` through.
- Modify `src/renderer/components/toolbar/merge-controls.tsx` — surface the `conflict` stage in the stage line.

**Step 8.1 — implementation.** In `src/renderer/App.tsx`:

Add the lazy import after line 27:

```ts
// Lazy so monaco stays in the existing ~7 MB diff chunk; the conflict editor shares it.
const ConflictView = lazy(() =>
  import('./components/diff/conflict-view').then((m) => ({ default: m.ConflictView })),
);
```

Add state after line 43 (`const [paneMode, ...]`):

```ts
  // Worktree currently holding an in-progress (paused) merge conflict, or null.
  const [conflictWorktreeId, setConflictWorktreeId] = useState<string | null>(null);
```

**REPLACE the existing reset-to-terminal effect (App.tsx:50-52) with this single effect** — do NOT add a second `useEffect` on `[selectedId]`. Folding the conflict probe into the existing reset gives ONE authority over the pane on selection, eliminating the ordering race between a sync reset and the async probe:

```ts
  // On selecting a worktree, reset the pane: to 'conflict' if a merge is paused there
  // (covers app-restart resume — truth comes from MERGE_HEAD in the primary tree),
  // otherwise back to 'terminal'. ONE effect owns the reset so there is no race
  // between a sync reset and an async probe.
  useEffect(() => {
    if (!selectedId) {
      setPaneMode('terminal');
      setConflictWorktreeId(null);
      return;
    }
    let cancelled = false;
    setPaneMode('terminal'); // optimistic default until the probe resolves
    void window.mango.merge
      .conflicts({ worktreeId: selectedId })
      .then((files) => {
        if (cancelled) return;
        if (files.length > 0) {
          setConflictWorktreeId(selectedId);
          setPaneMode('conflict');
        } else {
          setConflictWorktreeId((id) => (id === selectedId ? null : id));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId]);
```

Widen the `paneMode` union (line 43):

```ts
  const [paneMode, setPaneMode] = useState<'terminal' | 'diff' | 'conflict'>('terminal');
```

Replace `onMerge` (62-76) so a conflict opens the pane:

```ts
  const onMerge = useCallback(
    async (worktree: Worktree): Promise<void> => {
      const result = await runMerge({
        worktreeId: worktree.id,
        targetBranch: baseBranch,
        runVerifyHook: true,
        cleanup: true,
      });
      if (result.status === 'conflict') {
        setConflictWorktreeId(worktree.id);
        setPaneMode('conflict');
        return;
      }
      if (result.merged) {
        if (worktree.id === selectedId) setSelectedId(null);
        await refresh();
      }
    },
    [runMerge, refresh, selectedId, baseBranch],
  );
```

Add the conflict pane render after the Diff `Suspense` block (after line 170, inside the `selectedId ? (...)` branch). Also add a Conflict tab to the tablist when a conflict exists. Replace the tablist + pane region (lines 130-170) — add the tab button after the Diff tab button (after line 152):

```tsx
                {conflictWorktreeId === selectedId && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={paneMode === 'conflict'}
                    data-testid="tab-conflict"
                    style={{ color: '#e0a030' }}
                    onClick={() => setPaneMode('conflict')}
                  >
                    Conflicts
                  </button>
                )}
```

And add the conflict pane after the Diff block (after line 170):

```tsx
              {paneMode === 'conflict' && conflictWorktreeId === selectedId && (
                <Suspense
                  fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading conflicts…</p>}
                >
                  <ConflictView
                    key={`conflict-${selectedId}`}
                    worktreeId={selectedId}
                    targetBranch={baseBranch}
                    cleanup={true}
                    onResolved={(merged) => {
                      setConflictWorktreeId(null);
                      setPaneMode('terminal');
                      if (merged) {
                        if (selectedId === selectedWorktree?.id) setSelectedId(null);
                      }
                      void refresh();
                    }}
                  />
                </Suspense>
              )}
```

In `src/renderer/components/toolbar/merge-controls.tsx`, update the stage line color so a `conflict` stage reads as a warning, replacing lines 22-24 and the `<span>` style:

```ts
  const stageLabel = progress
    ? `${progress.stage}${progress.ok ? '' : progress.stage === 'conflict' ? ' ⚠' : ' ✗'}: ${progress.message}`
    : '';
  const stageColor =
    progress && progress.stage === 'conflict' ? '#e0a030' : progress && !progress.ok ? 'crimson' : '#888';
```

And use `stageColor` in the span (replace line 45):

```tsx
          style={{ fontSize: 11, color: stageColor }}
```

**Step 8.2 — run the full suite + typecheck + lint:**

```
npm run typecheck && npm run lint && npm run test
```

Expected output:

```
(no tsc errors)
(no eslint errors)
 Test Files  N passed (N)
      Tests  M passed (M)
```

**Commit:** `feat(merge): contextual conflict pane in App + restart resume + stage-line state`

---

## Task 9 — Full suite, documented Playwright smoke, V2-BACKLOG

**Files**

- Create/append `docs/V2-BACKLOG.md`.
- Add a documented Playwright smoke (manual run instructions; no new CI dependency required) under `tests/smoke/merge-conflict-smoke.md` describing the end-to-end path.

**Step 9.1 — run the full suite and the four guards:**

```
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected output: all green; `electron-vite build` emits the renderer chunk; confirm the conflict editor lands in the existing monaco lazy chunk (not the initial bundle):

```
out/renderer/assets/conflict-view-*.js     (or merged into the shared monaco chunk)
out/renderer/assets/diff-view-*.js  ~7 MB
```

Verify no `monaco-editor` reference leaked into the entry chunk:

```
grep -L "monaco" out/renderer/assets/index-*.js
```

Expected: the entry chunk path prints (meaning monaco is NOT in it).

**Step 9.2 — documented Playwright smoke** (`tests/smoke/merge-conflict-smoke.md`). COMPLETE content:

```md
# Merge Conflict Resolution — manual Playwright smoke

Prereq: a temp repo with a guaranteed conflict (feature edits a line, main edits the
same line). Launch the app pointed at that repo (set repoRoot via the dev harness).

1. Select the feature worktree; click **Merge → main**.
2. Assert the stage line shows `conflict ⚠: merge conflict: N file(s) need resolution`
   and a **Conflicts** tab (`data-testid=tab-conflict`) appears and is auto-selected.
3. Assert `data-testid=conflict-view` is visible and lists the conflicted file
   (`data-testid=conflict-file`).
4. Assert `data-testid=conflict-continue` is DISABLED while a conflict remains.
5. Click the file; assert the Monaco editor shows `<<<<<<<` / `=======` / `>>>>>>>`.
6. Click `data-testid=conflict-ours`; assert the file leaves the list.
7. Assert `data-testid=conflict-continue` becomes ENABLED; click it.
8. Assert the pane closes, the worktree list refreshes, and (cleanup=true) the
   feature worktree/branch is gone.
9. Restart-resume check: re-run merge to a conflict, kill + relaunch the app, select
   the worktree, assert the Conflicts tab reappears (truth from MERGE_HEAD).
10. Abort check: in a fresh conflict, click `data-testid=conflict-abort`; assert the
    pane closes and `git status` in the repo shows a clean tree (no MERGE_HEAD).
```

**Step 9.3 — V2-BACKLOG** (`docs/V2-BACKLOG.md`, create or append):

```md
# V2 Backlog — Merge Conflict Resolution (deferred)

- 3-way merge editor (base/ours/theirs/result). Deferred: monaco 0.55.1 ships no
  merge editor; a hand-built 3-pane is large effort. Single-editor-over-markers ships first.
- Syntax highlighting in the conflict editor (per-language workers). Deferred: would
  pull the heavy ts/json/css/html workers; MVP stays plaintext (editor.worker only).
- Conflict-marker lint: warn if `<<<<<<<`/`=======`/`>>>>>>>` remain when staging a
  manual resolution (git itself does not check). Nice-to-have.
- Inline decorations/gutter actions on each conflict hunk (accept-this-hunk).
- rename/rename and content+rename combined conflicts: richer than keep/remove.
- A dedicated merge:status push event so the conflict pane updates without polling.
```

**Step 9.4 — final full run:**

```
npm run test
```

Expected output:

```
 Test Files  (all) passed
      Tests  (all) passed
```

**Commit:** `docs(merge): conflict smoke checklist + V2 backlog; finalize conflict resolution`

---

## Migration Strategy

**Branch by Abstraction on the merge state machine — never a big-bang replace.**

1. **Additive first (Tasks 1, 2).** New types/channels/contract and the `ConflictResolver` class are pure additions. Nothing in the running app changes; `tsc` + the resolver's temp-repo tests prove them in isolation.
2. **Fork, don't replace (Task 3).** The `run()` catch becomes a two-way fork. The non-conflict throw keeps `git merge --abort` + `fail()` **verbatim** — the original safe-abort guarantee is preserved and re-tested (the new `AUTO-ABORTS a non-conflict merge failure` test). The true-conflict branch (gated on `git.status().conflicted` non-empty, not `/conflict/i`) is the only new behavior. The existing single conflict test is **split**, not silently regressed: its clean-tree assertion moves to the non-conflict-error case; a new test documents the intentional new contract (conflict leaves `MERGE_HEAD`). Cleanup is extracted into a shared `cleanupWorktree` helper with identical non-fatal semantics; its gate is unchanged (only after a completed merge or a user-confirmed `continue()`).
3. **Wire, then guard (Task 4).** IPC is additive. `MERGE_RUN` gains an `inProgress()` early-return so a second merge re-surfaces the conflict instead of tripping the dirty-tree gate. `SETTINGS_SET` is amended to NOT null the resolver while `inProgress()` (mirrors the `sessionManager` keep-while-busy discipline), so a mid-conflict settings change never drops the resolution capability.
4. **Renderer additive (Tasks 5-8).** Preload/hook/component/App changes are additive: when there is no conflict, the hardcoded `App.onMerge` happy path and the Terminal|Diff UX are byte-for-byte unchanged. The conflict pane is contextual (only mounts while `inProgress()` for the selected worktree) and reuses the existing monaco lazy chunk.
5. **No data migration.** State lives in git (`MERGE_HEAD` + index stages), recomputed per call — so an in-progress merge from a prior app version (or before restart) is picked up automatically; there is nothing persisted to migrate.
6. **Rollback.** Reverting Tasks 3-8 leaves Tasks 1-2 as dead-but-harmless additions; reverting the `run()` fork restores the exact prior auto-abort behavior. Each task is an independent commit.

---

## Acceptance Checklist

- [ ] On a real content conflict, `MergeRunner.run()` returns `status:'conflict'` + `conflicted[]`, emits a `conflict` stage, leaves the merge in progress (`git rev-parse MERGE_HEAD` succeeds, `git.status().conflicted` non-empty), and creates NO merge commit.
- [ ] A NON-conflict merge failure (bad target ref) still auto-aborts, returns `status:'failed'`, and leaves a clean tree (`status.conflicted === []` && `status.modified === []`, no `MERGE_HEAD`) — original safe-abort contract holds (split test).
- [ ] A second `MERGE_RUN` while `MERGE_HEAD` exists re-surfaces `status:'conflict'` instead of the "uncommitted changes" error (both `MergeRunner` test and `MERGE_RUN` IPC guard).
- [ ] `merge:resolve` with `ours` writes the target version + stages; `theirs` writes the feature version + stages; `manual` writes provided content + stages; `keep`/`remove` handle missing-stage files — each shrinks `git.status().conflicted`.
- [ ] `merge:continue` is rejected (no commit) while any conflict remains and succeeds (exactly one merge commit, clean tree, no `MERGE_HEAD`) only when all resolved; it uses `git commit --no-edit` and never opens an editor.
- [ ] `merge:abort` works at any point (including after a partial resolve), restores the target branch, drops `MERGE_HEAD`.
- [ ] After a user-driven `continue(cleanup:true)`, the worktree is removed THEN the feature branch deleted (order preserved); a cleanup failure reports `cleanedUp:false` WITHOUT flipping `merged:false`.
- [ ] `ConflictResolver` is stateless: `list/read/continue/abort/inProgress` recompute from `MERGE_HEAD`/`git.status()`; `SETTINGS_SET` during an in-progress merge does NOT drop it (IPC test).
- [ ] modify/delete (DU/UD) conflicts are detected: `list()` flags the absent stage, the UI disables the absent ours/theirs content button and offers keep/remove; `read()` returns `''` for the missing stage without throwing.
- [ ] UI labels `:2` as ours/target and `:3` as theirs/feature; conflict-resolver temp-repo tests cover UU + at least one modify/delete (missing-stage) case.
- [ ] The conflict editor disposes its model + editor + content disposable on unmount and on file switch; no `monaco` reference leaks into the initial renderer chunk (it stays in the lazy diff chunk).
- [ ] On app start / worktree (re)select, if a merge is in progress the Conflicts tab/pane appears (resume), driven by `merge:conflicts`.
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` all pass.
- [ ] No code path auto-commits/auto-continues without an explicit user click (asserted by absence in `run()` and by the `continue() rejected while conflict remains` test).

---

## Self-Review

- **Locked decisions honored?** (1) two-way fork gated on `git.status().conflicted` — yes (Task 3). (2) single editable plaintext editor over markers + the exact six button set — yes (Task 7); no merge editor attempted. (3) stateless `ConflictResolver` on its own ctx slot, not nulled while `inProgress()` — yes (Tasks 2, 4). (4) all plumbing commands exactly as specified, `commit --no-edit` not `merge --continue`, extended `showOrEmpty` regex incl. `/not at stage \d/` — yes (Task 2). (5) reuse `MERGE_PROGRESS` for the `conflict` stage + `status` discriminant + 5 invoke channels across 4 layers — yes (Tasks 1, 4, 5). (6) `continue()` only commit path, explicit-click only, shared cleanup gated post-merge, second-run early-return — yes (Tasks 3, 4, 7). (7) restart resume + missing-stage detect/disable/keep-remove — yes (Tasks 7, 8). (8) contextual mount + dispose discipline + plaintext lazy chunk — yes (Tasks 7, 8).
- **TDD per task?** Each task writes a failing test/check first (or `tsc` for pure-type/preload tasks where no runtime unit exists), shows the expected failing output, then the minimal complete implementation, then the passing run. Monaco components (DiffView precedent) and pure-type tasks fall back to `tsc`/lint + the documented Playwright smoke, which is the repo's existing convention.
- **Complete code?** Every code step contains full, paste-ready code — no placeholders, no "similar to above". The resolver, the `run()` fork region, all IPC handlers, the hook, and the full component are spelled out.
- **Irreversible-safety?** No `run()` path auto-continues; cleanup runs only after a completed merge or a confirmed `continue()` with zero conflicts and no `MERGE_HEAD`; abort is always available; the second-run guard prevents stranding. Verified against the locked rules.
- **Risks consciously addressed?** Conflict-vs-hard-failure misclassification (status-based gate), `SETTINGS_SET` drop (exemption + statelessness), editor hang (`commit --no-edit`), monaco bundle bloat (lazy chunk + grep guard), missing-stage UX (disable + keep/remove), ours/theirs inversion (labeled "(target)"/"(feature)" in UI and documented in types). 
- **Renderer-hook testing (resolved, not conditional):** `@testing-library/react` is confirmed ABSENT from `package.json`, and `tests/renderer/` holds only pure-function tests, so `useConflicts` (Task 6) gets NO RTL unit test and NO new dependency — it is covered by `typecheck:web` + the Task 9 Playwright smoke, matching the existing `use-settings`/`use-diff`/`use-merge` hooks. Every other test in the plan is a main-process `vitest` + `temp-git-repo` test that runs with the already-present toolchain.
