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

/**
 * The launcher executable(s) each toolchain installs, in PREFERENCE order (Homebrew names).
 * Kotlin prefers JetBrains' `kotlin-lsp` (the IntelliJ analysis engine — resolves modern
 * Gradle/multi-module classpaths) over the unmaintained `kotlin-language-server`, whose
 * Gradle init-script classpath resolution is broken by Gradle 8/9 (no classpath => no
 * cross-file definitions). The first candidate that exists wins.
 */
const SERVER_BINS: Readonly<Record<NavServerLanguage, readonly string[]>> = {
  java: ['jdtls'],
  kotlin: ['kotlin-lsp', 'kotlin-language-server'],
};

/**
 * Returns the absolute path to the (preferred) language server for `lang`, or null when none
 * is installed in a known location (and no valid override is set). An override path is honored
 * ONLY if it exists (a stale override degrades, never silently runs nothing). Preference
 * dominates location: `kotlin-lsp` anywhere beats `kotlin-language-server` anywhere.
 */
export function resolveLspServerPath(
  lang: NavServerLanguage,
  probe: LspDetectProbe,
): string | null {
  const override = probe.overrides?.[lang];
  if (override) return probe.exists(override) ? override : null;
  for (const bin of SERVER_BINS[lang]) {
    for (const dir of PROBE_DIRS) {
      const p = `${dir}/${bin}`;
      if (probe.exists(p)) return p;
    }
  }
  return null;
}

/** A short, safe reason string for the Settings degradation surface (no fs paths). */
export function unavailableReason(lang: NavServerLanguage): string {
  const bin = SERVER_BINS[lang][0]; // the preferred launcher
  return `${bin} not found — install it (e.g. \`brew install ${bin}\`) or set its path in Settings`;
}
