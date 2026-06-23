import type { CrossMachineSessionPointer } from '../../shared/types';

/**
 * Pure core of cross-machine session sync (no git, no I/O — fully unit-testable).
 *
 * Each machine owns ONE file on the shared `mangolove-sessions` orphan branch,
 * `<machineId>.json`, holding its own pointer array. Reading aggregates every
 * machine's file; writing only ever touches this machine's own file (conflict-free).
 * Content on that branch is written by OTHER machines and possibly OTHER versions, so
 * it is untrusted input — every parsed entry is strictly validated and malformed ones
 * are dropped (defense in depth, mirroring SessionStore's corrupt-safe philosophy).
 */

/** The dedicated orphan branch that carries per-machine pointer files. */
export const SYNC_BRANCH = 'mangolove-sessions';

const VALID_STATUSES: ReadonlySet<string> = new Set(['running', 'idle', 'ended']);

/** Serializes THIS machine's pointers to the JSON content of its `<machineId>.json`. */
export function serializePointers(pointers: readonly CrossMachineSessionPointer[]): string {
  return JSON.stringify(pointers, null, 2);
}

/**
 * Validates one untrusted entry down to EXACTLY the pointer contract, or null if it
 * is malformed in any field. Strict on every field (no shape-trust): branch and
 * machine fields must be non-empty strings, status must be one of the allowed values,
 * updatedAt a finite number; hasActiveTurn defaults to false unless strictly true.
 */
function sanitizePointer(entry: unknown): CrossMachineSessionPointer | null {
  if (entry === null || typeof entry !== 'object') return null;
  const r = entry as Record<string, unknown>;
  if (typeof r.branch !== 'string' || r.branch === '') return null;
  if (typeof r.status !== 'string' || !VALID_STATUSES.has(r.status)) return null;
  if (typeof r.machineId !== 'string' || r.machineId === '') return null;
  if (typeof r.machineLabel !== 'string' || r.machineLabel === '') return null;
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
  return {
    branch: r.branch,
    status: r.status as CrossMachineSessionPointer['status'],
    hasActiveTurn: r.hasActiveTurn === true,
    machineId: r.machineId,
    machineLabel: r.machineLabel,
    updatedAt: r.updatedAt,
  };
}

/**
 * Parses ONE machine file's content into valid pointers. Never throws: corrupt JSON
 * or a non-array yields [] (the file is treated as empty), and malformed entries are
 * dropped individually.
 */
export function parsePointers(content: string): CrossMachineSessionPointer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: CrossMachineSessionPointer[] = [];
  for (const entry of raw) {
    const pointer = sanitizePointer(entry);
    if (pointer) out.push(pointer);
  }
  return out;
}

/** Aggregates every machine file's content into one flat, validated pointer list. */
export function aggregatePointers(
  files: readonly { readonly content: string }[],
): CrossMachineSessionPointer[] {
  return files.flatMap((f) => parsePointers(f.content));
}

/**
 * PRIVACY filter applied before publishing: keeps only pointers whose branch already
 * exists on the remote, so a purely-local branch name never reaches the shared sync
 * branch. (Branches already pushed are public knowledge among collaborators anyway.)
 */
export function filterPublishablePointers(
  pointers: readonly CrossMachineSessionPointer[],
  remoteBranches: ReadonlySet<string>,
): CrossMachineSessionPointer[] {
  return pointers.filter((p) => remoteBranches.has(p.branch));
}

/** Bounded retry for the publish race: re-fetch + rebuild on a non-fast-forward push. */
const MAX_PUBLISH_ATTEMPTS = 5;

/** One machine's pointer file as read from the sync branch (name carries its machineId). */
export interface MachineFile {
  readonly machineId: string;
  readonly content: string;
}

/**
 * Injected git operations — the validated `mangolove-sessions` plumbing, split fine
 * enough that the concurrency (non-ff retry) logic lives in the orchestrator and is
 * unit-testable with a fake. The real implementation (session-ref-git) never checks
 * out the branch, so the user's working tree is untouched.
 */
export interface RefSyncGitOps {
  /** Fetches the sync branch; returns its current commit sha, or null if it doesn't exist yet. */
  fetchSyncTip(): Promise<string | null>;
  /** Branch names present on the remote (for the publish privacy filter). */
  remoteBranches(): Promise<string[]>;
  /** Reads every `<machineId>.json` on the sync branch (no checkout). */
  listFiles(): Promise<MachineFile[]>;
  /**
   * Builds a commit on `parentSha` (null => orphan/first commit) that sets ONLY
   * `<machineId>.json` to `content` (preserving every other machine's file via the
   * parent tree) and returns the new commit sha. Pure plumbing — no ref/working-tree
   * mutation yet.
   */
  buildOwnFileCommit(parentSha: string | null, machineId: string, content: string): Promise<string>;
  /**
   * Points the local sync ref at `commitSha` and pushes. Returns false on a
   * non-fast-forward rejection (someone else advanced the branch), true on success.
   */
  pushSyncTip(commitSha: string): Promise<boolean>;
}

/**
 * Orchestrates cross-machine pointer sync over the injected git ops. Reading
 * aggregates every machine's file; publishing writes ONLY this machine's file (after
 * the remote-branch privacy filter) and resolves the publish race by re-fetching the
 * advanced tip and rebuilding on it — so a concurrent push never drops either
 * machine's update (validated by spike). Best-effort: `publish` returns whether it
 * pushed and gives up after a bounded number of attempts rather than looping forever.
 */
export class SessionRefSync {
  constructor(private readonly git: RefSyncGitOps) {}

  /** Reads + validates all machines' pointers (this machine's included). */
  async fetchAll(): Promise<CrossMachineSessionPointer[]> {
    return aggregatePointers(await this.git.listFiles());
  }

  /**
   * Publishes THIS machine's pointers (filtered to branches already on the remote).
   * Returns true once pushed, false if it gave up after MAX_PUBLISH_ATTEMPTS
   * non-fast-forward retries. Throws only on an unexpected git error (the caller
   * best-effort-catches at the trigger site).
   */
  async publish(
    machineId: string,
    localPointers: readonly CrossMachineSessionPointer[],
  ): Promise<boolean> {
    const remote = new Set(await this.git.remoteBranches());
    const content = serializePointers(filterPublishablePointers(localPointers, remote));
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      const parent = await this.git.fetchSyncTip();
      const commit = await this.git.buildOwnFileCommit(parent, machineId, content);
      if (await this.git.pushSyncTip(commit)) return true;
      // non-fast-forward: the next iteration re-fetches the advanced tip and rebuilds.
    }
    return false;
  }
}
