import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseNameStatus, parseBinaryPaths } from '../../src/main/git/diff-viewer';
import { DiffViewer } from '../../src/main/git/diff-viewer';
import { makeTempGitRepo, seedDiffScenario, type TempGitRepo } from '../helpers/temp-git-repo';

describe('parseNameStatus', () => {
  it('parses added / modified / deleted', () => {
    const out = ['A\tadded.txt', 'M\tmod.txt', 'D\tdel.txt'].join('\n') + '\n';
    expect(parseNameStatus(out)).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'mod.txt', status: 'modified' },
      { path: 'del.txt', status: 'deleted' },
    ]);
  });

  it('parses a rename (R100 old new) keeping new path + oldPath', () => {
    const out = 'R100\tkeep.txt\trenamed.txt\n';
    expect(parseNameStatus(out)).toEqual([
      { path: 'renamed.txt', status: 'renamed', oldPath: 'keep.txt' },
    ]);
  });

  it('treats copies (C…) as added of the destination', () => {
    expect(parseNameStatus('C75\ta.txt\tb.txt\n')).toEqual([
      { path: 'b.txt', status: 'added' },
    ]);
  });

  it('ignores blank lines and unknown statuses', () => {
    expect(parseNameStatus('\nX\tweird.txt\n')).toEqual([]);
  });
});

describe('parseBinaryPaths', () => {
  it('collects paths whose numstat is "-\\t-"', () => {
    const out = ['-\t-\tblob.bin', '1\t0\tfeat.txt', '-\t-\timg.png'].join('\n') + '\n';
    expect(parseBinaryPaths(out)).toEqual(new Set(['blob.bin', 'img.png']));
  });

  it('uses the destination of a renamed binary (real git arrow + brace forms)', () => {
    // Real `git diff --numstat -M` emits a rename as ONE field with ' => ':
    expect(parseBinaryPaths('-\t-\told.bin => new.bin\n')).toEqual(new Set(['new.bin']));
    // brace form: pre/{old => new}/post
    expect(parseBinaryPaths('-\t-\tdir/{a.bin => b.bin}\n')).toEqual(new Set(['dir/b.bin']));
  });
});

describe('DiffViewer (real temp git repo)', () => {
  let repo: TempGitRepo;
  let viewer: DiffViewer;
  let worktreeId: string;

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    viewer = new DiffViewer(repo.git, repo.dir);
    ({ worktreeId } = await seedDiffScenario(repo));
  });
  afterEach(() => repo.cleanup());

  it('lists changed files PR-style (A/M/D/R + binary flag)', async () => {
    const files = await viewer.listChangedFiles({ worktreeId });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['added.txt']).toMatchObject({ status: 'added', binary: false });
    expect(byPath['mod.txt']).toMatchObject({ status: 'modified', binary: false });
    expect(byPath['del.txt']).toMatchObject({ status: 'deleted', binary: false });
    expect(byPath['renamed.txt']).toMatchObject({ status: 'renamed', oldPath: 'keep.txt' });
    expect(byPath['blob.bin']).toMatchObject({ status: 'added', binary: true });
  });

  it('getFileDiff(modified) returns merge-base original + branch modified', async () => {
    const d = await viewer.getFileDiff({ worktreeId, path: 'mod.txt' });
    expect(d).toEqual({
      path: 'mod.txt', status: 'modified', original: 'old\n', modified: 'old\nnew\n', binary: false,
    });
  });

  it('getFileDiff(added) has empty original', async () => {
    const d = await viewer.getFileDiff({ worktreeId, path: 'added.txt' });
    expect(d.status).toBe('added');
    expect(d.original).toBe('');
    expect(d.modified).toBe('brand new\n');
  });

  it('getFileDiff(deleted) has empty modified', async () => {
    const d = await viewer.getFileDiff({ worktreeId, path: 'del.txt' });
    expect(d.status).toBe('deleted');
    expect(d.original).toBe('bye\n');
    expect(d.modified).toBe('');
  });

  it('getFileDiff(binary) returns binary:true with empty contents', async () => {
    const d = await viewer.getFileDiff({ worktreeId, path: 'blob.bin' });
    expect(d).toMatchObject({ binary: true, original: '', modified: '' });
  });

  it('throws a clear error for an unknown worktree', async () => {
    await expect(viewer.listChangedFiles({ worktreeId: '/nope' })).rejects.toThrow(
      /unknown worktree/,
    );
  });

  it('throws for a path not in the diff', async () => {
    await expect(viewer.getFileDiff({ worktreeId, path: 'keep.txt' })).rejects.toThrow(
      /not a changed file/,
    );
  });
});
