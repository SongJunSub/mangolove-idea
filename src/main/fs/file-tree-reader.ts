import type { TreeEntry, TreeListRequest } from '../../shared/types';
import { isWithin, resolveExistingScopedPath } from './scoped-path';

/**
 * Reads a worktree's directory tree for the renderer's file explorer (A3).
 *
 * SECURITY (load-bearing): the renderer must NEVER be able to read an arbitrary path.
 * The three-layer scope check now lives in scoped-path.ts (shared with A4's editor);
 * this reader delegates to resolveExistingScopedPath, then lists the canonical target.
 */

// Re-exported so the existing tests/main/file-tree-reader.test.ts import stays green
// after isWithin moved to scoped-path.ts (the ONE audited gate).
export { isWithin };

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
    const { targetReal } = await resolveExistingScopedPath(
      this.deps,
      req.worktreeId,
      req.relPath ?? '',
    );

    const entries = this.deps
      .readdirSync(targetReal)
      .filter((d) => !HIDDEN.has(d.name))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    return sortEntries(entries);
  }
}
