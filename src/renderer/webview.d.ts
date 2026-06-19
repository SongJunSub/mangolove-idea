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
