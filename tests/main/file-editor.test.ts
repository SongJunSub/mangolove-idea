import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { FileEditor, MAX_BYTES, looksBinary, type StatLike } from '../../src/main/fs/file-editor';

interface Capture {
  readonly parentReal: string;
  readonly name: string;
  readonly content: string;
}

/**
 * Builds a FileEditor over an in-memory file map. realpath is identity (no symlinks in
 * these tests — the symlink-escape surface is covered by scoped-path.test.ts). lstat is
 * "present iff in the map". writeNoFollow records its args AND mutates the map so the
 * post-write fresh-token statSync sees the new bytes.
 */
function makeEditor(
  opts: { files?: Record<string, Buffer>; stats?: Record<string, StatLike>; mtime?: number } = {},
) {
  const files: Record<string, Buffer> = { ...(opts.files ?? {}) };
  const writes: Capture[] = [];
  const mtime = opts.mtime ?? 1000;
  const statSync = (p: string): StatLike => {
    if (opts.stats?.[p]) return opts.stats[p];
    const buf = files[p];
    if (!buf) throw new Error(`ENOENT ${p}`);
    return { isFile: () => true, size: buf.length, mtimeMs: mtime };
  };
  const editor = new FileEditor({
    knownWorktreeIds: async () => new Set(['/repo/wt']),
    realpathSync: (p) => p,
    lstatSync: (p) => {
      if (p in files || opts.stats?.[p]) return {};
      throw new Error(`ENOENT ${p}`);
    },
    statSync,
    readFileSync: (p) => {
      const b = files[p];
      if (!b) throw new Error(`ENOENT ${p}`);
      return b;
    },
    writeNoFollow: (parentReal, name, content) => {
      writes.push({ parentReal, name, content });
      files[join(parentReal, name)] = Buffer.from(content, 'utf8');
    },
  });
  return { editor, writes, files };
}

describe('looksBinary', () => {
  it('flags a NUL byte, passes plain text', () => {
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
    expect(looksBinary(Buffer.from('hello world', 'utf8'))).toBe(false);
  });
});

describe('FileEditor.read', () => {
  it('returns editable UTF-8 text that round-trips byte-identically', async () => {
    const { editor } = makeEditor({
      files: { '/repo/wt/a.ts': Buffer.from('héllo\nworld', 'utf8') },
    });
    const res = await editor.read({ worktreeId: '/repo/wt', relPath: 'a.ts' });
    expect(res.readOnly).toBe(false);
    expect(res.content).toBe('héllo\nworld');
    expect(res.baseToken).toBe(`1000:${Buffer.byteLength('héllo\nworld', 'utf8')}`);
  });

  it('a BINARY file (NUL byte) → readOnly, empty content', async () => {
    const { editor } = makeEditor({
      files: { '/repo/wt/x.png': Buffer.from([0x89, 0x50, 0x00, 0x01]) },
    });
    const res = await editor.read({ worktreeId: '/repo/wt', relPath: 'x.png' });
    expect(res).toMatchObject({ readOnly: true, reason: 'binary', content: '' });
  });

  it('a NON-UTF-8 file (latin-1 high byte, no NUL) → readOnly encoding (never silently corrupted)', async () => {
    // 0xFF 0x41 is invalid utf-8 but has no NUL, so it would pass a NUL-only sniff and
    // (without the strict decoder) become U+FFFD then be destroyed on save.
    const { editor } = makeEditor({ files: { '/repo/wt/latin.txt': Buffer.from([0xff, 0x41]) } });
    const res = await editor.read({ worktreeId: '/repo/wt', relPath: 'latin.txt' });
    expect(res).toMatchObject({ readOnly: true, reason: 'encoding', content: '' });
  });

  it('a too-large file → readOnly tooLarge (no read of the bytes)', async () => {
    const { editor } = makeEditor({
      stats: { '/repo/wt/big.bin': { isFile: () => true, size: MAX_BYTES + 1, mtimeMs: 1000 } },
    });
    const res = await editor.read({ worktreeId: '/repo/wt', relPath: 'big.bin' });
    expect(res).toMatchObject({ readOnly: true, reason: 'tooLarge', content: '' });
  });

  it('rejects a path that is not a regular file', async () => {
    const { editor } = makeEditor({
      stats: { '/repo/wt/adir': { isFile: () => false, size: 0, mtimeMs: 1000 } },
    });
    await expect(editor.read({ worktreeId: '/repo/wt', relPath: 'adir' })).rejects.toThrow(
      /not a file/,
    );
  });
});

describe('FileEditor.write', () => {
  it('writes a NEW file via writeNoFollow with the CANONICAL parent+name (never resolve(base,relPath))', async () => {
    const { editor, writes } = makeEditor();
    await editor.write({
      worktreeId: '/repo/wt',
      relPath: 'src/new.ts',
      content: 'export const x = 1;\n',
    });
    expect(writes).toEqual([
      { parentReal: '/repo/wt/src', name: 'new.ts', content: 'export const x = 1;\n' },
    ]);
  });

  it('returns a FRESH baseToken so the next save does not false-conflict', async () => {
    const { editor } = makeEditor({ files: { '/repo/wt/a.ts': Buffer.from('old', 'utf8') } });
    const res = await editor.write({
      worktreeId: '/repo/wt',
      relPath: 'a.ts',
      content: 'newer content',
      baseToken: `1000:3`,
    });
    expect(res.baseToken).toBe(`1000:${Buffer.byteLength('newer content', 'utf8')}`);
  });

  it('rejects when the file changed on disk (baseToken mismatch)', async () => {
    const { editor } = makeEditor({ files: { '/repo/wt/a.ts': Buffer.from('hello', 'utf8') } });
    await expect(
      editor.write({ worktreeId: '/repo/wt', relPath: 'a.ts', content: 'x', baseToken: '1:5' }),
    ).rejects.toThrow(/changed on disk/);
  });

  it('enforces the MAX_BYTES cap on the WRITE path (hostile renderer)', async () => {
    const { editor, writes } = makeEditor();
    const huge = '€'.repeat(Math.ceil(MAX_BYTES / 3) + 1); // 3 bytes each => > MAX_BYTES
    await expect(
      editor.write({ worktreeId: '/repo/wt', relPath: 'big.txt', content: huge }),
    ).rejects.toThrow(/too large/);
    expect(writes).toEqual([]); // never reached the write
  });

  it('refuses to write the worktree root', async () => {
    const { editor, writes } = makeEditor();
    await expect(
      editor.write({ worktreeId: '/repo/wt', relPath: '', content: 'x' }),
    ).rejects.toThrow(/worktree root/);
    expect(writes).toEqual([]);
  });
});
