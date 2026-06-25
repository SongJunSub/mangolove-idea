/**
 * Resolves the Java/Kotlin language-server launcher by ABSOLUTE PATH ONLY — never a
 * `$PATH` lookup, for the SAME reason as resolveAbducoPath: the packaged app overwrites
 * process.env.PATH from the user's login shell (an attacker-influenceable surface), so a
 * `$PATH`-resolved `jdtls` could run an arbitrary binary. The servers are NOT bundled and
 * NOT downloaded — they are the developer's own installed toolchain. Absent => the caller
 * reports capabilities {available:false} and that language's nav degrades gracefully.
 */

export type NavServerLanguage = 'java' | 'kotlin';

/** Injected probe so the resolver is pure + unit-testable without fs/electron. */
export interface LspDetectProbe {
  /** Existence check (existsSync at the call site). */
  exists(path: string): boolean;
  /** Per-language ABSOLUTE override paths from Settings (the only escape hatch). */
  readonly overrides?: { readonly java?: string; readonly kotlin?: string };
}

/** Homebrew-arm64, Homebrew-intel, system — ABSOLUTE dirs only, never $PATH. */
const PROBE_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** The wrapper executable each toolchain installs (Homebrew formula names). */
const SERVER_BIN: Readonly<Record<NavServerLanguage, string>> = {
  java: 'jdtls',
  kotlin: 'kotlin-language-server',
};

/**
 * Returns the absolute path to the language server for `lang`, or null when it is not
 * installed in a known location (and no valid override is set). An override path is
 * honored ONLY if it exists (a stale override degrades, never silently runs nothing).
 */
export function resolveLspServerPath(
  lang: NavServerLanguage,
  probe: LspDetectProbe,
): string | null {
  const override = probe.overrides?.[lang];
  if (override) return probe.exists(override) ? override : null;
  const bin = SERVER_BIN[lang];
  for (const dir of PROBE_DIRS) {
    const p = `${dir}/${bin}`;
    if (probe.exists(p)) return p;
  }
  return null;
}

/** A short, safe reason string for the Settings degradation surface (no fs paths). */
export function unavailableReason(lang: NavServerLanguage): string {
  const bin = SERVER_BIN[lang];
  return `${bin} not found — install it (e.g. \`brew install ${bin}\`) or set its path in Settings`;
}
