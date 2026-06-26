import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../src/renderer/components/settings/settings-modal';
import { renderWithI18n } from './i18n-test-util';

// SettingsModal reads copy via useI18n; render through the shared English provider.
const renderModal = (ui: React.ReactElement): ReturnType<typeof renderWithI18n> =>
  renderWithI18n(ui);

// SettingsModal calls session.persistenceInfo() + codenav.capabilities() + app.ping() on
// mount, and update.check() from the Updates section; stub the bridge.
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
    codenav: {
      capabilities: vi.fn(async () => ({
        java: { available: false, reason: 'jdtls not found' },
        kotlin: { available: false, reason: 'kotlin-language-server not found' },
      })),
    },
    app: {
      ping: vi.fn(async () => ({ appVersion: '0.1.1' })),
      openExternal: vi.fn(async () => ({ ok: true })),
    },
    update: {
      check: vi.fn(async () => ({
        currentVersion: '0.1.1',
        latestVersion: '0.1.1',
        updateAvailable: false,
        releaseUrl: null,
        dmgUrl: null,
        sha256: null,
        publishedAt: null,
      })),
    },
  };
  // window.mango is declared read-only; defineProperty (configurable) installs the stub
  // and lets each test redefine it.
  Object.defineProperty(window, 'mango', { value: mango, configurable: true });
});

describe('<SettingsModal> theme control', () => {
  it("defaults to 'system' when unset and auto-saves the picked theme on click", async () => {
    const onChange = vi.fn();
    renderModal(<SettingsModal settings={{}} onChange={onChange} onClose={vi.fn()} />);
    // unset => 'system' is the active (pressed) option
    expect(screen.getByTestId('settings-theme-system')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('settings-theme-dark')).toHaveAttribute('aria-pressed', 'false');

    // No Save button: picking a theme persists immediately.
    await userEvent.click(screen.getByTestId('settings-theme-dark'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('seeds the active option from the persisted theme', () => {
    renderModal(
      <SettingsModal settings={{ theme: 'light' }} onChange={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('settings-theme-light')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('settings-theme-system')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('<SettingsModal> language control', () => {
  it("defaults to 'system' when unset and auto-saves the picked language immediately", async () => {
    const onChange = vi.fn();
    renderModal(<SettingsModal settings={{}} onChange={onChange} onClose={vi.fn()} />);
    expect(screen.getByTestId('settings-locale-system')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByTestId('settings-locale-ko'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ko' }));
    expect(screen.getByTestId('settings-locale-ko')).toHaveAttribute('aria-pressed', 'true');
  });

  it('seeds the active language from the persisted setting', () => {
    renderModal(<SettingsModal settings={{ locale: 'en' }} onChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('settings-locale-en')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('settings-locale-system')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('<SettingsModal> auto-save', () => {
  it('has no Save button (fields auto-save)', () => {
    renderModal(<SettingsModal settings={{}} onChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('settings-save')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-close')).toBeInTheDocument();
  });

  it('persists a text field (trimmed) on blur', async () => {
    const onChange = vi.fn();
    renderModal(<SettingsModal settings={{}} onChange={onChange} onClose={vi.fn()} />);
    const input = screen.getByTestId('settings-agent');
    await userEvent.type(input, '  claude-next  ');
    await userEvent.tab(); // blur flushes the debounced write
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ agentCommand: 'claude-next' }));
  });

  it('flushes a pending text edit when Done is clicked', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    renderModal(<SettingsModal settings={{}} onChange={onChange} onClose={onClose} />);
    const input = screen.getByTestId('settings-base');
    await userEvent.type(input, 'develop');
    await userEvent.click(screen.getByTestId('settings-close'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'develop' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('<SettingsModal> cross-machine controls', () => {
  it('seeds the toggle + label from settings', () => {
    renderModal(
      <SettingsModal
        settings={{ crossMachineSessions: 'on', machineLabel: 'work-mac' }}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('settings-cross-machine')).toBeChecked();
    expect(screen.getByTestId('settings-machine-label')).toHaveValue('work-mac');
  });

  it('defaults to off, reveals the label on enable, and auto-saves the toggle', async () => {
    const onChange = vi.fn();
    renderModal(<SettingsModal settings={{}} onChange={onChange} onClose={vi.fn()} />);
    expect(screen.getByTestId('settings-cross-machine')).not.toBeChecked();
    expect(screen.queryByTestId('settings-machine-label')).not.toBeInTheDocument();

    // Enable -> the label input appears and the toggle persists immediately.
    await userEvent.click(screen.getByTestId('settings-cross-machine'));
    expect(screen.getByTestId('settings-machine-label')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ crossMachineSessions: 'on' }));
  });

  it('toggling an enabled instance OFF persists off immediately', async () => {
    const onChange = vi.fn();
    renderModal(
      <SettingsModal
        settings={{ crossMachineSessions: 'on' }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('settings-cross-machine')); // on -> off
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ crossMachineSessions: 'off' }));
  });
});
