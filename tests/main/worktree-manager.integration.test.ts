import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  WorktreeManager,
  parseWorktreePorcelain,
  sanitizeBranchToDir,
  classifyGitError,
  assertSafeBranchName,
} from '../../src/main/managers/worktree-manager';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

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

describe('assertSafeBranchName', () => {
  it('accepts normal branch names including slashes', () => {
    expect(() => assertSafeBranchName('main')).not.toThrow();
    expect(() => assertSafeBranchName('feature/cross-machine')).not.toThrow();
    expect(() => assertSafeBranchName('release_1.2')).not.toThrow();
  });

  it('rejects option-injection (leading -), whitespace, empty, and git-illegal metas', () => {
    for (const bad of ['', '-x', '--force', 'a b', 'a\tb', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b']) {
      expect(() => assertSafeBranchName(bad)).toThrow(/unsafe branch name/);
    }
  });

  it('rejects pseudo-refs, the detached sentinel, parens, dot-dot, and empty-sanitizing names', () => {
    // @ and all-symbol names sanitize to an empty dir (would collapse onto .worktrees);
    // '(detached)' is the porcelain sentinel that must never match a real branch lookup.
    for (const bad of [
      '@',
      'HEAD',
      '(detached)',
      'a..b',
      '@{0}',
      '.hidden',
      'trail/',
      '/lead',
      'x.lock',
      'a\u0001b', // control char
      '@@@', // sanitizes to ''
    ]) {
      expect(() => assertSafeBranchName(bad)).toThrow(/unsafe branch name/);
    }
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

  it('classifies a locked worktree removal', () => {
    const msg = classifyGitError(
      new Error("fatal: cannot remove a locked working tree, lock reason: 'busy'"),
    );
    expect(msg).toBe('worktree is locked; unlock it first');
  });

  it('classifies a worktree-path-already-exists collision', () => {
    const msg = classifyGitError(new Error("fatal: '/repo/.worktrees/a-b' already exists"));
    expect(msg).toBe('a worktree already exists at that path');
  });

  it('falls back to the trimmed git message otherwise', () => {
    const msg = classifyGitError(new Error('fatal: some other git failure\n'));
    expect(msg).toBe('some other git failure');
  });
});

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

  it('ensureForBranch checks out an existing branch into a worktree (start here)', async () => {
    // An existing local branch (mirrors a branch another machine published a pointer for).
    await repo.git.branch(['feat-remote']);
    const wt = await manager.ensureForBranch('feat-remote');
    expect(wt.branch).toBe('feat-remote');
    expect(wt.path).toBe(join(realpathSync(repo.dir), '.worktrees', 'feat-remote'));
    expect((await manager.list()).map((t) => t.branch).sort()).toEqual(['feat-remote', 'main']);
  });

  it('ensureForBranch is idempotent: returns the already-checked-out worktree', async () => {
    const first = await manager.create({ baseBranch: 'main', newBranch: 'feature/x' });
    const again = await manager.ensureForBranch('feature/x');
    expect(again.path).toBe(first.path);
    expect(await manager.list()).toHaveLength(2); // no second worktree created
  });

  it('ensureForBranch rejects unsafe branch names before touching git', async () => {
    // --detach: option injection; @: would collapse the worktree dir onto .worktrees;
    // (detached): the porcelain sentinel that must never match a detached worktree.
    for (const bad of ['--detach', '@', '(detached)', 'HEAD', '..']) {
      await expect(manager.ensureForBranch(bad)).rejects.toThrow(/unsafe branch name/);
    }
  });

  it('ensureForBranch with the (detached) sentinel does NOT return a detached worktree', async () => {
    // Create a real detached-HEAD worktree, whose parsed branch is the '(detached)' sentinel.
    const head = (await repo.git.revparse(['HEAD'])).trim();
    await repo.git.raw(['worktree', 'add', '--detach', join(repo.dir, '.worktrees', 'det'), head]);
    expect((await manager.list()).some((t) => t.branch === '(detached)')).toBe(true);
    // A crafted pointer with branch '(detached)' must be REJECTED, not matched to it.
    await expect(manager.ensureForBranch('(detached)')).rejects.toThrow(/unsafe branch name/);
  });

  it('rejects an explicit path that escapes the repo root (path traversal)', async () => {
    await expect(
      manager.create({ baseBranch: 'main', newBranch: 'evil', path: '../escape-wt' }),
    ).rejects.toThrow('worktree path must be inside the repository');
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
    await expect(manager.create({ baseBranch: 'main', newBranch: 'dup' })).rejects.toThrow(
      "branch 'dup' already exists",
    );
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
