import { describe, it, expect, vi } from 'vitest';
import { createServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  evaluateRelease,
  isNewerVersion,
  checkForUpdate,
  fetchJson,
  type HttpJsonResponse,
} from '../../src/main/update/update-checker';

const SHA = 'f0ee74ef6337440a469f7532dd73d74eac2fc789431cc9740ed6c268b9a34abd';

/** A GitHub `/releases/latest` JSON body for tag `v<ver>` with one .dmg asset. */
function release(
  ver: string,
  opts: { assets?: unknown[]; digest?: string | null; htmlUrl?: string } = {},
): unknown {
  const dmg = `MangoLove.IDEA-${ver}-arm64.dmg`;
  return {
    tag_name: `v${ver}`,
    html_url: opts.htmlUrl ?? `https://github.com/SongJunSub/mangolove-idea/releases/tag/v${ver}`,
    published_at: '2026-06-26T00:00:00Z',
    assets: opts.assets ?? [
      {
        name: dmg,
        browser_download_url: `https://github.com/SongJunSub/mangolove-idea/releases/download/v${ver}/${dmg}`,
        digest: opts.digest === undefined ? `sha256:${SHA}` : opts.digest,
      },
    ],
  };
}

describe('isNewerVersion', () => {
  it('detects a strictly newer X.Y.Z', () => {
    expect(isNewerVersion('0.2.0', '0.1.1')).toBe(true);
    expect(isNewerVersion('0.1.2', '0.1.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });
  it('is false for same or older', () => {
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });
  it('is false (never a phantom "newer") when either side is unparseable', () => {
    expect(isNewerVersion('garbage', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.2.0', 'garbage')).toBe(false);
  });
});

describe('evaluateRelease', () => {
  it('reports an available update with parsed fields', () => {
    const s = evaluateRelease('0.1.1', release('0.2.0'));
    expect(s).toMatchObject({
      currentVersion: '0.1.1',
      latestVersion: '0.2.0',
      updateAvailable: true,
      sha256: SHA,
      publishedAt: '2026-06-26T00:00:00Z',
    });
    expect(s.dmgUrl).toContain('MangoLove.IDEA-0.2.0-arm64.dmg');
    expect(s.releaseUrl).toContain('/tag/v0.2.0');
    expect(s.error).toBeUndefined();
  });

  it('strips the leading v and reports up-to-date when equal', () => {
    const s = evaluateRelease('0.2.0', release('0.2.0'));
    expect(s.latestVersion).toBe('0.2.0');
    expect(s.updateAvailable).toBe(false);
  });

  it('does not offer a downgrade', () => {
    expect(evaluateRelease('0.3.0', release('0.2.0')).updateAvailable).toBe(false);
  });

  it('handles a missing .dmg asset (dmgUrl + sha256 null, version still compared)', () => {
    const s = evaluateRelease('0.1.1', release('0.2.0', { assets: [] }));
    expect(s.updateAvailable).toBe(true);
    expect(s.dmgUrl).toBeNull();
    expect(s.sha256).toBeNull();
  });

  it('returns sha256 null for a missing or malformed digest', () => {
    expect(evaluateRelease('0.1.1', release('0.2.0', { digest: null })).sha256).toBeNull();
    expect(evaluateRelease('0.1.1', release('0.2.0', { digest: 'md5:zzz' })).sha256).toBeNull();
  });

  it('flags an unparseable / missing tag as a failed check', () => {
    expect(evaluateRelease('0.1.1', { tag_name: 'nightly' }).error).toBe('failed');
    expect(evaluateRelease('0.1.1', {}).error).toBe('failed');
    expect(evaluateRelease('0.1.1', null).error).toBe('failed');
  });
});

describe('checkForUpdate', () => {
  const ok = (json: unknown): HttpJsonResponse => ({ status: 200, json });

  it('maps a 200 + newer release to an available update', async () => {
    const httpGetJson = vi.fn(async () => ok(release('0.2.0')));
    const s = await checkForUpdate({ currentVersion: '0.1.1', httpGetJson });
    expect(s.updateAvailable).toBe(true);
    expect(s.latestVersion).toBe('0.2.0');
    expect(httpGetJson).toHaveBeenCalledOnce();
  });

  it('maps 403 and 429 to rate_limited', async () => {
    for (const status of [403, 429]) {
      const s = await checkForUpdate({
        currentVersion: '0.1.1',
        httpGetJson: async () => ({ status, json: null }),
      });
      expect(s.error).toBe('rate_limited');
      expect(s.updateAvailable).toBe(false);
    }
  });

  it('maps other non-200 statuses to failed', async () => {
    const s = await checkForUpdate({
      currentVersion: '0.1.1',
      httpGetJson: async () => ({ status: 404, json: null }),
    });
    expect(s.error).toBe('failed');
  });

  it('maps a thrown network error to offline', async () => {
    const s = await checkForUpdate({
      currentVersion: '0.1.1',
      httpGetJson: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(s.error).toBe('offline');
    expect(s.currentVersion).toBe('0.1.1');
  });
});

describe('fetchJson (default network seam)', () => {
  /** Start a throwaway loopback server; returns its url + close(). */
  async function serve(
    handler: Parameters<typeof createServer>[1],
  ): Promise<{ url: string; close: () => void }> {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
  }

  it('rejects (does NOT hang) on a mid-stream connection reset, well under the timeout', async () => {
    // The exact confirmed-Major scenario: headers + partial body, then the peer resets. The
    // error fires on the RESPONSE (not req) and clears the socket-idle timeout.
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
      res.socket?.destroy();
    });
    try {
      const start = Date.now();
      await expect(fetchJson(url, { timeoutMs: 3000 }, httpGet)).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(3000); // settled via res error, not the wall-clock cap
    } finally {
      close();
    }
  });

  it('rejects with a timeout when the server never responds (wall-clock bound)', async () => {
    const { url, close } = await serve(() => {
      /* accept but never respond */
    });
    try {
      const start = Date.now();
      await expect(fetchJson(url, { timeoutMs: 300 }, httpGet)).rejects.toThrow(/timed out/);
      expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    } finally {
      close();
    }
  });

  it('resolves a 200 JSON body', async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"tag_name":"v9.9.9"}');
    });
    try {
      const r = await fetchJson(url, { timeoutMs: 3000 }, httpGet);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ tag_name: 'v9.9.9' });
    } finally {
      close();
    }
  });
});
