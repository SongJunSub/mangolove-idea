import { describe, it, expect } from 'vitest';
import { detectServerUrl } from '../../src/renderer/lib/detect-server-url';
import type { LogLine } from '../../src/shared/types';

/** Builds a LogLine with sane defaults; only `text` matters for detection. */
function line(seq: number, text: string): LogLine {
  return { worktreeId: '/wt', seq, ts: 0, stream: 'stdout', level: 'info', text };
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

  it('detects the URL of the slice it is fed (per-worktree demux upstream)', () => {
    // useLogs(worktreeId) feeds detectServerUrl ONLY the selected worktree's lines,
    // so a different worktree's URL in another partition can never bleed in here.
    const aLine = (seq: number, text: string): LogLine => ({
      worktreeId: '/a',
      seq,
      ts: 0,
      stream: 'stdout',
      level: 'info',
      text,
    });
    const aOnly = [aLine(0, 'VITE ready'), aLine(1, '  ➜  Local:   http://localhost:5174/')];
    expect(detectServerUrl(aOnly)).toBe('http://localhost:5174/');
  });
});
