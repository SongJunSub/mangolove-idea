import { resolve, dirname, basename, sep } from 'node:path';

/**
 * THE one audited security gate for every renderer-driven filesystem path (A3 read,
 * A4 read/write). The worktree id IS its absolute path, so a request could carry ANY
 * path — these resolvers are the only thing standing between the renderer and the
 * whole disk. Three invariants, enforced in every resolver:
 *   1. The worktreeId MUST be a CURRENT known worktree (trusted WorktreeManager list).
 *   2. The lexically-joined target MUST stay within the worktree (blocks `..`).
 *   3. The REAL (symlink-followed) target MUST stay within the worktree (blocks
 *      symlink escapes) — and for WRITES, the final component is opened O_NOFOLLOW so
 *      a swapped-in / write-through symlink cannot escape between check and write.
 *
 * EXISTENCE IS lstat-BASED (the load-bearing subtlety): node:fs.existsSync FOLLOWS the
 * final symlink and returns FALSE for a DANGLING out-of-tree link — which would route a
 * dangling in-tree symlink into the NEW-file branch (parent in-tree => accepted) and
 * let writeFile CREATE a file OUTSIDE the worktree. lstat does NOT follow the final
 * component, so it is TRUE for a dangling/looping link, routing it into the existing
 * branch where realpath rejects it. Wire ScopeDeps.lstatSync to node:fs.lstatSync.
 */

/** True iff `p` is exactly `base` or strictly nested under it (both absolute + normalized). */
export function isWithin(base: string, p: string): boolean {
  const b = base.endsWith(sep) ? base.slice(0, -1) : base;
  return p === b || p.startsWith(b + sep);
}

export interface ScopeDeps {
  /** Current worktree ids (= absolute paths) from the trusted WorktreeManager. */
  readonly knownWorktreeIds: () => Promise<ReadonlySet<string>>;
  /** Canonicalizes + FOLLOWS symlinks; THROWS (ENOENT/ELOOP) if missing/looping. */
  readonly realpathSync: (p: string) => string;
  /**
   * lstats the final component WITHOUT following it; THROWS only if NOTHING is there.
   * TRUE for a present file/dir AND for a DANGLING/looping symlink (the non-follow
   * semantics are load-bearing — see the module header). Wire node:fs.lstatSync.
   */
  readonly lstatSync: (p: string) => unknown;
}

/** lexists := an lstat-present entry (true for a dangling/looping symlink). */
function lexists(lstatSync: ScopeDeps['lstatSync'], p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * READ/LIST gate (A3 byte-for-byte). The target MUST already exist. Returns the
 * worktree's real base + the target's real path. Only needs knownWorktreeIds +
 * realpathSync, so FileTreeReaderDeps satisfies it with no lstat seam.
 */
export async function resolveExistingScopedPath(
  deps: Pick<ScopeDeps, 'knownWorktreeIds' | 'realpathSync'>,
  worktreeId: string,
  relPath: string,
): Promise<{ baseReal: string; targetReal: string }> {
  const known = await deps.knownWorktreeIds();
  if (!known.has(worktreeId)) throw new Error('unknown worktree'); // layer 1
  const baseReal = deps.realpathSync(worktreeId);
  const target = resolve(baseReal, relPath ?? '');
  if (!isWithin(baseReal, target)) throw new Error('path escapes the worktree'); // layer 2
  const targetReal = deps.realpathSync(target); // throws if missing
  if (!isWithin(baseReal, targetReal)) throw new Error('path escapes the worktree (symlink)'); // 3
  return { baseReal, targetReal };
}

/** What a write resolves to: the CANONICAL parent + final basename (so the caller can
 *  open with O_NOFOLLOW on the final component). `existed` is informational. */
export interface WritableTarget {
  readonly baseReal: string;
  readonly parentReal: string;
  readonly name: string;
  readonly existed: boolean;
}

/**
 * WRITE gate. Returns {parentReal, name} so the caller opens the final component with
 * O_NOFOLLOW (defeating both the realpath->write TOCTOU re-traversal and a
 * write-through existing symlink). Rejects: unknown worktree, `..` traversal, the
 * worktree root itself, a symlink (dangling/looping/escaping) at the final component,
 * and a symlinked parent at any depth.
 */
export async function resolveWritableScopedPath(
  deps: ScopeDeps,
  worktreeId: string,
  relPath: string,
): Promise<WritableTarget> {
  const known = await deps.knownWorktreeIds();
  if (!known.has(worktreeId)) throw new Error('unknown worktree'); // layer 1
  const baseReal = deps.realpathSync(worktreeId);
  const target = resolve(baseReal, relPath ?? '');
  if (!isWithin(baseReal, target)) throw new Error('path escapes the worktree'); // layer 2
  if (target === baseReal) throw new Error('refusing to write the worktree root'); // never the dir

  if (lexists(deps.lstatSync, target)) {
    // EXISTING entry (incl. a dangling/looping symlink — lexists is TRUE for those).
    // realpath FOLLOWS the chain to the real file a naive writeFile would overwrite;
    // wrap it so an in-tree-looking broken/looping link surfaces the safe symlink
    // message (not a raw ENOENT/ELOOP). The O_NOFOLLOW open at the call site is what
    // actually blocks writing THROUGH a symlink that happened to resolve in-tree.
    let targetReal: string;
    try {
      targetReal = deps.realpathSync(target);
    } catch {
      throw new Error('path escapes the worktree (symlink)'); // ENOENT/ELOOP on a link
    }
    if (!isWithin(baseReal, targetReal)) {
      throw new Error('path escapes the worktree (symlink)'); // layer 3a
    }
    return {
      baseReal,
      parentReal: dirname(targetReal),
      name: basename(targetReal),
      existed: true,
    };
  }

  // NEW file: realpath(target) would throw ENOENT, so realpath the PARENT (must exist
  // and be in-tree). realpath canonicalizes the WHOLE parent chain, so a symlinked
  // intermediate directory at ANY depth is collapsed and rejected here.
  const parentReal = deps.realpathSync(dirname(target)); // throws if parent missing
  if (!isWithin(baseReal, parentReal)) {
    throw new Error('path escapes the worktree (parent symlink)'); // layer 3b
  }
  const finalReal = resolve(parentReal, basename(target));
  if (!isWithin(baseReal, finalReal)) throw new Error('path escapes the worktree');
  return { baseReal, parentReal, name: basename(target), existed: false };
}
