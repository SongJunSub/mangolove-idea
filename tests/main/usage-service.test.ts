import { describe, it, expect, vi } from 'vitest';
import {
  parseUsage,
  extractAccessToken,
  getUsage,
  type UsageDeps,
} from '../../src/main/usage/usage-service';

/** The real /api/oauth/usage response shape (trimmed to what we parse). */
const realResponse = {
  five_hour: { utilization: 3.0, resets_at: '2026-06-26T10:59:59+00:00' },
  seven_day: { utilization: 51.0, resets_at: '2026-06-30T10:59:59+00:00' },
  seven_day_opus: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 3,
      severity: 'normal',
      resets_at: '2026-06-26T10:59:59+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 51,
      severity: 'normal',
      resets_at: '2026-06-30T10:59:59+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 1,
      severity: 'normal',
      resets_at: '2026-06-30T10:59:59+00:00',
      scope: { model: { id: null, display_name: 'Sonnet' } },
      is_active: false,
    },
  ],
};

describe('extractAccessToken', () => {
  it('pulls claudeAiOauth.accessToken from the Keychain blob', () => {
    expect(extractAccessToken('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-xyz"}}')).toBe(
      'sk-ant-oat01-xyz',
    );
  });
  it('returns null for a missing token / non-JSON / empty token', () => {
    expect(extractAccessToken('{"claudeAiOauth":{}}')).toBeNull();
    expect(extractAccessToken('not json')).toBeNull();
    expect(extractAccessToken('{"claudeAiOauth":{"accessToken":""}}')).toBeNull();
  });
});

describe('parseUsage', () => {
  it('maps the limits array to labelled windows', () => {
    const s = parseUsage(realResponse);
    expect(s.error).toBeUndefined();
    expect(s.limits).toEqual([
      {
        kind: 'session',
        label: '세션 (5시간)',
        percent: 3,
        severity: 'normal',
        resetsAt: '2026-06-26T10:59:59+00:00',
        model: null,
      },
      {
        kind: 'weekly_all',
        label: '주간 (전체)',
        percent: 51,
        severity: 'normal',
        resetsAt: '2026-06-30T10:59:59+00:00',
        model: null,
      },
      {
        kind: 'weekly_scoped',
        label: '주간 (Sonnet)',
        percent: 1,
        severity: 'normal',
        resetsAt: '2026-06-30T10:59:59+00:00',
        model: 'Sonnet',
      },
    ]);
  });
  it('rounds the percent and defaults severity', () => {
    const s = parseUsage({ limits: [{ kind: 'session', percent: 2.7 }] });
    expect(s.limits[0]).toMatchObject({ percent: 3, severity: 'normal', resetsAt: null });
  });
  it('returns an empty list for a missing/garbage limits field', () => {
    expect(parseUsage({}).limits).toEqual([]);
    expect(parseUsage(null).limits).toEqual([]);
    expect(parseUsage({ limits: 'nope' }).limits).toEqual([]);
  });
});

function deps(over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    readCredential: async () => ({ ok: true, raw: '{"claudeAiOauth":{"accessToken":"tok"}}' }),
    fetchUsage: async () => ({ status: 200, json: realResponse }),
    ...over,
  };
}

describe('getUsage', () => {
  it('returns parsed usage on a 200', async () => {
    const s = await getUsage(deps());
    expect(s.error).toBeUndefined();
    expect(s.limits).toHaveLength(3);
  });

  it('passes the extracted token to fetchUsage', async () => {
    const fetchUsage = vi.fn(async () => ({ status: 200, json: realResponse }));
    await getUsage(deps({ fetchUsage }));
    expect(fetchUsage).toHaveBeenCalledWith('tok');
  });

  it('maps a missing credential to no-login', async () => {
    const s = await getUsage(
      deps({ readCredential: async () => ({ ok: false, reason: 'no-login' }) }),
    );
    expect(s.error).toBe('no-login');
  });

  it('maps a denied Keychain read to denied', async () => {
    const s = await getUsage(
      deps({ readCredential: async () => ({ ok: false, reason: 'denied' }) }),
    );
    expect(s.error).toBe('denied');
  });

  it('maps a credential without a token to no-login', async () => {
    const s = await getUsage(deps({ readCredential: async () => ({ ok: true, raw: '{}' }) }));
    expect(s.error).toBe('no-login');
  });

  it('maps 429 to rate_limited, other non-200 to failed', async () => {
    expect(
      (await getUsage(deps({ fetchUsage: async () => ({ status: 429, json: null }) }))).error,
    ).toBe('rate_limited');
    expect(
      (await getUsage(deps({ fetchUsage: async () => ({ status: 401, json: null }) }))).error,
    ).toBe('failed');
  });

  it('maps a network error to offline', async () => {
    const s = await getUsage(
      deps({
        fetchUsage: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    );
    expect(s.error).toBe('offline');
  });
});
