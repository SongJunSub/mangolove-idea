# Embedded Browser View (V2 item B — webview) — Implementation Plan

For agentic workers: **REQUIRED SUB-SKILL: superpowers:subagent-driven-development**

## Goal

Give the user an **embedded browser pane** inside MangoLove IDEA so they can see their
running **local dev server** (the one started via the existing Server controls) live, in
the same window — no alt-tabbing to an external browser. The pane is an interactive,
Electron-native **`<webview>`** rendering of the localhost page, with a URL bar
(auto-seeded from the server logs) and a Reload button.

This deliberately uses Electron's built-in `<webview>` guest view — **NO Playwright, NO
chromium download, NO packaging bloat**. Electron *already is* Chromium, so embedding the
page is a renderer-side tag, not a new dependency. It is a live, interactive view of the
user's own localhost server (click links, see the page render), not a screenshot tool.

This is an **additive, read-only-to-the-app** feature: no new IPC, no git writes, no
main-process logic beyond a one-line `webPreferences` flag. The whole MVP is
`<webview>` + a URL bar + Reload, with the URL auto-detected from the server logs the
renderer already receives.

## Architecture

Mirrors the existing MVP/V2 seams exactly — additive only, nothing reshaped:

- **Main side (one flag):** add `webviewTag: true` to the single `BrowserWindow`
  `webPreferences` in `src/main/index.ts`. `<webview>` is **disabled by default** in
  Electron; without this flag the `<webview>` element is inert. This is the *only*
  main-process change and it is a no-op for all existing behavior.
- **URL detection (pure, renderer-side):** a pure exported function
  `detectServerUrl(lines: LogLine[]): string | null` in `src/renderer/lib/detect-server-url.ts`
  scans the **server log lines the renderer already has** (via the existing `useLogs` hook,
  fed by the `LOG_LINE` IPC) for the **last** (most-recent — survives a server restart)
  `http(s)://localhost|127.0.0.1[:port][/path]` occurrence. **TDD** — it is a pure
  string→data function, mirroring `src/renderer/lib/log-filter.ts` + its
  `tests/renderer/log-filter.test.ts`.
- **Renderer pane:** a `BrowserPane` component
  (`src/renderer/components/browser/browser-pane.tsx`) = a controlled URL `<input>` (seeded
  from the detected URL, editable; Enter / Go loads it) + an Electron `<webview>` filling
  the pane (fixed height ~460 like `DiffView`, `partition="persist:mango-browser"`, no
  `nodeintegration`) + a Reload button calling the `<webview>` ref `.reload()`. No
  React.lazy needed (there is no heavy bundle — it is a DOM tag), but it mirrors
  `DiffView`'s host-div/ref + `data-testid` discipline.
- **App wiring:** add `'browser'` to the `App.tsx` `paneMode` union
  (`'terminal' | 'diff' | 'conflict'` → add `'browser'`), a `tab-browser` tab button
  mirroring `tab-terminal` / `tab-diff` / `tab-conflict`, and render `<BrowserPane>` when
  `paneMode === 'browser'`. The Browser tab is **available whenever a worktree is selected**
  (like Diff — the tab row only renders inside the `selectedId ? (...)` block) — when no
  URL is detected the URL bar is simply empty and the user can type one in. App passes
  `detectServerUrl(logLines)` (from the existing `useLogs` hook already in `App.tsx`) as the
  prefill URL.
- **Verification:** `detectServerUrl` is **unit-tested (TDD, vitest jsdom project)**. The
  `webviewTag` main change and the `BrowserPane` + `App.tsx` wiring have **NO unit test**
  (`@testing-library/react` is absent, and a `<webview>` only works inside a real Electron
  renderer) — they are gated on **`npm run typecheck:web` + `npm run build`** and a
  **documented GUI smoke** (start a local server, open the Browser tab, the live page
  renders in the `<webview>`; URL auto-detected). This matches Plan 0–5 / the existing V2
  plans (Monaco diff, scrollback): no committed e2e infra.

### Security rationale (the `webviewTag: true` decision — user-approved, LOCKED)

Enabling `webviewTag` is acceptable here, and the reasons must be recorded in the commit/PR:

1. **Single-user local dev tool.** MangoLove embeds the user's **own** localhost dev
   server. There is no untrusted-content threat model — the page is the user's app.
2. **Minimal XSS surface in the host renderer.** The renderer loads **only our bundled
   app** under a strict CSP (`default-src 'self'; script-src 'self'`); it does not render
   remote/untrusted HTML. So the classic "webviewTag lets injected page script reach
   Electron internals" vector requires first compromising our own bundle.
3. **The guest is isolated from the app IPC.** A `<webview>` guest gets its **own**
   WebContents: `contextIsolation` defaults **on** and `nodeIntegration` defaults **off**
   for guests (we add **no** `nodeintegration` attribute), so the embedded localhost page
   **cannot reach `window.mango` / `ipcRenderer`** — it has no preload of ours. The host
   renderer keeps its existing `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: false`.
4. **No new attack surface added to main.** We add **no new IPC channel** and **do not
   touch `APP_OPEN_EXTERNAL`** (which stays pinned to `https://github.com`). The only main
   change is the one boolean flag.

### CSP note (verified, recorded — no change required)

The renderer CSP is:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`.
A `<webview>` **guest has its own browsing context and its own CSP** (it is a separate
WebContents, like an `<iframe>` to a different origin but stronger) — the **host page CSP
does NOT apply to and does NOT block the guest's `src` navigation**. `default-src 'self'`
governs what the *host* renderer (`file://…/index.html`) may fetch/connect to; it does not
gate the `<webview>`'s own top-level navigation to `http://localhost:PORT`. Therefore **no
CSP change is needed**. (This was the open question to verify; the conclusion — guest is
not host-CSP-blocked — is recorded here so the implementer does not relax the host CSP.
Do **not** add `frame-src`/`child-src` for the host; the guest is not a host subresource.)

### TypeScript note (REQUIRED — the typecheck gate fails without it)

React 19's `@types/react` (19.2.7) ALREADY declares the `webview` JSX intrinsic (verified:
`JSX.IntrinsicElements.webview`, typed `WebViewHTMLAttributes<HTMLWebViewElement>`, which
already includes `src` / `partition` / `allowpopups`). So `<webview src=… partition=…>` JSX
typechecks WITHOUT any custom JSX declaration — and re-declaring `webview` under
`JSX.IntrinsicElements` would CONFLICT (**TS2717**). The ONLY type gap is that
`HTMLWebViewElement` is referenced-but-undefined by `@types/react` and is absent from
`lib.dom.d.ts`, so the `webviewRef.current?.reload()` / `.src` calls need it defined. Task 3
adds a tiny ambient `src/renderer/webview.d.ts` that DEFINES `HTMLWebViewElement` (global
script-mode interface — `@types/react`'s reference resolves to it) with the two Electron
`<webview>` members BrowserPane uses. It is covered by `tsconfig.web.json`'s
`src/renderer/**/*.ts` include (no tsconfig edit) and eslint ignores `**/*.d.ts` — mirroring how
the Monaco-diff plan added `vite-env.d.ts` to satisfy the web typecheck.

## Tech Stack

- **No new dependencies.** `<webview>` ships with Electron (already a dep). No
  Playwright, no monaco-style worker wiring, no chromium download.
- Existing: React 19.2.7, Vite 7.3.5 / electron-vite 5.0.0, TypeScript 5.7.3, vitest
  (node + jsdom projects).
- The GUI smoke is documented only (no committed e2e infra), matching Plan 0–5 and the
  existing V2 plans.

## File Structure

| File | New? | Purpose |
|---|---|---|
| `src/renderer/lib/detect-server-url.ts` | **new** | Pure `detectServerUrl(lines)` — last localhost URL in the logs (TDD). |
| `tests/renderer/detect-server-url.test.ts` | **new** | Unit tests for `detectServerUrl` (mirrors `log-filter.test.ts`). |
| `src/main/index.ts` | edit | Add `webviewTag: true` to the `BrowserWindow` `webPreferences`. |
| `src/renderer/webview.d.ts` | **new** | Defines `HTMLWebViewElement` (the `<webview>` ref element type) — React 19 already provides the JSX intrinsic. Typecheck gate. |
| `src/renderer/components/browser/browser-pane.tsx` | **new** | URL bar + `<webview>` + Reload. |
| `src/renderer/App.tsx` | edit | `'browser'` paneMode + `tab-browser` + render `<BrowserPane>` with `detectServerUrl(logLines)`. |
| `docs/V2-BACKLOG.md` | edit | Strike through the **브라우저 자동화** row (delivered as embedded webview, MVP). |

No `src/shared/*`, no `src/preload/*`, no `src/main/ipc/*` changes — **no new IPC**.

---

## Task 1 — `detectServerUrl` pure function (TDD)

**Files:** `tests/renderer/detect-server-url.test.ts` (new), `src/renderer/lib/detect-server-url.ts` (new)

A pure string→data function over `LogLine[]`. **RED → GREEN → commit.** Mirrors
`src/renderer/lib/log-filter.ts` + `tests/renderer/log-filter.test.ts` (same lib/ location,
same test project — vitest's `jsdom` project includes `tests/renderer/**/*.test.ts`).

**Steps:**

1. **RED.** Create `tests/renderer/detect-server-url.test.ts`:
   ```ts
   import { describe, it, expect } from 'vitest';
   import { detectServerUrl } from '../../src/renderer/lib/detect-server-url';
   import type { LogLine } from '../../src/shared/types';

   /** Builds a LogLine with sane defaults; only `text` matters for detection. */
   function line(seq: number, text: string): LogLine {
     return { seq, ts: 0, stream: 'stdout', level: 'info', text };
   }

   describe('detectServerUrl', () => {
     it('returns null when there is no localhost URL', () => {
       const lines = [line(0, 'starting up'), line(1, 'compiled successfully')];
       expect(detectServerUrl(lines)).toBeNull();
     });

     it('returns null for an empty list', () => {
       expect(detectServerUrl([])).toBeNull();
     });

     it('finds a Vite-style "Local:   http://localhost:5173/" line', () => {
       const lines = [
         line(0, 'VITE v7.3.5  ready in 312 ms'),
         line(1, '  ➜  Local:   http://localhost:5173/'),
         line(2, '  ➜  Network: use --host to expose'),
       ];
       expect(detectServerUrl(lines)).toBe('http://localhost:5173/');
     });

     it('matches 127.0.0.1 with a port and path', () => {
       const lines = [line(0, 'Server listening on http://127.0.0.1:8080/app')];
       expect(detectServerUrl(lines)).toBe('http://127.0.0.1:8080/app');
     });

     it('matches a bare host with no port and no path', () => {
       const lines = [line(0, 'open http://localhost now')];
       // trailing word boundary stops at the space; "now" is not part of the URL.
       expect(detectServerUrl(lines)).toBe('http://localhost');
     });

     it('prefers the MOST RECENT match when several appear (survives restart)', () => {
       const lines = [
         line(0, 'Local:   http://localhost:3000/'),
         line(1, 'shutting down'),
         line(2, '[restart] Local:   http://localhost:5173/'),
       ];
       expect(detectServerUrl(lines)).toBe('http://localhost:5173/');
     });

     it('returns the LAST url even when the last url-bearing line is not the last line', () => {
       const lines = [
         line(0, 'http://localhost:3000/'),
         line(1, 'http://localhost:4000/'),
         line(2, 'GET / 200 OK'),
       ];
       expect(detectServerUrl(lines)).toBe('http://localhost:4000/');
     });

     it('matches https as well as http', () => {
       const lines = [line(0, 'Local: https://localhost:8443/')];
       expect(detectServerUrl(lines)).toBe('https://localhost:8443/');
     });

     it('does NOT match a non-local host', () => {
       const lines = [line(0, 'fetching http://example.com:5173/api')];
       expect(detectServerUrl(lines)).toBeNull();
     });

     it('picks the last URL on a single line when that line has two', () => {
       // A line that prints both — we take the last match scanning the joined text.
       const lines = [line(0, 'from http://localhost:3000/ to http://localhost:3001/')];
       expect(detectServerUrl(lines)).toBe('http://localhost:3001/');
     });
   });
   ```
   Run `npm test -- detect-server-url` → **red** (module missing → import fails to resolve).

   Expected output (red): `Error: Failed to load url ../../src/renderer/lib/detect-server-url`
   (or `Cannot find module`), the file's `describe` reported as failed/unrun.

2. **GREEN.** Create `src/renderer/lib/detect-server-url.ts` — the COMPLETE implementation:
   ```ts
   import type { LogLine } from '../../shared/types';

   /**
    * Matches a localhost dev-server URL: http or https, host localhost or 127.0.0.1,
    * an optional :port, and an optional /path that runs to the next whitespace. The
    * `g` flag lets us take the LAST match on a line (some loggers print two).
    *
    * Intentionally scoped to localhost / 127.0.0.1 so an unrelated remote URL in the
    * logs (a fetched API, a docs link) never hijacks the browser pane.
    */
   const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/\S*)?/g;

   /**
    * Scans server log lines for the MOST RECENT localhost URL and returns it, or null.
    *
    * "Most recent" = the url-bearing line with the highest index wins (a server
    * restart prints a fresh "Local: …" line, which should replace a stale earlier
    * port). Within a single line that prints two URLs, the LAST match on that line
    * wins. Pure: no I/O, no React — unit-tested like log-filter.
    */
   export function detectServerUrl(lines: readonly LogLine[]): string | null {
     for (let i = lines.length - 1; i >= 0; i--) {
       const matches = lines[i].text.match(LOCAL_URL);
       if (matches && matches.length > 0) {
         return matches[matches.length - 1];
       }
     }
     return null;
   }
   ```
   Run `npm test -- detect-server-url` → **green** (10 passing).

   Expected output (green): `✓ tests/renderer/detect-server-url.test.ts (10 tests)` and
   `Test Files  1 passed`.

3. Run `npm run lint && npm run typecheck:web` → pass.

4. **Commit:** `feat(browser): detectServerUrl — last localhost URL from server logs (TDD)`

---

## Task 2 — Enable `webviewTag` in the main BrowserWindow

**Files:** `src/main/index.ts`

**NO unit test.** This is a single boolean on the real `BrowserWindow` `webPreferences`;
it only has an observable effect inside a live Electron renderer (it un-inerts the
`<webview>` element). It is therefore gated on **`npm run typecheck:node` + `npm run
build`** here, and proven end-to-end by the **GUI smoke in Task 5** (a real localhost page
renders in the `<webview>`; with the flag absent the `<webview>` would render nothing).
For `npm run dev` there is **no behavior change** until a `<webview>` is actually used
(Tasks 3–4), so this task is a safe, isolated, no-op-for-now enablement.

**Steps:**

1. In `src/main/index.ts`, in `createWindow()`, add `webviewTag: true` to the
   `webPreferences` block. The exact current block (anchor) is:
   ```ts
       webPreferences: {
         preload: resolve(import.meta.dirname, '../preload/index.mjs'),
         contextIsolation: true,
         nodeIntegration: false,
         sandbox: false, // preload needs Node built-ins (node:module via pty-factory chain)
       },
   ```
   Replace it with (adds the one line + the rationale comment; keeps every existing line
   verbatim):
   ```ts
       webPreferences: {
         preload: resolve(import.meta.dirname, '../preload/index.mjs'),
         contextIsolation: true,
         nodeIntegration: false,
         sandbox: false, // preload needs Node built-ins (node:module via pty-factory chain)
         // Enables the <webview> tag (DISABLED by default) for the embedded Browser pane
         // (V2 B). Safe here: single-user local dev tool; the host renderer loads only our
         // bundled app under a strict CSP (minimal XSS surface), and a <webview> GUEST gets
         // its own WebContents with contextIsolation ON + nodeIntegration OFF (we add no
         // `nodeintegration` attr) so the embedded localhost page cannot reach window.mango /
         // ipcRenderer. No new IPC; APP_OPEN_EXTERNAL is untouched.
         webviewTag: true,
       },
   ```

2. Run `npm run typecheck:node` → pass. Run `npm run build` (electron-vite build) → **must
   still succeed** (no renderer code consumes `<webview>` yet; this only proves the main
   bundle still compiles).

   Expected output: build completes with the usual `main`, `preload`, `renderer` outputs;
   no TS errors.

3. **Commit:** `feat(browser): enable webviewTag on the main BrowserWindow (security note)`

---

## Task 3 — `BrowserPane` component (URL bar + `<webview>` + Reload) and its JSX/ref types

**Files:** `src/renderer/webview.d.ts` (new), `src/renderer/components/browser/browser-pane.tsx` (new)

**NO unit test** (`@testing-library/react` is absent, and a `<webview>` is inert outside a
real Electron renderer). Gated on **`npm run typecheck:web` + `npm run build`** here, and
proven by the **GUI smoke in Task 5**. The component mirrors `DiffView`'s host-div + ref +
`data-testid` discipline and `agent-terminal.tsx`'s fixed-height fill style.

**Steps:**

1. **Create the `<webview>` ref element type** — `src/renderer/webview.d.ts`.
   IMPORTANT: React 19's `@types/react` (19.2.7) ALREADY declares the `webview` JSX intrinsic
   (`JSX.IntrinsicElements.webview`, typed as `WebViewHTMLAttributes<HTMLWebViewElement>` — which
   already includes `src`, `partition`, `allowpopups`, etc.). Re-declaring `webview` under
   `JSX.IntrinsicElements` would COLLIDE — **TS2717 "subsequent property declarations must have the
   same type"**. So we do NOT touch the JSX intrinsic at all. The only gap is that
   `HTMLWebViewElement` is merely REFERENCED by `@types/react` and is NOT defined there or in
   `lib.dom.d.ts`, so we DEFINE it here with the Electron `<webview>` surface BrowserPane uses (the
   ref methods/props). A script-mode `.d.ts` (no import/export) makes this a global declaration that
   `@types/react`'s `webview` reference then resolves to. Covered by `tsconfig.web.json`'s
   `src/renderer/**/*.ts` include; eslint ignores `*.d.ts`.
   ```ts
   // React 19 @types/react already provides the `webview` JSX intrinsic (with src/partition/
   // allowpopups) typed as HTMLWebViewElement — do NOT re-declare it (TS2717). HTMLWebViewElement
   // is referenced-but-undefined by @types/react and absent from lib.dom, so define it here with
   // the Electron <webview> methods/props BrowserPane reads via its ref. No import/export => this
   // is a global ambient declaration (it DEFINES HTMLWebViewElement, which @types/react resolves to).
   interface HTMLWebViewElement extends HTMLElement {
     /** Current/most-recent guest URL (reflects the `src` attribute; settable to navigate). */
     src: string;
     /** Reloads the guest page (no-op if nothing is loaded yet). */
     reload(): void;
   }
   ```
   > Why no JSX block: the JSX side is fully covered by `@types/react`'s `WebViewHTMLAttributes`
   > (verified: it declares `src`, `partition`, `allowpopups`, ...). We add ONLY the runtime element
   > type so `webviewRef.current?.reload()` / `.src` typecheck. The ref is typed `HTMLWebViewElement`.

2. **Create the component** — `src/renderer/components/browser/browser-pane.tsx`, the
   COMPLETE implementation:
   ```tsx
   import { useEffect, useRef, useState } from 'react';
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
       setUrl(draft.trim());
     };

     /** Reload the guest via the webview ref (no-op when nothing is loaded). */
     const reload = (): void => {
       webviewRef.current?.reload();
     };

     return (
       <div
         data-testid="browser-pane"
         style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
       >
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
             Go
           </button>
           <button type="button" data-testid="browser-reload" onClick={reload} disabled={!url}>
             Reload
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
               color: '#888',
               fontSize: 13,
             }}
           >
             Start your dev server, or type a URL above and press Go.
           </div>
         )}
       </div>
     );
   }
   ```
   Notes:
   - `data-testid` on the `<webview>` is passed through as a DOM attribute (used by the
     smoke). `ref` is typed `HTMLWebViewElement` (defined in webview.d.ts) so `.reload()` is type-safe.
   - `src` is rendered **only when `url` is non-empty**; otherwise a neutral placeholder
     fills the pane (the "always-available Browser tab with empty bar" requirement).
   - No `nodeintegration` attribute is set → guest stays `nodeIntegration:false`.

3. Run `npm run typecheck:web && npm run lint` → pass. (The `webview.d.ts` resolves both
   the JSX intrinsic and the ref type; the component is otherwise plain React.)

4. **Commit:** `feat(browser): BrowserPane (<webview> + URL bar + reload) + webview JSX types`

---

## Task 4 — App.tsx wiring: `'browser'` paneMode + `tab-browser` + render `BrowserPane`

**Files:** `src/renderer/App.tsx`

**NO unit test** (no `@testing-library/react`; `<webview>` needs a real renderer). Gated on
**`npm run typecheck:web` + `npm run build`** here, and proven by the **GUI smoke in Task
5**. Mirrors the existing `tab-terminal` / `tab-diff` / `tab-conflict` + per-`paneMode`
render pattern verbatim.

**Steps:**

1. **Import `detectServerUrl` and `BrowserPane`.** Add near the existing hook imports
   (after the `useLogs` import) and the component imports:
   ```ts
   import { detectServerUrl } from './lib/detect-server-url';
   import { BrowserPane } from './components/browser/browser-pane';
   ```
   `BrowserPane` is a tiny plain-DOM component (no heavy bundle), so it is imported eagerly
   — **not** `React.lazy` (unlike `DiffView`/`ConflictView`, which lazy-load monaco). The
   anchor for the lazy block is the existing:
   ```ts
   const ConflictView = lazy(() =>
     import('./components/diff/conflict-view').then((m) => ({ default: m.ConflictView })),
   );
   ```
   — add the two eager imports above the component declarations (with the other
   `./components/...` imports near the top of the file), NOT inside the lazy block.

2. **Widen the `paneMode` union.** Replace the existing line:
   ```ts
   const [paneMode, setPaneMode] = useState<'terminal' | 'diff' | 'conflict'>('terminal');
   ```
   with:
   ```ts
   const [paneMode, setPaneMode] = useState<'terminal' | 'diff' | 'conflict' | 'browser'>(
     'terminal',
   );
   ```

3. **Compute the detected URL** from the logs the component already has. `App.tsx` already
   holds `const logLines = useLogs();`. Just below it (or anywhere in the component body
   before the return), derive:
   ```ts
   const detectedServerUrl = detectServerUrl(logLines);
   ```
   (Recomputed each render from `logLines`; cheap — a single reverse scan. `BrowserPane`
   keeps its OWN editable URL state seeded from this, and re-seeds when it changes unless
   the user has overridden — see Task 3.)

4. **Add the `tab-browser` button.** In the `role="tablist"` block, the current anchor is
   the `tab-diff` button followed by the conditional `tab-conflict` button. Add a
   `tab-browser` button **after** `tab-diff` (before the `conflictWorktreeId === selectedId
   && (...)` conditional), mirroring `tab-diff` exactly:
   ```tsx
                   <button
                     type="button"
                     role="tab"
                     aria-selected={paneMode === 'browser'}
                     data-testid="tab-browser"
                     onClick={() => setPaneMode('browser')}
                   >
                     Browser
                   </button>
   ```
   The Browser tab is **always rendered** (like Terminal and Diff) — it is NOT wrapped in
   any conditional, so it is available whether or not a URL was detected.

5. **Render `BrowserPane`** when `paneMode === 'browser'`. The anchor is the existing
   `paneMode === 'diff' && (...)` block; add the browser block right after it (and before
   the `paneMode === 'conflict'` block):
   ```tsx
               {paneMode === 'browser' && (
                 <BrowserPane key={`browser-${selectedId}`} detectedUrl={detectedServerUrl} />
               )}
   ```
   `key` per `selectedId` keeps it consistent with the other panes (a fresh editable URL
   state per worktree selection). No `Suspense` wrapper — it is an eager import.

   > Reset note: the existing SINGLE `selectedId` reset effect (App.tsx:78-98 — one `useEffect`
   > that calls `setPaneMode('terminal')` in its no-selection early return AND as the optimistic
   > default before its async `owner()` conflict probe) already moves OFF `'browser'` when the
   > worktree changes, so nothing extra is needed — selecting a new worktree returns to the
   > Terminal tab.

6. Run `npm run typecheck:web && npm run lint && npm run build` → all pass; the build must
   succeed (the renderer now references `<webview>` + `BrowserPane`).

   Expected output: electron-vite build completes (`main`, `preload`, `renderer`); no TS
   errors; renderer bundle builds (no new large chunk — `BrowserPane` is tiny).

7. Run `npm test` → the full suite stays green (the only new tests are the `detectServerUrl`
   unit tests from Task 1; nothing else gains a test).

8. **Commit:** `feat(browser): Browser tab + BrowserPane wiring (detectServerUrl prefill)`

---

## Task 5 — Full suite + documented GUI smoke + V2-BACKLOG strike-through

**Files:** `docs/V2-BACKLOG.md` (edit). No e2e infra committed (smoke documented in the PR,
matching Plan 0–5 and the existing V2 plans).

**Steps:**

1. **Full gate:** `npm run typecheck && npm run lint && npm run build && npm test` →
   **all green**. The whole existing suite stays green (run `npm test` first to record the
   current baseline count — it is the only number that matters); this plan adds exactly the 10
   new `detectServerUrl` tests on top, and changes NO existing test.

2. **Documented GUI smoke (run locally; record evidence in the PR body — do NOT commit a
   runner).** This is the ONLY proof for the three untested pieces (`webviewTag`,
   `BrowserPane`, the `App.tsx` wiring):
   - In a checkout that has a runnable local dev server, start one so its logs flow into
     the app's LogPanel. Concretely, with `npm run dev` running MangoLove, start the
     embedded dev server via the existing **Server** controls (or, for a standalone check,
     start any `http://localhost:PORT` server, e.g. `python3 -m http.server 5173`, and
     paste its URL into the bar).
   - Select a worktree, click the **Browser** tab (`data-testid="tab-browser"`).
   - **Auto-detection:** confirm the URL bar (`data-testid="browser-url"`) is pre-filled
     with the localhost URL parsed from the server logs (e.g. `http://localhost:5173/`).
   - **Live render:** confirm the `<webview>` (`data-testid="browser-webview"`) renders the
     **live page** — the actual localhost app paints inside the pane (this is what proves
     `webviewTag: true` took effect; with the flag absent the `<webview>` would be blank).
   - **Reload:** click **Reload** (`data-testid="browser-reload"`) → the page reloads.
   - **Manual URL:** clear the bar, type another `http://localhost:PORT`, press **Enter** /
     **Go** → the `<webview>` navigates there; confirm the auto-detected URL does NOT
     clobber the typed one on the next log line (override holds).
   - **Empty state:** with no URL detected and the bar empty, the Browser tab shows the
     neutral placeholder (`data-testid="browser-empty"`), and typing a URL + Go works.
   - **Isolation sanity (optional):** in the embedded page's DevTools, confirm
     `window.mango` is `undefined` inside the guest (it cannot reach the app IPC).
   - **No regressions:** Terminal / Diff / Conflicts tabs still work; the live `claude`
     PTY survives switching to Browser and back (Terminal stays mounted, hidden via
     `display:none`).
   - Capture a screenshot of the rendered localhost page in the pane for the PR body.

3. **V2-BACKLOG strike-through.** In `docs/V2-BACKLOG.md`, section **B. 외부 연동**, the
   current row (anchor):
   ```md
   | **브라우저 자동화** | M | Plan 3 | 로컬 서버 기동 후 Playwright로 화면 확인까지 한 화면에서 |
   ```
   Replace it with the delivered, struck-through form (mirroring the other `~~…~~ ✅ 완료`
   rows in that file):
   ```md
   | ~~**브라우저 자동화 → 임베디드 브라우저 뷰**~~ ✅ **완료(MVP)** | S | Plan 3 | 로컬 dev 서버를 **앱 안에서** 라이브로 본다. Electron 네이티브 `<webview>`(Playwright·크로미움 다운로드 없음 — Electron이 곧 Chromium). `webviewTag:true`(메인 1줄) + 순수 `detectServerUrl`(서버 로그에서 마지막 localhost URL, TDD) + `BrowserPane`(URL 바·`<webview>`·Reload, `partition="persist:mango-browser"`, nodeIntegration off) + `'browser'` paneMode/`tab-browser`. 게스트는 자체 WebContents(contextIsolation on)라 host CSP/IPC와 격리. 신규 IPC 없음. 계획: docs/plans/2026-06-19-v2-browser-view.md |
   ```
   Optionally also append to the status line at the top of the file (the `갱신 2026-06-19`
   line) `, **임베디드 브라우저 뷰 완료**`.

4. **Commit:** `docs(browser): mark embedded browser view delivered in V2 backlog`

---

## Migration Strategy (additive)

- **No breaking changes.** The only main-process change is one additive boolean
  (`webviewTag: true`); every existing `webPreferences` field is unchanged. No IPC channel
  is added, renamed, or removed; `APP_OPEN_EXTERNAL` is untouched (stays pinned to
  `https://github.com`). No `src/shared/*` contract change, so no producer/consumer needs
  updating.
- **`paneMode` union widening** (`+ 'browser'`) is purely additive — the existing
  `'terminal' | 'diff' | 'conflict'` branches are unchanged, and the single existing
  `selectedId` reset effect (its two `setPaneMode('terminal')` calls) continues to work (it
  moves off `'browser'` on worktree change for free).
- **New files only** otherwise: `detect-server-url.ts` (+ its test), `webview.d.ts`,
  `browser-pane.tsx`. No file is deleted; `App.tsx` gains a tab + a render branch + two
  imports + one derived value.
- **Build/runtime fallback:** if a future Electron disables `webviewTag` again, the pane
  degrades to an inert element (no crash) and `detectServerUrl` + the URL bar still work.
- **Each task commits independently** and leaves the suite green, so the work can land
  incrementally (or be bisected) without a broken intermediate state.

## Acceptance Checklist

- [ ] `detectServerUrl(lines)` is a **pure** exported function in
      `src/renderer/lib/detect-server-url.ts`; returns the **last** (most-recent)
      `http(s)://localhost|127.0.0.1[:port][/path]` in the logs, or `null`; **TDD** unit
      tests (Vite-style line, prefers most recent, returns null when none, ignores remote
      hosts) pass in the vitest jsdom project.
- [ ] `src/main/index.ts` `BrowserWindow.webPreferences` has `webviewTag: true` with the
      security-rationale comment; the existing `contextIsolation: true`,
      `nodeIntegration: false`, `sandbox: false` are unchanged. **No unit test** — gated on
      `typecheck:node` + `build` + the GUI smoke (and that is stated in Task 2).
- [ ] `BrowserPane` (`src/renderer/components/browser/browser-pane.tsx`) renders a controlled
      URL `<input>` (seeded from the detected URL, editable, Enter/Go loads), an Electron
      `<webview>` (rendered only when the URL is non-empty; neutral placeholder otherwise)
      with `src={url}`, fixed ~460 height fill, `partition="persist:mango-browser"`, **no
      `nodeintegration`**, and a **Reload** button calling the `<webview>` ref `.reload()`.
      Re-seeds from a new detected URL unless the user overrode the bar. **No unit test** —
      gated on `typecheck:web` + `build` + the GUI smoke (stated in Task 3).
- [ ] `src/renderer/webview.d.ts` DEFINES `HTMLWebViewElement` (the `<webview>` ref element type)
      so `npm run typecheck:web` passes — it does NOT re-declare the `webview` JSX intrinsic (React
      19 already provides it; re-declaring would be TS2717).
- [ ] `App.tsx` `paneMode` union includes `'browser'`; a `tab-browser` button (always
      available, mirroring `tab-diff`) is added; `<BrowserPane>` renders when
      `paneMode === 'browser'` with `detectedUrl={detectServerUrl(logLines)}`. **No unit
      test** — gated on `typecheck:web` + `build` + the GUI smoke (stated in Task 4).
- [ ] **No new IPC**; `APP_OPEN_EXTERNAL` untouched; no `src/shared/*`, `src/preload/*`, or
      `src/main/ipc/*` changes.
- [ ] CSP is **unchanged** — recorded rationale that the `<webview>` guest has its own
      context and is not blocked by the host `default-src 'self'`.
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` all pass; the
      pre-existing suite stays green and the `detectServerUrl` tests are added on top.
- [ ] Documented GUI smoke shows: URL auto-detected from logs, the **live** localhost page
      rendering inside the `<webview>`, Reload works, manual URL entry works, the empty
      placeholder shows when no URL — recorded in the PR (no committed e2e infra).
- [ ] `docs/V2-BACKLOG.md` **브라우저 자동화** row struck through as delivered (embedded
      webview, MVP).

## Self-Review

- **Right tool, zero bloat:** the LOCKED decision is honored — Electron-native `<webview>`,
  **no Playwright, no chromium download, no packaging bloat**. The only dependency is the
  Electron we already ship; the only main change is one boolean.
- **Reuse, not reshape:** `detectServerUrl` mirrors `log-filter.ts` (pure fn in `lib/`) and
  its test mirrors `log-filter.test.ts` (same `tests/renderer/` jsdom project).
  `BrowserPane` mirrors `DiffView`'s host-div/ref + `data-testid` + fixed-height fill and
  `agent-terminal.tsx`'s style. The `tab-browser` button + the `paneMode` branch mirror
  `tab-diff` / the diff render branch verbatim. `webview.d.ts` mirrors the Monaco-diff
  plan's `vite-env.d.ts` move (a `.d.ts` to satisfy `typecheck:web`).
- **Test gating is honest and matches the LOCKED instruction:** only the **pure**
  `detectServerUrl` is TDD'd; the `webviewTag` main flag and the `BrowserPane`/`App.tsx`
  wiring have **no unit test** (no `@testing-library/react`; `<webview>` is renderer-only)
  and are explicitly gated on `typecheck:web` / `build` + the GUI smoke — each such task
  says so in its body.
- **Security is reasoned, not assumed:** `webviewTag: true` is justified for a single-user
  local dev tool (host loads only our bundled app under strict CSP; the guest gets its own
  WebContents with contextIsolation on + nodeIntegration off, so it can't reach
  `window.mango`). No new IPC; `APP_OPEN_EXTERNAL` untouched.
- **CSP verified, not relaxed:** the open question (does the host CSP block the guest?) is
  resolved — a `<webview>` guest has its own browsing context, so `default-src 'self'`
  governs the host, not the guest's `http://localhost` navigation. No CSP edit; the
  rationale is recorded so a future maintainer doesn't "fix" a non-problem by loosening the
  host policy.
- **Additive + reversible:** widening `paneMode`, adding a tab, and adding files cannot
  regress existing panes; if `webviewTag` were ever disabled the pane degrades to an inert
  element. Each task lands green independently.

**Out of scope (noted, not built):** back/forward navigation, open-in-system-browser (would
require touching/loosening the pinned `APP_OPEN_EXTERNAL` — intentionally avoided), devtools
toggle for the guest, per-worktree URL memory, multiple tabs, and committed e2e infra.
