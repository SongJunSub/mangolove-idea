/**
 * Opens a URL in the OS default browser via the main-side, github.com-pinned guard
 * (APP_OPEN_EXTERNAL). No-ops on a null/empty url so callers can pass an optional field
 * directly. The single renderer entry point for "open a link" — keep all sites on it so
 * the null-guard never drifts.
 */
export function openExternal(url: string | null | undefined): void {
  if (url) void window.mango.app.openExternal({ url });
}
