import { describe, it, expect } from 'vitest';
import {
  buildPointers,
  SessionPublisher,
  type SessionPublisherDeps,
} from '../../src/main/sync/session-publisher';
import type { MachineIdentity } from '../../src/main/sync/machine-identity';

const ID: MachineIdentity = { machineId: 'm-aaaa', machineLabel: 'work-mac' };

describe('buildPointers', () => {
  it('maps live sessions to pointers (running iff a turn is active)', () => {
    const ptrs = buildPointers(
      [
        { branch: 'feat-x', hasActiveTurn: true },
        { branch: 'feat-y', hasActiveTurn: false },
      ],
      ID,
      1234,
    );
    expect(ptrs).toEqual([
      {
        branch: 'feat-x',
        status: 'running',
        hasActiveTurn: true,
        machineId: 'm-aaaa',
        machineLabel: 'work-mac',
        updatedAt: 1234,
      },
      {
        branch: 'feat-y',
        status: 'idle',
        hasActiveTurn: false,
        machineId: 'm-aaaa',
        machineLabel: 'work-mac',
        updatedAt: 1234,
      },
    ]);
  });

  it('is [] when no sessions are live (ended sessions are simply absent)', () => {
    expect(buildPointers([], ID, 1)).toEqual([]);
  });
});

/** A deferred promise so a test can hold a publish open and drive coalescing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(over: Partial<SessionPublisherDeps> & { enabled?: boolean } = {}) {
  const publishes: { machineId: string; pointers: unknown[] }[] = [];
  let sessions: { branch: string; hasActiveTurn: boolean }[] = [];
  const deps: SessionPublisherDeps = {
    isEnabled: () => over.enabled ?? true,
    identity: () => ID,
    liveSessions: async () => sessions,
    publish: async (machineId, pointers) => {
      publishes.push({ machineId, pointers });
      return true;
    },
    now: () => 1,
    ...over,
  };
  return { deps, publishes, setSessions: (s: typeof sessions) => (sessions = s) };
}

describe('SessionPublisher gate', () => {
  it('does nothing when opted out (no publish, no liveSessions read)', async () => {
    let liveRead = 0;
    const { deps, publishes } = harness({
      enabled: false,
      liveSessions: async () => {
        liveRead++;
        return [];
      },
    });
    new SessionPublisher(deps).notifyChanged();
    await Promise.resolve();
    expect(publishes).toEqual([]);
    expect(liveRead).toBe(0);
  });

  it('publishes the current live sessions when enabled', async () => {
    const { deps, publishes, setSessions } = harness({});
    setSessions([{ branch: 'feat-x', hasActiveTurn: true }]);
    const pub = new SessionPublisher(deps);
    pub.notifyChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(publishes).toHaveLength(1);
    expect(publishes[0].machineId).toBe('m-aaaa');
    expect(publishes[0].pointers).toHaveLength(1);
  });
});

describe('SessionPublisher coalescing', () => {
  it('coalesces a burst into at most one extra publish (no overlapping pushes)', async () => {
    const gate = deferred<void>();
    let started = 0;
    const { deps, publishes } = harness({
      publish: async (machineId, pointers) => {
        started++;
        publishes.push({ machineId, pointers });
        if (started === 1) await gate.promise; // hold the first publish open
        return true;
      },
    });
    const pub = new SessionPublisher(deps);
    pub.notifyChanged(); // starts publish #1 (now in-flight, awaiting gate)
    await Promise.resolve();
    pub.notifyChanged(); // dirty
    pub.notifyChanged(); // still dirty (coalesced, not a 3rd publish)
    pub.notifyChanged();
    expect(publishes).toHaveLength(1); // only #1 has started so far
    gate.resolve(); // let #1 finish -> exactly ONE more publish for the coalesced burst
    await new Promise((r) => setTimeout(r, 0));
    expect(publishes).toHaveLength(2);
    // A later, separate notification publishes again (not stuck).
    pub.notifyChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(publishes).toHaveLength(3);
  });

  it('a publish rejection is swallowed (best-effort) and routed to onError', async () => {
    const errors: unknown[] = [];
    const { deps } = harness({
      publish: async () => {
        throw new Error('push failed');
      },
      onError: (e) => errors.push(e),
    });
    new SessionPublisher(deps).notifyChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
  });
});
