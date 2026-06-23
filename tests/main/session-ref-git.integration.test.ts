import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRefSyncGit } from '../../src/main/sync/session-ref-git';
import { SessionRefSync, SYNC_BRANCH } from '../../src/main/sync/session-ref-sync';
import type { CrossMachineSessionPointer } from '../../src/shared/types';

/** Real-git integration: a bare remote + two clones (machines A and B). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const ptr = (over: Partial<CrossMachineSessionPointer>): CrossMachineSessionPointer => ({
  branch: 'main',
  status: 'running',
  hasActiveTurn: true,
  machineId: 'm-aaaa',
  machineLabel: 'work-mac',
  updatedAt: 1_700_000_000_000,
  ...over,
});

describe('createRefSyncGit (real git, 2-clone)', () => {
  let base: string;
  let remote: string;
  let cloneA: string;
  let cloneB: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'mango-sync-it-'));
    remote = join(base, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
    cloneA = join(base, 'A');
    execFileSync('git', ['clone', '--quiet', remote, cloneA]);
    git(cloneA, 'config', 'user.email', 't@x');
    git(cloneA, 'config', 'user.name', 'T');
    writeFileSync(join(cloneA, 'f.txt'), 'work\n');
    git(cloneA, 'add', '.');
    git(cloneA, 'commit', '--quiet', '-m', 'init');
    git(cloneA, 'push', '--quiet', 'origin', 'main');
    // Feature branches on the remote (so the privacy filter has >1 remote branch);
    // one carries a slash, as real branches commonly do (e.g. feature/foo).
    git(cloneA, 'push', '--quiet', 'origin', 'main:refs/heads/feat-x');
    git(cloneA, 'push', '--quiet', 'origin', 'main:refs/heads/feature/foo');
    cloneB = join(base, 'B');
    execFileSync('git', ['clone', '--quiet', remote, cloneB]);
    git(cloneB, 'config', 'user.email', 't@x');
    git(cloneB, 'config', 'user.name', 'T');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('round-trips pointers A -> remote -> B, dropping local-only branches', async () => {
    const syncA = new SessionRefSync(createRefSyncGit(cloneA));
    const pushed = await syncA.publish('m-aaaa', [
      ptr({ branch: 'feat-x', machineId: 'm-aaaa' }),
      ptr({ branch: 'secret-local', machineId: 'm-aaaa' }), // not on remote -> filtered out
    ]);
    expect(pushed).toBe(true);

    const syncB = new SessionRefSync(createRefSyncGit(cloneB));
    const seen = await syncB.fetchAll();
    expect(seen.map((p) => p.branch)).toEqual(['feat-x']); // local-only branch never published
    expect(seen[0].machineLabel).toBe('work-mac');
  });

  it('is conflict-free: A and B publish, both files coexist', async () => {
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [
      ptr({ machineId: 'm-aaaa', branch: 'main' }),
    ]);
    await new SessionRefSync(createRefSyncGit(cloneB)).publish('m-bbbb', [
      ptr({ machineId: 'm-bbbb', branch: 'feat-x' }),
    ]);

    const all = await new SessionRefSync(createRefSyncGit(cloneA)).fetchAll();
    expect(all.map((p) => p.machineId).sort()).toEqual(['m-aaaa', 'm-bbbb']);
  });

  it('never touches the working tree or creates a local sync branch', async () => {
    const headBefore = git(cloneA, 'rev-parse', 'HEAD');
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [ptr({ branch: 'main' })]);
    expect(git(cloneA, 'rev-parse', 'HEAD')).toBe(headBefore); // HEAD unmoved
    expect(git(cloneA, 'status', '--porcelain')).toBe(''); // working tree clean
    expect(git(cloneA, 'branch', '--list', SYNC_BRANCH)).toBe(''); // no local sync branch
    expect(git(cloneA, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // still on main
  });

  it('fetchAll is [] before any machine has published (branch absent)', async () => {
    expect(await new SessionRefSync(createRefSyncGit(cloneB)).fetchAll()).toEqual([]);
  });

  it('remoteBranches reflects pushed branches (incl. slashed names) and excludes the sync branch', async () => {
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [ptr({ branch: 'main' })]);
    const names = await createRefSyncGit(cloneA).remoteBranches();
    expect(names.sort()).toEqual(['feat-x', 'feature/foo', 'main']); // mangolove-sessions excluded
  });

  it('round-trips a pointer on a slash-containing branch (A -> remote -> B)', async () => {
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [
      ptr({ branch: 'feature/foo', machineId: 'm-aaaa' }),
    ]);
    const seen = await new SessionRefSync(createRefSyncGit(cloneB)).fetchAll();
    expect(seen.map((p) => p.branch)).toEqual(['feature/foo']);
  });

  it('resolves a REAL non-fast-forward race via retry with no lost update', async () => {
    // Seed the branch, then force a genuine race: A and B both build on the SAME tip.
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [
      ptr({ machineId: 'm-aaaa', branch: 'main' }),
    ]);
    const opsA = createRefSyncGit(cloneA);
    const opsB = createRefSyncGit(cloneB);
    const tipA = await opsA.fetchSyncTip();
    const tipB = await opsB.fetchSyncTip();
    expect(tipA).toBe(tipB); // both see the same parent -> a real race is set up

    // A wins the push.
    const commitA = await opsA.buildOwnFileCommit(
      tipA,
      'm-aaaa',
      JSON.stringify([ptr({ machineId: 'm-aaaa', branch: 'main', status: 'ended' })]),
    );
    expect(await opsA.pushSyncTip(commitA)).toBe(true);

    // B pushes on the now-stale parent -> REAL git non-fast-forward rejection.
    // This is the only test that exercises isNonFastForward() against real git stderr.
    const commitB = await opsB.buildOwnFileCommit(
      tipB,
      'm-bbbb',
      JSON.stringify([ptr({ machineId: 'm-bbbb', branch: 'feat-x' })]),
    );
    expect(await opsB.pushSyncTip(commitB)).toBe(false); // classified retryable, NOT thrown

    // B's full publish() retry re-fetches A's tip, rebuilds, and succeeds.
    expect(
      await new SessionRefSync(opsB).publish('m-bbbb', [
        ptr({ machineId: 'm-bbbb', branch: 'feat-x' }),
      ]),
    ).toBe(true);

    // Both machines' updates survive (A's 'ended' + B's file): no lost update.
    const all = await new SessionRefSync(createRefSyncGit(cloneA)).fetchAll();
    expect(all.map((p) => p.machineId).sort()).toEqual(['m-aaaa', 'm-bbbb']);
    expect(all.find((p) => p.machineId === 'm-aaaa')?.status).toBe('ended');
  });

  it('republishing the SAME machine overwrites its own file and preserves others', async () => {
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [
      ptr({ machineId: 'm-aaaa', branch: 'main', status: 'running' }),
    ]);
    await new SessionRefSync(createRefSyncGit(cloneB)).publish('m-bbbb', [
      ptr({ machineId: 'm-bbbb', branch: 'feat-x' }),
    ]);
    // A publishes AGAIN with changed content.
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [
      ptr({ machineId: 'm-aaaa', branch: 'main', status: 'ended' }),
    ]);

    const all = await new SessionRefSync(createRefSyncGit(cloneB)).fetchAll();
    expect(all.map((p) => p.machineId).sort()).toEqual(['m-aaaa', 'm-bbbb']); // B's file intact, A's not duplicated
    expect(all.find((p) => p.machineId === 'm-aaaa')?.status).toBe('ended'); // A's latest content
  });

  it('listFiles skips a stray non-.json entry on the sync branch and never throws', async () => {
    await new SessionRefSync(createRefSyncGit(cloneA)).publish('m-aaaa', [
      ptr({ machineId: 'm-aaaa', branch: 'main' }),
    ]);
    // Hand-build a commit that ADDS a stray README alongside the machine files.
    const tip = git(cloneA, 'rev-parse', 'refs/remotes/origin/mangolove-sessions');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: cloneA,
      input: 'not json\n',
      encoding: 'utf8',
    }).trim();
    const idx = join(base, 'stray.idx');
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    execFileSync('git', ['read-tree', `${tip}^{tree}`], { cwd: cloneA, env });
    execFileSync('git', ['update-index', '--add', '--cacheinfo', '100644', blob, 'README.md'], {
      cwd: cloneA,
      env,
    });
    const tree = execFileSync('git', ['write-tree'], { cwd: cloneA, env, encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-p', tip, '-m', 'stray'], {
      cwd: cloneA,
      encoding: 'utf8',
    }).trim();
    git(cloneA, 'push', '--quiet', 'origin', `${commit}:refs/heads/${SYNC_BRANCH}`);

    const all = await new SessionRefSync(createRefSyncGit(cloneB)).fetchAll();
    expect(all.map((p) => p.machineId)).toEqual(['m-aaaa']); // stray README ignored, valid pointer kept
  });

  it('buildOwnFileCommit cleans up its temp index on success AND on error', async () => {
    const idxFiles = () =>
      readdirSync(tmpdir()).filter((f) => f.startsWith('mango-sync-') && f.endsWith('.idx'));
    const before = idxFiles();
    const ops = createRefSyncGit(cloneA);
    // Success path.
    await ops.buildOwnFileCommit(null, 'm-aaaa', '[]');
    // Error path: an invalid parent sha makes read-tree fail mid-build -> must still clean up.
    await expect(
      ops.buildOwnFileCommit('0000000000000000000000000000000000000000', 'm-aaaa', '[]'),
    ).rejects.toThrow();
    expect(idxFiles().sort()).toEqual(before.sort()); // no leaked temp index from either path
  });
});
