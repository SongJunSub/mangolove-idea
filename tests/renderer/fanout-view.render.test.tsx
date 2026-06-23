import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FanoutRun } from '../../src/shared/types';

// Control the fan-out hook so the view is tested in isolation from IPC.
const fanout = vi.hoisted(() => ({
  run: null as FanoutRun | null,
  busy: false,
  error: null as string | null,
  start: vi.fn(async () => undefined),
  select: vi.fn(),
  abort: vi.fn(async () => undefined),
}));
vi.mock('../../src/renderer/hooks/use-fanout', () => ({ useFanout: () => fanout }));

// Import AFTER the mock is registered.
import { FanoutView } from '../../src/renderer/components/fanout/fanout-view';

beforeEach(() => {
  fanout.run = null;
  fanout.busy = false;
  fanout.error = null;
  fanout.start.mockClear();
});

const view = () => render(<FanoutView base="main" onMerged={vi.fn()} />);

describe('<FanoutView> (form)', () => {
  it('defaults to opus+haiku selected, sonnet unselected', () => {
    view();
    expect(screen.getByTestId('fanout-model-opus')).toBeChecked();
    expect(screen.getByTestId('fanout-model-haiku')).toBeChecked();
    expect(screen.getByTestId('fanout-model-sonnet')).not.toBeChecked();
  });

  it('disables Start until a prompt is entered, then starts with prompt+models+skip', () => {
    view();
    const start = screen.getByTestId('fanout-start');
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByTestId('fanout-prompt'), { target: { value: 'refactor X' } });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(fanout.start).toHaveBeenCalledWith({
      prompt: 'refactor X',
      models: ['opus', 'haiku'],
      skipPermissions: false,
    });
  });

  it('toggling a model + skip-permissions is reflected in the start request', () => {
    view();
    fireEvent.click(screen.getByTestId('fanout-model-sonnet')); // add sonnet
    fireEvent.click(screen.getByTestId('fanout-model-haiku')); // remove haiku
    fireEvent.click(screen.getByTestId('fanout-skip-permissions'));
    fireEvent.change(screen.getByTestId('fanout-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('fanout-start'));
    expect(fanout.start).toHaveBeenCalledWith({
      prompt: 'go',
      models: ['opus', 'sonnet'],
      skipPermissions: true,
    });
  });

  it('surfaces a hook error and disables Start while busy', () => {
    fanout.error = 'lane spawn failed';
    fanout.busy = true;
    view();
    expect(screen.getByText(/error: lane spawn failed/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('fanout-prompt'), { target: { value: 'x' } });
    expect(screen.getByTestId('fanout-start')).toBeDisabled(); // busy gates it
  });
});
