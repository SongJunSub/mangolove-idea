import { join } from 'node:path';

/** Injected probe so the resolver is pure + unit-testable without electron/fs. */
export interface AbducoPathProbe {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  /** Electron's process.resourcesPath (where bundled binaries live in the .app). */
  readonly resourcesPath: string;
  /** Existence check (default existsSync at the call site in index.ts). */
  exists(path: string): boolean;
}

/**
 * Known DEV install locations for abduco, ABSOLUTE paths only. Ordered
 * Homebrew-arm64, Homebrew-intel, system. We intentionally do NOT consult $PATH.
 */
const DEV_ABDUCO_PATHS: readonly string[] = [
  '/opt/homebrew/bin/abduco',
  '/usr/local/bin/abduco',
  '/usr/bin/abduco',
];

/**
 * Resolves the abduco binary by ABSOLUTE PATH ONLY — never a `$PATH` lookup. The
 * packaged app overwrites `process.env.PATH` from the user's login shell
 * (index.ts), which is an attacker-influenced surface; a `$PATH`-resolved
 * `abduco` could run an arbitrary binary. So:
 *   - non-darwin            -> null (abduco is POSIX; the app ships --mac only).
 *   - packaged (the .app)   -> ONLY the bundled, code-signed resources/bin/abduco.
 *   - dev (not packaged)    -> the first existing known Homebrew/system absolute path.
 * Returns null when abduco can't be found; the caller then falls back to b-lite
 * (DirectLauncher) and surfaces the unavailability in the Settings UI.
 */
export function resolveAbducoPath(probe: AbducoPathProbe): string | null {
  if (probe.platform !== 'darwin') return null;
  if (probe.isPackaged) {
    const bundled = join(probe.resourcesPath, 'bin', 'abduco');
    return probe.exists(bundled) ? bundled : null;
  }
  return DEV_ABDUCO_PATHS.find((p) => probe.exists(p)) ?? null;
}
