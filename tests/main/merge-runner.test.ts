import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync, writeFileSync } from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import { MergeRunner, type MergeEmitter } from '../../src/main/git/merge-runner';
import { WorktreeManager } from '../../src/main/managers/worktree-manager';
import type { ProcessRunner, IProcLike, ProcExitEvent } from '../../src/main/proc/process-runner';
import type { MergeProgressEvent } from '../../src/shared/types';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

/** Fake verify runner: exits with a fixed code, capturing the command + cwd. */
function makeVerifyRunner(code: number) {
  const calls: { command: string; cwd: string }[] = [];
  const runner: ProcessRunner = {
    spawn(command, opts): IProcLike {
      calls.push({ command, cwd: opts.cwd });
      const exitCbs: ((e: ProcExitEvent) => void)[] = [];
      queueMicrotask(() => exitCbs.forEach((cb) => cb({ code, signal: null })));
      return {
        pid: 4242,
        kill: () => {},
        onStdout: () => {},
        onStderr: () => {},
        onExit: (cb) => void exitCbs.push(cb),
      };
    },
  };
  return { runner, calls };
}

function makeEmitter() {
  const events: MergeProgressEvent[] = [];
  const emitter: MergeEmitter = { emitProgress: (e) => void events.push(e) };
  return { emitter, events };
}

/** Adds a feature worktree with one extra commit; returns its id (path) + branch. */
async function addFeature(repo: TempGitRepo, branch: string, file = 'f.txt') {
  const path = join(realpathSync(repo.dir), '.worktrees', branch.replace(/\W+/g, '-'));
  await repo.git.raw(['worktree', 'add', path, '-b', branch, 'main']);
  const fg = simpleGit(path);
  writeFileSync(join(path, file), `${branch} change\n`);
  await fg.add(file);
  await fg.commit(`${branch} commit`);
  return { id: path, branch };
}

describe('MergeRunner', () => {
  let repo: TempGitRepo;
  let git: SimpleGit;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    // one real file commit so the repo has content to merge into
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    await repo.git.add('base.txt');
    await repo.git.commit('base');
    git = simpleGit(realpathSync(repo.dir));
    worktrees = new WorktreeManager(repo.git, repo.dir);
  });

  afterEach(() => repo.cleanup());

  it('fails at verify when the hook exits non-zero (no merge, no cleanup)', async () => {
    const feat = await addFeature(repo, 'feature/v');
    const { runner } = makeVerifyRunner(1);
    const { emitter, events } = makeEmitter();
    const runner2 = new MergeRunner({
      git,
      worktrees,
      verifyRunner: runner,
      emitter,
      verifyCommand: 'verify',
    });

    const result = await runner2.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: true,
      cleanup: true,
    });

    expect(result.merged).toBe(false);
    expect(result.cleanedUp).toBe(false);
    expect(result.error).toMatch(/verify/i);
    expect(events.find((e) => e.stage === 'verify')).toMatchObject({ stage: 'verify', ok: false });
    expect(events.some((e) => e.stage === 'merge')).toBe(false);
    // feature worktree still present
    const trees = await worktrees.list();
    expect(trees.map((t) => t.branch)).toContain('feature/v');
  });

  it('runs verify in the worktree cwd with the configured command', async () => {
    const feat = await addFeature(repo, 'feature/cwd');
    const { runner, calls } = makeVerifyRunner(0);
    const { emitter } = makeEmitter();
    const mr = new MergeRunner({
      git,
      worktrees,
      verifyRunner: runner,
      emitter,
      verifyCommand: 'npm test',
    });
    await mr.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: true,
      cleanup: false,
    });
    expect(calls[0]).toEqual({ command: 'npm test', cwd: feat.id });
  });

  it('merges the feature branch into the target (fast-forward) and reaches done', async () => {
    const feat = await addFeature(repo, 'feature/m');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({
      git,
      worktrees,
      verifyRunner: runner,
      emitter,
      verifyCommand: 'true',
    });

    const result = await mr.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: true,
      cleanup: false,
    });

    expect(result.merged).toBe(true);
    expect(events.map((e) => e.stage)).toEqual(['verify', 'merge', 'done']);
    // target (main) now contains the feature file
    const log = await repo.git.log();
    expect(log.all.some((c) => c.message.includes('feature/m commit'))).toBe(true);
  });

  it('aborts and fails at merge on a conflict, leaving the tree clean', async () => {
    // diverge: feature edits base.txt one way, main edits it another
    const path = join(realpathSync(repo.dir), '.worktrees', 'cflt');
    await repo.git.raw(['worktree', 'add', path, '-b', 'feature/cflt', 'main']);
    const fg = simpleGit(path);
    writeFileSync(join(path, 'base.txt'), 'feature-version\n');
    await fg.add('base.txt');
    await fg.commit('feat edit');
    writeFileSync(join(repo.dir, 'base.txt'), 'main-version\n');
    await repo.git.add('base.txt');
    await repo.git.commit('main edit');

    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });

    const result = await mr.run({
      worktreeId: path,
      targetBranch: 'main',
      runVerifyHook: false,
      cleanup: true,
    });

    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/conflict/i);
    expect(events.find((e) => e.stage === 'merge')).toMatchObject({ ok: false });
    // tree is clean (abort restored it) — no merge-in-progress markers
    const st = await repo.git.status();
    expect(st.conflicted).toEqual([]);
    expect(st.modified).toEqual([]);
  });

  it('refuses to merge when the primary tree has tracked changes', async () => {
    const feat = await addFeature(repo, 'feature/dirty');
    writeFileSync(join(repo.dir, 'base.txt'), 'uncommitted edit\n'); // dirty tracked file
    const { runner } = makeVerifyRunner(0);
    const { emitter } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });
    const result = await mr.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: false,
      cleanup: false,
    });
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/uncommitted|dirty/i);
  });

  it('cleans up (removes worktree + deletes branch) after a successful merge', async () => {
    const feat = await addFeature(repo, 'feature/clean');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });

    const result = await mr.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: false,
      cleanup: true,
    });

    expect(result).toMatchObject({ merged: true, cleanedUp: true });
    expect(events.map((e) => e.stage)).toEqual(['merge', 'cleanup', 'done']);
    const trees = await worktrees.list();
    expect(trees.map((t) => t.branch)).not.toContain('feature/clean');
    const branches = await repo.git.branchLocal();
    expect(branches.all).not.toContain('feature/clean');
  });

  it('leaves the worktree in place when cleanup is false', async () => {
    const feat = await addFeature(repo, 'feature/keep');
    const { runner } = makeVerifyRunner(0);
    const { emitter, events } = makeEmitter();
    const mr = new MergeRunner({ git, worktrees, verifyRunner: runner, emitter });
    const result = await mr.run({
      worktreeId: feat.id,
      targetBranch: 'main',
      runVerifyHook: false,
      cleanup: false,
    });
    expect(result.cleanedUp).toBe(false);
    expect(events.some((e) => e.stage === 'cleanup')).toBe(false);
    const trees = await worktrees.list();
    expect(trees.map((t) => t.branch)).toContain('feature/keep');
  });
});
