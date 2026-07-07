import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '../../shared/types';
import { coercePaneLayout } from '../../shared/pane-layout';
import { coerceTerminalLayouts } from '../../shared/terminal-layout';
import { coerceOpenTabs, coerceWorktreeTabs, type OpenTabs } from '../../shared/open-tabs';

/**
 * Resolves the default settings.json path under Electron's userData dir. Kept
 * separate (mirrors getDefaultSessionsPath) so register-ipc reads the store from
 * ctx while tests inject an explicit temp path into the SettingsStore constructor.
 */
export function getDefaultSettingsPath(getUserDataPath: () => string): string {
  return join(getUserDataPath(), 'settings.json');
}

/** The known string-valued AppSettings keys — the ONLY string keys read/written. */
const KNOWN_KEYS: readonly (keyof AppSettings)[] = [
  'theme',
  'locale',
  'agentCommand',
  'verifyCommand',
  'serverCommand',
  'lspJavaPath',
  'lspKotlinPath',
  'baseBranch',
  'repoRoot',
  'sessionPersistence',
  'crossMachineSessions',
  'machineId',
  'machineLabel',
  'lastDismissedUpdateVersion',
];

/** The string-array AppSettings keys (sanitized as arrays of non-empty strings). */
const KNOWN_ARRAY_KEYS: readonly (keyof AppSettings)[] = ['recentRepos'];

/** Projects an unknown to an array of non-empty strings ([] for any non-array input). */
function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * Projects an unknown to a clamped PaneLayout (delegating to the shared coercer, which also
 * MIGRATES the legacy 2-field shape), or undefined when it is unrecognizable — so a present-
 * but-invalid value is treated as UNSET, the same delete-on-invalid rule as the string keys.
 */
function sanitizePaneLayout(raw: unknown): AppSettings['paneLayout'] {
  return coercePaneLayout(raw);
}

/**
 * Persists the V2 item E AppSettings to a single JSON file whose path is injected
 * (tests use a temp file). Mirrors SessionStore EXACTLY: never throws on a
 * missing/corrupt/non-object file (treated as empty {}), sanitizes to ONLY the
 * known string fields (KNOWN_KEYS) and array fields (KNOWN_ARRAY_KEYS) — dropping
 * unknown keys and wrong-typed values — and writes atomically (temp file + rename)
 * so a crash mid-write cannot leave a half file.
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
    const current = this.load();
    const merged: Record<string, unknown> = { ...current };
    const source = partial as Record<string, unknown>;
    for (const key of KNOWN_KEYS) {
      if (!(key in source)) continue;
      const value = source[key];
      if (typeof value === 'string' && value !== '') {
        merged[key] = value;
      } else {
        delete merged[key];
      }
    }
    for (const key of KNOWN_ARRAY_KEYS) {
      if (!(key in source)) continue;
      const arr = sanitizeStringArray(source[key]);
      if (arr.length > 0) {
        merged[key] = arr;
      } else {
        delete merged[key]; // [] or non-array -> unset
      }
    }
    if ('paneLayout' in source) {
      const layout = sanitizePaneLayout(source.paneLayout);
      if (layout) {
        merged.paneLayout = layout;
      } else {
        delete merged.paneLayout; // present-but-invalid -> unset (revert to CSS defaults)
      }
    }
    if ('terminalLayouts' in source) {
      const layouts = coerceTerminalLayouts(source.terminalLayouts);
      if (layouts) {
        merged.terminalLayouts = layouts;
      } else {
        delete merged.terminalLayouts; // present-but-invalid / empty -> unset (default single tile)
      }
    }
    if (source.openTabs !== null && typeof source.openTabs === 'object') {
      // Per-key MERGE (never whole-map replace): each worktree key is validated on its own, an
      // empty/invalid entry DELETES just that key, and untouched keys (other windows/repos) are
      // preserved — so a second window can never stomp another repo's persisted tabs.
      // merged.openTabs already came from load()->sanitize() (coerced), so no re-coerce needed.
      const next: Record<string, unknown> = {
        ...((merged.openTabs as OpenTabs | undefined) ?? {}),
      };
      for (const [wt, entry] of Object.entries(source.openTabs as Record<string, unknown>)) {
        if (wt === '') continue;
        const tabs = coerceWorktreeTabs(entry);
        if (tabs) next[wt] = tabs;
        else delete next[wt];
      }
      if (Object.keys(next).length > 0) merged.openTabs = next;
      else delete merged.openTabs;
    }
    this.write(merged as AppSettings);
    return merged as AppSettings;
  }

  /**
   * Projects an input to EXACTLY the known STRING fields (drops anything else).
   * Enforces the SAME non-empty invariant as set(): an empty string is treated as
   * UNSET (dropped), so a present key ALWAYS carries a non-empty value on BOTH read
   * and write. This keeps get() from ever surfacing '' — robust to hand-edited or
   * partially-corrupt files (consistent with the corrupt-safe philosophy above) and
   * preserves "unset means fall back to env/default" downstream where `?? ` is used.
   */
  private sanitize(raw: unknown): AppSettings {
    if (raw === null || typeof raw !== 'object') return {};
    const source = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of KNOWN_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    for (const key of KNOWN_ARRAY_KEYS) {
      const arr = sanitizeStringArray(source[key]);
      if (arr.length > 0) out[key] = arr;
    }
    const layout = sanitizePaneLayout(source.paneLayout);
    if (layout) out.paneLayout = layout;
    const terminalLayouts = coerceTerminalLayouts(source.terminalLayouts);
    if (terminalLayouts) out.terminalLayouts = terminalLayouts;
    const openTabs = coerceOpenTabs(source.openTabs);
    if (openTabs) out.openTabs = openTabs;
    return out as AppSettings;
  }

  private write(settings: AppSettings): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, this.filePath);
  }
}
