import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerKind } from '../../shared/types';

/** Result of inspecting a worktree dir for a runnable local server. */
export interface DetectedRunner {
  readonly kind: ServerKind;
  /** Resolved command line to spawn (shell string), or undefined when unknown. */
  readonly command?: string;
}

/** Minimal read-only fs surface so detection is injectable in tests. */
export interface FsReader {
  exists(path: string): boolean;
  readText(path: string): string;
}

const NODE_FS_READER: FsReader = {
  exists: (p) => existsSync(p),
  readText: (p) => readFileSync(p, 'utf8'),
};

/**
 * PURE: inspects a worktree dir and decides which local server (if any) to run.
 *
 * Precedence (Spring wins — a repo may carry a tooling package.json alongside a
 * gradle server, but the server we boot is Spring):
 *   1. gradlew AND (build.gradle | build.gradle.kts) => spring-gradle, './gradlew bootRun'
 *   2. package.json with scripts.dev   => npm, 'npm run dev'
 *   3. package.json with scripts.start => npm, 'npm start'
 *   4. otherwise                       => unknown (no command)
 * Never throws: malformed package.json is treated as "no scripts".
 */
export function detectRunner(dir: string, fs: FsReader = NODE_FS_READER): DetectedRunner {
  const has = (file: string): boolean => fs.exists(join(dir, file));

  if (has('gradlew') && (has('build.gradle') || has('build.gradle.kts'))) {
    return { kind: 'spring-gradle', command: './gradlew bootRun' };
  }

  if (has('package.json')) {
    const scripts = readScripts(fs, join(dir, 'package.json'));
    if (typeof scripts.dev === 'string') return { kind: 'npm', command: 'npm run dev' };
    if (typeof scripts.start === 'string') return { kind: 'npm', command: 'npm start' };
  }

  return { kind: 'unknown', command: undefined };
}

/** Reads package.json scripts; returns {} on any read/parse error (best-effort). */
function readScripts(fs: FsReader, pkgPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readText(pkgPath));
    if (parsed && typeof parsed === 'object' && 'scripts' in parsed) {
      const s = (parsed as { scripts?: unknown }).scripts;
      if (s && typeof s === 'object') return s as Record<string, unknown>;
    }
  } catch {
    // Malformed package.json => behave as if no scripts. (No empty-catch lint:
    // the comment + fallthrough are intentional.)
    return {};
  }
  return {};
}
