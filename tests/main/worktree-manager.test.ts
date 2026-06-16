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
