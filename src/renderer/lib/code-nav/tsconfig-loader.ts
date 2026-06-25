import { parseJsonc } from './jsonc';

/**
 * Reads the selected worktree's tsconfig.json (following relative `extends`) and distils
 * the module-resolution inputs monaco's TS service needs: a worktree-root-relative base
 * directory + the `paths` alias map. ts-nav then maps these into the mango:// URI space.
 *
 * Reads go through window.mango.file.read (FILE_READ), which is the trust boundary: it
 * confines every relPath to the worktree (rejects `..`/symlink escapes), so an
 * `extends` chain cannot read outside the tree. We additionally refuse to even FORM an
 * escaping relPath (joinRel returns null), so a malformed `extends` is skipped, not read.
 *
 * v1 scope: relative (`./` `../`) extends only — bare/package extends (e.g.
 * `@tsconfig/node18`) and directory-form extends are not resolved. `baseUrl`/`paths` are
 * taken from the nearest config that defines them, matching TypeScript's override (not
 * merge) semantics for `paths`. Split-definition monorepo configs are best-effort.
 */

export interface TsconfigNav {
  /** Worktree-root-relative base dir for module resolution. '' = the worktree root. */
  readonly baseDir: string;
  /** The tsconfig `paths` map from its nearest definer, verbatim. */
  readonly paths: Record<string, string[]>;
}

const EMPTY_NAV: TsconfigNav = { baseDir: '', paths: {} };
const MAX_EXTENDS_DEPTH = 16;
// Hard cap on total configs read for one load. The shared `visited` set already bounds reads
// to the number of distinct config files, but this is a belt-and-suspenders limit against a
// pathological repo with thousands of tsconfig files in one `extends` graph.
const MAX_CONFIGS = 256;
const ROOT_CONFIG = 'tsconfig.json';

/** Per-key provenance: the value plus the worktree-root-relative dir of its defining config. */
interface Sourced<T> {
  readonly value: T;
  readonly dir: string;
}
interface EffectiveOptions {
  baseUrl?: Sourced<string>;
  paths?: Sourced<Record<string, string[]>>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The directory of a '/'-separated relPath ('' for a top-level file). */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * Joins `rel` onto `base` (both '/'-separated, worktree-root-relative), collapsing `.`/`..`.
 * Returns null if it would escape above the worktree root — caller skips it (never reads it).
 */
function joinRel(base: string, rel: string): string | null {
  const parts = base ? base.split('/').filter(Boolean) : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** Resolves a relative `extends` value to a worktree-root-relative tsconfig path, or null. */
function resolveExtends(configDir: string, extendsValue: string): string | null {
  if (!extendsValue.startsWith('./') && !extendsValue.startsWith('../')) return null;
  const withExt = extendsValue.endsWith('.json') ? extendsValue : `${extendsValue}.json`;
  return joinRel(configDir, withExt);
}

/** Keeps only well-formed `{ [pattern]: string[] }` entries, or null if none survive. */
function sanitizePaths(raw: Record<string, unknown>): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Array.isArray(val)) continue;
    const substitutions = val.filter((x): x is string => typeof x === 'string');
    if (substitutions.length > 0) out[key] = substitutions;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function readConfig(worktreeId: string, relPath: string): Promise<unknown | null> {
  let res: Awaited<ReturnType<typeof window.mango.file.read>>;
  try {
    res = await window.mango.file.read({ worktreeId, relPath });
  } catch {
    return null; // out of scope / unreadable -> treated as absent
  }
  if (res.readOnly) return null; // binary / too large / non-UTF-8 -> not a config we parse
  try {
    return parseJsonc(res.content);
  } catch {
    return null; // malformed JSONC -> fail closed
  }
}

/**
 * Loads a config's effective baseUrl/paths, applying its `extends` parents first (lower
 * precedence) then overlaying its own compilerOptions.
 *
 * `visited` is a SINGLE set SHARED across every branch (mutated, never copied): a config is
 * read at most once for the whole graph, which both terminates cycles AND blocks a malicious
 * diamond `extends` DAG from amplifying into W^depth FILE_READ calls (a worktree-select DoS).
 * Trade-off: a config inherited via two paths contributes through the FIRST path reached only;
 * its options still land in the final result, only relative precedence in an exotic
 * split-definition config may differ — acceptable for v1's best-effort scope.
 */
async function loadEffective(
  worktreeId: string,
  relPath: string,
  depth: number,
  visited: Set<string>,
): Promise<EffectiveOptions | null> {
  if (depth > MAX_EXTENDS_DEPTH || visited.has(relPath) || visited.size >= MAX_CONFIGS) return null;
  visited.add(relPath); // before the read, so an unreadable config is not retried via a sibling
  const raw = await readConfig(worktreeId, relPath);
  if (!isObject(raw)) return null;

  const configDir = dirOf(relPath);
  let acc: EffectiveOptions = {};

  const extendsRaw = raw.extends;
  const extendsList =
    typeof extendsRaw === 'string'
      ? [extendsRaw]
      : Array.isArray(extendsRaw)
        ? extendsRaw.filter((e): e is string => typeof e === 'string')
        : [];
  for (const extendsValue of extendsList) {
    const parentRel = resolveExtends(configDir, extendsValue);
    if (!parentRel) continue;
    const parent = await loadEffective(worktreeId, parentRel, depth + 1, visited);
    if (parent) acc = { ...acc, ...parent };
  }

  const compilerOptions = raw.compilerOptions;
  if (isObject(compilerOptions)) {
    if (typeof compilerOptions.baseUrl === 'string') {
      acc = { ...acc, baseUrl: { value: compilerOptions.baseUrl, dir: configDir } };
    }
    if (isObject(compilerOptions.paths)) {
      const paths = sanitizePaths(compilerOptions.paths);
      if (paths) acc = { ...acc, paths: { value: paths, dir: configDir } };
    }
  }

  return acc;
}

/** Resolves the effective options into a worktree-root-relative { baseDir, paths }. */
function toNav(eff: EffectiveOptions): TsconfigNav {
  let baseDir = '';
  if (eff.baseUrl) {
    baseDir = joinRel(eff.baseUrl.dir, eff.baseUrl.value) ?? '';
  } else if (eff.paths) {
    baseDir = eff.paths.dir; // TS>=5: paths are relative to their config dir when baseUrl is absent
  }
  return { baseDir, paths: eff.paths?.value ?? {} };
}

/**
 * Loads the worktree's root tsconfig path-alias config. Never throws — any failure
 * (missing/malformed/out-of-scope tsconfig) yields the empty nav, so relative-import
 * navigation is unaffected and only alias resolution is skipped.
 */
export async function loadTsconfigNav(worktreeId: string): Promise<TsconfigNav> {
  try {
    const eff = await loadEffective(worktreeId, ROOT_CONFIG, 0, new Set());
    return eff ? toNav(eff) : EMPTY_NAV;
  } catch {
    return EMPTY_NAV;
  }
}
