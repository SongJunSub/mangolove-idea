import { useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  SessionPersistenceInfo,
  CodeNavCapabilities,
} from '../../../shared/types';
import { useUpdateCheck } from '../../hooks/use-update-check';
import { useAutoSave } from '../../hooks/use-auto-save';
import { openExternal } from '../../lib/open-external';

/** Props for the Settings modal. */
export interface SettingsModalProps {
  /** Current persisted settings used to seed the inputs. */
  readonly settings: AppSettings;
  /**
   * Persists ONE auto-saved patch as the user edits (no Save button). A text field
   * blanked to '' is sent as the EMPTY STRING, which SettingsStore.set() treats as a
   * DELETE of that key (reverting it to the env seam, then the default).
   */
  onChange(patch: Partial<AppSettings>): void;
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
 * Per-project settings editor (V2 item E). Fields are seeded from the persisted
 * settings and AUTO-SAVE as you edit — text inputs debounce (one write when you
 * pause), toggles/segmented controls persist immediately. There is no Save button;
 * a transient "Saved" note confirms each write. The card is responsive: its body
 * scrolls so every control stays reachable on a short/narrow window.
 *
 * Also hosts the b-full session-persistence control: a toggle that wraps the agent
 * in an abduco detached session so an in-flight turn survives quit/crash. The
 * EFFECTIVE mode (from session.persistenceInfo) is shown so a 'full' request that
 * abduco can't honor is surfaced LOUDLY instead of silently downgrading; a
 * stop-all-background kill-switch ends every surviving session on demand.
 */
export function SettingsModal({
  settings,
  onChange,
  onClose,
}: SettingsModalProps): React.JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(settings.theme ?? 'system');
  const [agentCommand, setAgentCommand] = useState(settings.agentCommand ?? '');
  const [verifyCommand, setVerifyCommand] = useState(settings.verifyCommand ?? '');
  const [serverCommand, setServerCommand] = useState(settings.serverCommand ?? '');
  const [baseBranch, setBaseBranch] = useState(settings.baseBranch ?? '');
  const [persistFull, setPersistFull] = useState(settings.sessionPersistence === 'full');
  const [crossMachine, setCrossMachine] = useState(settings.crossMachineSessions === 'on');
  const [machineLabel, setMachineLabel] = useState(settings.machineLabel ?? '');
  const [lspJavaPath, setLspJavaPath] = useState(settings.lspJavaPath ?? '');
  const [lspKotlinPath, setLspKotlinPath] = useState(settings.lspKotlinPath ?? '');
  const [info, setInfo] = useState<SessionPersistenceInfo | null>(null);
  const [caps, setCaps] = useState<CodeNavCapabilities | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stoppedNote, setStoppedNote] = useState('');
  const [appVersion, setAppVersion] = useState('');
  // Transient "✓ Saved" note: shown for ~1.5s after each persist (timer re-armed each write).
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { status: update, checking: checkingUpdate, check: checkForUpdate } = useUpdateCheck(false);

  const { queue, flush } = useAutoSave<AppSettings>((patch) => {
    onChange(patch);
    setShowSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setShowSaved(false), 1500);
  });

  useEffect(() => {
    let alive = true;
    void window.mango.session.persistenceInfo().then((i) => {
      if (alive) setInfo(i);
    });
    // Code-nav availability is machine-global (PATH-detected); worktreeId is ignored.
    void window.mango.codenav.capabilities('').then((c) => {
      if (alive) setCaps(c);
    });
    void window.mango.app.ping().then((a) => {
      if (alive) setAppVersion(a.appVersion);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Clear the "Saved" timer on unmount so it can't fire after the modal closes.
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const close = (): void => {
    flush(); // persist any debounced edit before unmounting
    onClose();
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

  // A debounced text field: updates local state for responsiveness, queues the
  // trimmed value, and flushes on blur so leaving the field persists at once.
  const textRow = (
    label: string,
    placeholder: string,
    value: string,
    setLocal: (v: string) => void,
    key: keyof AppSettings,
    testid: string,
  ): React.JSX.Element => (
    <label className="settings-field">
      {label}
      <input
        aria-label={label}
        data-testid={testid}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setLocal(e.target.value);
          queue({ [key]: field(e.target.value) } as Partial<AppSettings>);
        }}
        onBlur={flush}
      />
    </label>
  );

  return (
    <div className="settings-overlay" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-modal"
        className="settings-card"
        // Clicks inside the card must not bubble to the overlay's close handler.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-card__head">
          <h2 className="settings-card__title">Settings</h2>
          <span className="settings-saved" data-testid="settings-saved" aria-live="polite">
            {showSaved ? '✓ Saved' : ''}
          </span>
        </div>

        <div className="settings-card__body">
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Theme</div>
            <div role="group" aria-label="Theme" style={{ display: 'inline-flex', gap: 4 }}>
              {(['dark', 'light', 'system'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  data-testid={`settings-theme-${t}`}
                  aria-pressed={theme === t}
                  onClick={() => {
                    setTheme(t);
                    queue({ theme: t }, true);
                  }}
                  style={{
                    background: theme === t ? 'var(--accent)' : 'var(--surface)',
                    color: theme === t ? '#fff' : 'var(--text)',
                    borderColor: theme === t ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'System'}
                </button>
              ))}
            </div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
            Blank = fall back to the env seam, then the default.
          </p>
          {textRow(
            'agent command',
            'claude',
            agentCommand,
            setAgentCommand,
            'agentCommand',
            'settings-agent',
          )}
          {textRow(
            'verify command',
            'true',
            verifyCommand,
            setVerifyCommand,
            'verifyCommand',
            'settings-verify',
          )}
          {textRow(
            'server command',
            '(auto-detect)',
            serverCommand,
            setServerCommand,
            'serverCommand',
            'settings-server',
          )}
          {textRow('base branch', 'main', baseBranch, setBaseBranch, 'baseBranch', 'settings-base')}

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input
              type="checkbox"
              data-testid="settings-persist-full"
              checked={persistFull}
              onChange={(e) => {
                setPersistFull(e.target.checked);
                queue({ sessionPersistence: e.target.checked ? 'full' : 'lite' }, true);
              }}
            />
            Keep the agent running in the background after quit (b-full)
          </label>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            Wraps the agent in an abduco session so an in-flight turn survives quit/crash and
            re-attaches on reopen. macOS only.
          </p>
          {downgraded && (
            <p
              data-testid="settings-persist-warning"
              style={{ fontSize: 12, color: 'var(--err)', margin: '6px 0 0' }}
            >
              ⚠ abduco not found — b-full is disabled and sessions fall back to lite. Install it:{' '}
              <code>brew install abduco</code>
            </p>
          )}
          {info?.effective === 'full' && (
            <p style={{ fontSize: 12, color: 'var(--ok)', margin: '6px 0 0' }}>
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
              <span style={{ fontSize: 12, color: 'var(--ok)', marginLeft: 8 }}>{stoppedNote}</span>
            )}
          </div>

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input
              type="checkbox"
              data-testid="settings-cross-machine"
              checked={crossMachine}
              onChange={(e) => {
                setCrossMachine(e.target.checked);
                queue({ crossMachineSessions: e.target.checked ? 'on' : 'off' }, true);
              }}
            />
            Share this machine's sessions across machines (visibility only)
          </label>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            Publishes session metadata (branch + status, never the conversation) to the shared
            remote so you can see sessions from your other machines. Off by default.
          </p>
          {crossMachine &&
            textRow(
              'this machine label',
              'machine-…',
              machineLabel,
              setMachineLabel,
              'machineLabel',
              'settings-machine-label',
            )}

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
            Code navigation (Java / Kotlin)
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 8px' }}>
            Command+click go-to-definition for Java/Kotlin uses your installed language server
            (TS/JS works built-in). Set a path below to override PATH detection.
          </p>
          {(['java', 'kotlin'] as const).map((lang) => {
            const st = caps?.[lang];
            return (
              <p
                key={lang}
                data-testid={`settings-codenav-${lang}`}
                style={{
                  fontSize: 12,
                  margin: '2px 0',
                  color: st?.available ? 'var(--ok)' : 'var(--muted)',
                }}
              >
                {st?.available ? '✓' : '⚠'} {lang}:{' '}
                {st?.available ? 'available' : (st?.reason ?? 'checking…')}
              </p>
            );
          })}
          {textRow(
            'jdtls path (Java)',
            '(auto-detect)',
            lspJavaPath,
            setLspJavaPath,
            'lspJavaPath',
            'settings-lsp-java',
          )}
          {textRow(
            'kotlin-language-server path',
            '(auto-detect)',
            lspKotlinPath,
            setLspKotlinPath,
            'lspKotlinPath',
            'settings-lsp-kotlin',
          )}

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Updates</div>
          <div
            data-testid="settings-update"
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
          >
            <span>
              Current version: <strong>v{appVersion || '…'}</strong>
            </span>
            <button
              type="button"
              data-testid="settings-update-check"
              disabled={checkingUpdate}
              onClick={() => void checkForUpdate()}
            >
              {checkingUpdate ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
          {update && (
            <p data-testid="settings-update-result" style={{ fontSize: 12, margin: '6px 0 0' }}>
              {update.error ? (
                `Couldn't check (${update.error.replace('_', ' ')}) — try again later.`
              ) : update.updateAvailable ? (
                <>
                  v{update.latestVersion} is available.{' '}
                  <button
                    type="button"
                    data-testid="settings-update-download"
                    onClick={() => openExternal(update.dmgUrl ?? update.releaseUrl)}
                  >
                    Download
                  </button>
                </>
              ) : (
                "You're on the latest version."
              )}
            </p>
          )}
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            Unsigned build: an update downloads as a .dmg you drag into Applications.
          </p>
        </div>

        <div className="settings-card__foot">
          <button type="button" data-testid="settings-close" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
