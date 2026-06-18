import { describe, it, expect } from 'vitest';
import { parseNameStatus, parseBinaryPaths } from '../../src/main/git/diff-viewer';

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
