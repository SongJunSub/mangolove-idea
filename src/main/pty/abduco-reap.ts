import { sessionNameFor } from './abduco-session';

/**
 * Boot-time reaping of ORPHANED detached b-full sessions.
 *
 * b-full's whole promise is that a detached `abduco` session SURVIVES the app
 * quitting/crashing so it can be re-attached on reopen. So we must NOT reap every
 * live session at boot — that would defeat b-full.
 *
 * RECORD-DRIVEN BY DESIGN (a hard safety invariant): reaping iterates the THIS-
 * instance SessionStore records, never the raw live-session list. It can therefore
 * only ever kill a session whose worktree path WE persisted — never one owned by a
 * different userData dir (another install, or a `--user-data-dir`-isolated GUI smoke
 * booting beside the user's real app). A live `mango-` session with no matching
 * record in our store is SPARED here (the user's manual kill-switch still handles
 * it); auto-killing an unrecognized session would risk SIGKILLing work this instance
 * never started.
 *
 * Among sessions we DO own, we reap the ones that can no longer be usefully
 * re-attached, plus a long-TTL backstop for abandoned ones:
 *   - worktree-gone: the record's worktree directory no longer exists on disk, so the
 *                    session can never be re-attached to a real worktree -> orphan.
 *   - ttl-expired  : the record + worktree still exist, but it has been untouched for
 *                    longer than the TTL -> treated as abandoned.
 * Everything else we own (worktree present, within TTL) is KEPT — those are exactly
 * the sessions a reopen will re-attach. ZERO new persisted state: the session name is
 * sessionNameFor(record.worktreePath), so the existing SessionStore records
 * (worktreePath + updatedAt) are sufficient to classify.
 */

/** 7 days. The primary reap trigger (worktree-gone) catches real orphans immediately;
 *  this TTL is only the backstop for a record+worktree that has sat untouched so long
 *  it is considered abandoned. Trade-off: a legitimately long-running detached turn
 *  left untouched > 7 days would be reaped on next boot. */
export const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The minimal SessionRecord slice reaping needs (structural — SessionStore satisfies it). */
export interface ReapRecord {
  readonly worktreePath: string;
  readonly updatedAt: number;
}

/** Pure inputs for the reap decision (no I/O — fully unit-testable). */
export interface ReapSelectInput {
  /** Live OUR-namespace session names (from AbducoLauncher.listLiveDetached). */
  readonly liveNames: readonly string[];
  /** Persisted session records (from SessionStore.all()). */
  readonly records: readonly ReapRecord[];
  /** Worktree-directory existence check (existsSync at the call site). */
  readonly exists: (path: string) => boolean;
  /** Current epoch ms. */
  readonly now: number;
  /** Abandonment backstop in ms (default ORPHAN_TTL_MS). */
  readonly ttlMs?: number;
}

/**
 * Returns the session names to reap. Pure and RECORD-DRIVEN: iterates OUR records,
 * and for each record whose session is currently live, reaps it iff its worktree dir
 * is gone OR its record is older than the TTL. A live session with no matching record
 * is never returned (not ours to auto-kill); a kept name is one a reopen could still
 * re-attach.
 */
export function selectReapableSessions(input: ReapSelectInput): string[] {
  const ttlMs = input.ttlMs ?? ORPHAN_TTL_MS;
  const live = new Set(input.liveNames);
  const reap: string[] = [];
  for (const record of input.records) {
    const name = sessionNameFor(record.worktreePath);
    if (!live.has(name)) continue; // session isn't live -> nothing to reap
    const orphaned = !input.exists(record.worktreePath) || input.now - record.updatedAt > ttlMs;
    if (orphaned) reap.push(name);
  }
  return reap;
}

/** Effects the boot-reap needs (injected so the orchestrator is unit-testable). */
export interface ReapDeps {
  /** Lists OUR live detached session names. */
  readonly listLiveDetached: () => Promise<string[]>;
  /** Loads the persisted session records. */
  readonly loadRecords: () => ReapRecord[];
  /** Ends the detached session with this EXACT mango name. */
  readonly endDetachedByName: (name: string) => Promise<void>;
  readonly exists: (path: string) => boolean;
  readonly now: () => number;
  readonly ttlMs?: number;
}

/**
 * Reaps orphaned detached sessions at boot and returns the names actually reaped.
 * BEST-EFFORT and never throws: any failure (abduco hiccup, a single kill error)
 * is swallowed so it can never block app startup. Each reap is awaited
 * individually so one failure does not abort the rest.
 */
export async function reapOrphanDetachedSessions(deps: ReapDeps): Promise<string[]> {
  let liveNames: string[];
  try {
    liveNames = await deps.listLiveDetached();
  } catch {
    return []; // can't enumerate -> reap nothing this boot
  }

  const toReap = selectReapableSessions({
    liveNames,
    records: deps.loadRecords(),
    exists: deps.exists,
    now: deps.now(),
    ttlMs: deps.ttlMs,
  });

  const reaped: string[] = [];
  for (const name of toReap) {
    try {
      await deps.endDetachedByName(name);
      reaped.push(name);
    } catch {
      // one orphan failed to reap (transient) — leave it for a later boot, keep going
    }
  }
  return reaped;
}
