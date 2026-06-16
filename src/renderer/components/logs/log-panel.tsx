import { useMemo, useState } from 'react';
import type { LogLine } from '../../../shared/types';
import { filterLogs } from '../../lib/log-filter';

const LEVEL_OPTIONS: LogLine['level'][] = ['raw', 'debug', 'info', 'warn', 'error'];
const LEVEL_COLOR: Record<LogLine['level'], string> = {
  error: '#cf222e',
  warn: '#b58900',
  info: '#2ea043',
  debug: '#6e7781',
  raw: '#888',
};
/** Cap how many lines we actually render (newest), independent of the buffer. */
const RENDER_CAP = 1000;

export interface LogPanelProps {
  readonly lines: readonly LogLine[];
}

/** Live server log list with a case-insensitive grep + a min-level select. */
export function LogPanel({ lines }: LogPanelProps): React.JSX.Element {
  const [grep, setGrep] = useState<string>('');
  const [minLevel, setMinLevel] = useState<LogLine['level']>('raw');

  const visible = useMemo(() => {
    const filtered = filterLogs(lines, { grep, minLevel });
    return filtered.length > RENDER_CAP ? filtered.slice(filtered.length - RENDER_CAP) : filtered;
  }, [lines, grep, minLevel]);

  return (
    <section data-testid="log-panel" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>Server logs</strong>
        <input
          aria-label="log grep"
          placeholder="filter…"
          value={grep}
          onChange={(e) => setGrep(e.target.value)}
          style={{ flex: 1, fontSize: 12 }}
        />
        <label style={{ fontSize: 12 }}>
          level
          <select
            aria-label="min level"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as LogLine['level'])}
            style={{ marginLeft: 4 }}
          >
            {LEVEL_OPTIONS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 11, color: '#888' }}>{visible.length} shown</span>
      </div>
      <div
        style={{
          height: 240,
          overflowY: 'auto',
          background: '#1e1e1e',
          color: '#ddd',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          padding: 8,
          borderRadius: 4,
        }}
      >
        {visible.length === 0 ? (
          <div style={{ color: '#666' }}>no log lines</div>
        ) : (
          visible.map((l) => (
            <div key={l.seq} style={{ whiteSpace: 'pre-wrap', color: LEVEL_COLOR[l.level] }}>
              {l.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
