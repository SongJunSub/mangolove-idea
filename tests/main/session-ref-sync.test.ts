import { describe, it, expect } from 'vitest';
import {
  serializePointers,
  parsePointers,
  aggregatePointers,
  filterPublishablePointers,
  SessionRefSync,
  SYNC_BRANCH,
  type RefSyncGitOps,
  type MachineFile,
} from '../../src/main/sync/session-ref-sync';
import type { CrossMachineSessionPointer } from '../../src/shared/types';

const ptr = (over: Partial<CrossMachineSessionPointer> = {}): CrossMachineSessionPointer => ({
  branch: 'feat-x',
  status: 'running',
  hasActiveTurn: true,
  machineId: 'm-aaaa',
  machineLabel: 'work-mac',
  updatedAt: 1_700_000_000_000,
  ...over,
});

describe('serialize/parse round-trip', () => {
  it('round-trips a pointer array', () => {
    const pointers = [ptr(), ptr({ branch: 'feat-y', status: 'idle', hasActiveTurn: false })];
    expect(parsePointers(serializePointers(pointers))).toEqual(pointers);
  });

  it('SYNC_BRANCH is the dedicated orphan branch name', () => {
    expect(SYNC_BRANCH).toBe('mangolove-sessions');
  });
});

describe('parsePointers — untrusted-input hardening', () => {
  it('returns [] on corrupt JSON', () => {
    expect(parsePointers('{not json')).toEqual([]);
  });

  it('returns [] on a non-array top level', () => {
    expect(parsePointers('{"branch":"x"}')).toEqual([]);
  });

  it('drops malformed entries individually, keeps valid ones', () => {
    const content = JSON.stringify([
      ptr(), // valid
      { branch: '', status: 'running', machineId: 'm', machineLabel: 'l', updatedAt: 1 }, // empty branch
      { branch: 'b', status: 'bogus', machineId: 'm', machineLabel: 'l', updatedAt: 1 }, // bad status
      { branch: 'b', status: 'idle', machineId: 'm', machineLabel: 'l', updatedAt: 'nope' }, // bad updatedAt
      { branch: 'b', status: 'ended', machineId: 'm', machineLabel: 'l', updatedAt: 5 }, // valid
      null, // junk
      42, // junk
    ]);
    const parsed = parsePointers(content);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.branch)).toEqual(['feat-x', 'b']);
  });

  it('coerces a non-true hasActiveTurn to false (never trusts shape)', () => {
    const content = JSON.stringify([
      {
        branch: 'b',
        status: 'idle',
        machineId: 'm',
        machineLabel: 'l',
        updatedAt: 1,
        hasActiveTurn: 'yes',
      },
    ]);
    expect(parsePointers(content)[0].hasActiveTurn).toBe(false);
  });

  it('rejects NaN/Infinity updatedAt', () => {
    expect(
      parsePointers(
        JSON.stringify([
          { branch: 'b', status: 'idle', machineId: 'm', machineLabel: 'l', updatedAt: null },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('aggregatePointers', () => {
  it('flattens many machine files into one list, skipping corrupt files', () => {
    const files = [
      { content: serializePointers([ptr({ machineId: 'm-aaaa' })]) },
      { content: '{corrupt' }, // skipped
      { content: serializePointers([ptr({ machineId: 'm-bbbb', branch: 'feat-y' })]) },
    ];
    const all = aggregatePointers(files);
    expect(all.map((p) => p.machineId).sort()).toEqual(['m-aaaa', 'm-bbbb']);
  });

  it('is [] for no files', () => {
    expect(aggregatePointers([])).toEqual([]);
  });
});

describe('filterPublishablePointers — privacy filter', () => {
  it('keeps only pointers whose branch is on the remote (no local-only branch leak)', () => {
    const pointers = [
      ptr({ branch: 'feat-x' }), // on remote
      ptr({ branch: 'secret-local' }), // local-only -> dropped
      ptr({ branch: 'feat-y' }), // on remote
    ];
    const remote = new Set(['feat-x', 'feat-y', 'main']);
    const kept = filterPublishablePointers(pointers, remote);
    expect(kept.map((p) => p.branch)).toEqual(['feat-x', 'feat-y']);
  });

  it('publishes nothing when no branch is on the remote', () => {
    expect(filterPublishablePointers([ptr({ branch: 'local' })], new Set())).toEqual([]);
  });
});

/** Scriptable fake git ops recording calls; `pushResults` is consumed per push attempt. */
function fakeOps(over: {
  files?: MachineFile[];
  remoteBranches?: string[];
  pushResults?: boolean[]; // sequence of pushSyncTip outcomes
  tips?: (string | null)[]; // sequence of fetchSyncTip results
  // Force a specific op to REJECT (models a real git hard error, vs the boolean non-ff).
  throws?: { push?: boolean; remoteBranches?: boolean; listFiles?: boolean };
}) {
  const calls = {
    fetchSyncTip: 0,
    builds: [] as { parent: string | null; machineId: string; content: string }[],
    pushes: [] as string[],
  };
  const pushResults = over.pushResults ?? [true];
  const tips = over.tips ?? [];
  const t = over.throws ?? {};
  const ops: RefSyncGitOps = {
    fetchSyncTip: async () => tips[calls.fetchSyncTip++] ?? null,
    remoteBranches: async () => {
      if (t.remoteBranches) throw new Error('ls-remote failed');
      return over.remoteBranches ?? [];
    },
    listFiles: async () => {
      if (t.listFiles) throw new Error('ls-tree failed');
      return over.files ?? [];
    },
    buildOwnFileCommit: async (parent, machineId, content) => {
      calls.builds.push({ parent, machineId, content });
      return `commit-${calls.builds.length}`;
    },
    pushSyncTip: async (sha) => {
      calls.pushes.push(sha);
      if (t.push) throw new Error('git push (sync) failed');
      return pushResults[calls.pushes.length - 1] ?? false;
    },
  };
  return { ops, calls };
}

describe('SessionRefSync.fetchAll', () => {
  it('aggregates every machine file into one pointer list', async () => {
    const { ops } = fakeOps({
      files: [
        { machineId: 'm-aaaa', content: serializePointers([ptr({ machineId: 'm-aaaa' })]) },
        {
          machineId: 'm-bbbb',
          content: serializePointers([ptr({ machineId: 'm-bbbb', branch: 'feat-y' })]),
        },
      ],
    });
    const all = await new SessionRefSync(ops).fetchAll();
    expect(all.map((p) => p.machineId).sort()).toEqual(['m-aaaa', 'm-bbbb']);
  });
});

describe('SessionRefSync.publish', () => {
  it('publishes only remote-branch pointers and pushes once on success', async () => {
    const { ops, calls } = fakeOps({ remoteBranches: ['feat-x'], pushResults: [true] });
    const pushed = await new SessionRefSync(ops).publish('m-aaaa', [
      ptr({ branch: 'feat-x' }),
      ptr({ branch: 'local-only' }), // filtered out (not on remote)
    ]);
    expect(pushed).toBe(true);
    expect(calls.pushes).toHaveLength(1);
    // The committed content must contain feat-x and NOT the local-only branch.
    const content = calls.builds[0].content;
    expect(content).toContain('feat-x');
    expect(content).not.toContain('local-only');
    expect(calls.builds[0].machineId).toBe('m-aaaa');
  });

  it('retries on a non-fast-forward rejection and succeeds (no lost update)', async () => {
    const { ops, calls } = fakeOps({
      remoteBranches: ['feat-x'],
      pushResults: [false, true], // first push rejected, second accepted
      tips: ['tipA', 'tipB'], // re-fetch sees the advanced tip
    });
    const pushed = await new SessionRefSync(ops).publish('m-aaaa', [ptr({ branch: 'feat-x' })]);
    expect(pushed).toBe(true);
    expect(calls.pushes).toHaveLength(2); // retried exactly once
    expect(calls.fetchSyncTip).toBe(2); // re-fetched the advanced tip before rebuilding
    expect(calls.builds[1].parent).toBe('tipB'); // rebuilt on the NEW tip
  });

  it('gives up after a bounded number of attempts (best-effort, never loops forever)', async () => {
    const { ops, calls } = fakeOps({
      remoteBranches: ['feat-x'],
      pushResults: [false, false, false, false, false, false], // always rejected
    });
    const pushed = await new SessionRefSync(ops).publish('m-aaaa', [ptr({ branch: 'feat-x' })]);
    expect(pushed).toBe(false);
    expect(calls.pushes).toHaveLength(5); // MAX_PUBLISH_ATTEMPTS
  });

  it('a THROWN push (hard git error, not non-ff) propagates and is NOT retried', async () => {
    const { ops, calls } = fakeOps({ remoteBranches: ['feat-x'], throws: { push: true } });
    await expect(
      new SessionRefSync(ops).publish('m-aaaa', [ptr({ branch: 'feat-x' })]),
    ).rejects.toThrow(/git push/);
    expect(calls.pushes).toHaveLength(1); // aborted on the throw — not looped to MAX
  });

  it('a THROWN remoteBranches propagates before any commit is built', async () => {
    const { ops, calls } = fakeOps({ throws: { remoteBranches: true } });
    await expect(
      new SessionRefSync(ops).publish('m-aaaa', [ptr({ branch: 'feat-x' })]),
    ).rejects.toThrow(/ls-remote/);
    expect(calls.builds).toHaveLength(0);
    expect(calls.pushes).toHaveLength(0);
  });
});

describe('SessionRefSync.fetchAll — error propagation', () => {
  it('a THROWN listFiles propagates out of fetchAll', async () => {
    const { ops } = fakeOps({ throws: { listFiles: true } });
    await expect(new SessionRefSync(ops).fetchAll()).rejects.toThrow(/ls-tree/);
  });
});
