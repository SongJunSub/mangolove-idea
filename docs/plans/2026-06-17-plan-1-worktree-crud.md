I now have full verification of the porcelain format (blank-line-separated stanzas, `worktree`/`HEAD`/`branch`/`locked` lines, `detached` for no branch, errors via exit 128/255). I have everything to author the plan.

# Plan 1 — Worktree CRUD

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan — dispatch each Task to a subagent, review its diff against the Task's acceptance criteria, and only then proceed to the next Task. The `WorktreeManager` Tasks are strict TDD (failing test → run red → implement → run green → commit); the renderer Tasks are typecheck/lint/build-verified.

- **id:** `p1-worktree-crud`
- **dependsOn:** Plan 0 (`p0-scaffold-ipc`, merged to `main`).

## Goal

Create / list / remove git worktrees with base-branch selection, surfaced in the sidebar — backed by **real `simple-git` worktree operations**, unit-tested against a temp git repo. From the UI you pick a base branch, type a new branch name, create a worktree, see it appear in the sidebar, and remove it. This is MVP item 1. Plan 1 implements **nothing** from later plans (no sessions, no server, no merge).

## Architecture

```
RENDERER (React 19)                         PRELOAD (contextBridge)            MAIN (Node ESM)
─────────────────────                       ──────────────────────            ────────────────────────
toolbar.tsx ─ New worktree form ┐
                                │ create()
use-worktrees.ts ───────────────┼─► window.mango.worktree ─► ipcRenderer ─► ipcMain.handle(IPC.WORKTREE_*)
  list / create / remove        │   .list/.create/.remove     .invoke         in register-ipc.ts
                                │ list() / remove()                              │ delegates to
worktree-list.tsx ──────────────┘                                               ▼
  └─ worktree-item.tsx (one row per Worktree)                          WorktreeManager (simple-git)
                                                                        git.raw(['worktree', ...])
                                                                        against a repoRoot SimpleGit
```

- The renderer NEVER touches `ipcRenderer` — only `window.mango.worktree.*` (binding invariant §6.4).
- `register-ipc.ts` constructs the **real** `WorktreeManager` from the app's repo root and delegates the three `WORKTREE_*` channels to it. The Plan-0 stub (`WORKTREE_LIST → []`) is replaced; create/remove handlers are added.
- `WorktreeManager` is **constructor-injected with a `SimpleGit` instance** (and the resolved repo root path), so unit tests drive it against `makeTempGitRepo()` and the production handler drives it against the user's repo — **the manager never reaches for a global repo path itself**.
- The preload's `worktree.create`/`worktree.remove` flip from `notYet('1')` to real `ipcRenderer.invoke(...)`.

## Tech Stack

Reuse exactly what Plan 0 established (no new dependencies): electron-vite 5 / vite 7 / vitest 4 (node + jsdom projects) / react 19 / typescript 5.7 / **simple-git 3.36** (already a `dependency`). Main is ESM (`"type":"module"`); preload emits `.mjs`. Tests use the `__mocks__/electron.ts` manual mock aliased in `vitest.config.ts` and the `makeTempGitRepo()` helper. Lint = ESLint 9 flat + typescript-eslint 8 (`no-explicit-any: error`); format = Prettier (2-space, single quotes, semicolons, 100 col, trailing commas). Files are kebab-case.

> **simple-git has NO first-class worktree API.** All worktree ops go through `git.raw([...])`. Verified against git 2.51.2:
> - add: `git worktree add <path> -b <newBranch> <baseBranch>` — verified that git 2.51.2 auto-creates intermediate parent dirs (e.g. `.worktrees/`), so no explicit `mkdir` is needed. NOTE: git emits the worktree's path realpath-canonicalized in `list --porcelain` (macOS `/var`→`/private/var`), which is why the manager canonicalizes `repoRoot` via `realpathSync` (Task 2).
> - list: `git worktree list --porcelain` → blank-line-separated stanzas, each with `worktree <abs-path>`, `HEAD <full-sha>`, then **either** `branch refs/heads/<name>` **or** `detached`, and an optional `locked` line.
> - remove: `git worktree remove <path>` (+ `--force` when dirty/locked). Removing the **primary** working tree fails (`fatal: '<p>' is a main working tree`, exit 128); removing a non-existent path fails (`fatal: '<p>' is not a working tree`, exit 128); adding a branch that exists fails (`fatal: a branch named '<n>' already exists`, exit 255). `simple-git`'s `git.raw` rejects with an `Error` whose `.message` contains that `fatal:` text — we map it to a typed error.

## Design Decisions (made here, by the engineer)

1. **Default worktree directory layout.** When `CreateWorktreeRequest.path` is absent, the worktree is created at `<repoRoot>/.worktrees/<sanitized-branch>`, where `sanitized-branch` replaces every run of characters outside `[A-Za-z0-9._-]` (notably `/`) with a single `-` and trims leading/trailing `-`. Example: `feature/login` → `<repoRoot>/.worktrees/feature-login`.
   - **Justification:** deterministic (same branch → same path → idempotent UX), cleanable (one `.worktrees/` dir holds them all; removing it sweeps every managed worktree), and kept **inside** the repo root under a dot-dir that we add to `.gitignore` guidance — git's own worktree metadata (`.git/worktrees/...`) tolerates nested worktree dirs, and confining them under `repoRoot` keeps the app's footprint contained and easy to reason about in tests (the temp repo's `.worktrees/` lives under the temp dir and is removed by `cleanup()`). We do **not** scatter sibling dirs next to the repo (harder to find/clean and pollutes the parent).
   - Path is always resolved to an **absolute** path (`path.resolve(repoRoot, '.worktrees', sanitized)`); when `req.path` is provided it is resolved against `repoRoot` too, so the id (= path) is always absolute and stable.

2. **Porcelain parsing → `Worktree[]`.** Split the `--porcelain` output on blank lines into stanzas; for each stanza:
   - `id` and `path` = the absolute path on the `worktree ` line.
   - `head` = short (first 7 chars) of the sha on the `HEAD ` line, if present.
   - `branch` = the part after `refs/heads/` on the `branch ` line; if the stanza has `detached` (no `branch` line) → `branch = '(detached)'`.
   - `isLocked` = stanza contains a `locked` line.
   - `isPrimary` = **the first stanza** (git always lists the main working tree first; the temp repo is non-bare so there is always exactly one primary). Any `bare` stanza is skipped entirely (a bare repo has no working tree to manage).

3. **Constructor injection for testability.** `new WorktreeManager(git, repoRoot)` where `git: SimpleGit` and `repoRoot: string`. Tests pass `repo.git` + `repo.dir`; the production handler passes `simpleGit(repoRoot)` + `repoRoot`. The manager calls `this.git.raw([...])` and never instantiates `simpleGit` itself — so it cannot accidentally touch the user's real repo in a test.

4. **Typed error handling.** The manager throws plain `Error` with a clean, classified message for: branch-already-exists, primary-removal, non-existent-worktree, and dirty-removal-without-force. `create()`'s handler lets the rejection propagate (so `window.mango.worktree.create` rejects and the hook surfaces `error`). `remove()`'s handler catches and returns `Ack { ok:false, error }` (the contract makes `remove` return `Ack`, `create` return `Worktree`). The classifier (`classifyGitError`) is a pure function, unit-tested.

## File Structure

| File | Created/Modified | Single responsibility |
|---|---|---|
| `src/main/managers/worktree-manager.ts` | **create** | `WorktreeManager` class + pure `parseWorktreePorcelain`, `sanitizeBranchToDir`, `classifyGitError` helpers. Real `simple-git` worktree add/list/remove. |
| `src/main/ipc/ipc-context.ts` | **modify** | Add optional `worktreeManager` slot to `IpcContext`. |
| `src/main/ipc/register-ipc.ts` | **modify** | Replace the `WORKTREE_LIST` stub and add `WORKTREE_CREATE`/`WORKTREE_REMOVE` handlers; lazily build the real `WorktreeManager` from the repo root via a small injected factory. |
| `src/main/index.ts` | **modify** | Resolve the repo root (`process.cwd()`) and pass it into `registerIpc` so the real manager is constructed. |
| `src/preload/index.ts` | **modify** | Flip `worktree.create`/`worktree.remove` from `notYet('1')` to real `ipcRenderer.invoke(IPC.WORKTREE_CREATE/REMOVE, req)`. |
| `src/renderer/hooks/use-worktrees.ts` | **create** | React hook: `list` (load), `create`, `remove`, exposing `worktrees`, `loading`, `error`, `refresh`. Talks only to `window.mango.worktree`. |
| `src/renderer/components/sidebar/worktree-list.tsx` | **create** | Renders the list of `Worktree`s (or empty/loading/error states); maps each to `WorktreeItem`. |
| `src/renderer/components/sidebar/worktree-item.tsx` | **create** | One row: branch, primary/locked badges, short HEAD, a Remove button (disabled for primary). |
| `src/renderer/components/toolbar/toolbar.tsx` | **create** | "New worktree" form: base-branch input + new-branch input + Create button; calls the hook's `create`. |
| `src/renderer/App.tsx` | **modify** | Compose `Toolbar` + `WorktreeList` via `useWorktrees`, keeping the Plan-0 ping panel. |
| `tests/main/worktree-manager.test.ts` | **create** | Unit tests vs `makeTempGitRepo()`: create/list/remove, default-path layout, primary/locked parsing, and the 4 error cases. Plus pure-helper tests. |
| `tests/main/ipc-roundtrip.test.ts` | **modify** | Update the existing `worktree:list` stub assertion to the new delegating behavior; add create/remove delegation assertions with a fake manager. |

## Tasks

---

### Task 1 — `WorktreeManager`: pure helpers (TDD)

**Files:** `tests/main/worktree-manager.test.ts` (create), `src/main/managers/worktree-manager.ts` (create).

**Step 1.1** — Write the failing test file for the pure helpers only. Create `tests/main/worktree-manager.test.ts` with this complete content:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseWorktreePorcelain,
  sanitizeBranchToDir,
  classifyGitError,
} from '../../src/main/managers/worktree-manager';

describe('sanitizeBranchToDir', () => {
  it('replaces slashes and unsafe chars with a single dash', () => {
    expect(sanitizeBranchToDir('feature/login')).toBe('feature-login');
    expect(sanitizeBranchToDir('fix//weird  name')).toBe('fix-weird-name');
  });

  it('keeps dots, underscores and dashes; trims leading/trailing dashes', () => {
    expect(sanitizeBranchToDir('release_1.2-rc')).toBe('release_1.2-rc');
    expect(sanitizeBranchToDir('/leading/trailing/')).toBe('leading-trailing');
  });
});

describe('parseWorktreePorcelain', () => {
  it('parses primary + feature stanzas, branch, short head, locked', () => {
    const out = [
      'worktree /repo',
      'HEAD adec22e41ccac34567273915692fca4bb34197b1',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/feature-x',
      'HEAD adec22e41ccac34567273915692fca4bb34197b1',
      'branch refs/heads/feature/x',
      'locked',
      '',
    ].join('\n');
    const trees = parseWorktreePorcelain(out);
    expect(trees).toHaveLength(2);
    expect(trees[0]).toEqual({
      id: '/repo',
      path: '/repo',
      branch: 'main',
      head: 'adec22e',
      isPrimary: true,
      isLocked: false,
    });
    expect(trees[1]).toEqual({
      id: '/repo/.worktrees/feature-x',
      path: '/repo/.worktrees/feature-x',
      branch: 'feature/x',
      head: 'adec22e',
      isPrimary: false,
      isLocked: true,
    });
  });

  it('marks a detached stanza branch as (detached)', () => {
    const out = ['worktree /repo/det', 'HEAD abcdef1234567890', 'detached', ''].join('\n');
    const trees = parseWorktreePorcelain(out);
    expect(trees[0].branch).toBe('(detached)');
    expect(trees[0].isPrimary).toBe(true);
  });

  it('skips bare stanzas', () => {
    const out = [
      'worktree /repo.git',
      'bare',
      '',
      'worktree /repo/wt',
      'HEAD abcdef1234567890',
      'branch refs/heads/main',
      '',
    ].join('\n');
    const trees = parseWorktreePorcelain(out);
    expect(trees).toHaveLength(1);
    expect(trees[0].path).toBe('/repo/wt');
    expect(trees[0].isPrimary).toBe(true);
  });
});

describe('classifyGitError', () => {
  it('classifies branch-already-exists', () => {
    const msg = classifyGitError(new Error("fatal: a branch named 'feature/x' already exists"));
    expect(msg).toBe("branch 'feature/x' already exists");
  });

  it('classifies primary-removal', () => {
    const msg = classifyGitError(new Error("fatal: '/repo' is a main working tree"));
    expect(msg).toBe('cannot remove the primary working tree');
  });

  it('classifies non-existent worktree', () => {
    const msg = classifyGitError(new Error("fatal: '/repo/nope' is not a working tree"));
    expect(msg).toBe('not a worktree');
  });

  it('classifies dirty removal needing force', () => {
    const msg = classifyGitError(
      new Error("fatal: '/repo/wt' contains modified or untracked files, use --force to delete it"),
    );
    expect(msg).toBe('worktree has uncommitted changes; use force to remove');
  });

  it('falls back to the trimmed git message otherwise', () => {
    const msg = classifyGitError(new Error('fatal: some other git failure\n'));
    expect(msg).toBe('some other git failure');
  });
});
```

**Step 1.2** — Run it and confirm it fails because the module does not exist yet:

```bash
npm test -- worktree-manager
```

Expected: failure with `Failed to resolve import "../../src/main/managers/worktree-manager"` (module not found). This proves the test runs in the `node` project and is red for the right reason.

**Step 1.3** — Create `src/main/managers/worktree-manager.ts` with the helpers (class added in Task 2). Complete content:

```ts
import type { Worktree } from '../../shared/types';

/**
 * Converts a branch name into a filesystem-safe directory segment: every run of
 * characters outside [A-Za-z0-9._-] (notably '/') collapses to one '-', and
 * leading/trailing dashes are trimmed. Deterministic so the same branch always
 * maps to the same default worktree dir.
 */
export function sanitizeBranchToDir(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Parses `git worktree list --porcelain` output into Worktree[]. Stanzas are
 * blank-line separated. The first non-bare stanza is the primary working tree.
 * Bare stanzas (no working tree) are skipped.
 */
export function parseWorktreePorcelain(output: string): Worktree[] {
  const stanzas = output
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const trees: Worktree[] = [];
  let primaryAssigned = false;

  for (const stanza of stanzas) {
    const lines = stanza.split('\n').map((l) => l.trim());
    if (lines.some((l) => l === 'bare')) continue;

    const pathLine = lines.find((l) => l.startsWith('worktree '));
    if (!pathLine) continue;
    const treePath = pathLine.slice('worktree '.length).trim();

    const headLine = lines.find((l) => l.startsWith('HEAD '));
    const head = headLine ? headLine.slice('HEAD '.length).trim().slice(0, 7) : undefined;

    const branchLine = lines.find((l) => l.startsWith('branch '));
    const branch = branchLine
      ? branchLine.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      : '(detached)';

    const isLocked = lines.some((l) => l === 'locked' || l.startsWith('locked '));

    trees.push({
      id: treePath,
      path: treePath,
      branch,
      head,
      isPrimary: !primaryAssigned,
      isLocked,
    });
    primaryAssigned = true;
  }

  return trees;
}

/**
 * Maps a raw git error into a short, user-facing message for the known failure
 * modes of worktree add/remove. Falls back to the trimmed git message.
 */
export function classifyGitError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const branchExists = /a branch named '([^']+)' already exists/.exec(raw);
  if (branchExists) return `branch '${branchExists[1]}' already exists`;
  if (/is a main working tree/.test(raw)) return 'cannot remove the primary working tree';
  if (/is not a working tree/.test(raw)) return 'not a worktree';
  if (/use --force to delete it/.test(raw)) {
    return 'worktree has uncommitted changes; use force to remove';
  }
  return raw.replace(/^fatal:\s*/i, '').trim();
}
```

> Note: Task 1 imports only `Worktree` (the only type the three pure helpers use). Task 2's Step 2.3 rewrites the import block to add `realpathSync`, `resolve`, `SimpleGit`, and the request types when the `WorktreeManager` class lands — keeping the file lint-clean (`noUnusedLocals`) between tasks. Shown code == committed code in each task.

**Step 1.4** — Re-run and confirm green:

```bash
npm test -- worktree-manager
```

Expected: all `sanitizeBranchToDir`, `parseWorktreePorcelain`, `classifyGitError` tests pass.

**Step 1.5** — Commit.

```bash
git checkout -b plan-1-worktree-crud
git add src/main/managers/worktree-manager.ts tests/main/worktree-manager.test.ts
git commit -m "feat(worktree): pure porcelain parser, branch sanitizer, error classifier"
```

(Commit message footer, all commits in this plan):
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 2 — `WorktreeManager` class against a real temp repo (TDD)

**Files:** `tests/main/worktree-manager.test.ts` (extend), `src/main/managers/worktree-manager.ts` (add class).

**Step 2.1** — Append the integration `describe` block to the **bottom** of `tests/main/worktree-manager.test.ts`. Add `WorktreeManager` and the temp-repo helper to the existing imports first.

Change the top import line:
```ts
import { describe, it, expect } from 'vitest';
import {
  parseWorktreePorcelain,
  sanitizeBranchToDir,
  classifyGitError,
} from '../../src/main/managers/worktree-manager';
```
to:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  WorktreeManager,
  parseWorktreePorcelain,
  sanitizeBranchToDir,
  classifyGitError,
} from '../../src/main/managers/worktree-manager';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';
```

Append this block at the end of the file:

```ts
describe('WorktreeManager (real temp git repo)', () => {
  let repo: TempGitRepo;
  let manager: WorktreeManager;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    manager = new WorktreeManager(repo.git, repo.dir);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('lists only the primary worktree initially', async () => {
    const trees = await manager.list();
    expect(trees).toHaveLength(1);
    expect(trees[0].isPrimary).toBe(true);
    expect(trees[0].branch).toBe('main');
    expect(trees[0].head).toMatch(/^[0-9a-f]{7}$/);
  });

  it('creates a worktree on a new branch at the default .worktrees path', async () => {
    const created = await manager.create({ baseBranch: 'main', newBranch: 'feature/login' });
    expect(created.branch).toBe('feature/login');
    expect(created.isPrimary).toBe(false);
    // realpathSync: the manager canonicalizes repoRoot, so created.path is the
    // realpath'd form (/private/var/... on macOS), not the raw mkdtemp /var/... path.
    expect(created.path).toBe(join(realpathSync(repo.dir), '.worktrees', 'feature-login'));
    expect(created.id).toBe(created.path);

    const trees = await manager.list();
    expect(trees).toHaveLength(2);
    expect(trees.map((t) => t.branch).sort()).toEqual(['feature/login', 'main']);
  });

  it('honors an explicit path (resolved against repo root)', async () => {
    const created = await manager.create({
      baseBranch: 'main',
      newBranch: 'hotfix',
      path: 'custom/hf',
    });
    expect(created.path).toBe(join(realpathSync(repo.dir), 'custom', 'hf'));
    expect(created.branch).toBe('hotfix');
  });

  it('removes a created worktree', async () => {
    const created = await manager.create({ baseBranch: 'main', newBranch: 'temp' });
    await manager.remove({ worktreeId: created.id });
    const trees = await manager.list();
    expect(trees).toHaveLength(1);
    expect(trees[0].isPrimary).toBe(true);
  });

  it('throws a classified error when the branch already exists', async () => {
    await manager.create({ baseBranch: 'main', newBranch: 'dup' });
    await expect(
      manager.create({ baseBranch: 'main', newBranch: 'dup' }),
    ).rejects.toThrow("branch 'dup' already exists");
  });

  it('throws when removing the primary worktree', async () => {
    await expect(manager.remove({ worktreeId: repo.dir })).rejects.toThrow(
      'cannot remove the primary working tree',
    );
  });

  it('throws when removing a non-existent worktree', async () => {
    await expect(
      manager.remove({ worktreeId: join(repo.dir, '.worktrees', 'ghost') }),
    ).rejects.toThrow('not a worktree');
  });
});
```

**Step 2.2** — Run; confirm the new block fails because `WorktreeManager` isn't exported yet:

```bash
npm test -- worktree-manager
```

Expected: the pure-helper tests still pass; the `WorktreeManager (real temp git repo)` tests fail (no `WorktreeManager` export).

**Step 2.3** — Implement the class. Replace the **import block** at the top of `src/main/managers/worktree-manager.ts` (the single `import type { Worktree }` line from Task 1) with:

```ts
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { CreateWorktreeRequest, RemoveWorktreeRequest, Worktree } from '../../shared/types';
```

Then append the class to the **end** of the file (after the three helper functions):

```ts
/**
 * Real git-worktree CRUD over simple-git. Constructor-injected with a SimpleGit
 * bound to `repoRoot`, so it is unit-testable against a temp repo and never
 * reaches for a global repo path itself.
 */
export class WorktreeManager {
  private readonly git: SimpleGit;
  private readonly repoRoot: string;

  constructor(git: SimpleGit, repoRoot: string) {
    this.git = git;
    // Canonicalize the root: `git worktree list --porcelain` emits realpath'd
    // paths (on macOS /var -> /private/var via symlink), so we must store the
    // canonical root for resolve()'d targets to equal the porcelain output —
    // otherwise create()'s `trees.find(t => t.path === target)` never matches.
    this.repoRoot = realpathSync(repoRoot);
  }

  /** Lists every managed worktree (primary first). */
  async list(): Promise<Worktree[]> {
    const out = await this.git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(out);
  }

  /**
   * Creates a new branch `newBranch` off `baseBranch` and checks it out in a new
   * worktree. Target dir is `req.path` (resolved against repoRoot) or, by default,
   * `<repoRoot>/.worktrees/<sanitized-branch>`. Returns the created Worktree.
   */
  async create(req: CreateWorktreeRequest): Promise<Worktree> {
    const target = req.path
      ? resolve(this.repoRoot, req.path)
      : resolve(this.repoRoot, '.worktrees', sanitizeBranchToDir(req.newBranch));

    try {
      await this.git.raw(['worktree', 'add', target, '-b', req.newBranch, req.baseBranch]);
    } catch (error) {
      throw new Error(classifyGitError(error));
    }

    const trees = await this.list();
    const created = trees.find((t) => t.path === target);
    if (!created) {
      throw new Error(`worktree created at ${target} but not found in listing`);
    }
    return created;
  }

  /** Removes the worktree identified by its path (id), optionally with --force. */
  async remove(req: RemoveWorktreeRequest): Promise<void> {
    const args = ['worktree', 'remove', req.worktreeId];
    if (req.force) args.push('--force');
    try {
      await this.git.raw(args);
    } catch (error) {
      throw new Error(classifyGitError(error));
    }
  }
}
```

**Step 2.4** — Run and confirm all green:

```bash
npm test -- worktree-manager
```

Expected: every `describe` passes (pure helpers + the 7 real-repo cases).

**Step 2.5** — Typecheck the node project and commit.

```bash
npm run typecheck:node
git add src/main/managers/worktree-manager.ts tests/main/worktree-manager.test.ts
git commit -m "feat(worktree): WorktreeManager CRUD over simple-git, unit-tested vs temp repo"
```

Expected: `typecheck:node` exits 0.

---

### Task 3 — Wire the IPC handlers (TDD on delegation)

**Files:** `src/main/ipc/ipc-context.ts` (modify), `src/main/ipc/register-ipc.ts` (modify), `tests/main/ipc-roundtrip.test.ts` (modify).

**Step 3.1** — Update `IpcContext` to carry an optional manager. Replace the whole body of `src/main/ipc/ipc-context.ts`:

```ts
import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 1 adds the WorktreeManager (lazily created on first use from repoRoot).
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
  /** Absolute path of the repo MangoLove operates on (set by main/index.ts). */
  repoRoot?: string;
  /** Lazily constructed in register-ipc from repoRoot; injectable in tests. */
  worktreeManager?: WorktreeManager;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
```

**Step 3.2** — Update the existing IPC round-trip tests to the new delegating behavior, and add create/remove delegation tests with a fake manager. Replace the **entire** `describe('registerIpc', ...)` block in `tests/main/ipc-roundtrip.test.ts` (keep the `buildAppInfo` block untouched) with:

```ts
describe('registerIpc', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
    };
    return { handlers, ipcMain };
  }

  it('registers a handler for app:ping that returns AppInfo', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    registerIpc(ipcMain as never, { mainWindow: null });
    expect(handlers.has('app:ping')).toBe(true);
    const pingResult = (await handlers.get('app:ping')!({})) as { electronVersion: string };
    expect(typeof pingResult.electronVersion).toBe('string');
  });

  it('worktree:list delegates to the injected WorktreeManager', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fakeManager = {
      list: vi.fn(async () => [
        { id: '/r', path: '/r', branch: 'main', isPrimary: true, isLocked: false },
      ]),
      create: vi.fn(),
      remove: vi.fn(),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const list = await handlers.get('worktree:list')!({});
    expect(fakeManager.list).toHaveBeenCalledOnce();
    expect(list).toEqual([
      { id: '/r', path: '/r', branch: 'main', isPrimary: true, isLocked: false },
    ]);
  });

  it('worktree:create delegates the request and returns the Worktree', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const created = {
      id: '/r/.worktrees/feat',
      path: '/r/.worktrees/feat',
      branch: 'feat',
      isPrimary: false,
      isLocked: false,
    };
    const fakeManager = {
      list: vi.fn(),
      create: vi.fn(async () => created),
      remove: vi.fn(),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const req = { baseBranch: 'main', newBranch: 'feat' };
    const result = await handlers.get('worktree:create')!({}, req);
    expect(fakeManager.create).toHaveBeenCalledWith(req);
    expect(result).toEqual(created);
  });

  it('worktree:remove returns Ack ok:true on success', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fakeManager = {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(async () => undefined),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const req = { worktreeId: '/r/.worktrees/feat' };
    const ack = await handlers.get('worktree:remove')!({}, req);
    expect(fakeManager.remove).toHaveBeenCalledWith(req);
    expect(ack).toEqual({ ok: true });
  });

  it('worktree:remove returns Ack ok:false with the error message on failure', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fakeManager = {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(async () => {
        throw new Error('cannot remove the primary working tree');
      }),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const ack = (await handlers.get('worktree:remove')!({}, { worktreeId: '/r' })) as {
      ok: boolean;
      error?: string;
    };
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('cannot remove the primary working tree');
  });
});
```

**Step 3.3** — Run; confirm the new `registerIpc` tests fail (handlers not wired):

```bash
npm test -- ipc-roundtrip
```

Expected: `buildAppInfo` + `app:ping` pass; the four `worktree:*` delegation tests fail (current `WORKTREE_LIST` returns `[]` and create/remove are unregistered).

**Step 3.4** — Wire the handlers. Replace the entire body of `src/main/ipc/register-ipc.ts` with:

```ts
import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type {
  Ack,
  AppInfo,
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Worktree,
} from '../../shared/types';
import { probeNodePty, type NodePtyProbe } from '../pty/pty-factory';
import { WorktreeManager } from '../managers/worktree-manager';
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
 * Resolves the WorktreeManager: prefer the one already on ctx (tests inject a
 * fake); otherwise lazily build a real one from ctx.repoRoot and cache it.
 */
async function getWorktreeManager(ctx: IpcContext): Promise<WorktreeManager> {
  if (ctx.worktreeManager) return ctx.worktreeManager;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  ctx.worktreeManager = new WorktreeManager(simpleGit(repoRoot), repoRoot);
  return ctx.worktreeManager;
}

/**
 * Registers ALL main-process IPC handlers in one place. Plan 1 wires the real
 * WORKTREE_LIST/CREATE/REMOVE handlers, delegating to the WorktreeManager on ctx.
 */
export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle(IPC.APP_PING, async (): Promise<AppInfo> => {
    const { app } = await import('electron');
    return buildAppInfo(app, process.versions, probeNodePty);
  });

  ipcMain.handle(IPC.WORKTREE_LIST, async (): Promise<Worktree[]> => {
    const manager = await getWorktreeManager(ctx);
    return manager.list();
  });

  ipcMain.handle(
    IPC.WORKTREE_CREATE,
    async (_event: unknown, req: CreateWorktreeRequest): Promise<Worktree> => {
      const manager = await getWorktreeManager(ctx);
      return manager.create(req);
    },
  );

  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    async (_event: unknown, req: RemoveWorktreeRequest): Promise<Ack> => {
      const manager = await getWorktreeManager(ctx);
      try {
        await manager.remove(req);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}
```

**Step 3.5** — Run the full main test suite + node typecheck:

```bash
npm test -- ipc-roundtrip worktree-manager
npm run typecheck:node
```

Expected: all green; typecheck exits 0. (The `worktree:create` delegation test calls the handler with `({}, req)` — the handler ignores `_event` and forwards `req`.)

**Step 3.6** — Set `repoRoot` in main. In `src/main/index.ts`, change:

```ts
const ctx = createIpcContext();
```
to:
```ts
const ctx = createIpcContext();
ctx.repoRoot = process.cwd();
```

> `process.cwd()` is the repo MangoLove was launched in. This is the MVP-appropriate source; a future plan can add a repo-picker. The lazy factory in `getWorktreeManager` reads it.

**Step 3.7** — Commit.

```bash
git add src/main/ipc/ipc-context.ts src/main/ipc/register-ipc.ts src/main/index.ts tests/main/ipc-roundtrip.test.ts
git commit -m "feat(worktree): wire WORKTREE_LIST/CREATE/REMOVE handlers to WorktreeManager"
```

---

### Task 4 — Flip the preload create/remove from stub to real invoke

**Files:** `src/preload/index.ts` (modify).

**Step 4.1** — In `src/preload/index.ts`, replace the `worktree` block:

```ts
  worktree: {
    list: () => ipcRenderer.invoke(IPC.WORKTREE_LIST),
    create: () => notYet('1'),
    remove: () => notYet('1'),
  },
```
with:
```ts
  worktree: {
    list: () => ipcRenderer.invoke(IPC.WORKTREE_LIST),
    create: (req) => ipcRenderer.invoke(IPC.WORKTREE_CREATE, req),
    remove: (req) => ipcRenderer.invoke(IPC.WORKTREE_REMOVE, req),
  },
```

> `notYet` is still used by other surfaces (session/server/merge), so the function stays. The `req` params are typed by `MangoApi.worktree` (the binding contract) — no `any`.

**Step 4.2** — Typecheck node (preload is in the node tsconfig) and commit.

```bash
npm run typecheck:node
git add src/preload/index.ts
git commit -m "feat(worktree): flip preload worktree.create/remove to real ipc invoke"
```

Expected: typecheck exits 0.

---

### Task 5 — Renderer hook `use-worktrees`

**Files:** `src/renderer/hooks/use-worktrees.ts` (create).

**Step 5.1** — Create `src/renderer/hooks/use-worktrees.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { CreateWorktreeRequest, Worktree } from '../../shared/types';

/** Return shape of the worktree CRUD hook. */
export interface UseWorktrees {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  refresh(): Promise<void>;
  create(req: CreateWorktreeRequest): Promise<void>;
  remove(worktreeId: string, force?: boolean): Promise<void>;
}

/**
 * Worktree CRUD over window.mango.worktree. Loads the list on mount; create and
 * remove refresh the list and surface errors as a string (never throws to UI).
 */
export function useWorktrees(): UseWorktrees {
  const [worktrees, setWorktrees] = useState<readonly Worktree[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.mango.worktree.list();
      setWorktrees(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (req: CreateWorktreeRequest): Promise<void> => {
      setError(null);
      try {
        await window.mango.worktree.create(req);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (worktreeId: string, force?: boolean): Promise<void> => {
      setError(null);
      try {
        const ack = await window.mango.worktree.remove({ worktreeId, force });
        if (!ack.ok) {
          setError(ack.error ?? 'remove failed');
          return;
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { worktrees, loading, error, refresh, create, remove };
}
```

**Step 5.2** — Typecheck web and commit.

```bash
npm run typecheck:web
git add src/renderer/hooks/use-worktrees.ts
git commit -m "feat(worktree): use-worktrees renderer hook (list/create/remove)"
```

Expected: `typecheck:web` exits 0.

---

### Task 6 — Sidebar components `worktree-item` + `worktree-list`

**Files:** `src/renderer/components/sidebar/worktree-item.tsx` (create), `src/renderer/components/sidebar/worktree-list.tsx` (create).

**Step 6.1** — Create `src/renderer/components/sidebar/worktree-item.tsx`:

```ts
import type { Worktree } from '../../../shared/types';

/** Props for one worktree row. */
export interface WorktreeItemProps {
  readonly worktree: Worktree;
  onRemove(worktreeId: string): void;
}

/** A single worktree row: branch, badges, short HEAD, and a Remove action. */
export function WorktreeItem({ worktree, onRemove }: WorktreeItemProps): React.JSX.Element {
  return (
    <li
      data-testid="worktree-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderBottom: '1px solid #eee',
      }}
    >
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}>{worktree.branch}</span>
      {worktree.isPrimary && <span style={{ fontSize: 11, color: '#888' }}>primary</span>}
      {worktree.isLocked && <span style={{ fontSize: 11, color: '#b58900' }}>locked</span>}
      {worktree.head && <span style={{ fontSize: 11, color: '#aaa' }}>{worktree.head}</span>}
      <button
        type="button"
        disabled={worktree.isPrimary}
        onClick={() => onRemove(worktree.id)}
        title={worktree.isPrimary ? 'cannot remove the primary worktree' : 'remove worktree'}
      >
        Remove
      </button>
    </li>
  );
}
```

**Step 6.2** — Create `src/renderer/components/sidebar/worktree-list.tsx`:

```ts
import type { Worktree } from '../../../shared/types';
import { WorktreeItem } from './worktree-item';

/** Props for the worktree sidebar list. */
export interface WorktreeListProps {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  onRemove(worktreeId: string): void;
}

/** Sidebar list of worktrees with loading/error/empty states. */
export function WorktreeList({
  worktrees,
  loading,
  error,
  onRemove,
}: WorktreeListProps): React.JSX.Element {
  return (
    <section data-testid="worktree-list" style={{ minWidth: 260 }}>
      <h2 style={{ fontSize: 14, margin: '8px 0' }}>Worktrees</h2>
      {error && <pre style={{ color: 'crimson', fontSize: 12 }}>error: {error}</pre>}
      {loading && <p style={{ fontSize: 12, color: '#888' }}>loading…</p>}
      {!loading && worktrees.length === 0 && (
        <p style={{ fontSize: 12, color: '#888' }}>no worktrees</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {worktrees.map((wt) => (
          <WorktreeItem key={wt.id} worktree={wt} onRemove={onRemove} />
        ))}
      </ul>
    </section>
  );
}
```

**Step 6.3** — Typecheck web and commit.

```bash
npm run typecheck:web
git add src/renderer/components/sidebar/worktree-item.tsx src/renderer/components/sidebar/worktree-list.tsx
git commit -m "feat(worktree): sidebar worktree-list + worktree-item components"
```

Expected: `typecheck:web` exits 0.

---

### Task 7 — Toolbar "New worktree" form

**Files:** `src/renderer/components/toolbar/toolbar.tsx` (create).

**Step 7.1** — Create `src/renderer/components/toolbar/toolbar.tsx`:

```ts
import { useState } from 'react';
import type { CreateWorktreeRequest } from '../../../shared/types';

/** Props for the toolbar's New-worktree form. */
export interface ToolbarProps {
  onCreate(req: CreateWorktreeRequest): void;
}

/** Toolbar: base-branch + new-branch inputs and a Create action (MVP item 1). */
export function Toolbar({ onCreate }: ToolbarProps): React.JSX.Element {
  const [baseBranch, setBaseBranch] = useState<string>('main');
  const [newBranch, setNewBranch] = useState<string>('');

  const canCreate = baseBranch.trim().length > 0 && newBranch.trim().length > 0;

  const submit = (): void => {
    if (!canCreate) return;
    onCreate({ baseBranch: baseBranch.trim(), newBranch: newBranch.trim() });
    setNewBranch('');
  };

  return (
    <div
      data-testid="toolbar"
      style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}
    >
      <label style={{ fontSize: 12 }}>
        base
        <input
          aria-label="base branch"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          style={{ marginLeft: 4, width: 120 }}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        new branch
        <input
          aria-label="new branch"
          value={newBranch}
          placeholder="feature/login"
          onChange={(e) => setNewBranch(e.target.value)}
          style={{ marginLeft: 4, width: 160 }}
        />
      </label>
      <button type="button" disabled={!canCreate} onClick={submit}>
        New worktree
      </button>
    </div>
  );
}
```

**Step 7.2** — Typecheck web and commit.

```bash
npm run typecheck:web
git add src/renderer/components/toolbar/toolbar.tsx
git commit -m "feat(worktree): toolbar New-worktree form (base + new branch)"
```

Expected: `typecheck:web` exits 0.

---

### Task 8 — Compose in `App.tsx`

**Files:** `src/renderer/App.tsx` (modify).

**Step 8.1** — Replace the entire content of `src/renderer/App.tsx`:

```ts
import { useCallback, useState } from 'react';
import type { AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const { worktrees, loading, error, create, remove } = useWorktrees();

  const onPing = useCallback(async () => {
    setPingError(null);
    try {
      const result = await window.mango.app.ping();
      setInfo(result);
    } catch (e) {
      setPingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 1: worktree CRUD over real simple-git.</p>

      <Toolbar onCreate={create} />
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          onRemove={(id) => void remove(id)}
        />
        <section>
          <button type="button" onClick={onPing}>
            Ping main
          </button>
          {pingError && <pre style={{ color: 'crimson' }}>error: {pingError}</pre>}
          {info && (
            <pre data-testid="ping-result" style={{ marginTop: 16 }}>
              {formatVersions(info)}
            </pre>
          )}
        </section>
      </div>
    </main>
  );
}
```

> `create` from the hook returns `Promise<void>` and `Toolbar.onCreate` is `void`-returning — React drops the returned promise. `remove` is wrapped in `(id) => void remove(id)` to satisfy the `void`-returning `onRemove` prop without floating-promise lint noise.

**Step 8.2** — Typecheck web and commit.

```bash
npm run typecheck:web
git add src/renderer/App.tsx
git commit -m "feat(worktree): compose Toolbar + WorktreeList in App"
```

Expected: `typecheck:web` exits 0.

---

### Task 9 — Full verification gate

**Files:** none (verification only).

**Step 9.1** — Run the whole gate (match Plan 0's CI commands):

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Expected:
- `npm test` — all node + jsdom tests pass (worktree-manager: pure helpers + 7 real-repo cases; ipc-roundtrip: ping + 4 worktree delegations; format-versions unchanged).
- `npm run typecheck` — node + web both exit 0.
- `npm run lint` — 0 errors (no `any`; `_event`/`_e` ignored by `argsIgnorePattern: '^_'`).
- `npm run format:check` — clean (run `npm run format` first if Prettier reports diffs, then re-commit).
- `npm run build` — electron-vite builds main/preload/renderer with no errors.

**Step 9.2** — Manual smoke (no e2e infra added — matches Plan 0's "manual smoke" strategy). From the repo root (so `process.cwd()` is a real git repo):

```bash
npm run dev
```

In the window: the **Worktrees** sidebar shows the primary worktree (branch `main`, `primary` badge, Remove disabled). Type a new branch (e.g. `feature/demo`) with base `main`, click **New worktree** → a new row appears (branch `feature/demo`, short HEAD), and `<repoRoot>/.worktrees/feature-demo` exists on disk. Click **Remove** on it → the row disappears and the dir is gone. Trigger a duplicate-branch create → the sidebar shows `error: branch 'feature/demo' already exists` and no row is added. Quit dev.

> **Cleanup after smoke:** remove the demo worktree if you left one — `git worktree remove .worktrees/feature-demo` and delete the branch `git branch -D feature/demo`. Do **not** commit the `.worktrees/` dir.

**Step 9.3** — Final review commit if `format` changed anything; otherwise nothing to commit. The branch `plan-1-worktree-crud` is ready for PR (open it only when the user asks).

---

## Plan 1 Acceptance Checklist

1. `src/main/managers/worktree-manager.ts` exists, exporting `WorktreeManager` + pure `parseWorktreePorcelain`, `sanitizeBranchToDir`, `classifyGitError`. ✅ verify: `npm test -- worktree-manager` green.
2. `WorktreeManager` is constructor-injected `(git: SimpleGit, repoRoot: string)` and uses only `git.raw([...])` for worktree ops. ✅ verify: read the constructor; tests construct it from `makeTempGitRepo()`.
3. `create()` with no `path` lands the worktree at `<repoRoot>/.worktrees/<sanitized-branch>`. ✅ verify: the "default .worktrees path" test asserts `join(realpathSync(repo.dir), '.worktrees', 'feature-login')` (realpath because the manager canonicalizes repoRoot).
4. `list()` returns the primary first with correct `branch`, short `head`, `isPrimary`, `isLocked`. ✅ verify: porcelain-parse tests + the real-repo list test.
5. The four error cases (branch exists, primary removal, non-existent removal, dirty-without-force classification) return typed errors. ✅ verify: `classifyGitError` tests + the `rejects.toThrow` real-repo tests.
6. `register-ipc.ts` wires `WORKTREE_LIST/CREATE/REMOVE` via `ipcMain.handle(IPC.X, …)`, delegating to the manager; `remove` maps failures to `Ack {ok:false,error}`. ✅ verify: `npm test -- ipc-roundtrip` green (4 delegation tests).
7. `src/main/index.ts` sets `ctx.repoRoot = process.cwd()`. ✅ verify: read the file.
8. Preload `worktree.create`/`worktree.remove` call `ipcRenderer.invoke(IPC.WORKTREE_CREATE/REMOVE, req)` (no more `notYet('1')`). ✅ verify: read `src/preload/index.ts`.
9. `use-worktrees.ts` exposes `worktrees/loading/error/refresh/create/remove`, talking only to `window.mango.worktree`. ✅ verify: read the hook; no `ipcRenderer` import.
10. Sidebar (`worktree-list.tsx` + `worktree-item.tsx`) renders rows, badges, disabled-Remove-for-primary; toolbar has base + new-branch inputs and a Create button. ✅ verify: read the components; manual smoke.
11. `App.tsx` composes `Toolbar` + `WorktreeList` via the hook and keeps the Plan-0 ping panel. ✅ verify: read; manual smoke.
12. Full gate green: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`. ✅ verify: Task 9 Step 9.1.
13. No later-plan features (no session/server/merge code) introduced. ✅ verify: only the files in the File Structure table changed; session/server/merge preload stubs untouched.
14. Reused the **exact** binding contract: `Worktree`/`CreateWorktreeRequest`/`RemoveWorktreeRequest`/`Ack` types and `IPC.WORKTREE_*` channels — none redefined. ✅ verify: imports point at `../shared/types` and `../shared/ipc-channels`.

## Self-Review Notes

- **Spec coverage:** Plan 1 goal (create/list/remove with base-branch selection, surfaced in the sidebar, real `simple-git`, unit-tested vs temp repo) is fully covered — manager TDD (Tasks 1–2), IPC wiring TDD (Task 3), preload flip (Task 4), hook + components + toolbar + composition (Tasks 5–8), verification + manual smoke (Task 9). All six "key files" named in the roadmap are produced.
- **Type consistency vs the real contract:** Every payload uses the existing `src/shared/types.ts` interfaces verbatim (`Worktree`, `CreateWorktreeRequest`, `RemoveWorktreeRequest`, `Ack`) and the existing `IPC.WORKTREE_LIST/CREATE/REMOVE` constants. The handler signatures match the §4.2 table (`WORKTREE_CREATE → Worktree`, `WORKTREE_REMOVE → Ack`). The preload change matches `MangoApi.worktree` exactly, so `tsc` over `tsconfig.web.json` (which includes `src/preload/index.d.ts`) stays consistent.
- **Verified facts, not assumptions:** the porcelain stanza format (blank-line-separated; `worktree`/`HEAD`/`branch refs/heads/…`/`detached`/`locked`/`bare` lines), and the exact `fatal:` strings for branch-exists (exit 255), primary-removal and not-a-working-tree (exit 128) were confirmed by running git 2.51.2 locally — the `classifyGitError` regexes match those real messages.
- **Testability:** the manager never calls `simpleGit()` itself; the IPC layer's `getWorktreeManager` prefers an injected `ctx.worktreeManager` (fake in tests) and only builds the real one from `ctx.repoRoot`/`process.cwd()` in production — so no unit test can touch the user's real repo.
- **No placeholders:** every code step shows complete file content or an exact find/replace; every command lists expected output. No "add validation"/"similar to above".
- **Lint cleanliness:** no `any` (fakes in tests use `as never`, which is allowed; handler `_event` params are `unknown` and prefixed `_` per `argsIgnorePattern`). Files are kebab-case; 2-space/single-quote/100-col matches `.prettierrc.json`.
- **Known scope edge (intentional):** repo root is `process.cwd()` for the MVP; a repo-picker is deferred. The default `.worktrees/` dir lives under the repo root — document in README (out of this plan's file set, but called out in Task 9 smoke cleanup) that `.worktrees/` should be git-ignored.