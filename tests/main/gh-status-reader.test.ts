import { describe, it, expect, vi } from 'vitest';
import { GhStatusReader } from '../../src/main/git/gh-status-reader';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';
import type { ProcessRunner, IProcLike } from '../../src/main/proc/process-runner';

/** Records each spawnArgs call (file, args, cwd) and hands out queued fakes. */
function makeRunnerFactory(fakes: FakeProcHandle[]) {
  const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
  let i = 0;
  const runner: ProcessRunner = {
    spawn: () => {
      throw new Error('GhStatusReader must use spawnArgs (non-shell), not spawn');
    },
    spawnArgs: (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd });
      const f = fakes[i++];
      if (!f) throw new Error('fake runner ran out of procs');
      return f as unknown as IProcLike;
    },
  };
  return { runner, calls };
}

/** Minimal git double: resolveBranch + resolvePath + upstream check. */
function makeDeps(opts: {
  fakes: FakeProcHandle[];
  branch: string;
  worktreePath: string;
  hasUpstream: boolean;
}) {
  const { runner, calls } = makeRunnerFactory(opts.fakes);
  const reader = new GhStatusReader({
    runner,
    repoRoot: '/repo',
    owner: 'SongJunSub',
    repo: 'mangolove-idea',
    resolveBranch: vi.fn().mockResolvedValue(opts.branch),
    resolvePath: vi.fn().mockResolvedValue(opts.worktreePath),
    hasUpstream: vi.fn().mockResolvedValue(opts.hasUpstream),
    timeoutMs: 50,
  });
  return { reader, calls };
}

const PR_VIEW_JSON = JSON.stringify({
  number: 42,
  title: 'Add login',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/SongJunSub/mangolove-idea/pull/42',
  reviewDecision: '',
});

const CHECKS_JSON = JSON.stringify([
  { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'x' },
  { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'y' },
]);

describe('GhStatusReader', () => {
  it('not-pushed: no upstream short-circuits WITHOUT spawning gh', async () => {
    const { reader, calls } = makeDeps({
      fakes: [],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: false,
    });
    const status = await reader.status({ worktreeId: '/repo/.worktrees/feat' });
    expect(status).toEqual({ kind: 'not-pushed' });
    expect(calls).toHaveLength(0); // gh NEVER spawned
  });

  it('open-pr: parses pr view + pr checks into pr + ci (ci from bucket)', async () => {
    const view = makeFakeRunner();
    const checks = makeFakeRunner();
    const { reader, calls } = makeDeps({
      fakes: [view, checks],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStdout(PR_VIEW_JSON);
    view.emitExit(0);
    checks.emitStdout(CHECKS_JSON);
    checks.emitExit(0);
    const status = await p;

    expect(status.kind).toBe('open-pr');
    if (status.kind === 'open-pr') {
      expect(status.pr).toMatchObject({
        number: 42,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: '',
      });
      expect(status.ci.summary).toBe('failing');
      expect(status.ci.counts).toMatchObject({ pass: 1, fail: 1 });
    }

    // cwd = worktree path, file = gh, args include -R owner/repo AND the POSITIONAL branch.
    expect(calls[0].file).toBe('gh');
    expect(calls[0].cwd).toBe('/repo/.worktrees/feat');
    expect(calls[0].args).toEqual([
      'pr',
      'view',
      'feature/login',
      '-R',
      'SongJunSub/mangolove-idea',
      '--json',
      'number,title,state,isDraft,url,reviewDecision',
    ]);
    expect(calls[1].args.slice(0, 3)).toEqual(['pr', 'checks', 'feature/login']);
  });

  it('pending-checks: a PR with running checks (pr checks exit 8, no rows) => ci.summary pending', async () => {
    // `gh pr checks` exits 8 = "Checks pending" (documented in `gh pr checks --help`) with no
    // completed JSON rows. parseCi maps exit 8 -> ci.summary 'pending' (distinct from exit-1
    // 'no checks reported' -> 'none'). This is the only classifier path with no live capture.
    const view = makeFakeRunner();
    const checks = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view, checks],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStdout(PR_VIEW_JSON);
    view.emitExit(0);
    checks.emitStdout(''); // checks still running: gh exits 8 with no JSON array
    checks.emitExit(8);
    const status = await p;

    expect(status.kind).toBe('open-pr');
    if (status.kind === 'open-pr') {
      expect(status.ci.summary).toBe('pending');
    }
  });

  it('no-pr: pr view exit 1 + no-PR stderr => no-pr, no checks call', async () => {
    const view = makeFakeRunner();
    const { reader, calls } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStderr('no pull requests found for branch "feature/login"');
    view.emitExit(1);
    const status = await p;
    expect(status).toEqual({ kind: 'no-pr' });
    expect(calls).toHaveLength(1); // checks NOT spawned when there is no PR
  });

  it('gh-missing: spawn ENOENT error maps to gh-missing (no hang)', async () => {
    const view = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitError(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const status = await p;
    expect(status).toEqual({ kind: 'gh-missing' });
  });

  it('not-authed: pr view exit 4 maps to not-authed', async () => {
    const view = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const p = reader.status({ worktreeId: '/repo/.worktrees/feat' });
    view.emitStderr('gh auth login');
    view.emitExit(4);
    expect(await p).toEqual({ kind: 'not-authed' });
  });

  it('timeout: a runner that never exits is killed and resolves to error', async () => {
    const view = makeFakeRunner();
    const { reader } = makeDeps({
      fakes: [view],
      branch: 'feature/login',
      worktreePath: '/repo/.worktrees/feat',
      hasUpstream: true,
    });
    const status = await reader.status({ worktreeId: '/repo/.worktrees/feat' });
    expect(status.kind).toBe('error');
    expect(view.killed()).toBe(true);
  });
});
