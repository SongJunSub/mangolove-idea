import { describe, it, expect } from 'vitest';
import {
  FileTreeReader,
  isWithin,
  sortEntries,
  type FileTreeReaderDeps,
  type DirentLike,
} from '../../src/main/fs/file-tree-reader';

const dirent = (name: string, isDir: boolean): DirentLike => ({ name, isDirectory: () => isDir });

describe('isWithin (pure path-containment)', () => {
  it('accepts the base itself and nested paths', () => {
    expect(isWithin('/repo/wt', '/repo/wt')).toBe(true);
    expect(isWithin('/repo/wt', '/repo/wt/src/App.tsx')).toBe(true);
    expect(isWithin('/repo/wt/', '/repo/wt/src')).toBe(true); // trailing slash on base
  });
  it('rejects siblings, parents, and prefix-collisions', () => {
    expect(isWithin('/repo/wt', '/repo')).toBe(false);
    expect(isWithin('/repo/wt', '/etc/passwd')).toBe(false);
    expect(isWithin('/repo/wt', '/repo/wt-evil/x')).toBe(false); // prefix but not nested
  });
});

describe('sortEntries', () => {
  it('puts directories first, then files, each case-insensitive alpha', () => {
    const out = sortEntries([
      { name: 'README.md', isDir: false },
      { name: 'src', isDir: true },
      { name: 'b.ts', isDir: false },
      { name: 'Apps', isDir: true },
    ]);
    expect(out.map((e) => e.name)).toEqual(['Apps', 'src', 'b.ts', 'README.md']);
  });
});

/** Builds a reader with one known worktree + a realpath/readdir map. */
function makeReader(
  over: Partial<FileTreeReaderDeps> = {},
  realMap: Record<string, string> = {},
  dirMap: Record<string, DirentLike[]> = {},
): FileTreeReader {
  return new FileTreeReader({
    knownWorktreeIds: async () => new Set(['/repo/wt']),
    realpathSync: (p) => realMap[p] ?? p,
    readdirSync: (p) => dirMap[p] ?? [],
    ...over,
  });
}

describe('FileTreeReader.list (security-scoped)', () => {
  it('lists + sorts entries, dropping .git', async () => {
    const reader = makeReader(
      {},
      {},
      {
        '/repo/wt/src': [dirent('b.ts', false), dirent('a', true), dirent('.git', true)],
      },
    );
    const out = await reader.list({ worktreeId: '/repo/wt', relPath: 'src' });
    expect(out).toEqual([
      { name: 'a', isDir: true },
      { name: 'b.ts', isDir: false },
    ]);
  });

  it('rejects an UNKNOWN worktree id (renderer cannot read an arbitrary path)', async () => {
    const reader = makeReader();
    await expect(reader.list({ worktreeId: '/etc', relPath: '' })).rejects.toThrow(
      /unknown worktree/,
    );
  });

  it("rejects a '..' traversal out of the worktree", async () => {
    const reader = makeReader();
    await expect(reader.list({ worktreeId: '/repo/wt', relPath: '../../etc' })).rejects.toThrow(
      /escapes the worktree/,
    );
  });

  it('rejects a SYMLINK whose real path escapes the worktree', async () => {
    // lexically /repo/wt/link is inside, but realpath resolves it outside.
    const reader = makeReader({}, { '/repo/wt/link': '/etc/secrets' });
    await expect(reader.list({ worktreeId: '/repo/wt', relPath: 'link' })).rejects.toThrow(
      /symlink/,
    );
  });

  it("reads the root when relPath is omitted ('')", async () => {
    const reader = makeReader({}, {}, { '/repo/wt': [dirent('package.json', false)] });
    const out = await reader.list({ worktreeId: '/repo/wt' });
    expect(out).toEqual([{ name: 'package.json', isDir: false }]);
  });
});
