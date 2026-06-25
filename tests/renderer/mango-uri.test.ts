import { describe, it, expect } from 'vitest';
import {
  encodeMango,
  decodeMango,
  mangoBaseUrl,
  navBaseUrl,
  MANGO_SCHEME,
} from '../../src/renderer/lib/mango-uri';

describe('mango-uri codec', () => {
  it('round-trips (worktreeId, relPath) through encode/decode', () => {
    const cases: Array<[string, string]> = [
      ['/Users/me/repo/.worktrees/wt-1', 'src/App.tsx'],
      ['/abs/path', ''], // worktree root
      ['/p', 'a/b/c/deep.ts'],
      ['/with space/repo', 'src/has space.ts'],
      ['/유니코드/wt', 'src/한글.ts'], // utf-8 safe
    ];
    for (const [id, rel] of cases) {
      const parts = encodeMango(id, rel);
      expect(parts.scheme).toBe(MANGO_SCHEME);
      expect(decodeMango(parts)).toEqual({ worktreeId: id, relPath: rel });
    }
  });

  it('the worktree segment is URL-safe base64 (no raw slashes from the abs path)', () => {
    const parts = encodeMango('/a/b/c', 'x.ts');
    const seg = parts.path.slice(1, parts.path.indexOf('/', 1));
    expect(seg).toMatch(/^[A-Za-z0-9_-]+$/); // no '/', '+', '=' that would corrupt the URI
  });

  it('FAILS CLOSED on a non-mango scheme', () => {
    expect(decodeMango({ scheme: 'file', path: '/L2EvYg/x.ts' })).toBeNull();
    expect(decodeMango({ scheme: 'http', path: '/L2EvYg/x.ts' })).toBeNull();
  });

  it('FAILS CLOSED on a malformed path / un-decodable worktree segment', () => {
    expect(decodeMango({ scheme: 'mango', path: 'no-leading-slash' })).toBeNull();
    expect(decodeMango({ scheme: 'mango', path: '/' })).toBeNull(); // empty worktree segment
    expect(decodeMango({ scheme: 'mango', path: '/!!!not-base64!!!/x.ts' })).toBeNull();
  });

  it('mangoBaseUrl is the single-slash mango root that aliases join onto', () => {
    const id = '/a/b/c';
    const seg = encodeMango(id, '').path.slice(1); // <b64url>
    // Single slash (empty authority) is load-bearing: TS sees 'mango:' as a path segment.
    expect(mangoBaseUrl(id)).toBe(`mango:/${seg}`);
    // Joining an alias substitution reproduces the EXACT model URI string the worker matches.
    const modelUri = `${encodeMango(id, 'src/foo.ts').scheme}:${encodeMango(id, 'src/foo.ts').path}`;
    expect(`${mangoBaseUrl(id)}/src/foo.ts`).toBe(modelUri);
  });

  it('navBaseUrl appends the tsconfig base dir (or stays at the root when empty)', () => {
    const id = '/a/b/c';
    expect(navBaseUrl(id, '')).toBe(mangoBaseUrl(id));
    expect(navBaseUrl(id, 'src')).toBe(`${mangoBaseUrl(id)}/src`);
    expect(navBaseUrl(id, 'packages/app')).toBe(`${mangoBaseUrl(id)}/packages/app`);
  });
});
