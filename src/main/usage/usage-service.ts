import { get as httpsGet } from 'node:https';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import type { UsageStatus, UsageLimit } from '../../shared/types';

/**
 * Reads the user's Claude Code subscription usage (5-hour session + weekly limits + resets)
 * the same way the `/usage` command does: the OAuth token lives in the macOS Keychain
 * ("Claude Code-credentials"), and `GET https://api.anthropic.com/api/oauth/usage` returns the
 * per-window utilization. READ-ONLY metadata — it does NOT consume tokens or incur any cost.
 *
 * UNDOCUMENTED endpoint (reverse-engineered; same one Orca / Claude Monitor use): may change.
 * The token is used ONLY to authenticate this call and is NEVER logged or sent anywhere else.
 *
 * Split for testability: `parseUsage` + `getUsage` are pure over injected side-effects
 * (`UsageDeps`); the real Keychain spawn + HTTPS live in `createRealUsageDeps`.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const TIMEOUT_MS = 10_000;

/** The injected side-effects so getUsage is unit-testable without a Keychain or the network. */
export interface UsageDeps {
  /** Reads the Claude Code credential blob from the OS, or a typed reason it could not. */
  readCredential(): Promise<
    | { readonly ok: true; readonly raw: string }
    | { readonly ok: false; readonly reason: 'no-login' | 'denied' }
  >;
  /** GET the usage endpoint with the bearer token; returns the status + parsed JSON. */
  fetchUsage(token: string): Promise<{ readonly status: number; readonly json: unknown }>;
}

/** Pulls the OAuth access token out of the Keychain credential blob (`claudeAiOauth.accessToken`). */
export function extractAccessToken(rawCredential: string): string | null {
  try {
    const parsed = JSON.parse(rawCredential) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

interface RawLimit {
  readonly kind?: unknown;
  readonly percent?: unknown;
  readonly severity?: unknown;
  readonly resets_at?: unknown;
  readonly scope?: { readonly model?: { readonly display_name?: unknown } } | null;
}

/** A short Korean label for a usage window. */
function labelFor(kind: string, model: string | null): string {
  switch (kind) {
    case 'session':
      return '세션 (5시간)';
    case 'weekly_all':
      return '주간 (전체)';
    case 'weekly_scoped':
      return model ? `주간 (${model})` : '주간 (모델)';
    default:
      return kind;
  }
}

/** PURE: turns the usage endpoint's JSON into a UsageStatus (driven by its `limits` array). */
export function parseUsage(json: unknown): UsageStatus {
  const body = (json ?? {}) as { limits?: unknown };
  const rawLimits = Array.isArray(body.limits) ? (body.limits as RawLimit[]) : [];
  const limits: UsageLimit[] = [];
  for (const r of rawLimits) {
    const kind = typeof r?.kind === 'string' ? r.kind : '';
    if (!kind) continue;
    const model =
      r.scope && typeof r.scope.model?.display_name === 'string'
        ? r.scope.model.display_name
        : null;
    limits.push({
      kind,
      label: labelFor(kind, model),
      percent: typeof r.percent === 'number' ? Math.max(0, Math.round(r.percent)) : 0,
      severity: typeof r.severity === 'string' ? r.severity : 'normal',
      resetsAt: typeof r.resets_at === 'string' ? r.resets_at : null,
      model,
    });
  }
  return { limits };
}

/** Builds a failed status with a typed reason. */
function failed(error: NonNullable<UsageStatus['error']>): UsageStatus {
  return { limits: [], error };
}

/**
 * Reads Claude usage. NEVER throws — every failure maps to a typed `error`. No token cost.
 */
export async function getUsage(deps: UsageDeps): Promise<UsageStatus> {
  const cred = await deps.readCredential();
  if (!cred.ok) return failed(cred.reason);
  const token = extractAccessToken(cred.raw);
  if (!token) return failed('no-login');

  let res: { status: number; json: unknown };
  try {
    res = await deps.fetchUsage(token);
  } catch {
    return failed('offline');
  }
  if (res.status === 429) return failed('rate_limited');
  if (res.status !== 200) return failed('failed');
  return parseUsage(res.json);
}

/** The REAL side-effects: spawn `security` for the Keychain + an authenticated HTTPS GET. */
export function createRealUsageDeps(claudeVersion: string): UsageDeps {
  // Cache the credential for the app session so the macOS Keychain prompt appears at most ONCE
  // per launch (not on every refresh). A token that expires mid-session surfaces as a failed
  // fetch until the next launch — acceptable for a read-only usage widget.
  let cachedRaw: string | null = null;
  return {
    readCredential: () =>
      new Promise((resolve) => {
        if (cachedRaw) {
          resolve({ ok: true, raw: cachedRaw });
          return;
        }
        // `-w` prints just the secret (the credential JSON) to stdout. Reading a Keychain item
        // created by another app prompts the user once on macOS (read-only, their own token).
        execFile(
          '/usr/bin/security',
          ['find-generic-password', '-a', userInfo().username, '-s', KEYCHAIN_SERVICE, '-w'],
          { timeout: TIMEOUT_MS },
          (err, stdout) => {
            if (!err && stdout.trim()) {
              cachedRaw = stdout.trim();
              resolve({ ok: true, raw: cachedRaw });
              return;
            }
            // exit 44 = errSecItemNotFound (never logged in); anything else = denied/cancelled.
            const code = (err as { code?: number } | null)?.code;
            resolve({ ok: false, reason: code === 44 ? 'no-login' : 'denied' });
          },
        );
      }),
    fetchUsage: (token) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (run: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          run();
        };
        const req = httpsGet(
          USAGE_URL,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'anthropic-beta': 'oauth-2025-04-20',
              'User-Agent': `claude-code/${claudeVersion}`,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              let json: unknown = null;
              try {
                json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                json = null;
              }
              finish(() => resolve({ status: res.statusCode ?? 0, json }));
            });
            res.on('error', (e: Error) => finish(() => reject(e)));
          },
        );
        req.on('error', (e: Error) => finish(() => reject(e)));
        const timer = setTimeout(() => {
          req.destroy();
          finish(() => reject(new Error('usage request timed out')));
        }, TIMEOUT_MS);
      }),
  };
}
