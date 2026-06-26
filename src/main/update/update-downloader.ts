import { createWriteStream, createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import type { HttpGet } from './update-checker';

/**
 * Streams a .dmg to disk for the one-click self-update, FOLLOWING redirects (a GitHub release
 * download 302-redirects to its CDN). https-only on every hop (no downgrade), a redirect cap,
 * a socket-idle timeout, and `res` error handling so a mid-stream reset rejects instead of
 * hanging. Integrity is enforced separately by `sha256OfFile` against the release digest —
 * a download is never trusted on host/transport alone. `get` is injectable for tests.
 */

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;

export interface DownloadOptions {
  /** Injected GET (default node:https) so the redirect/stream path is testable. */
  readonly get?: HttpGet;
  /** Progress callback; totalBytes is undefined when the server sends no Content-Length. */
  onProgress?(receivedBytes: number, totalBytes: number | undefined): void;
}

/** Downloads `url` to `destPath`, following https redirects; rejects (never hangs) on failure. */
export function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  const get = options.get ?? httpsGet;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      void unlink(destPath).catch(() => {}); // drop the partial file
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let startedHttps: boolean;
    try {
      startedHttps = new URL(url).protocol === 'https:';
    } catch {
      reject(new Error('invalid download url'));
      return;
    }

    const request = (current: string, redirectsLeft: number): void => {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        fail(new Error('invalid download url'));
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        fail(new Error('refused unsupported url scheme'));
        return;
      }
      // Never downgrade: an https download must not be redirected to plain http (the handler
      // requires the initial dmg url to be https; http is allowed only end-to-end, for tests).
      if (startedHttps && parsed.protocol !== 'https:') {
        fail(new Error('refused insecure redirect (https -> http)'));
        return;
      }
      const req = get(current, { headers: { 'User-Agent': 'MangoLove-IDEA' } }, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain the redirect body
          if (redirectsLeft <= 0) {
            fail(new Error('too many redirects'));
            return;
          }
          request(new URL(location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          fail(new Error(`download failed: HTTP ${status}`));
          return;
        }
        const total = Number(res.headers['content-length']) || undefined;
        let received = 0;
        const out = createWriteStream(destPath);
        res.on('data', (c: Buffer) => {
          received += c.length;
          options.onProgress?.(received, total);
        });
        // A mid-stream reset fires on res; without this the pipe would stall silently.
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('download connection aborted')));
        out.on('error', fail);
        out.on('finish', succeed);
        res.pipe(out);
      });
      req.on('error', fail);
      req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('download timed out')));
    };

    request(url, MAX_REDIRECTS);
  });
}

/** Streams a file through sha256 and returns the lowercase-hex digest. */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
