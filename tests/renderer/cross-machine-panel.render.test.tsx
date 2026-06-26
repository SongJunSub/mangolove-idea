import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { CrossMachinePanel } from '../../src/renderer/components/cross-machine/cross-machine-panel';
import type { CrossMachineSessionPointer } from '../../src/shared/types';

const ptr = (over: Partial<CrossMachineSessionPointer>): CrossMachineSessionPointer => ({
  branch: 'feat-x',
  status: 'running',
  hasActiveTurn: true,
  machineId: 'm-other',
  machineLabel: 'home-mac',
  updatedAt: 1,
  ...over,
});

function renderPanel(over: Partial<React.ComponentProps<typeof CrossMachinePanel>> = {}) {
  const props = {
    pointers: [] as CrossMachineSessionPointer[],
    loading: false,
    error: null as string | null,
    enabled: true,
    selfMachineId: 'm-self',
    onRefresh: vi.fn(),
    onStartHere: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...render(wrapI18n(<CrossMachinePanel {...props} />)) };
}

describe('<CrossMachinePanel>', () => {
  it('lists another machine session with a "Start here" button and fires it on click', () => {
    const { props } = renderPanel({ pointers: [ptr({ machineId: 'm-other', branch: 'feat-x' })] });
    const section = screen.getByTestId('cm-machine-m-other');
    expect(within(section).getByText('feat-x')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cm-start-feat-x'));
    expect(props.onStartHere).toHaveBeenCalledWith('feat-x');
  });

  it('marks THIS machine and never offers "Start here" on its own sessions', () => {
    renderPanel({
      pointers: [ptr({ machineId: 'm-self', machineLabel: 'work-mac', branch: 'mine' })],
    });
    const section = screen.getByTestId('cm-machine-m-self');
    expect(within(section).getByText(/\(this machine\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('cm-start-mine')).not.toBeInTheDocument();
  });

  it('renders NOTHING actionable when opted out (gate): no groups, shows the enable hint', () => {
    renderPanel({ enabled: false, pointers: [ptr({ branch: 'feat-x' })] });
    expect(screen.getByTestId('cross-machine-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('cm-machine-m-other')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cm-start-feat-x')).not.toBeInTheDocument();
  });

  it('shows the empty state only when enabled, not loading, and no pointers', () => {
    renderPanel({ enabled: true, loading: false, pointers: [] });
    expect(screen.getByTestId('cross-machine-empty')).toBeInTheDocument();
  });

  it('surfaces an error and disables refresh while loading', () => {
    const { props } = renderPanel({ error: 'sync failed', loading: true });
    expect(screen.getByTestId('cross-machine-error')).toHaveTextContent('sync failed');
    const refresh = screen.getByTestId('cross-machine-refresh');
    expect(refresh).toBeDisabled();
    fireEvent.click(screen.getByTestId('cross-machine-close'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('orders this machine first among multiple machines', () => {
    renderPanel({
      pointers: [
        ptr({ machineId: 'm-other', machineLabel: 'home' }),
        ptr({ machineId: 'm-self', machineLabel: 'work', branch: 'mine' }),
      ],
    });
    const sections = screen.getAllByTestId(/^cm-machine-/);
    expect(sections[0]).toHaveAttribute('data-testid', 'cm-machine-m-self');
  });
});
