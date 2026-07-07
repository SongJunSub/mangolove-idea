import { useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  SessionPersistenceInfo,
  CodeNavCapabilities,
} from '../../../shared/types';
import { useUpdateCheck } from '../../hooks/use-update-check';
import { useSelfUpdate } from '../../hooks/use-self-update';
import { useAutoSave } from '../../hooks/use-auto-save';
import { useI18n } from '../../i18n/i18n-context';
import { asLocaleSetting } from '../../i18n/resolve-locale';
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
 * scrolls so every control stays reachable on a short/narrow window. All copy is
 * localized via useI18n; the Language control switches the whole app live.
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
  const { t } = useI18n();
  const [locale, setLocale] = useState(asLocaleSetting(settings.locale));
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(settings.theme ?? 'system');
  const [agentCommand, setAgentCommand] = useState(settings.agentCommand ?? '');
  const [verifyCommand, setVerifyCommand] = useState(settings.verifyCommand ?? '');
  const [serverCommand, setServerCommand] = useState(settings.serverCommand ?? '');
  const [baseBranch, setBaseBranch] = useState(settings.baseBranch ?? '');
  const [persistFull, setPersistFull] = useState(settings.sessionPersistence === 'full');
  const [lspJavaPath, setLspJavaPath] = useState(settings.lspJavaPath ?? '');
  const [lspKotlinPath, setLspKotlinPath] = useState(settings.lspKotlinPath ?? '');
  const [info, setInfo] = useState<SessionPersistenceInfo | null>(null);
  const [caps, setCaps] = useState<CodeNavCapabilities | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stoppedNote, setStoppedNote] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  // Transient "✓ Saved" note: shown for ~1.5s after each persist (timer re-armed each write).
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { status: update, checking: checkingUpdate, check: checkForUpdate } = useUpdateCheck(false);
  // Same one-click download → verify → install → restart the bottom-right banner uses, so the
  // Settings action installs automatically instead of just opening the .dmg in the browser.
  const selfUpdate = useSelfUpdate();
  // A verified one-click request — present only when the release has BOTH a .dmg and its sha256
  // (auto-install is refused without the hash). Captured here so the narrowing survives the closure.
  const oneClickReq =
    update?.dmgUrl && update.sha256 ? { dmgUrl: update.dmgUrl, sha256: update.sha256 } : null;

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
    setStoppedNote(false);
    try {
      await window.mango.session.stopAllBackground();
      setStoppedNote(true);
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

  // A labeled segmented control (radio-like button group). The caller's onSelect closure
  // narrows the value back to its enum and persists it; used for both Language and Theme.
  const segmentedRow = (
    label: string,
    options: { value: string; label: string }[],
    selected: string,
    onSelect: (value: string) => void,
    testidPrefix: string,
  ): React.JSX.Element => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div role="group" aria-label={label} style={{ display: 'inline-flex', gap: 4 }}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            data-testid={`${testidPrefix}-${o.value}`}
            aria-pressed={selected === o.value}
            onClick={() => onSelect(o.value)}
            style={{
              background: selected === o.value ? 'var(--accent)' : 'var(--surface)',
              color: selected === o.value ? '#fff' : 'var(--text)',
              borderColor: selected === o.value ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  const localeOptions: { value: 'system' | 'ko' | 'en'; label: string }[] = [
    { value: 'system', label: t('settings.language.system') },
    { value: 'ko', label: t('settings.language.ko') },
    { value: 'en', label: t('settings.language.en') },
  ];
  const themeOptions: { value: 'dark' | 'light' | 'system'; label: string }[] = [
    { value: 'dark', label: t('settings.theme.dark') },
    { value: 'light', label: t('settings.theme.light') },
    { value: 'system', label: t('settings.theme.system') },
  ];

  return (
    <div className="settings-overlay" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        data-testid="settings-modal"
        className="settings-card"
        // Clicks inside the card must not bubble to the overlay's close handler.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-card__head">
          <h2 className="settings-card__title">{t('settings.title')}</h2>
          <span className="settings-saved" data-testid="settings-saved" aria-live="polite">
            {showSaved ? t('settings.saved') : ''}
          </span>
        </div>

        <div className="settings-card__body">
          {segmentedRow(
            t('settings.language'),
            localeOptions,
            locale,
            (v) => {
              setLocale(v as 'system' | 'ko' | 'en');
              queue({ locale: v } as Partial<AppSettings>, true);
            },
            'settings-locale',
          )}

          {segmentedRow(
            t('settings.theme'),
            themeOptions,
            theme,
            (v) => {
              setTheme(v as 'dark' | 'light' | 'system');
              queue({ theme: v } as Partial<AppSettings>, true);
            },
            'settings-theme',
          )}

          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
            {t('settings.blankHint')}
          </p>
          {textRow(
            t('settings.agentCommand'),
            'claude',
            agentCommand,
            setAgentCommand,
            'agentCommand',
            'settings-agent',
          )}
          {textRow(
            t('settings.verifyCommand'),
            'true',
            verifyCommand,
            setVerifyCommand,
            'verifyCommand',
            'settings-verify',
          )}
          {textRow(
            t('settings.serverCommand'),
            t('settings.autoDetect'),
            serverCommand,
            setServerCommand,
            'serverCommand',
            'settings-server',
          )}
          {textRow(
            t('settings.baseBranch'),
            'main',
            baseBranch,
            setBaseBranch,
            'baseBranch',
            'settings-base',
          )}

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
            {t('settings.persist.label')}
          </label>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            {t('settings.persist.hint')}
          </p>
          {downgraded && (
            <p
              data-testid="settings-persist-warning"
              style={{ fontSize: 12, color: 'var(--err)', margin: '6px 0 0' }}
            >
              {t('settings.persist.missing')} <code>brew install abduco</code>
            </p>
          )}
          {info?.effective === 'full' && (
            <p style={{ fontSize: 12, color: 'var(--ok)', margin: '6px 0 0' }}>
              {t('settings.persist.active')}
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              data-testid="settings-stop-all-background"
              onClick={() => void stopAll()}
              disabled={stopping}
            >
              {stopping ? t('settings.stopping') : t('settings.stopAll')}
            </button>
            {stoppedNote && (
              <span style={{ fontSize: 12, color: 'var(--ok)', marginLeft: 8 }}>
                {t('settings.stoppedNote')}
              </span>
            )}
          </div>

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
            {t('settings.codenav.title')}
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 8px' }}>
            {t('settings.codenav.hint')}
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
                {st?.available
                  ? t('settings.codenav.available')
                  : (st?.reason ?? t('settings.codenav.checking'))}
              </p>
            );
          })}
          {textRow(
            t('settings.codenav.javaPath'),
            t('settings.autoDetect'),
            lspJavaPath,
            setLspJavaPath,
            'lspJavaPath',
            'settings-lsp-java',
          )}
          {textRow(
            t('settings.codenav.kotlinPath'),
            t('settings.autoDetect'),
            lspKotlinPath,
            setLspKotlinPath,
            'lspKotlinPath',
            'settings-lsp-kotlin',
          )}

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            {t('settings.updates.title')}
          </div>
          <div
            data-testid="settings-update"
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
          >
            <span>
              {t('settings.updates.current')} <strong>v{appVersion || '…'}</strong>
            </span>
            <button
              type="button"
              data-testid="settings-update-check"
              disabled={checkingUpdate}
              onClick={() => void checkForUpdate()}
            >
              {checkingUpdate ? t('settings.updates.checking') : t('settings.updates.check')}
            </button>
          </div>
          {update && (
            <p data-testid="settings-update-result" style={{ fontSize: 12, margin: '6px 0 0' }}>
              {update.error ? (
                t('settings.updates.failed', { reason: update.error.replace('_', ' ') })
              ) : update.updateAvailable ? (
                <>
                  {t('settings.updates.available', { version: update.latestVersion ?? '' })}{' '}
                  {selfUpdate.state.phase === 'error' ? (
                    // Auto-install failed → surface it + fall back to a manual .dmg download.
                    <>
                      {t('update.failed', { reason: selfUpdate.state.reason })}{' '}
                      <button
                        type="button"
                        data-testid="settings-update-download"
                        onClick={() => openExternal(update.dmgUrl ?? update.releaseUrl)}
                      >
                        {t('settings.updates.download')}
                      </button>
                    </>
                  ) : selfUpdate.state.phase !== 'idle' ? (
                    <span data-testid="settings-update-installing">
                      {t('settings.updates.installing')}
                    </span>
                  ) : oneClickReq ? (
                    // One-click: download + verify + swap + restart (like the banner).
                    <button
                      type="button"
                      data-testid="settings-update-download"
                      onClick={() => selfUpdate.start(oneClickReq)}
                    >
                      {t('update.now')}
                    </button>
                  ) : (
                    // No verifiable sha256 → auto-install is refused; offer a manual download.
                    <button
                      type="button"
                      data-testid="settings-update-download"
                      onClick={() => openExternal(update.dmgUrl ?? update.releaseUrl)}
                    >
                      {t('settings.updates.download')}
                    </button>
                  )}
                </>
              ) : (
                t('settings.updates.upToDate')
              )}
            </p>
          )}
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            {t('settings.updates.unsignedHint')}
          </p>
        </div>

        <div className="settings-card__foot">
          <button type="button" data-testid="settings-close" onClick={close}>
            {t('settings.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
