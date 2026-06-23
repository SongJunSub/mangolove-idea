import { describe, it, expect } from 'vitest';
import { parsePsList } from '../../src/main/pty/abduco-exec';

describe('parsePsList', () => {
  it('parses pid + full command line per row', () => {
    const out = parsePsList(
      '  47731 /opt/homebrew/bin/abduco -A mango-0123456789abcdef claude\n' +
        '    1 /sbin/launchd\n',
    );
    expect(out).toEqual([
      { pid: 47731, cmd: '/opt/homebrew/bin/abduco -A mango-0123456789abcdef claude' },
      { pid: 1, cmd: '/sbin/launchd' },
    ]);
  });

  it('skips blank and non-numeric lines', () => {
    expect(parsePsList('\n   \nnotanumber foo\n')).toEqual([]);
  });
});
