import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
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
  const dir = mkdtempSync(joinPath(tmpdir(), 'mango-git-'));
  const git = simpleGit(dir);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.email', 'test@mango.local');
  await git.addConfig('user.name', 'Mango Test');
  await git.commit('init', [], { '--allow-empty': null });
  return {
    dir,
    git,
    // maxRetries/retryDelay: git may still be flushing .git/objects when cleanup runs, so a
    // recursive rmSync can transiently hit ENOTEMPTY/EBUSY on CI — retry instead of flaking.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

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
