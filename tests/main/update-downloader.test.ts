import { describe, it, expect } from 'vitest';
import { createServer, get as httpGet, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadToFile, sha256OfFile } from '../../src/main/update/update-downloader';

const root = mkdtempSync(join(tmpdir(), 'mango-dl-'));
let n = 0;
const dest = (): string => join(root, `dl-${n++}.bin`);

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

describe('downloadToFile', () => {
  it('streams a body to disk and reports progress', async () => {
    const body = Buffer.alloc(5000, 7);
    const { url, server } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    const out = dest();
    const seen: Array<{ r: number; t?: number }> = [];
    try {
      await downloadToFile(`${url}/app.dmg`, out, {
        get: httpGet,
        onProgress: (r, t) => seen.push({ r, t }),
      });
      expect(readFileSync(out).length).toBe(5000);
      expect(seen.at(-1)).toEqual({ r: 5000, t: 5000 });
    } finally {
      server.close();
    }
  });

  it('follows a redirect to the real asset', async () => {
    const body = Buffer.from('REAL-DMG-BYTES');
    const assets = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    const front = await serve((_req, res) => {
      res.writeHead(302, { Location: `${assets.url}/cdn/app.dmg` });
      res.end();
    });
    const out = dest();
    try {
      await downloadToFile(`${front.url}/app.dmg`, out, { get: httpGet });
      expect(readFileSync(out).toString()).toBe('REAL-DMG-BYTES');
    } finally {
      front.server.close();
      assets.server.close();
    }
  });

  it('rejects (and drops the partial file) on a mid-stream reset', async () => {
    const { url, server } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '1000000' });
      res.write(Buffer.alloc(1000, 1));
      res.socket?.destroy();
    });
    const out = dest();
    try {
      await expect(downloadToFile(`${url}/app.dmg`, out, { get: httpGet })).rejects.toThrow();
      expect(existsSync(out)).toBe(false); // partial cleaned up
    } finally {
      server.close();
    }
  });

  it('rejects on a non-200, non-redirect status', async () => {
    const { url, server } = await serve((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    try {
      await expect(downloadToFile(`${url}/x.dmg`, dest(), { get: httpGet })).rejects.toThrow(/404/);
    } finally {
      server.close();
    }
  });

  it('rejects an unsupported url scheme without making a request', async () => {
    await expect(downloadToFile('ftp://example.com/x.dmg', dest())).rejects.toThrow(/scheme/);
  });
});

describe('sha256OfFile', () => {
  it('matches the crypto digest of the file bytes', async () => {
    const body = Buffer.from('checksum me');
    const { url, server } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    const out = dest();
    try {
      await downloadToFile(`${url}/f`, out, { get: httpGet });
      const expected = createHash('sha256').update(body).digest('hex');
      expect(await sha256OfFile(out)).toBe(expected);
    } finally {
      server.close();
    }
  });
});
