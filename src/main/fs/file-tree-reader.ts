import { resolve, sep } from 'node:path';
import type { TreeEntry, TreeListRequest } from '../../shared/types';

/**
 * Reads a worktree's directory tree for the renderer's file explorer (A3).
 *
 * SECURITY (load-bearing): the renderer must NEVER be able to read an arbitrary path.
 * The worktree id IS its absolute path, so a request could carry any path — therefore:
 *   1. The requested worktreeId MUST be one of the CURRENT known worktrees (trusted list
 *      from WorktreeManager); an unknown id is rejected.
 *   2. The base is the worktree's REAL path; the requested relPath is joined and checked
 *      to stay within it (blocks `..` traversal), then the resolved target's REAL path is
 *      re-checked (blocks symlink escapes out of the worktree).
 * Anything outside the worktree throws — never lists.
 */

/** True iff `p` is exactly `base` or strictly nested under it (both absolute + normalized). */
export function isWithin(base: string, p: string): boolean {
  const b = base.endsWith(sep) ? base.slice(0, -1) : base;
  return p === b || p.startsWith(b + sep);
}

/** Directories first, then files; case-insensitive alphabetical within each group. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** A directory entry as fs.readdirSync({withFileTypes:true}) yields (the slice we use). */
export interface DirentLike {
  readonly name: string;
  isDirectory(): boolean;
}

export interface FileTreeReaderDeps {
  /** Current worktree ids (= absolute paths) from the trusted WorktreeManager. */
  readonly knownWorktreeIds: () => Promise<ReadonlySet<string>>;
  /** Resolves symlinks + canonicalizes; throws if the path doesn't exist. */
  readonly realpathSync: (p: string) => string;
  /** Lists a directory's entries (withFileTypes). */
  readonly readdirSync: (p: string) => readonly DirentLike[];
}

/** Entries never shown in the tree (noise / not useful to browse). */
const HIDDEN = new Set(['.git']);

export class FileTreeReader {
  constructor(private readonly deps: FileTreeReaderDeps) {}

  /** Lists the entries of `relPath` within the worktree, scoped + sorted. Throws on escape. */
  async list(req: TreeListRequest): Promise<TreeEntry[]> {
    const known = await this.deps.knownWorktreeIds();
    if (!known.has(req.worktreeId)) {
      throw new Error('unknown worktree'); // never read a path the app doesn't own
    }
    const baseReal = this.deps.realpathSync(req.worktreeId);
    const target = resolve(baseReal, req.relPath ?? '');
    if (!isWithin(baseReal, target)) throw new Error('path escapes the worktree');
    const targetReal = this.deps.realpathSync(target);
    if (!isWithin(baseReal, targetReal)) throw new Error('path escapes the worktree (symlink)');

    const entries = this.deps
      .readdirSync(targetReal)
      .filter((d) => !HIDDEN.has(d.name))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    return sortEntries(entries);
  }
}
