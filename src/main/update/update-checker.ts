import { get as httpsGet } from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { UpdateStatus } from '../../shared/types';

/**
 * In-app update check against the project's GitHub Releases (macOS arm64, UNSIGNED).
 *
 * The app is unsigned, so this only DETECTS a newer stable release and surfaces the
 * download — it never auto-replaces the bundle (that is a separate, signed-only or
 * explicit-consent flow). The check is read-only: a single HTTPS GET to a FIXED GitHub
 * repo endpoint (no user input -> no SSRF surface), no auth (public repo), no writes.
 *
 * Split for testability: `evaluateRelease` is a PURE function over the release JSON;
 * `checkForUpdate` composes it with an injectable HTTP seam (default: node:https).
 */

/** FIXED endpoint — `/releases/latest` excludes drafts AND pre-releases (stable only). */
export const LATEST_RELEASE_URL =
  'https://api.github.com/repos/SongJunSub/mangolove-idea/releases/latest';

const DEFAULT_TIMEOUT_MS = 8000;

/** One HTTP JSON response: the status code + the parsed body (null when unparseable). */
export interface HttpJsonResponse {
  readonly status: number;
  readonly json: unknown;
}

/** Injectable GET-JSON seam so checkForUpdate is unit-testable without the network. */
export type HttpGetJson = (url: string, opts: { timeoutMs: number }) => Promise<HttpJsonResponse>;

/** The (defensively-typed) slice of the GitHub release JSON we consume. */
interface GhRelease {
  readonly tag_name?: unknown;
  readonly html_url?: unknown;
  readonly published_at?: unknown;
  readonly assets?: unknown;
}

interface GhAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly digest?: unknown;
}

/** Builds a failed status (no version info), tagged with why for the manual surface. */
function failedStatus(currentVersion: string, error: UpdateStatus['error']): UpdateStatus {
  return {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    dmgUrl: null,
    sha256: null,
    publishedAt: null,
    error,
  };
}

/** Parses `[major, minor, patch]` from a leading X.Y.Z, or null when it does not match. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True iff `latest` is a strictly-newer X.Y.Z than `current`. Stable-only (the release
 * pipeline never tags a stable build with a pre-release suffix, and `/releases/latest`
 * filters pre-releases anyway), so a numeric major/minor/patch compare is correct and
 * needs no semver dependency. Either side failing to parse => false (never a false "newer").
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Extracts the lowercase-hex sha256 from a GitHub asset `digest` ("sha256:<64hex>"). */
function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== 'string') return null;
  const m = /^sha256:([0-9a-f]{64})$/.exec(digest);
  return m ? m[1] : null;
}

/**
 * PURE: turns a GitHub `/releases/latest` JSON body into an UpdateStatus. Defensive to
 * shape drift — any missing/wrong-typed field degrades to null, and an unparseable
 * version yields a 'failed' status rather than a misleading "no update".
 */
export function evaluateRelease(currentVersion: string, raw: unknown): UpdateStatus {
  const rel = (raw ?? {}) as GhRelease;
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
  const latestVersion = tag.replace(/^v/, '');
  if (!parseVersion(latestVersion) || !parseVersion(currentVersion)) {
    return failedStatus(currentVersion, 'failed');
  }
  const assets: GhAsset[] = Array.isArray(rel.assets) ? (rel.assets as GhAsset[]) : [];
  const dmg = assets.find((a) => typeof a?.name === 'string' && a.name.endsWith('.dmg'));
  const dmgUrl =
    dmg && typeof dmg.browser_download_url === 'string' ? dmg.browser_download_url : null;
  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    releaseUrl: typeof rel.html_url === 'string' ? rel.html_url : null,
    dmgUrl,
    sha256: parseSha256Digest(dmg?.digest),
    publishedAt: typeof rel.published_at === 'string' ? rel.published_at : null,
  };
}

/** The node http(s) `get` shape — injectable so the reset/timeout handling is testable. */
export type HttpGet = (
  url: string,
  options: { headers: Record<string, string> },
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

/**
 * Default HTTP seam: one GET of a JSON body with the required User-Agent. The promise is
 * bounded by a WALL-CLOCK timer, not the socket-idle timeout: a mid-stream connection reset
 * (ECONNRESET / premature close after headers) fires on the RESPONSE — not on `req` — and
 * CLEARS the socket-idle timeout, so without `res` error handling + an independent timer the
 * promise would hang forever (and the Settings "Checking…" button would stick). Empirically
 * confirmed. `get` is injectable so this exact behavior is unit-tested against a local server.
 */
export function fetchJson(
  url: string,
  opts: { timeoutMs: number },
  get: HttpGet = httpsGet,
): Promise<HttpJsonResponse> {
  return new Promise<HttpJsonResponse>((resolve, reject) => {
    let settled = false;
    // `finish` reads `timer` via closure; both the response and req callbacks fire ASYNC
    // (after the executor assigns `timer` below), so the forward reference is TDZ-safe.
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    const req = get(
      url,
      { headers: { 'User-Agent': 'MangoLove-IDEA', Accept: 'application/vnd.github+json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null; // non-JSON body -> caller maps a non-200/!parse to 'failed'
          }
          finish(() => resolve({ status: res.statusCode ?? 0, json }));
        });
        // A mid-stream reset surfaces HERE, not on req; without these the promise hangs.
        res.on('error', (e: Error) => finish(() => reject(e)));
        res.on('aborted', () => finish(() => reject(new Error('update check connection aborted'))));
      },
    );
    req.on('error', (e: Error) => finish(() => reject(e)));
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error('update check timed out')));
    }, opts.timeoutMs);
  });
}

/**
 * Checks GitHub for a newer stable release. NEVER throws — every failure maps to a typed
 * `error` ('offline' | 'rate_limited' | 'failed') with `updateAvailable: false`, so the
 * silent launch check simply shows nothing and a manual check can explain why.
 */
export async function checkForUpdate(opts: {
  currentVersion: string;
  httpGetJson?: HttpGetJson;
  timeoutMs?: number;
}): Promise<UpdateStatus> {
  const get = opts.httpGetJson ?? fetchJson;
  let res: HttpJsonResponse;
  try {
    res = await get(LATEST_RELEASE_URL, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch {
    return failedStatus(opts.currentVersion, 'offline');
  }
  if (res.status === 403 || res.status === 429) {
    return failedStatus(opts.currentVersion, 'rate_limited');
  }
  if (res.status !== 200) {
    return failedStatus(opts.currentVersion, 'failed');
  }
  return evaluateRelease(opts.currentVersion, res.json);
}
