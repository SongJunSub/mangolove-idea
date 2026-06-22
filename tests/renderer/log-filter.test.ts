import { describe, it, expect } from 'vitest';
import { filterLogs, LEVEL_RANK } from '../../src/renderer/lib/log-filter';
import type { LogLine } from '../../src/shared/types';

const lines: LogLine[] = [
  { worktreeId: '/wt', seq: 0, ts: 0, stream: 'stdout', level: 'debug', text: 'starting up' },
  { worktreeId: '/wt', seq: 1, ts: 0, stream: 'stdout', level: 'info', text: 'listening on 8080' },
  { worktreeId: '/wt', seq: 2, ts: 0, stream: 'stderr', level: 'warn', text: 'deprecated API' },
  {
    worktreeId: '/wt',
    seq: 3,
    ts: 0,
    stream: 'stderr',
    level: 'error',
    text: 'NullPointerException',
  },
  { worktreeId: '/wt', seq: 4, ts: 0, stream: 'stdout', level: 'raw', text: 'BANNER' },
];

describe('filterLogs', () => {
  it('returns everything for empty grep + min raw', () => {
    expect(filterLogs(lines, { grep: '', minLevel: 'raw' })).toHaveLength(5);
  });

  it('greps case-insensitively on text', () => {
    const out = filterLogs(lines, { grep: 'NULLpointer', minLevel: 'raw' });
    expect(out.map((l) => l.seq)).toEqual([3]);
  });

  it('gates by minimum level (warn hides info/debug/raw)', () => {
    const out = filterLogs(lines, { grep: '', minLevel: 'warn' });
    expect(out.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('combines grep AND level', () => {
    const out = filterLogs(lines, { grep: 'e', minLevel: 'warn' });
    expect(out.map((l) => l.seq)).toEqual([2, 3]);
  });

  it('error is the highest rank, raw the lowest', () => {
    expect(LEVEL_RANK.error).toBeGreaterThan(LEVEL_RANK.warn);
    expect(LEVEL_RANK.raw).toBe(0);
  });
});
