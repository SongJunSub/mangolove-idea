import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../src/renderer/components/settings/settings-modal';

// SettingsModal calls window.mango.session.persistenceInfo() on mount; stub the bridge.
beforeEach(() => {
  const mango = {
    session: {
      persistenceInfo: vi.fn(async () => ({
        requested: 'lite' as const,
        effective: 'lite' as const,
        abducoAvailable: true,
      })),
      stopAllBackground: vi.fn(async () => ({ ok: true })),
    },
  };
  // window.mango is declared read-only; defineProperty (configurable) installs the stub
  // and lets each test redefine it.
  Object.defineProperty(window, 'mango', { value: mango, configurable: true });
});

describe('<SettingsModal> cross-machine controls', () => {
  it('seeds the toggle + label from settings and persists them on Save', async () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        settings={{ crossMachineSessions: 'on', machineLabel: 'work-mac' }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('settings-cross-machine')).toBeChecked();
    expect(screen.getByTestId('settings-machine-label')).toHaveValue('work-mac');

    await userEvent.click(screen.getByTestId('settings-save'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ crossMachineSessions: 'on', machineLabel: 'work-mac' }),
    );
  });

  it('defaults to off (unchecked) and hides the label input until enabled', async () => {
    const onSave = vi.fn();
    render(<SettingsModal settings={{}} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByTestId('settings-cross-machine')).not.toBeChecked();
    expect(screen.queryByTestId('settings-machine-label')).not.toBeInTheDocument();

    // Enable -> the label input appears.
    await userEvent.click(screen.getByTestId('settings-cross-machine'));
    expect(screen.getByTestId('settings-machine-label')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('settings-save'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ crossMachineSessions: 'on' }));
  });

  it('toggling an enabled instance OFF persists off', async () => {
    const onSave = vi.fn();
    render(
      <SettingsModal settings={{ crossMachineSessions: 'on' }} onSave={onSave} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId('settings-cross-machine')); // on -> off
    await userEvent.click(screen.getByTestId('settings-save'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ crossMachineSessions: 'off' }));
  });
});
