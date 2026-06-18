Target repo is clean and untouched. I have all verified facts. Now I'll write the complete plan.

Verified facts feeding the plan:
- monaco-editor NOT in package.json; Vite 7.3.5, electron-vite 5.0.0, React 19.2.7.
- monaco-editor@0.55.1, @monaco-editor/react@4.7.0 (React 19 OK) — but react wrapper defaults to CDN loader → violates CSP. Decision: raw monaco-editor.
- `?worker` imports + `self.MonacoEnvironment.getWorker` build clean under Vite 7; electron-vite forces renderer `base:'./'` in prod → workers emit as `new Worker(new URL("…worker.js", import.meta.url))` → same-origin under `file://`, satisfies `default-src 'self'` (worker-src falls back). No CSP change needed; add `worker-src 'self' blob:` defensively.
- Three-dot `base...branch` = correct PR diff; original side content must come from **merge-base** (`git merge-base base branch`), modified from branch tip. `-M` for rename detection. numstat `- -` = binary.
- `git show <ref>:<path>` errors for absent paths (added→no base, deleted→no branch) — must catch.

Here is the plan:

# Monaco Diff Viewer (V2 item A1) — Implementation Plan

For agentic workers: **REQUIRED SUB-SKILL: superpowers:subagent-driven-development**

## Goal

Let the user review a selected worktree's branch changes inside the app, in a Monaco `DiffEditor`, pairing with the existing **Merge** button (review-before-merge). Default scope is a **PR-style diff**: the worktree branch vs its base branch (default `main`) — a list of changed files plus a side-by-side Monaco diff per file (original = base/merge-base version, modified = worktree-branch version). This is a **read-only** feature — no git writes.

## Architecture

Mirrors the existing MVP seams exactly — additive only, nothing reshaped:

- **Main side**: a new pure-ish, constructor-injected `DiffViewer` (mirrors `WorktreeManager`: takes a `SimpleGit` + `repoRoot`), unit-tested against a temp git repo. Two methods: `listChangedFiles` and `getFileDiff`.
- **IPC**: two new **additive** channels `DIFF_LIST` / `DIFF_FILE` registered in `register-ipc.ts` via the same `ipcMain.handle(...)` + lazy `getDiffViewer(ctx)` pattern as `getWorktreeManager`. New `diff` namespace on `MangoApi` + preload wiring. **No existing contract type changes.**
- **Renderer**: a `DiffView` component using raw `monaco-editor`'s `createDiffEditor`, **React.lazy + Suspense** (exactly like `AgentTerminal`) so monaco's ~3.9 MB bundle is a separate async chunk fetched only when the Diff tab opens. A segmented **Terminal | Diff** toggle in the selected-worktree pane (state in `App.tsx`); ALL existing UI stays.
- **Verification**: vitest node tests for `DiffViewer` (temp repo) + IPC delegation (fake manager), matching the existing `ipc-roundtrip.test.ts` style; the Monaco renderer verified by typecheck/lint/build + a documented (NOT committed) Playwright smoke.

### Verified integration facts (do not re-litigate; established by throwaway-dir experiments)

1. **monaco-editor is NOT yet a dependency.** Stack is Vite **7.3.5**, electron-vite **5.0.0**, React **19.2.7**, TS 5.7.3.
2. **Use raw `monaco-editor@0.55.1`, NOT `@monaco-editor/react`.** The react wrapper's default loader fetches monaco from a **CDN**, which violates the renderer CSP (`script-src 'self'`). Raw monaco + Vite `?worker` imports keeps everything same-origin.
3. **Worker wiring that VERIFIED-builds under Vite 7**: five `monaco-editor/esm/vs/.../*.worker?worker` imports + `self.MonacoEnvironment.getWorker(_id, label)` returning the right worker per language label. `npx vite build` succeeded; emitted `*.worker-*.js` chunks.
4. **CSP is satisfied with NO change required, but we add one defensive directive.** electron-vite forces the renderer `base = './'` in production, so the `?worker` imports emit `new Worker(new URL("…worker-*.js", import.meta.url))` — a relative, `import.meta.url`-anchored, **same-origin** worker that resolves under `file://`. Same-origin workers are permitted by the existing `default-src 'self'` (no `worker-src` present → falls back to `default-src`). We will add `worker-src 'self' blob:` to the CSP — the built monaco chunk DOES contain a `URL.createObjectURL(new Blob([...]))` worker fallback (verified in the bundle); it did not fire in the same-origin `file://` runtime test, but the directive intentionally permits it for origin edge cases. No `script-src` relaxation.
5. **Diff semantics (VERIFIED with a temp repo + advancing base):**
   - Changed-file list: `git diff --name-status -M <base>...<branch>` (**three-dot** = PR semantics: only the branch's own changes vs the merge-base; two-dot wrongly includes commits that landed on base after branching). `-M` enables rename detection (`R100  old  new`).
   - Binary detection: `git diff --numstat -M <base>...<branch>` reports binary as `-\t-\t<path>`.
   - **Original** side content comes from the **merge-base**, not the base tip: `MB=$(git merge-base <base> <branch>)`, then `git show <MB>:<path>`. **Modified** side: `git show <branch>:<path>`.
   - `git show <ref>:<path>` **errors** (`fatal: path '…' does not exist`) for added files on the base side and deleted files on the branch side — both must be caught and mapped to `''`.

## Tech Stack

- **monaco-editor** `0.55.1` (new `dependencies` entry) — raw ESM + `?worker`.
- Existing: simple-git 3.36.0, React 19, Vite 7 / electron-vite 5, vitest 4 (node + jsdom projects).
- No new dev deps. Playwright smoke is documented only (no committed e2e infra), matching Plan 0–5.

## File Structure

| File | New? | Purpose |
|---|---|---|
| `package.json` | edit | Add `monaco-editor: 0.55.1` to `dependencies`. |
| `src/shared/ipc-channels.ts` | edit | Add `DIFF_LIST`, `DIFF_FILE` channel strings. |
| `src/shared/types.ts` | edit | Add `ChangeStatus`, `ChangedFile`, `FileDiff`, `DiffListRequest`, `DiffFileRequest`. |
| `src/shared/ipc-contract.ts` | edit | Add `diff` namespace to `MangoApi`. |
| `src/main/git/diff-viewer.ts` | **new** | `DiffViewer` + pure parsers (`parseNameStatus`, `parseBinaryPaths`). |
| `src/main/ipc/ipc-context.ts` | edit | Add `diffViewer?` to `IpcContext`. |
| `src/main/ipc/register-ipc.ts` | edit | `getDiffViewer(ctx)` + `DIFF_LIST`/`DIFF_FILE` handlers. |
| `src/preload/index.ts` | edit | Wire `diff.list` / `diff.file`. |
| `src/renderer/monaco-env.ts` | **new** | `import 'monaco-editor'` + `self.MonacoEnvironment.getWorker` + the five `?worker` imports. |
| `src/renderer/vite-env.d.ts` | **new** | `/// <reference types="vite/client" />` — types the `?worker` imports (else TS2307). |
| `src/renderer/hooks/use-diff.ts` | **new** | Per-worktree diff hook over `window.mango.diff`. |
| `src/renderer/components/diff/diff-view.tsx` | **new** | Changed-file list + monaco `createDiffEditor` host. |
| `src/renderer/App.tsx` | edit | `Terminal | Diff` toggle; lazy `DiffView`. |
| `src/renderer/index.html` | edit | Add `worker-src 'self' blob:` to CSP. |
| `tests/main/diff-viewer.test.ts` | **new** | Temp-repo unit tests for `DiffViewer` + parsers. |
| `tests/main/ipc-roundtrip.test.ts` | edit | Add `DIFF_LIST`/`DIFF_FILE` delegation tests. |

---

## Task 1 — Add monaco-editor + verify it installs and builds (no app code yet)

**Files:** `package.json`

**Steps:**

1. Add to `package.json` `dependencies` (keep alphabetical-ish, after `"@xterm/xterm"`):
   ```json
   "monaco-editor": "0.55.1",
   ```
2. Run `npm install`. Confirm `node_modules/monaco-editor/esm/vs/editor/editor.worker.js` exists.
3. Run `npm run build` (electron-vite build). It MUST still succeed (monaco isn't imported anywhere yet, so this just proves the dep install didn't break the toolchain).
4. Run `npm test` — the existing **128 tests stay green** (no code touched).
5. **Commit:** `chore: add monaco-editor 0.55.1 dependency`.

---

## Task 2 — Shared contract: channels + types + MangoApi.diff (additive)

**Files:** `src/shared/ipc-channels.ts`, `src/shared/types.ts`, `src/shared/ipc-contract.ts`

**Steps:**

1. In `src/shared/ipc-channels.ts`, add a new block before the closing `} as const;` (mirrors how Plan 5 added `SESSION_RECORDS` additively):
   ```ts
   // diff viewer (V2 A1) — read-only PR-style diff (renderer -> main, invoke)
   DIFF_LIST: 'diff:list', // invoke (worktreeId, base? -> ChangedFile[])
   DIFF_FILE: 'diff:file', // invoke (worktreeId, base?, path -> FileDiff)
   ```
2. In `src/shared/types.ts`, append at the end (after `AppInfo`):
   ```ts
   // ── Diff viewer (V2 item A1) ──

   /** Per-file change kind in a PR-style diff. */
   export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

   /** One changed file in the worktree branch vs its base (merge-base) diff. */
   export interface ChangedFile {
     /** Path shown to the user (the new/destination path for renames). */
     readonly path: string;
     readonly status: ChangeStatus;
     /** Original path when status === 'renamed' (the pre-rename path), else undefined. */
     readonly oldPath?: string;
     /** True if git treats the file as binary (no text diff possible). */
     readonly binary: boolean;
   }

   /** Full original/modified contents for one file, for Monaco's DiffEditor. */
   export interface FileDiff {
     readonly path: string;
     readonly status: ChangeStatus;
     /** Base (merge-base) contents; '' for added or binary files. */
     readonly original: string;
     /** Branch contents; '' for deleted or binary files. */
     readonly modified: string;
     readonly binary: boolean;
   }

   export interface DiffListRequest {
     readonly worktreeId: string;
     /** Base branch to diff against; defaults to 'main' in the main process. */
     readonly base?: string;
   }

   export interface DiffFileRequest {
     readonly worktreeId: string;
     readonly base?: string;
     /** The changed file's path (the new path for renames). */
     readonly path: string;
   }
   ```
3. In `src/shared/ipc-contract.ts`, extend the type import list with `ChangedFile, FileDiff, DiffListRequest, DiffFileRequest` and add the namespace to `MangoApi` after `merge`:
   ```ts
   diff: {
     /** PR-style changed-file list: worktree branch vs base (default 'main'). */
     list(req: DiffListRequest): Promise<ChangedFile[]>;
     /** Original (merge-base) + modified (branch) contents for one file. */
     file(req: DiffFileRequest): Promise<FileDiff>;
   };
   ```
4. Run `npm run typecheck` (node + web). Must pass — these are pure additive types.
5. **Commit:** `feat(diff): add DIFF_LIST/DIFF_FILE channels + ChangedFile/FileDiff contract`.

---

## Task 3 — DiffViewer parsers (TDD: pure functions first)

**Files:** `tests/main/diff-viewer.test.ts` (new), `src/main/git/diff-viewer.ts` (new)

These two parsers are pure string→data and trivially unit-testable. **RED → GREEN → commit.**

**Steps:**

1. **RED.** Create `tests/main/diff-viewer.test.ts` with parser tests only (import will fail to compile = red):
   ```ts
   import { describe, it, expect } from 'vitest';
   import { parseNameStatus, parseBinaryPaths } from '../../src/main/git/diff-viewer';

   describe('parseNameStatus', () => {
     it('parses added / modified / deleted', () => {
       const out = ['A\tadded.txt', 'M\tmod.txt', 'D\tdel.txt'].join('\n') + '\n';
       expect(parseNameStatus(out)).toEqual([
         { path: 'added.txt', status: 'added' },
         { path: 'mod.txt', status: 'modified' },
         { path: 'del.txt', status: 'deleted' },
       ]);
     });

     it('parses a rename (R100 old new) keeping new path + oldPath', () => {
       const out = 'R100\tkeep.txt\trenamed.txt\n';
       expect(parseNameStatus(out)).toEqual([
         { path: 'renamed.txt', status: 'renamed', oldPath: 'keep.txt' },
       ]);
     });

     it('treats copies (C…) as added of the destination', () => {
       expect(parseNameStatus('C75\ta.txt\tb.txt\n')).toEqual([
         { path: 'b.txt', status: 'added' },
       ]);
     });

     it('ignores blank lines and unknown statuses', () => {
       expect(parseNameStatus('\nX\tweird.txt\n')).toEqual([]);
     });
   });

   describe('parseBinaryPaths', () => {
     it('collects paths whose numstat is "-\\t-"', () => {
       const out = ['-\t-\tblob.bin', '1\t0\tfeat.txt', '-\t-\timg.png'].join('\n') + '\n';
       expect(parseBinaryPaths(out)).toEqual(new Set(['blob.bin', 'img.png']));
     });

     it('uses the destination of a renamed binary (real git arrow + brace forms)', () => {
       // Real `git diff --numstat -M` emits a rename as ONE field with ' => ':
       expect(parseBinaryPaths('-\t-\told.bin => new.bin\n')).toEqual(new Set(['new.bin']));
       // brace form: pre/{old => new}/post
       expect(parseBinaryPaths('-\t-\tdir/{a.bin => b.bin}\n')).toEqual(new Set(['dir/b.bin']));
     });
   });
   ```
   Run `npm test -- diff-viewer` → red (module missing).
2. **GREEN.** Create `src/main/git/diff-viewer.ts` with the parsers (class added in Task 4):
   ```ts
   import type { SimpleGit } from 'simple-git';
   import { realpathSync } from 'node:fs';
   import type { ChangedFile, ChangeStatus, FileDiff } from '../../shared/types';

   /** Maps a git name-status letter to our ChangeStatus (copy -> added). */
   function statusFromCode(code: string): ChangeStatus | null {
     const c = code[0];
     if (c === 'A') return 'added';
     if (c === 'M' || c === 'T') return 'modified';
     if (c === 'D') return 'deleted';
     if (c === 'R') return 'renamed';
     if (c === 'C') return 'added';
     return null;
   }

   /**
    * Parses `git diff --name-status -M <base>...<branch>` output. Rename/copy lines
    * are `R<score>\told\tnew`; we report the NEW path (and oldPath for renames).
    * Binary-ness is folded in separately (parseBinaryPaths) — set later by the caller.
    */
   export function parseNameStatus(out: string): Omit<ChangedFile, 'binary'>[] {
     const files: Omit<ChangedFile, 'binary'>[] = [];
     for (const line of out.split('\n')) {
       if (!line.trim()) continue;
       const parts = line.split('\t');
       const status = statusFromCode(parts[0]);
       if (!status) continue;
       if (status === 'renamed') {
         files.push({ path: parts[2], status, oldPath: parts[1] });
       } else if (parts[0][0] === 'C') {
         files.push({ path: parts[2], status }); // copy: destination only
       } else {
         files.push({ path: parts[1], status });
       }
     }
     return files;
   }

   /**
    * Resolves a numstat path field that may use git's rename notation to the
    * DESTINATION path: "old => new" -> "new", and the brace form
    * "pre/{old => new}/post" -> "pre/new/post". Plain paths pass through.
    */
   export function numstatDest(field: string): string {
     if (!field.includes(' => ')) return field;
     const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
     if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
     const arrow = field.split(' => ');
     return arrow[arrow.length - 1];
   }

   /**
    * Parses `git diff --numstat -M <base>...<branch>` and returns the set of paths
    * git treats as binary (numstat columns are '-' '-'). For a renamed file git puts
    * the rename notation in the single path field, so we resolve to the destination
    * (numstatDest) — matching the NEW path that parseNameStatus reports.
    */
   export function parseBinaryPaths(out: string): Set<string> {
     const bin = new Set<string>();
     for (const line of out.split('\n')) {
       if (!line.trim()) continue;
       const parts = line.split('\t');
       if (parts[0] === '-' && parts[1] === '-') {
         bin.add(numstatDest(parts[parts.length - 1]));
       }
     }
     return bin;
   }
   ```
   Run `npm test -- diff-viewer` → green.
3. Run `npm run lint && npm run typecheck`.
4. **Commit:** `feat(diff): name-status + numstat parsers (TDD)`.

---

## Task 4 — DiffViewer class against a real temp git repo (TDD)

**Files:** `tests/main/diff-viewer.test.ts` (extend), `src/main/git/diff-viewer.ts` (extend), `tests/helpers/temp-git-repo.ts` (extend — add a worktree+change helper)

**Steps:**

1. **Add a test helper.** In `tests/helpers/temp-git-repo.ts`, append a helper that creates the PR-style scenario (verified to produce A/M/D/R + binary):
   ```ts
   import { writeFileSync } from 'node:fs';
   import { join as joinPath } from 'node:path';

   /**
    * On top of `makeTempGitRepo`, seeds base files on main, adds a worktree on
    * `branch`, and commits an added/modified/deleted/renamed/binary change set.
    * Returns the absolute worktree path (its id). Used by DiffViewer tests.
    */
   export async function seedDiffScenario(
     repo: TempGitRepo,
     branch = 'feature/x',
   ): Promise<{ worktreeId: string }> {
     const g = repo.git;
     writeFileSync(joinPath(repo.dir, 'keep.txt'), 'l1\nl2\n');
     writeFileSync(joinPath(repo.dir, 'mod.txt'), 'old\n');
     writeFileSync(joinPath(repo.dir, 'del.txt'), 'bye\n');
     await g.add('.');
     await g.commit('seed');
     const wtPath = joinPath(repo.dir, '.worktrees', 'feat');
     await g.raw(['worktree', 'add', wtPath, '-b', branch, 'main']);
     const wt = simpleGit(wtPath);
     writeFileSync(joinPath(wtPath, 'mod.txt'), 'old\nnew\n');
     writeFileSync(joinPath(wtPath, 'added.txt'), 'brand new\n');
     writeFileSync(joinPath(wtPath, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254]));
     await wt.rm(['del.txt']);
     await wt.mv('keep.txt', 'renamed.txt');
     await wt.add('.');
     await wt.commit('feat');
     return { worktreeId: realpathSync(wtPath) };
   }
   ```
   (Add `realpathSync` to the file's imports; `simpleGit` is already imported.)
2. **RED.** Extend `tests/main/diff-viewer.test.ts`:
   ```ts
   import { DiffViewer } from '../../src/main/git/diff-viewer';
   import { makeTempGitRepo, seedDiffScenario, type TempGitRepo } from '../helpers/temp-git-repo';
   import { afterEach, beforeEach } from 'vitest';

   describe('DiffViewer (real temp git repo)', () => {
     let repo: TempGitRepo;
     let viewer: DiffViewer;
     let worktreeId: string;

     beforeEach(async () => {
       repo = await makeTempGitRepo();
       viewer = new DiffViewer(repo.git, repo.dir);
       ({ worktreeId } = await seedDiffScenario(repo));
     });
     afterEach(() => repo.cleanup());

     it('lists changed files PR-style (A/M/D/R + binary flag)', async () => {
       const files = await viewer.listChangedFiles({ worktreeId });
       const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
       expect(byPath['added.txt']).toMatchObject({ status: 'added', binary: false });
       expect(byPath['mod.txt']).toMatchObject({ status: 'modified', binary: false });
       expect(byPath['del.txt']).toMatchObject({ status: 'deleted', binary: false });
       expect(byPath['renamed.txt']).toMatchObject({ status: 'renamed', oldPath: 'keep.txt' });
       expect(byPath['blob.bin']).toMatchObject({ status: 'added', binary: true });
     });

     it('getFileDiff(modified) returns merge-base original + branch modified', async () => {
       const d = await viewer.getFileDiff({ worktreeId, path: 'mod.txt' });
       expect(d).toEqual({
         path: 'mod.txt', status: 'modified', original: 'old\n', modified: 'old\nnew\n', binary: false,
       });
     });

     it('getFileDiff(added) has empty original', async () => {
       const d = await viewer.getFileDiff({ worktreeId, path: 'added.txt' });
       expect(d.status).toBe('added');
       expect(d.original).toBe('');
       expect(d.modified).toBe('brand new\n');
     });

     it('getFileDiff(deleted) has empty modified', async () => {
       const d = await viewer.getFileDiff({ worktreeId, path: 'del.txt' });
       expect(d.status).toBe('deleted');
       expect(d.original).toBe('bye\n');
       expect(d.modified).toBe('');
     });

     it('getFileDiff(binary) returns binary:true with empty contents', async () => {
       const d = await viewer.getFileDiff({ worktreeId, path: 'blob.bin' });
       expect(d).toMatchObject({ binary: true, original: '', modified: '' });
     });

     it('throws a clear error for an unknown worktree', async () => {
       await expect(viewer.listChangedFiles({ worktreeId: '/nope' })).rejects.toThrow(
         /unknown worktree/,
       );
     });

     it('throws for a path not in the diff', async () => {
       await expect(viewer.getFileDiff({ worktreeId, path: 'keep.txt' })).rejects.toThrow(
         /not a changed file/,
       );
     });
   });
   ```
   Run `npm test -- diff-viewer` → red.
3. **GREEN.** Extend `src/main/git/diff-viewer.ts` with the class. Note the **merge-base** original ref and the catch-on-missing-path behavior (both verified):
   ```ts
   import type { ChangedFile, DiffFileRequest, DiffListRequest, FileDiff } from '../../shared/types';

   const DEFAULT_BASE = 'main';

   /**
    * Read-only PR-style diff for a worktree branch vs its base. Constructor-injected
    * with a SimpleGit bound to repoRoot (mirrors WorktreeManager) so it is unit-testable
    * on a temp repo. NEVER writes. The "original" side comes from the merge-base of
    * (base, branch) so the three-dot PR semantics hold even when base has advanced.
    */
   export class DiffViewer {
     private readonly git: SimpleGit;
     private readonly repoRoot: string;

     constructor(git: SimpleGit, repoRoot: string) {
       this.git = git;
       this.repoRoot = realpathSync(repoRoot);
     }

     /** Resolves worktreeId -> branch (canonicalized id match like SessionManager). */
     private async resolveBranch(worktreeId: string): Promise<string> {
       const out = await this.git.raw(['worktree', 'list', '--porcelain']);
       // Reuse the canonical realpath comparison: ids are realpath'd worktree paths.
       const stanzas = out.split(/\n\s*\n/);
       for (const stanza of stanzas) {
         const lines = stanza.split('\n').map((l) => l.trim());
         const pathLine = lines.find((l) => l.startsWith('worktree '));
         if (!pathLine) continue;
         const p = pathLine.slice('worktree '.length).trim();
         if (realpathSync(p) !== realpathSync(worktreeId)) continue;
         const br = lines.find((l) => l.startsWith('branch '));
         if (!br) throw new Error(`worktree ${worktreeId} has no branch (detached)`);
         return br.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
       }
       throw new Error(`unknown worktree ${worktreeId}`);
     }

     /** PR-style changed-file list: branch vs base (default 'main'), with binary flags. */
     async listChangedFiles(req: DiffListRequest): Promise<ChangedFile[]> {
       const base = req.base ?? DEFAULT_BASE;
       const branch = await this.resolveBranch(req.worktreeId);
       const range = `${base}...${branch}`; // three-dot: PR semantics (verified).
       const nameStatus = await this.git.raw(['diff', '--name-status', '-M', range]);
       const numstat = await this.git.raw(['diff', '--numstat', '-M', range]);
       const binary = parseBinaryPaths(numstat);
       return parseNameStatus(nameStatus).map((f) => ({ ...f, binary: binary.has(f.path) }));
     }

     /** Original (merge-base) + modified (branch tip) contents for one changed file. */
     async getFileDiff(req: DiffFileRequest): Promise<FileDiff> {
       const base = req.base ?? DEFAULT_BASE;
       const files = await this.listChangedFiles({ worktreeId: req.worktreeId, base });
       const entry = files.find((f) => f.path === req.path);
       if (!entry) throw new Error(`${req.path} is not a changed file in this diff`);

       if (entry.binary) {
         return { path: entry.path, status: entry.status, original: '', modified: '', binary: true };
       }

       const branch = await this.resolveBranch(req.worktreeId);
       const mergeBase = (await this.git.raw(['merge-base', base, branch])).trim();
       // Original side: the merge-base version of the OLD path (pre-rename for renames).
       const originalPath = entry.oldPath ?? entry.path;
       const original =
         entry.status === 'added' ? '' : await this.showOrEmpty(`${mergeBase}:${originalPath}`);
       const modified =
         entry.status === 'deleted' ? '' : await this.showOrEmpty(`${branch}:${entry.path}`);
       return { path: entry.path, status: entry.status, original, modified, binary: false };
     }

     /** `git show <ref>:<path>`; returns '' when the path is absent at that ref. */
     private async showOrEmpty(spec: string): Promise<string> {
       try {
         return await this.git.show([spec]);
       } catch (error) {
         const raw = error instanceof Error ? error.message : String(error);
         if (/does not exist|exists on disk, but not in|no such path/i.test(raw)) return '';
         throw error;
       }
     }
   }
   ```
   Run `npm test -- diff-viewer` → green.
4. Run `npm run lint && npm run typecheck && npm test` — all green (now 128 + new diff tests).
5. **Commit:** `feat(diff): DiffViewer over simple-git (merge-base PR diff, temp-repo tests)`.

---

## Task 5 — IPC wiring + delegation tests (TDD, additive)

**Files:** `src/main/ipc/ipc-context.ts`, `src/main/ipc/register-ipc.ts`, `tests/main/ipc-roundtrip.test.ts`

**Steps:**

1. In `src/main/ipc/ipc-context.ts`: add the import `import type { DiffViewer } from '../git/diff-viewer';` and a field:
   ```ts
   /** Lazily constructed in register-ipc; injectable in tests (V2 A1). */
   diffViewer?: DiffViewer;
   ```
2. **RED.** Add to `tests/main/ipc-roundtrip.test.ts` a new `describe('registerIpc — diff (V2 A1)')` block mirroring the merge block:
   ```ts
   describe('registerIpc — diff (V2 A1)', () => {
     function makeIpcMain() {
       const handlers = new Map<string, (...a: unknown[]) => unknown>();
       const ipcMain = {
         handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
         on: vi.fn(),
       };
       return { handlers, ipcMain };
     }

     it('DIFF_LIST delegates to diffViewer.listChangedFiles', async () => {
       const { handlers, ipcMain } = makeIpcMain();
       const files = [{ path: 'a.txt', status: 'modified', binary: false }];
       const dv = { listChangedFiles: vi.fn(async () => files), getFileDiff: vi.fn() };
       registerIpc(ipcMain as never, { mainWindow: null, diffViewer: dv as never });
       const req = { worktreeId: '/wt', base: 'main' };
       const out = await handlers.get('diff:list')!({}, req);
       expect(dv.listChangedFiles).toHaveBeenCalledWith(req);
       expect(out).toEqual(files);
     });

     it('DIFF_FILE delegates to diffViewer.getFileDiff', async () => {
       const { handlers, ipcMain } = makeIpcMain();
       const fd = { path: 'a.txt', status: 'modified', original: 'x', modified: 'y', binary: false };
       const dv = { listChangedFiles: vi.fn(), getFileDiff: vi.fn(async () => fd) };
       registerIpc(ipcMain as never, { mainWindow: null, diffViewer: dv as never });
       const req = { worktreeId: '/wt', path: 'a.txt' };
       const out = await handlers.get('diff:file')!({}, req);
       expect(dv.getFileDiff).toHaveBeenCalledWith(req);
       expect(out).toEqual(fd);
     });
   });
   ```
   Run `npm test -- ipc-roundtrip` → red (handlers not registered).
3. **GREEN.** In `src/main/ipc/register-ipc.ts`:
   - Add type imports: `ChangedFile, FileDiff, DiffListRequest, DiffFileRequest` to the `../../shared/types` import, and `import { DiffViewer } from '../git/diff-viewer';`.
   - Add a lazy getter mirroring `getWorktreeManager` (reuse the same simple-git + repoRoot; a fresh `simpleGit(repoRoot)` is fine — DiffViewer is read-only):
     ```ts
     async function getDiffViewer(ctx: IpcContext): Promise<DiffViewer> {
       if (ctx.diffViewer) return ctx.diffViewer;
       const repoRoot = ctx.repoRoot ?? process.cwd();
       const { simpleGit } = await import('simple-git');
       ctx.diffViewer = new DiffViewer(simpleGit(repoRoot), repoRoot);
       return ctx.diffViewer;
     }
     ```
   - Register handlers inside `registerIpc` (after the `MERGE_RUN` handler):
     ```ts
     ipcMain.handle(
       IPC.DIFF_LIST,
       async (_event: unknown, req: DiffListRequest): Promise<ChangedFile[]> => {
         return (await getDiffViewer(ctx)).listChangedFiles(req);
       },
     );

     ipcMain.handle(
       IPC.DIFF_FILE,
       async (_event: unknown, req: DiffFileRequest): Promise<FileDiff> => {
         return (await getDiffViewer(ctx)).getFileDiff(req);
       },
     );
     ```
   Run `npm test -- ipc-roundtrip` → green.
4. **Preload.** In `src/preload/index.ts`, add the `diff` namespace to `api` after `merge`:
   ```ts
   diff: {
     list: (req) => ipcRenderer.invoke(IPC.DIFF_LIST, req),
     file: (req) => ipcRenderer.invoke(IPC.DIFF_FILE, req),
   },
   ```
5. Run `npm run typecheck && npm run lint && npm test` — all green.
6. **Commit:** `feat(diff): DIFF_LIST/DIFF_FILE IPC handlers + preload (delegation tests)`.

---

## Task 6 — Monaco worker environment (the verified worker wiring)

**Files:** `src/renderer/monaco-env.ts` (new), `src/renderer/index.html` (CSP)

This module is imported **only** by the lazy `DiffView`, so it stays out of the initial chunk.

**Steps:**

1. Create `src/renderer/monaco-env.ts` (exact verified wiring — `?worker` imports + `getWorker`):
   ```ts
   // Monaco worker wiring for raw monaco-editor under electron-vite / Vite 7.
   // Each '?worker' import is a Vite-bundled worker entry. electron-vite forces the
   // renderer base to './', so Vite emits `new Worker(new URL("…worker-*.js",
   // import.meta.url))` — a SAME-ORIGIN worker that resolves under file:// and is
   // permitted by the renderer CSP (default-src 'self'). NOT @monaco-editor/react,
   // whose default loader pulls monaco from a CDN and would violate script-src 'self'.
   // Brings monaco's ambient `declare global { var MonacoEnvironment }` into scope —
   // this file otherwise imports only ?worker modules, so without it `tsc` errors
   // TS2339 on `self.MonacoEnvironment`. Harmless to bundle: monaco-env is imported
   // ONLY by the lazy DiffView, so this stays in the lazy chunk.
   import 'monaco-editor';
   import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
   import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
   import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
   import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
   import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

   self.MonacoEnvironment = {
     getWorker(_workerId: string, label: string): Worker {
       if (label === 'json') return new JsonWorker();
       if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
       if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
       if (label === 'typescript' || label === 'javascript') return new TsWorker();
       return new EditorWorker();
     },
   };
   ```
2. **CSP (minimal, justified).** In `src/renderer/index.html`, extend the CSP `content` to add `worker-src`:
   ```html
   content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:"
   ```
   Justification (inline comment in the PR/commit, not the meta tag): Vite emits monaco's workers as same-origin `*.worker-*.js` (already allowed by `default-src 'self'`); the explicit `worker-src 'self' blob:` makes the worker policy explicit and tolerates monaco's TS language service spawning a sub-worker via a `blob:` URL. No `script-src` relaxation — monaco is fully bundled, never CDN-loaded.
3. **Create `src/renderer/vite-env.d.ts` (REQUIRED — the typecheck gate fails without it):**
   ```ts
   /// <reference types="vite/client" />
   ```
   The `?worker` import suffix is typed by Vite's client types. `tsconfig.web.json` has `types: ["node"]` only and there is NO existing `vite/client` reference in the repo, so WITHOUT this file `npm run typecheck:web` errors **TS2307** on every `?worker` import. The file is already covered by tsconfig.web's `src/renderer/**/*.ts` include (no tsconfig edit needed) and eslint ignores `**/*.d.ts`. (Together with the `import 'monaco-editor'` above — which supplies the `MonacoEnvironment` global, else **TS2339** — both resolve.) Run `npm run typecheck:web` to confirm.
4. **Commit:** `feat(diff): monaco worker environment + CSP worker-src (verified Vite 7 wiring)`.

---

## Task 7 — Renderer: use-diff hook + DiffView component

**Files:** `src/renderer/hooks/use-diff.ts` (new), `src/renderer/components/diff/diff-view.tsx` (new)

**Steps:**

1. Create `src/renderer/hooks/use-diff.ts` (mirrors `use-session.ts` shape):
   ```ts
   import { useCallback, useEffect, useState } from 'react';
   import type { ChangedFile, FileDiff } from '../../shared/types';

   /** Loads the PR-style changed-file list for one worktree (branch vs base). */
   export interface UseDiff {
     readonly files: ChangedFile[];
     readonly loading: boolean;
     readonly error: string | null;
     loadFile(path: string): Promise<FileDiff>;
   }

   export function useDiff(worktreeId: string, base?: string): UseDiff {
     const [files, setFiles] = useState<ChangedFile[]>([]);
     const [loading, setLoading] = useState<boolean>(true);
     const [error, setError] = useState<string | null>(null);

     useEffect(() => {
       let cancelled = false;
       setLoading(true);
       setError(null);
       window.mango.diff
         .list({ worktreeId, base })
         .then((f) => {
           if (!cancelled) setFiles(f);
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
     }, [worktreeId, base]);

     const loadFile = useCallback(
       (path: string): Promise<FileDiff> => window.mango.diff.file({ worktreeId, base, path }),
       [worktreeId, base],
     );

     return { files, loading, error, loadFile };
   }
   ```
2. Create `src/renderer/components/diff/diff-view.tsx` — the changed-file list + monaco `createDiffEditor` host. Mirrors `AgentTerminal`'s mount/dispose discipline (refs + cleanup):
   ```tsx
   import './../../monaco-env';
   import * as monaco from 'monaco-editor';
   import { useEffect, useRef, useState } from 'react';
   import type { ChangedFile, FileDiff } from '../../../shared/types';
   import { useDiff } from '../../hooks/use-diff';

   export interface DiffViewProps {
     readonly worktreeId: string;
     /** Base branch to diff against; defaults to 'main' (main-side default). */
     readonly base?: string;
   }

   const STATUS_LABEL: Record<ChangedFile['status'], string> = {
     added: 'A',
     modified: 'M',
     deleted: 'D',
     renamed: 'R',
   };

   /**
    * PR-style diff for a worktree: a changed-file list (click -> loads that file) and
    * a readOnly Monaco DiffEditor (original = merge-base, modified = branch). Monaco +
    * its models are created on mount and disposed on unmount (mirrors AgentTerminal).
    */
   export function DiffView({ worktreeId, base }: DiffViewProps): React.JSX.Element {
     const { files, loading, error } = useDiff(worktreeId, base);
     const hostRef = useRef<HTMLDivElement | null>(null);
     const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
     const [selectedPath, setSelectedPath] = useState<string | null>(null);
     const [fileError, setFileError] = useState<string | null>(null);

     // Create the diff editor once on mount; dispose on unmount.
     useEffect(() => {
       const host = hostRef.current;
       if (!host) return;
       const editor = monaco.editor.createDiffEditor(host, {
         readOnly: true,
         renderSideBySide: true,
         automaticLayout: true,
         theme: 'vs-dark',
       });
       editorRef.current = editor;
       return () => {
         const model = editor.getModel();
         model?.original.dispose();
         model?.modified.dispose();
         editor.dispose();
         editorRef.current = null;
       };
     }, []);

     // When a file is selected, fetch its diff and swap the editor's models.
     useEffect(() => {
       if (!selectedPath) return;
       let cancelled = false;
       setFileError(null);
       window.mango.diff
         .file({ worktreeId, base, path: selectedPath })
         .then((d: FileDiff) => {
           const editor = editorRef.current;
           if (cancelled || !editor) return;
           const prev = editor.getModel();
           // A1 uses 'plaintext' for every file — this avoids monaco's heavier
           // LANGUAGE workers (ts/json/css/html) per file; the base editor.worker
           // still loads on first render (same-origin, allowed by worker-src 'self').
           // Per-extension syntax highlighting is a future enhancement.
           const lang = 'plaintext';
           const original = monaco.editor.createModel(
             d.binary ? '[binary file — diff not shown]' : d.original,
             lang,
           );
           const modified = monaco.editor.createModel(
             d.binary ? '[binary file — diff not shown]' : d.modified,
             lang,
           );
           editor.setModel({ original, modified });
           prev?.original.dispose();
           prev?.modified.dispose();
         })
         .catch((e: unknown) => {
           if (!cancelled) setFileError(e instanceof Error ? e.message : String(e));
         });
       return () => {
         cancelled = true;
       };
     }, [selectedPath, worktreeId, base]);

     return (
       <div data-testid="diff-view" style={{ display: 'flex', gap: 12, height: 460 }}>
         <ul
           style={{
             width: 240,
             margin: 0,
             padding: 0,
             listStyle: 'none',
             overflowY: 'auto',
             fontSize: 13,
             borderRight: '1px solid #333',
           }}
         >
           {loading && <li style={{ color: '#888' }}>Loading changes…</li>}
           {error && <li style={{ color: 'crimson' }}>error: {error}</li>}
           {!loading && !error && files.length === 0 && (
             <li style={{ color: '#888' }}>No changes vs base.</li>
           )}
           {files.map((f) => (
             <li key={f.path}>
               <button
                 type="button"
                 data-testid="diff-file"
                 onClick={() => setSelectedPath(f.path)}
                 style={{
                   width: '100%',
                   textAlign: 'left',
                   padding: '4px 6px',
                   background: selectedPath === f.path ? '#094771' : 'transparent',
                   color: '#ddd',
                   border: 'none',
                   cursor: 'pointer',
                   fontFamily: 'ui-monospace, Menlo, monospace',
                 }}
               >
                 <span style={{ opacity: 0.7, marginRight: 6 }}>{STATUS_LABEL[f.status]}</span>
                 {f.path}
                 {f.binary && <span style={{ opacity: 0.5 }}> (binary)</span>}
               </button>
             </li>
           ))}
         </ul>
         <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
           {fileError && <p style={{ color: 'crimson', fontSize: 13 }}>error: {fileError}</p>}
           {!selectedPath && !fileError && (
             <p style={{ color: '#888', fontSize: 13 }}>Select a file to view its diff.</p>
           )}
           <div ref={hostRef} style={{ width: '100%', height: 460, borderRadius: 4 }} />
         </div>
       </div>
     );
   }
   ```
   (Both sides use `plaintext` language to keep the bundle behavior deterministic and avoid per-file language workers on the hot path; syntax highlighting per extension is an easy follow-up and out of scope for A1.)
3. Run `npm run typecheck:web && npm run lint`.
4. **Commit:** `feat(diff): DiffView (monaco DiffEditor) + use-diff hook`.

---

## Task 8 — App.tsx: Terminal | Diff toggle (lazy DiffView), keep all existing UI

**Files:** `src/renderer/App.tsx`

**Steps:**

1. Add a lazy import next to the existing `AgentTerminal` lazy import:
   ```ts
   // Lazy so monaco's ~3.9 MB bundle is a SEPARATE async chunk, fetched only when the
   // Diff tab is first opened (mirrors AgentTerminal's React.lazy treatment of xterm).
   const DiffView = lazy(() =>
     import('./components/diff/diff-view').then((m) => ({ default: m.DiffView })),
   );
   ```
2. Add a pane-mode state near the other `useState`s:
   ```ts
   const [paneMode, setPaneMode] = useState<'terminal' | 'diff'>('terminal');
   ```
3. Inside the `selectedId ? (...)` branch of the right-pane `<section>`, replace the single `<Suspense><AgentTerminal/></Suspense>` with a toggle + conditional render. **Keep AgentTerminal mounted** when switching to Diff is acceptable to lose terminal state — but to preserve the live PTY, render the toggle and only swap the visible view (hide terminal with CSS rather than unmount):
   ```tsx
   {selectedId ? (
     <>
       <div role="tablist" aria-label="worktree view" style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
         <button
           type="button"
           role="tab"
           aria-selected={paneMode === 'terminal'}
           data-testid="tab-terminal"
           onClick={() => setPaneMode('terminal')}
         >
           Terminal
         </button>
         <button
           type="button"
           role="tab"
           aria-selected={paneMode === 'diff'}
           data-testid="tab-diff"
           onClick={() => setPaneMode('diff')}
         >
           Diff
         </button>
       </div>
       {/* Terminal stays mounted (live PTY) but hidden when Diff is active. */}
       <div style={{ display: paneMode === 'terminal' ? 'block' : 'none' }}>
         <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading terminal…</p>}>
           <AgentTerminal
             key={selectedId}
             worktreeId={selectedId}
             continueSession={!sessionRecords.loading && sessionRecords.has(selectedId)}
           />
         </Suspense>
       </div>
       {paneMode === 'diff' && (
         <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading diff…</p>}>
           <DiffView key={`diff-${selectedId}`} worktreeId={selectedId} base="main" />
         </Suspense>
       )}
     </>
   ) : (
     <p style={{ fontSize: 13, color: '#888' }}>Select a worktree to start its agent.</p>
   )}
   ```
   Notes: the terminal is kept mounted (hidden via `display:none`) so the live `claude` PTY is not torn down when peeking at the diff; `DiffView` is mounted only when Diff is active (so monaco doesn't load until first opened) and re-keyed per worktree. `base="main"` matches the merge default; carrying a per-worktree base is an explicit follow-up (noted in V2 backlog) — out of scope for A1.
4. Optionally reset `paneMode` to `'terminal'` when `selectedId` changes (so a freshly selected worktree opens on Terminal): add `useEffect(() => setPaneMode('terminal'), [selectedId]);`.
5. Run `npm run typecheck:web && npm run lint && npm run build`. **The electron-vite build MUST succeed** and produce a separate monaco chunk (verify a large async chunk appears in the renderer build output).
6. Run `npm test` — all prior + new tests green.
7. **Commit:** `feat(diff): Terminal|Diff toggle in selected-worktree pane (lazy DiffView)`.

---

## Task 9 — Build/CSP verification + documented Playwright smoke

**Files:** none committed (smoke is documented in the PR description only — NO e2e infra committed, matching Plan 0–5)

**Steps:**

1. Full gate: `npm run typecheck && npm run lint && npm run build && npm test`. All green; build emits a monaco async chunk.
2. **Manual / Playwright smoke (run locally, document the result; do NOT commit a test runner):**
   - `npm run dev`. In a worktree that has at least one committed change vs `main`, select it.
   - Click the **Diff** tab. Assert (snapshot/screenshot): the changed-file list renders ≥1 `data-testid="diff-file"` entry, and clicking one mounts `data-testid="diff-view"` with the Monaco diff editor (the `.monaco-diff-editor` DOM node appears) and shows the side-by-side original/modified.
   - Open DevTools console: **zero CSP violation errors** for workers (confirms the same-origin worker + `worker-src 'self' blob:` story). Confirm a network/file request for `*.worker-*.js` succeeds.
   - Switch back to **Terminal**: the live `claude` session is intact (the terminal was hidden, not unmounted).
3. Record the smoke evidence (screenshot/console excerpt) in the PR body.

---

## Acceptance Checklist

- [ ] `monaco-editor@0.55.1` is in `dependencies`; `npm install` + `npm run build` succeed.
- [ ] `DIFF_LIST` / `DIFF_FILE` channels added; **no existing channel or contract type modified** (additive only).
- [ ] `ChangedFile`, `FileDiff`, `ChangeStatus`, `DiffListRequest`, `DiffFileRequest` added to `types.ts`; `MangoApi.diff` added to the contract; preload wires both.
- [ ] `DiffViewer` uses **three-dot** `base...branch` for the file list and the **merge-base** as the original ref; handles added (empty original) / deleted (empty modified) / renamed (oldPath original) / binary (empty + flag); throws clear errors for unknown worktree / non-changed path.
- [ ] `DiffViewer` + parser unit tests pass against a real temp git repo (A/M/D/R + binary scenario).
- [ ] IPC delegation tests for `DIFF_LIST`/`DIFF_FILE` pass (fake `diffViewer`, mirroring the merge block).
- [ ] Monaco worker wiring is the verified `?worker` + `self.MonacoEnvironment.getWorker` approach (raw monaco, **not** `@monaco-editor/react`); renderer build emits same-origin `*.worker-*.js`.
- [ ] CSP updated minimally to `…; worker-src 'self' blob:`; no `script-src` relaxation; no CSP violations in the smoke.
- [ ] `DiffView` is **React.lazy + Suspense** (monaco is a separate async chunk, loaded only when the Diff tab opens) — mirrors `AgentTerminal`.
- [ ] App.tsx has a **Terminal | Diff** toggle; the live terminal PTY survives switching (hidden, not unmounted); all existing UI retained.
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` all pass; **the original 128 tests stay green** and the new diff tests are added on top.
- [ ] Documented Playwright/manual smoke shows the file list + mounted Monaco diff editor; recorded in PR (no committed e2e infra).

## Self-Review

- **Read-only guarantee**: `DiffViewer` only calls `git diff`, `git show`, `git merge-base`, `git worktree list` — zero writes; no `checkout`/`merge`/`add`. The IPC handlers are pure delegations.
- **Reuse, not reshape**: `DiffViewer` mirrors `WorktreeManager` (SimpleGit + realpath'd repoRoot, injectable); IPC mirrors `getWorktreeManager` lazy-getter + `ipcMain.handle`; preload + contract additions mirror the `merge` namespace; `DiffView` mirrors `AgentTerminal`'s lazy-load + mount/dispose discipline; tests mirror `worktree-manager.test.ts` (temp repo) and `ipc-roundtrip.test.ts` (fake delegation).
- **The two known traps are resolved against reality**: monaco-editor was absent and is added (Task 1); the Vite-7 worker wiring is the exact form that VERIFIED-built (`?worker` + `getWorker`, base `'./'` → `import.meta.url` workers), and the CSP is satisfied by same-origin workers with one defensive `worker-src` directive — no CDN loader, so `script-src 'self'` holds.
- **Diff correctness is verified, not assumed**: three-dot vs two-dot, merge-base-as-original, and binary `-\t-` numstat were all confirmed in a temp repo with an *advanced* base before being encoded.
- **Bundle hygiene**: monaco (~3.9 MB) never enters the initial chunk — it's behind `React.lazy` triggered only on first Diff-tab open, exactly like xterm behind `AgentTerminal`.

**Out of scope (noted, not built):** per-worktree base branch (default `'main'`), per-extension syntax highlighting/language workers, inline (non-side-by-side) toggle, and committed e2e infra.