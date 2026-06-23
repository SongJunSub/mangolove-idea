import { useEffect, useState } from 'react';
import type { AppSettings, SessionPersistenceInfo } from '../../../shared/types';

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
 *
 * Also hosts the b-full session-persistence control: a toggle that wraps the agent
 * in an abduco detached session so an in-flight turn survives quit/crash. The
 * EFFECTIVE mode (from session.persistenceInfo) is shown so a 'full' request that
 * abduco can't honor is surfaced LOUDLY instead of silently downgrading; a
 * stop-all-background kill-switch ends every surviving session on demand.
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
  const [persistFull, setPersistFull] = useState(settings.sessionPersistence === 'full');
  const [info, setInfo] = useState<SessionPersistenceInfo | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stoppedNote, setStoppedNote] = useState('');

  useEffect(() => {
    let alive = true;
    void window.mango.session.persistenceInfo().then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, []);

  const submit = (): void => {
    onSave({
      agentCommand: field(agentCommand),
      verifyCommand: field(verifyCommand),
      serverCommand: field(serverCommand),
      baseBranch: field(baseBranch),
      // 'full' enables b-full; 'lite' (not '') keeps the value a valid enum and
      // reads back as lite. SettingsStore persists both as non-empty strings.
      sessionPersistence: persistFull ? 'full' : 'lite',
    });
  };

  const stopAll = async (): Promise<void> => {
    setStopping(true);
    setStoppedNote('');
    try {
      await window.mango.session.stopAllBackground();
      setStoppedNote('All background agents stopped.');
    } finally {
      setStopping(false);
    }
  };

  // The b-full 'full' request can't be honored when abduco is missing -> LOUD warn.
  const downgraded = persistFull && info !== null && !info.abducoAvailable;

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

        <hr style={{ border: 0, borderTop: '1px solid #eee', margin: '16px 0' }} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <input
            type="checkbox"
            data-testid="settings-persist-full"
            checked={persistFull}
            onChange={(e) => setPersistFull(e.target.checked)}
          />
          Keep the agent running in the background after quit (b-full)
        </label>
        <p style={{ fontSize: 11, color: '#888', margin: '4px 0 0' }}>
          Wraps the agent in an abduco session so an in-flight turn survives quit/crash and
          re-attaches on reopen. macOS only.
        </p>
        {downgraded && (
          <p
            data-testid="settings-persist-warning"
            style={{ fontSize: 12, color: '#b00', margin: '6px 0 0' }}
          >
            ⚠ abduco not found — b-full is disabled and sessions fall back to lite. Install it:{' '}
            <code>brew install abduco</code>
          </p>
        )}
        {info?.effective === 'full' && (
          <p style={{ fontSize: 12, color: '#0a7', margin: '6px 0 0' }}>
            ✓ b-full active — agents survive quit/crash; reopen re-attaches.
          </p>
        )}
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            data-testid="settings-stop-all-background"
            onClick={() => void stopAll()}
            disabled={stopping}
          >
            {stopping ? 'Stopping…' : 'Stop all background agents'}
          </button>
          {stoppedNote && (
            <span style={{ fontSize: 12, color: '#0a7', marginLeft: 8 }}>{stoppedNote}</span>
          )}
        </div>

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
