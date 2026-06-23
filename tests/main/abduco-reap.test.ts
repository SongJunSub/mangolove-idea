import { describe, it, expect } from 'vitest';
import {
  selectReapableSessions,
  reapOrphanDetachedSessions,
  ORPHAN_TTL_MS,
  type ReapRecord,
} from '../../src/main/pty/abduco-reap';
import { sessionNameFor } from '../../src/main/pty/abduco-session';

const NOW = 1_700_000_000_000;
const WT_KEEP = '/repo/.worktrees/keep';
const WT_GONE = '/repo/.worktrees/gone';
const WT_OLD = '/repo/.worktrees/old';
const NAME_KEEP = sessionNameFor(WT_KEEP);
const NAME_GONE = sessionNameFor(WT_GONE);
const NAME_OLD = sessionNameFor(WT_OLD);
const NAME_NO_RECORD = sessionNameFor('/repo/.worktrees/orphan');

/** exists() that returns true for every path EXCEPT the listed gone ones. */
function existsExcept(...gone: string[]): (p: string) => boolean {
  const goneSet = new Set(gone);
  return (p) => !goneSet.has(p);
}

const rec = (worktreePath: string, updatedAt: number): ReapRecord => ({ worktreePath, updatedAt });

describe('selectReapableSessions', () => {
  it('KEEP (b-full preservation): record present, worktree present, within TTL -> NOT reaped', () => {
    const reap = selectReapableSessions({
      liveNames: [NAME_KEEP],
      records: [rec(WT_KEEP, NOW - 60_000)],
      exists: existsExcept(),
      now: NOW,
    });
    expect(reap).toEqual([]);
  });

  it('SAFETY: a live session with no matching record is SPARED (not ours to auto-kill)', () => {
    // Mirrors a --user-data-dir-isolated smoke booting beside the user's real app, or a
    // second install: their live mango sessions have no record in OUR store and must
    // never be auto-reaped (only the user's manual kill-switch may end them).
    const reap = selectReapableSessions({
      liveNames: [NAME_NO_RECORD],
      records: [rec(WT_KEEP, NOW)],
      exists: existsExcept(),
      now: NOW,
    });
    expect(reap).toEqual([]);
  });

  it('worktree-gone: record exists but its worktree dir is gone -> reaped', () => {
    const reap = selectReapableSessions({
      liveNames: [NAME_GONE],
      records: [rec(WT_GONE, NOW)],
      exists: existsExcept(WT_GONE),
      now: NOW,
    });
    expect(reap).toEqual([NAME_GONE]);
  });

  it('ttl-expired: record + worktree present but older than TTL -> reaped', () => {
    const reap = selectReapableSessions({
      liveNames: [NAME_OLD],
      records: [rec(WT_OLD, NOW - ORPHAN_TTL_MS - 1)],
      exists: existsExcept(),
      now: NOW,
    });
    expect(reap).toEqual([NAME_OLD]);
  });

  it('TTL boundary is exclusive: exactly TTL old is KEPT (not yet abandoned)', () => {
    const reap = selectReapableSessions({
      liveNames: [NAME_OLD],
      records: [rec(WT_OLD, NOW - ORPHAN_TTL_MS)],
      exists: existsExcept(),
      now: NOW,
    });
    expect(reap).toEqual([]);
  });

  it('mixed set: reaps exactly the owned orphans, keeps reattachable + spares no-record', () => {
    const reap = selectReapableSessions({
      liveNames: [NAME_KEEP, NAME_GONE, NAME_OLD, NAME_NO_RECORD],
      records: [
        rec(WT_KEEP, NOW - 1000),
        rec(WT_GONE, NOW - 1000),
        rec(WT_OLD, NOW - ORPHAN_TTL_MS - 1),
      ],
      exists: existsExcept(WT_GONE),
      now: NOW,
    });
    expect(reap.sort()).toEqual([NAME_GONE, NAME_OLD].sort());
    expect(reap).not.toContain(NAME_KEEP); // reattachable
    expect(reap).not.toContain(NAME_NO_RECORD); // not ours
  });

  it('a record whose session is NOT live is skipped (nothing to reap)', () => {
    const reap = selectReapableSessions({
      liveNames: [], // none live
      records: [rec(WT_GONE, NOW - ORPHAN_TTL_MS - 1)], // would-be orphan, but not live
      exists: existsExcept(WT_GONE),
      now: NOW,
    });
    expect(reap).toEqual([]);
  });

  it('custom ttlMs overrides the default', () => {
    const reap = selectReapableSessions({
      liveNames: [NAME_OLD],
      records: [rec(WT_OLD, NOW - 2000)],
      exists: existsExcept(),
      now: NOW,
      ttlMs: 1000,
    });
    expect(reap).toEqual([NAME_OLD]);
  });
});

describe('reapOrphanDetachedSessions', () => {
  function harness(over: {
    live?: string[];
    records?: ReapRecord[];
    gone?: string[];
    endThrowsFor?: string;
  }) {
    const ended: string[] = [];
    const deps = {
      listLiveDetached: async () => over.live ?? [],
      loadRecords: () => over.records ?? [],
      endDetachedByName: async (name: string) => {
        if (name === over.endThrowsFor) throw new Error('kill failed');
        ended.push(name);
      },
      exists: existsExcept(...(over.gone ?? [])),
      now: () => NOW,
    };
    return { deps, ended };
  }

  it('ends exactly the owned orphans and returns them; keeps reattachable, spares no-record', async () => {
    const { deps, ended } = harness({
      live: [NAME_KEEP, NAME_GONE, NAME_NO_RECORD],
      records: [rec(WT_KEEP, NOW), rec(WT_GONE, NOW)],
      gone: [WT_GONE],
    });
    const reaped = await reapOrphanDetachedSessions(deps);
    expect(reaped).toEqual([NAME_GONE]);
    expect(ended).toEqual([NAME_GONE]);
  });

  it('never reaps a reattachable session (KEEP) — b-full preservation end-to-end', async () => {
    const { deps, ended } = harness({
      live: [NAME_KEEP],
      records: [rec(WT_KEEP, NOW - 60_000)],
    });
    expect(await reapOrphanDetachedSessions(deps)).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('returns [] and reaps nothing when listing throws (boot must not break)', async () => {
    const ended: string[] = [];
    const reaped = await reapOrphanDetachedSessions({
      listLiveDetached: async () => {
        throw new Error('abduco hiccup');
      },
      loadRecords: () => [],
      endDetachedByName: async (n) => void ended.push(n),
      exists: () => true,
      now: () => NOW,
    });
    expect(reaped).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('a single kill failure does not abort the rest', async () => {
    // Two owned orphans (both worktree-gone); the first kill throws, the second must
    // still be reaped.
    const { deps } = harness({
      live: [NAME_GONE, NAME_OLD],
      records: [rec(WT_GONE, NOW), rec(WT_OLD, NOW)],
      gone: [WT_GONE, WT_OLD],
      endThrowsFor: NAME_GONE,
    });
    const reaped = await reapOrphanDetachedSessions(deps);
    expect(reaped).toEqual([NAME_OLD]);
  });
});
