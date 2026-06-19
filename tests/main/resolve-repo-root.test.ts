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
