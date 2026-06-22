import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { realpathSync, writeFileSync, existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { WorktreeManager } from '../../src/main/managers/worktree-manager';
import { MergeRunner, type MergeEmitter } from '../../src/main/git/merge-runner';
import {
  FanoutManager,
  type FanoutEmitter,
  type LaneRunner,
  type LaneProc,
} from '../../src/main/git/fanout-manager';
import type { FanoutLaneStatusEvent } from '../../src/shared/types';
import type { ProcessRunner } from '../../src/main/proc/process-runner';
import { makeTempGitRepo, type TempGitRepo } from '../helpers/temp-git-repo';

/** Verify runner stub (MergeRunner needs one; fan-out never runs the hook). */
const noopVerifyRunner: ProcessRunner = {
  spawn: () => {
    throw new Error('verify hook not used by fan-out');
  },
  spawnArgs: () => {
    throw new Error('verify hook not used by fan-out');
  },
};

/**
 * A FAKE lane runner: writes a per-model file into the lane cwd (so each lane
 * produces a real git diff) and records the argv it was "given", then reports
 * exit 0 — WITHOUT committing. The MANAGER owns the commit (mirroring the real
 * runLane, where `claude -p` leaves edits uncommitted), so this exercises the
 * manager's commit-before-merge path rather than masking it. NOT real claude.
 */
function makeFakeLaneRunner() {
  const calls: { model: string; cwd: string; prompt: string; skipPermissions: boolean }[] = [];
  const laneRunner: LaneRunner = ({ model, cwd, prompt, skipPermissions, onDone }) => {
    calls.push({ model, cwd, prompt, skipPermissions });
    // Write the edit ONLY — NO commit. The MANAGER owns the commit (mirroring the real
    // runLane, where `claude -p` leaves edits uncommitted), so this exercises the
    // manager's commit-before-merge path rather than masking it.
    writeFileSync(join(cwd, `lane-${model}.txt`), `${model} did: ${prompt}\n`);
    onDone({ code: 0, stdout: `${model} done`, stderr: '' });
    const proc: LaneProc = { kill: () => {} };
    return proc;
  };
  return { laneRunner, calls };
}

function makeEmitter() {
  const events: FanoutLaneStatusEvent[] = [];
  const emitter: FanoutEmitter = { emitLaneStatus: (e) => void events.push(e) };
  return { emitter, events };
}

/** Polls until the run's lanes all reach a terminal status (done|failed). */
async function waitTerminal(mgr: FanoutManager): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const run = mgr.get();
    if (run && run.lanes.every((l) => l.status === 'done' || l.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('lanes did not reach a terminal status');
}

describe('FanoutManager', () => {
  let repo: TempGitRepo;
  let worktrees: WorktreeManager;
  let merge: MergeRunner;
  let mergeEmitter: MergeEmitter;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    await repo.git.add('base.txt');
    await repo.git.commit('base');
    worktrees = new WorktreeManager(repo.git, repo.dir);
    mergeEmitter = { emitProgress: () => {} };
    merge = new MergeRunner({
      git: simpleGit(realpathSync(repo.dir)),
      worktrees,
      verifyRunner: noopVerifyRunner,
      emitter: mergeEmitter,
      verifyCommand: 'true',
    });
  });

  afterEach(() => repo.cleanup());

  function makeManager(laneRunner: LaneRunner, emitter: FanoutEmitter): FanoutManager {
    let n = 0;
    return new FanoutManager({
      worktrees,
      merge,
      resolveBase: async () => 'main',
      laneRunner,
      agentCommand: 'fake-claude',
      emitter,
      genId: () => `run${(n += 1)}`,
      gitFactory: (cwd) => simpleGit(cwd),
      repoRoot: realpathSync(repo.dir),
    });
  }

  it('start() creates one worktree per model and runs the fake lane in each', async () => {
    const { laneRunner, calls } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);

    const res = await mgr.start({
      prompt: 'do it',
      models: ['opus', 'haiku'],
      skipPermissions: false,
    });
    expect(res.lanes).toHaveLength(2);
    await waitTerminal(mgr);

    // Two worktrees were created (+ the primary).
    const trees = await worktrees.list();
    expect(trees.filter((t) => t.branch.startsWith('fanout/'))).toHaveLength(2);
    // The fake ran in each lane's cwd with the right model + prompt.
    expect(calls.map((c) => c.model).sort()).toEqual(['haiku', 'opus']);
    expect(calls.every((c) => c.prompt === 'do it')).toBe(true);
    expect(calls.every((c) => existsSync(join(c.cwd, `lane-${c.model}.txt`)))).toBe(true);
  });

  it('transitions each lane queued -> running -> done and emits status events', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter, events } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);

    await mgr.start({ prompt: 'p', models: ['haiku'], skipPermissions: false });
    await waitTerminal(mgr);

    const run = mgr.get();
    expect(run?.lanes[0].status).toBe('done');
    const seq = events.filter((e) => e.lane.laneId === 'haiku').map((e) => e.lane.status);
    expect(seq).toEqual(['running', 'done']); // queued is the start() snapshot; events start at running
  });

  it('rejects more than 4 models', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await expect(
      mgr.start({ prompt: 'p', models: ['a', 'b', 'c', 'd', 'e'], skipPermissions: false }),
    ).rejects.toThrow(/at most 4|max/i);
  });

  it('rejects zero models', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await expect(mgr.start({ prompt: 'p', models: [], skipPermissions: false })).rejects.toThrow(
      /at least one|>= 1|empty/i,
    );
  });

  it('rejects a second start while a run is active', async () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    await mgr.start({ prompt: 'p', models: ['haiku'], skipPermissions: false });
    await expect(
      mgr.start({ prompt: 'p2', models: ['opus'], skipPermissions: false }),
    ).rejects.toThrow(/active|in progress|already/i);
  });

  it('get() returns null before any run', () => {
    const { laneRunner } = makeFakeLaneRunner();
    const { emitter } = makeEmitter();
    const mgr = makeManager(laneRunner, emitter);
    expect(mgr.get()).toBe(null);
  });
});
