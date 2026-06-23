import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LogPanel } from '../../src/renderer/components/logs/log-panel';
import type { LogLine } from '../../src/shared/types';

const line = (over: Partial<LogLine>): LogLine => ({
  worktreeId: '/wt',
  seq: 0,
  ts: 0,
  stream: 'stdout',
  level: 'info',
  text: 'hello',
  ...over,
});

const lines: LogLine[] = [
  line({ seq: 0, level: 'debug', text: 'starting up' }),
  line({ seq: 1, level: 'info', text: 'listening on 8080' }),
  line({ seq: 2, level: 'error', text: 'boom failed' }),
];

describe('<LogPanel>', () => {
  it('renders all lines and a count', () => {
    render(<LogPanel lines={lines} />);
    expect(screen.getByText('listening on 8080')).toBeInTheDocument();
    expect(screen.getByText('3 shown')).toBeInTheDocument();
  });

  it('greps case-insensitively, narrowing the visible lines', () => {
    render(<LogPanel lines={lines} />);
    fireEvent.change(screen.getByLabelText('log grep'), { target: { value: 'BOOM' } });
    expect(screen.getByText('boom failed')).toBeInTheDocument();
    expect(screen.queryByText('listening on 8080')).not.toBeInTheDocument();
    expect(screen.getByText('1 shown')).toBeInTheDocument();
  });

  it('raises the minimum level, hiding lower-severity lines', () => {
    render(<LogPanel lines={lines} />);
    fireEvent.change(screen.getByLabelText('min level'), { target: { value: 'error' } });
    expect(screen.getByText('boom failed')).toBeInTheDocument();
    expect(screen.queryByText('starting up')).not.toBeInTheDocument();
    expect(screen.getByText('1 shown')).toBeInTheDocument();
  });

  it('shows the empty placeholder when nothing matches', () => {
    render(<LogPanel lines={lines} />);
    fireEvent.change(screen.getByLabelText('log grep'), { target: { value: 'zzz-nomatch' } });
    expect(screen.getByText('no log lines')).toBeInTheDocument();
  });
});
