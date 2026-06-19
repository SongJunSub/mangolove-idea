import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '../../shared/types';

/**
 * Resolves the default settings.json path under Electron's userData dir. Kept
 * separate (mirrors getDefaultSessionsPath) so register-ipc reads the store from
 * ctx while tests inject an explicit temp path into the SettingsStore constructor.
 */
export function getDefaultSettingsPath(getUserDataPath: () => string): string {
  return join(getUserDataPath(), 'settings.json');
}

/** The five known AppSettings keys — the ONLY keys ever read/written. */
const KNOWN_KEYS: readonly (keyof AppSettings)[] = [
  'agentCommand',
  'verifyCommand',
  'serverCommand',
  'baseBranch',
  'repoRoot',
];

/**
 * Persists the V2 item E AppSettings to a single JSON file whose path is injected
 * (tests use a temp file). Mirrors SessionStore EXACTLY: never throws on a
 * missing/corrupt/non-object file (treated as empty {}), sanitizes to ONLY the
 * five known STRING fields (drops unknown keys, ignores non-strings), and writes
 * atomically (temp file + rename) so a crash mid-write cannot leave a half file.
 *
 * EVERY field is optional: an unset field means the caller falls back to the env
 * seam then the hardcoded default (precedence: settings > env > default).
 */
export class SettingsStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Reads + parses settings, returning {} on missing/corrupt/non-object files. */
  load(): AppSettings {
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return {}; // corrupt JSON -> recover as empty
    }
    return this.sanitize(parsed);
  }

  /** Alias for load() — present so callers reading "current settings" read clearly. */
  get(): AppSettings {
    return this.load();
  }

  /**
   * Merges a partial into the current settings, then persists. A key PRESENT in
   * `partial` with an empty string (or a non-string) is treated as a DELETE of that
   * key (reverts to env/default) — so clearing a field in the Settings modal really
   * unsets it instead of leaving the old persisted value stuck. A key ABSENT from
   * `partial` is left untouched (true partial-merge). Sanitized to the known fields.
   */
  set(partial: Partial<AppSettings>): AppSettings {
    const merged: Record<string, string> = { ...this.load() };
    const source = partial as Record<string, unknown>;
    for (const key of KNOWN_KEYS) {
      if (!(key in source)) continue; // not in this partial -> leave as-is
      const value = source[key];
      if (typeof value === 'string' && value !== '') {
        merged[key] = value;
      } else {
        delete merged[key]; // '' or non-string -> unset (revert to env/default)
      }
    }
    this.write(merged);
    return merged;
  }

  /**
   * Projects an input to EXACTLY the five known STRING fields (drops anything else).
   * Enforces the SAME non-empty invariant as set(): an empty string is treated as
   * UNSET (dropped), so a present key ALWAYS carries a non-empty value on BOTH read
   * and write. This keeps get() from ever surfacing '' — robust to hand-edited or
   * partially-corrupt files (consistent with the corrupt-safe philosophy above) and
   * preserves "unset means fall back to env/default" downstream where `?? ` is used.
   */
  private sanitize(raw: unknown): AppSettings {
    if (raw === null || typeof raw !== 'object') return {};
    const source = raw as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of KNOWN_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  }

  private write(settings: AppSettings): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, this.filePath);
  }
}
