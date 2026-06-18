import { useState } from 'react';
import type { AppSettings } from '../../../shared/types';

/** Props for the Settings modal. */
export interface SettingsModalProps {
  /** Current persisted settings used to seed the inputs. */
  readonly settings: AppSettings;
  /**
   * Persists the edited partial. The modal sends ALL four fields every save; a
   * blank field is sent as the EMPTY STRING `''`, which SettingsStore.set() treats
   * as a DELETE of that key (reverting it to the env seam, then the default).
   */
  onSave(partial: AppSettings): void;
  onClose(): void;
}

/**
 * Normalizes an input to its trimmed value. A blank input becomes `''` (NOT
 * undefined) so it actually reaches SettingsStore.set() and clears the key — if it
 * collapsed to undefined, sanitize would drop it from the merge and the old value
 * would stick. Precedence (settings > env > default) lives in resolveCommands.
 */
function field(value: string): string {
  return value.trim();
}

/**
 * Per-project settings editor (V2 item E). Four text inputs seeded from the
 * persisted settings; Save persists the edited values + closes; Cancel closes.
 * Mirrors the App.tsx quit-warning modal (fixed overlay + role="dialog").
 */
export function SettingsModal({
  settings,
  onSave,
  onClose,
}: SettingsModalProps): React.JSX.Element {
  const [agentCommand, setAgentCommand] = useState(settings.agentCommand ?? '');
  const [verifyCommand, setVerifyCommand] = useState(settings.verifyCommand ?? '');
  const [serverCommand, setServerCommand] = useState(settings.serverCommand ?? '');
  const [baseBranch, setBaseBranch] = useState(settings.baseBranch ?? '');

  const submit = (): void => {
    onSave({
      agentCommand: field(agentCommand),
      verifyCommand: field(verifyCommand),
      serverCommand: field(serverCommand),
      baseBranch: field(baseBranch),
    });
  };

  const row = (
    label: string,
    placeholder: string,
    value: string,
    set: (v: string) => void,
    testid: string,
  ): React.JSX.Element => (
    <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
      {label}
      <input
        aria-label={label}
        data-testid={testid}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        style={{ display: 'block', width: '100%', marginTop: 2 }}
      />
    </label>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="settings-modal"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{ background: '#fff', borderRadius: 8, padding: 24, width: 420, maxWidth: '90vw' }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Settings</h2>
        <p style={{ fontSize: 12, color: '#888', marginTop: 0 }}>
          Blank = fall back to the env seam, then the default.
        </p>
        {row('agent command', 'claude', agentCommand, setAgentCommand, 'settings-agent')}
        {row('verify command', 'true', verifyCommand, setVerifyCommand, 'settings-verify')}
        {row('server command', '(auto-detect)', serverCommand, setServerCommand, 'settings-server')}
        {row('base branch', 'main', baseBranch, setBaseBranch, 'settings-base')}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" data-testid="settings-save" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
