import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/i18n-context';
// NB: no import for the webview element type — `HTMLWebViewElement` is a GLOBAL ambient
// type (defined in src/renderer/webview.d.ts), so it is referenced directly.

export interface BrowserPaneProps {
  /**
   * URL auto-detected from the server logs (or null). Used to SEED the editable URL
   * bar; re-seeds when it changes UNLESS the user has typed their own URL (override).
   * NB: the override is STICKY for the pane's lifetime — once the user edits the bar,
   * auto-reseed stops permanently (even if they clear it) until the pane remounts on a
   * worktree change (App mounts BrowserPane with key={`browser-${selectedId}`}). This
   * is the intended MVP tradeoff: predictable, never fights the user's typed URL.
   */
  readonly detectedUrl: string | null;
}

/**
 * Embedded browser pane: a controlled URL bar (seeded from the detected localhost URL,
 * freely editable) + an Electron <webview> guest filling the pane + a Reload button.
 *
 * The <webview> is a plain DOM element — no special disposal beyond React unmount. The
 * guest runs with nodeIntegration OFF (no `nodeintegration` attr) + a persistent isolated
 * session (partition="persist:mango-browser"), so the embedded localhost page cannot reach
 * the app's IPC. No back/forward in the MVP — URL bar + Reload is the whole surface.
 */
export function BrowserPane({ detectedUrl }: BrowserPaneProps): React.JSX.Element {
  const { t } = useI18n();
  const webviewRef = useRef<HTMLWebViewElement | null>(null);
  // The address-bar text (what the user is editing).
  const [draft, setDraft] = useState<string>(detectedUrl ?? '');
  // The URL actually loaded into the <webview> (committed via Enter / Go).
  const [url, setUrl] = useState<string>(detectedUrl ?? '');
  // True once the user has edited the bar — stops auto-reseed from clobbering their input.
  const [overridden, setOverridden] = useState<boolean>(false);

  // Re-seed from a NEW detected URL only while the user has not taken over the bar. This
  // lets a server (re)start auto-fill the address, but never overwrites a typed URL.
  useEffect(() => {
    if (overridden) return;
    const next = detectedUrl ?? '';
    setDraft(next);
    setUrl(next);
  }, [detectedUrl, overridden]);

  /** Commit the draft as the loaded URL (Enter or the Go button). */
  const go = (): void => {
    const trimmed = draft.trim();
    // Normalize the address bar to the loaded value (so the bar and the <webview>
    // never disagree) and mark it overridden so a later detected-URL change cannot
    // clobber a URL the user explicitly committed.
    setDraft(trimmed);
    setOverridden(true);
    setUrl(trimmed);
  };

  /** Reload the guest via the webview ref (no-op when nothing is loaded). */
  const reload = (): void => {
    webviewRef.current?.reload();
  };

  return (
    <div data-testid="browser-pane" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text"
          data-testid="browser-url"
          value={draft}
          placeholder="http://localhost:5173/"
          onChange={(e) => {
            setDraft(e.target.value);
            setOverridden(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '4px 8px',
            fontSize: 13,
            fontFamily: 'ui-monospace, Menlo, monospace',
          }}
        />
        <button type="button" data-testid="browser-go" onClick={go} disabled={!draft.trim()}>
          {t('browser.go')}
        </button>
        <button type="button" data-testid="browser-reload" onClick={reload} disabled={!url}>
          {t('browser.reload')}
        </button>
      </div>
      {url ? (
        <webview
          ref={webviewRef}
          data-testid="browser-webview"
          src={url}
          partition="persist:mango-browser"
          style={{ width: '100%', height: 460, border: '1px solid #333', borderRadius: 4 }}
        />
      ) : (
        <div
          data-testid="browser-empty"
          style={{
            width: '100%',
            height: 460,
            border: '1px dashed #333',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          {t('browser.empty')}
        </div>
      )}
    </div>
  );
}
