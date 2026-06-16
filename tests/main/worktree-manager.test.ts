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
