import type { LogLine } from '../../shared/types';

/** Ordering for the min-level gate: error highest, raw lowest. */
export const LEVEL_RANK: Record<LogLine['level'], number> = {
  error: 4,
  warn: 3,
  info: 2,
  debug: 1,
  raw: 0,
};

/** Filter criteria from the log panel controls. */
export interface LogFilter {
  readonly grep: string;
  readonly minLevel: LogLine['level'];
}

/**
 * PURE: keep lines whose text contains `grep` (case-insensitive) AND whose level
 * rank is >= the selected minLevel rank. Empty grep + minLevel 'raw' is a no-op.
 */
export function filterLogs(lines: readonly LogLine[], filter: LogFilter): LogLine[] {
  const needle = filter.grep.toLowerCase();
  const minRank = LEVEL_RANK[filter.minLevel];
  return lines.filter(
    (l) =>
      LEVEL_RANK[l.level] >= minRank && (needle === '' || l.text.toLowerCase().includes(needle)),
  );
}
