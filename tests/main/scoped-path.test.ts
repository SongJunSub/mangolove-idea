import { describe, it, expect } from 'vitest';
import {
  isWithin,
  resolveExistingScopedPath,
  resolveWritableScopedPath,
  type ScopeDeps,
} from '../../src/main/fs/scoped-path';

/**
 * Adversarial tests for the A4 WRITE gate. The threat model is a HOSTILE renderer that
 * can send any relPath. The load-bearing subtlety is lstat-vs-follow existence: a
 * DANGLING out-of-tree symlink must route into the EXISTING branch (where realpath
 * rejects it), NOT the new-file branch (where a follow-based existsSync would wrongly
 * accept it and let writeFile create a file outside the worktree).
 */

/**
 * Builds ScopeDeps backed by injected maps:
 *  - real:    realpathSync(p) returns real[p] ?? p (identity for in-tree paths)
 *  - missing: realpathSync(p) THROWS for these (simulates ENOENT on a new file / ELOOP
 *             or a dangling link's missing target)
 *  - lstat:   lstatSync(p) SUCCEEDS for these (a present file/dir OR a dangling/looping
 *             symlink), THROWS otherwise. This is the non-follow existence seam.
 */
function makeDeps(opts: {
  real?: Record<string, string>;
  missing?: Set<string>;
  lstat?: Set<string>;
}): ScopeDeps {
  const { real = {}, missing = new Set(), lstat = new Set() } = opts;
  return {
    knownWorktreeIds: async () => new Set(['/repo/wt']),
    realpathSync: (p) => {
      if (missing.has(p)) throw new Error(`ENOENT: ${p}`);
      return real[p] ?? p;
    },
    lstatSync: (p) => {
      if (lstat.has(p)) return {};
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

describe('isWithin (re-exported from the one gate)', () => {
  it('accepts base + nested, rejects sibling/parent/prefix-collision', () => {
    expect(isWithin('/repo/wt', '/repo/wt/src/a.ts')).toBe(true);
    expect(isWithin('/repo/wt', '/repo/wt')).toBe(true);
    expect(isWithin('/repo/wt', '/repo')).toBe(false);
    expect(isWithin('/repo/wt', '/repo/wt-evil/x')).toBe(false);
  });
});

describe('resolveWritableScopedPath — security (write gate)', () => {
  it('CASE 1 (CRITICAL): new-file write where the path is a DANGLING out-of-tree symlink → REJECT', async () => {
    // /repo/wt/link.txt is a symlink to a NOT-YET-EXISTING /outside/nope.txt.
    // lstat(link) SUCCEEDS (it's a link) → existing branch; realpath(link) THROWS (dangling).
    // A follow-based existsSync would return FALSE here → new-file branch → realpath(parent=
    // /repo/wt) in-tree → ACCEPT → writeFile creates /outside/nope.txt. lstat blocks that.
    const deps = makeDeps({
      lstat: new Set(['/repo/wt/link.txt']),
      missing: new Set(['/repo/wt/link.txt']),
    });
    await expect(resolveWritableScopedPath(deps, '/repo/wt', 'link.txt')).rejects.toThrow(
      /symlink/,
    );
  });

  it('CASE 2: overwriting an EXISTING symlink whose realpath escapes (→ /etc/hosts) → REJECT', async () => {
    const deps = makeDeps({
      lstat: new Set(['/repo/wt/evil']),
      real: { '/repo/wt/evil': '/etc/hosts' },
    });
    await expect(resolveWritableScopedPath(deps, '/repo/wt', 'evil')).rejects.toThrow(/symlink/);
  });

  it('CASE 3: a LOOPING in-tree symlink (realpath throws ELOOP) → REJECT with the safe symlink message', async () => {
    const deps = makeDeps({
      lstat: new Set(['/repo/wt/loop']),
      missing: new Set(['/repo/wt/loop']), // realpath throws ELOOP-equivalent
    });
    await expect(resolveWritableScopedPath(deps, '/repo/wt', 'loop')).rejects.toThrow(/symlink/);
  });

  it('rejects writing the worktree ROOT itself (relPath "" / ".")', async () => {
    const deps = makeDeps({ lstat: new Set(['/repo/wt']) });
    await expect(resolveWritableScopedPath(deps, '/repo/wt', '')).rejects.toThrow(/worktree root/);
    await expect(resolveWritableScopedPath(deps, '/repo/wt', '.')).rejects.toThrow(/worktree root/);
  });

  it('rejects a `..` traversal out of the worktree', async () => {
    const deps = makeDeps({});
    await expect(resolveWritableScopedPath(deps, '/repo/wt', '../../etc/passwd')).rejects.toThrow(
      /escapes the worktree/,
    );
  });

  it('rejects a NEW file under a SYMLINKED parent dir at any depth (parent realpath escapes)', async () => {
    // /repo/wt/out is a symlink to /evil/out; writing /repo/wt/out/new.ts would land in /evil.
    const deps = makeDeps({ real: { '/repo/wt/out': '/evil/out' } });
    await expect(resolveWritableScopedPath(deps, '/repo/wt', 'out/new.ts')).rejects.toThrow(
      /parent symlink/,
    );
  });

  it('rejects an UNKNOWN worktree id', async () => {
    const deps = makeDeps({ lstat: new Set(['/etc/passwd']) });
    await expect(resolveWritableScopedPath(deps, '/etc', 'passwd')).rejects.toThrow(
      /unknown worktree/,
    );
  });

  it('ACCEPTS a new in-tree file → returns the canonical parent + basename, existed=false', async () => {
    const deps = makeDeps({}); // src exists (identity realpath); new.ts does not (lstat absent)
    const out = await resolveWritableScopedPath(deps, '/repo/wt', 'src/new.ts');
    expect(out).toEqual({
      baseReal: '/repo/wt',
      parentReal: '/repo/wt/src',
      name: 'new.ts',
      existed: false,
    });
  });

  it('ACCEPTS overwriting an EXISTING in-tree regular file, existed=true', async () => {
    const deps = makeDeps({ lstat: new Set(['/repo/wt/README.md']) });
    const out = await resolveWritableScopedPath(deps, '/repo/wt', 'README.md');
    expect(out).toEqual({
      baseReal: '/repo/wt',
      parentReal: '/repo/wt',
      name: 'README.md',
      existed: true,
    });
  });
});

describe('resolveExistingScopedPath — read gate (shared with A3)', () => {
  it('rejects an unknown worktree, a `..` escape, and a symlink escape; accepts in-tree', async () => {
    const deps = makeDeps({ real: { '/repo/wt/link': '/etc/secrets' } });
    await expect(resolveExistingScopedPath(deps, '/nope', '')).rejects.toThrow(/unknown worktree/);
    await expect(resolveExistingScopedPath(deps, '/repo/wt', '../etc')).rejects.toThrow(
      /escapes the worktree/,
    );
    await expect(resolveExistingScopedPath(deps, '/repo/wt', 'link')).rejects.toThrow(/symlink/);
    await expect(resolveExistingScopedPath(deps, '/repo/wt', 'src/a.ts')).resolves.toEqual({
      baseReal: '/repo/wt',
      targetReal: '/repo/wt/src/a.ts',
    });
  });
});
