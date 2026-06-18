import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import { ConflictResolver } from '../../src/main/git/conflict-resolver';
import { WorktreeManager } from '../../src/main/managers/worktree-manager';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

/** Seeds a content conflict (UU) on base.txt: feature edits one way, main another. */
async function seedContentConflict(repo: TempGitRepo, git: SimpleGit): Promise<string> {
  writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
  await repo.git.add('base.txt');
  await repo.git.commit('base');
  const path = join(realpathSync(repo.dir), '.worktrees', 'cflt');
  await repo.git.raw(['worktree', 'add', path, '-b', 'feature/cflt', 'main']);
  const fg = simpleGit(path);
  writeFileSync(join(path, 'base.txt'), 'feature-version\n');
  await fg.add('base.txt');
  await fg.commit('feat edit');
  writeFileSync(join(repo.dir, 'base.txt'), 'main-version\n');
  await repo.git.add('base.txt');
  await repo.git.commit('main edit');
  await git.checkout('main');
  // Start the merge so MERGE_HEAD exists + base.txt is conflicted.
  await git.merge(['--no-edit', 'feature/cflt']).catch(() => undefined);
  return path;
}

/** Seeds a modify/delete conflict (DU): main deletes file.txt, feature modifies it. */
async function seedModifyDelete(repo: TempGitRepo, git: SimpleGit): Promise<string> {
  writeFileSync(join(repo.dir, 'file.txt'), 'one\n');
  await repo.git.add('file.txt');
  await repo.git.commit('add file');
  const path = join(realpathSync(repo.dir), '.worktrees', 'md');
  await repo.git.raw(['worktree', 'add', path, '-b', 'feature/md', 'main']);
  const fg = simpleGit(path);
  writeFileSync(join(path, 'file.txt'), 'one\ntwo\n'); // feature modifies
  await fg.add('file.txt');
  await fg.commit('feat modify');
  await repo.git.rm(['file.txt']); // main deletes
  await repo.git.commit('main delete');
  await git.checkout('main');
  await git.merge(['--no-edit', 'feature/md']).catch(() => undefined);
  return path;
}

describe('ConflictResolver', () => {
  let repo: TempGitRepo;
  let git: SimpleGit;
  let worktrees: WorktreeManager;
  let resolver: ConflictResolver;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    git = simpleGit(realpathSync(repo.dir));
    worktrees = new WorktreeManager(repo.git, repo.dir);
    resolver = new ConflictResolver({ git, worktrees });
  });

  afterEach(() => repo.cleanup());

  it('inProgress() reflects MERGE_HEAD', async () => {
    expect(await resolver.inProgress()).toBe(false);
    await seedContentConflict(repo, git);
    expect(await resolver.inProgress()).toBe(true);
  });

  it('inProgressWorktreeId() is null when no merge is paused', async () => {
    expect(await resolver.inProgressWorktreeId()).toBeNull();
  });

  it('inProgressWorktreeId() returns the feature worktree (MERGE_HEAD owner), not the primary', async () => {
    const wtPath = await seedContentConflict(repo, git);
    const owner = await resolver.inProgressWorktreeId();
    expect(owner).toBe(wtPath);
    // The primary tree owns MERGE_HEAD on disk but is NEVER the attributed owner —
    // the owner is the worktree whose branch is the merge's second parent.
    const trees = await worktrees.list();
    const primary = trees.find((t) => t.isPrimary);
    expect(owner).not.toBe(primary?.id);
  });

  it('inProgressWorktreeId() does not attribute the merge to an UNRELATED worktree', async () => {
    await seedContentConflict(repo, git);
    // A second, unrelated worktree exists but is NOT the one being merged.
    const otherPath = join(realpathSync(repo.dir), '.worktrees', 'other');
    await repo.git.raw(['worktree', 'add', otherPath, '-b', 'feature/other', 'main']);
    const owner = await resolver.inProgressWorktreeId();
    expect(owner).not.toBe(realpathSync(otherPath));
    expect(owner).toBe(join(realpathSync(repo.dir), '.worktrees', 'cflt'));
  });

  it('inProgressWorktreeId() goes back to null after the merge is aborted', async () => {
    await seedContentConflict(repo, git);
    expect(await resolver.inProgressWorktreeId()).not.toBeNull();
    await resolver.abort({ worktreeId: '' });
    expect(await resolver.inProgressWorktreeId()).toBeNull();
  });

  it('list() returns the conflicted file with UU code and both stages', async () => {
    await seedContentConflict(repo, git);
    const files = await resolver.list();
    expect(files).toEqual([{ path: 'base.txt', code: 'UU', hasOurs: true, hasTheirs: true }]);
  });

  it('read() returns ours=target, theirs=feature, and the marker working text', async () => {
    await seedContentConflict(repo, git);
    const v = await resolver.read('base.txt');
    expect(v.ours).toBe('main-version\n');
    expect(v.theirs).toBe('feature-version\n');
    expect(v.working).toContain('<<<<<<<');
    expect(v.working).toContain('>>>>>>>');
    expect(v.hasOurs).toBe(true);
    expect(v.hasTheirs).toBe(true);
  });

  it('acceptOurs writes the target version + stages it (conflict cleared)', async () => {
    await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'ours' });
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('main-version\n');
    expect(await resolver.list()).toEqual([]);
  });

  it('acceptTheirs writes the feature version + stages it', async () => {
    await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'theirs' });
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('feature-version\n');
    expect(await resolver.list()).toEqual([]);
  });

  it('resolveManual writes the provided content + stages it', async () => {
    await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'manual', content: 'merged!\n' });
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('merged!\n');
    expect(await resolver.list()).toEqual([]);
  });

  it('continue() is rejected while a conflict remains and creates no commit', async () => {
    await seedContentConflict(repo, git);
    const before = (await repo.git.log()).total;
    const res = await resolver.continue({ worktreeId: '', targetBranch: 'main', cleanup: false });
    expect(res.status).toBe('conflict');
    expect((await repo.git.log()).total).toBe(before);
    expect(await resolver.inProgress()).toBe(true);
  });

  it('continue() creates exactly one merge commit when all resolved (tree clean, no MERGE_HEAD)', async () => {
    const wtPath = await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'ours' });
    const before = (await repo.git.log()).total;
    const res = await resolver.continue({
      worktreeId: wtPath,
      targetBranch: 'main',
      cleanup: false,
    });
    expect(res.merged).toBe(true);
    expect(res.status).toBe('merged');
    // continue() creates the merge commit (2 parents). That ALSO makes the feature
    // commit reachable from HEAD for the first time (it was only held by MERGE_HEAD
    // while paused), so log().total grows by 2 — the merge commit + the now-reachable
    // feature commit — not 1.
    expect((await repo.git.log()).total).toBe(before + 2);
    // Robust intent check: HEAD is a real merge commit (sha + 2 parents = 3 tokens).
    const parents = (await repo.git.raw(['rev-list', '--parents', '-n', '1', 'HEAD']))
      .trim()
      .split(/\s+/);
    expect(parents.length).toBe(3);
    expect(await resolver.inProgress()).toBe(false);
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
  });

  it('continue(cleanup) removes the worktree THEN deletes the feature branch', async () => {
    const wtPath = await seedContentConflict(repo, git);
    await resolver.resolve({ path: 'base.txt', choice: 'ours' });
    const res = await resolver.continue({
      worktreeId: wtPath,
      targetBranch: 'main',
      cleanup: true,
    });
    expect(res).toMatchObject({ merged: true, cleanedUp: true });
    const branches = await repo.git.branchLocal();
    expect(branches.all).not.toContain('feature/cflt');
  });

  it('abort() drops MERGE_HEAD and restores the target version', async () => {
    await seedContentConflict(repo, git);
    const res = await resolver.abort({ worktreeId: '' });
    expect(res.status).toBe('failed');
    expect(await resolver.inProgress()).toBe(false);
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
    expect(readFileSync(join(repo.dir, 'base.txt'), 'utf8')).toBe('main-version\n');
  });

  it('list() flags a modify/delete (DU) as missing the deleted stage', async () => {
    await seedModifyDelete(repo, git);
    const files = await resolver.list();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('file.txt');
    // main deleted (stage 2 absent), feature modified (stage 3 present).
    expect(files[0].hasOurs).toBe(false);
    expect(files[0].hasTheirs).toBe(true);
  });

  it('read() of a modify/delete returns ours="" without throwing', async () => {
    await seedModifyDelete(repo, git);
    const v = await resolver.read('file.txt');
    expect(v.ours).toBe('');
    expect(v.theirs).toBe('one\ntwo\n');
    expect(v.hasOurs).toBe(false);
  });

  it("resolve 'keep' stages the working file and clears the conflict (modify/delete)", async () => {
    await seedModifyDelete(repo, git);
    await resolver.resolve({ path: 'file.txt', choice: 'keep' });
    expect(await resolver.list()).toEqual([]);
    expect(existsSync(join(repo.dir, 'file.txt'))).toBe(true);
  });

  it("resolve 'remove' git-rm's the path and clears the conflict (modify/delete)", async () => {
    await seedModifyDelete(repo, git);
    await resolver.resolve({ path: 'file.txt', choice: 'remove' });
    expect(await resolver.list()).toEqual([]);
    expect(existsSync(join(repo.dir, 'file.txt'))).toBe(false);
  });
});
