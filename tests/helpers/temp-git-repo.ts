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
