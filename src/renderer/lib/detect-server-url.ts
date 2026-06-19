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
