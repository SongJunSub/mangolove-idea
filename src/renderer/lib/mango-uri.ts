/**
 * Worktree-scoped model URI codec for code navigation (Phase B).
 *
 * Every monaco model is stamped with a `mango:` URI that encodes BOTH the worktreeId
 * and the relPath, so any navigation result (which is just a target URI + position)
 * round-trips back to EXACTLY one (worktreeId, relPath). The worktreeId is carried in
 * the FIRST path segment as URL-safe base64 — in the PATH, not the authority, because
 * URI authorities are case-folded by some parsers and base64url is case-sensitive;
 * monaco preserves path case, so this is the safe place.
 *
 * SECURITY (load-bearing): decode is FAIL-CLOSED — a non-`mango` scheme, a malformed
 * path, or an un-decodable worktree segment returns null and the caller refuses the
 * navigation. The worktreeId is ALWAYS derived from the URI here, NEVER from a captured
 * closure, because monaco providers/openers are process-global (shared across windows/
 * worktrees) and a closure would let a background worktree be navigated into.
 *
 * The pure core ({scheme, path} in/out) carries no monaco dependency so it is unit-
 * tested in node; the renderer wraps it with monaco.Uri.from / a monaco.Uri at the edge.
 */

export const MANGO_SCHEME = 'mango';

/** The subset of a monaco.Uri this codec reads/writes. */
export interface MangoUriParts {
  readonly scheme: string;
  readonly path: string;
}

/** UTF-8-safe URL-safe base64 (no padding). */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of b64urlEncode; returns null on any malformed input (fail-closed). */
function b64urlDecode(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Builds the mango URI parts for (worktreeId, relPath). relPath '' => the worktree root. */
export function encodeMango(worktreeId: string, relPath: string): MangoUriParts {
  const seg = b64urlEncode(worktreeId);
  const rest = relPath ? `/${relPath}` : '';
  return { scheme: MANGO_SCHEME, path: `/${seg}${rest}` };
}

/**
 * The TS module-resolution `baseUrl` for a worktree's mango models: `mango:/<b64url>`.
 *
 * Load-bearing detail: encodeMango puts the worktreeId in the PATH (not the authority), so
 * monaco renders model URIs with a SINGLE slash (`mango:/<b64url>/rel`). TypeScript only
 * treats a "filename" as URL-rooted when it contains `://`; with one slash it sees `mango:`
 * as an ordinary path segment, so combinePaths(baseUrl, alias-substitution) reproduces the
 * exact model URI string the worker matches. A directory-style baseUrl ('src'/'.') would
 * match no model URI and silently no-op, which is why the base must be this full prefix.
 */
export function mangoBaseUrl(worktreeId: string): string {
  const { scheme, path } = encodeMango(worktreeId, '');
  return `${scheme}:${path}`;
}

/**
 * The TS `baseUrl` to feed setCompilerOptions for a worktree: the `mango:/<b64url>` root
 * plus the tsconfig's worktree-root-relative base dir ('' => the root). A tsconfig alias
 * substitution joined onto this reproduces a real model URI (see mangoBaseUrl). PURE.
 */
export function navBaseUrl(worktreeId: string, baseDir: string): string {
  const root = mangoBaseUrl(worktreeId);
  return baseDir ? `${root}/${baseDir}` : root;
}

/** Decodes mango URI parts back to (worktreeId, relPath), or null (fail-closed). */
export function decodeMango(parts: MangoUriParts): { worktreeId: string; relPath: string } | null {
  if (parts.scheme !== MANGO_SCHEME) return null;
  const path = parts.path;
  if (!path.startsWith('/')) return null;
  const body = path.slice(1);
  const slash = body.indexOf('/');
  const seg = slash === -1 ? body : body.slice(0, slash);
  if (!seg) return null;
  const worktreeId = b64urlDecode(seg);
  if (worktreeId === null) return null;
  const relPath = slash === -1 ? '' : body.slice(slash + 1);
  return { worktreeId, relPath };
}
