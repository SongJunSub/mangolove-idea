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
