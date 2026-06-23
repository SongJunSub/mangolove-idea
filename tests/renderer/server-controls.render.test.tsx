import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ServerControls } from '../../src/renderer/components/toolbar/server-controls';
import type { ServerState, ServerStatus } from '../../src/shared/types';

const status = (state: ServerState): ServerStatus => ({
  process: { worktreeId: '/wt', kind: 'npm', state },
});

function controls(over: Partial<React.ComponentProps<typeof ServerControls>> = {}) {
  const props = {
    selectedId: '/wt' as string | null,
    status: null as ServerStatus | null,
    onStart: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
  return { props, ...render(<ServerControls {...props} />) };
}

const runBtn = () => screen.getByRole('button', { name: 'Run' });
const stopBtn = () => screen.getByRole('button', { name: 'Stop' });

describe('<ServerControls>', () => {
  it('stopped + selected: Run enabled, Stop disabled; Run fires onStart', () => {
    const { props } = controls({ status: status('stopped') });
    expect(runBtn()).toBeEnabled();
    expect(stopBtn()).toBeDisabled();
    fireEvent.click(runBtn());
    expect(props.onStart).toHaveBeenCalledWith('/wt');
  });

  it('running: Run disabled, Stop enabled; Stop fires onStop', () => {
    const { props } = controls({ status: status('running') });
    expect(runBtn()).toBeDisabled();
    expect(stopBtn()).toBeEnabled();
    fireEvent.click(stopBtn());
    expect(props.onStop).toHaveBeenCalledWith('/wt');
  });

  it('transitioning (starting): both buttons disabled', () => {
    controls({ status: status('starting') });
    expect(runBtn()).toBeDisabled();
    expect(stopBtn()).toBeEnabled(); // Stop is allowed while busy (to cancel)
  });

  it('no selection: both disabled', () => {
    controls({ selectedId: null, status: null });
    expect(runBtn()).toBeDisabled();
    expect(stopBtn()).toBeDisabled();
  });

  it('shows the current server state label', () => {
    controls({ status: status('crashed') });
    expect(screen.getByText('server: crashed')).toBeInTheDocument();
  });
});
