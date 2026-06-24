import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-worktree cap on a stored scrollback string (256 KB of UTF-8). Combined with
 * the renderer's serialize({ scrollback: ~1000 }) line bound, this keeps scrollback.json
 * small even with many worktrees. Exported so the unit test asserts the exact bound.
 */
export const SCROLLBACK_MAX_BYTES = 256 * 1024;

/**
 * Global cap on the NUMBER of stored worktree entries. A backstop against unbounded
 * growth from any removal path that forgets to drop its entry: set() evicts the
 * least-recently-SET entries beyond this count. Combined with the per-entry byte cap
 * this bounds scrollback.json to ~MAX_ENTRIES * 256 KB. A dev rarely has more than a
 * handful of live worktrees, so 32 is ample headroom.
 */
export const SCROLLBACK_MAX_ENTRIES = 32;

/**
 * Resolves the default scrollback.json path under Electron's userData dir. Kept
 * separate (mirrors getDefaultSettingsPath/getDefaultSessionsPath) so register-ipc reads
 * the store from ctx while tests inject an explicit temp path into the constructor.
 */
export function getDefaultScrollbackPath(getUserDataPath: () => string): string {
  return join(getUserDataPath(), 'scrollback.json');
}

/** The on-disk shape: a flat map of worktreeId -> serialized terminal buffer string. */
type ScrollbackMap = Record<string, string>;

/**
 * Persists each worktree's LAST serialized xterm screen (ANSI string from SerializeAddon)
 * to a single JSON file whose path is injected (tests use a temp file). Mirrors the
 * corrupt-safe / atomic / sanitize pattern of SettingsStore/SessionStore: never throws on
 * a missing/corrupt/non-object file (treated as empty {}), sanitizes to ONLY string values
 * keyed by worktreeId (drops non-strings), writes atomically (temp file + rename) so a crash
 * mid-write cannot leave a half file, and caps each entry to SCROLLBACK_MAX_BYTES (keeping
 * the TAIL = newest screen). Two intentional deviations from SettingsStore: write() uses
 * COMPACT JSON (these values are large opaque ANSI blobs — pretty-printing only wastes bytes
 * against the cap), and sanitize() explicitly rejects arrays (the non-object test requires it).
 *
 * This is a DISPOSABLE placeholder cache: it holds NO durable conversation state (claude
 * owns rehydration via `--continue`). The worst case of corruption/loss is one missed
 * "instant restore" flash, never data loss — so the corrupt-as-empty recovery is intentional.
 */
export class ScrollbackStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Reads + parses the map, returning {} on missing/corrupt/non-object files. */
  private load(): ScrollbackMap {
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return {}; // corrupt JSON -> recover as empty
    }
    return this.sanitize(parsed);
  }

  /** Returns the saved buffer for a worktree, or undefined if none/invalid. */
  get(worktreeId: string): string | undefined {
    return this.load()[worktreeId];
  }

  /** Stores (capped) the buffer for a worktree, then persists atomically. */
  set(worktreeId: string, data: string): void {
    const map = this.load();
    // Re-insert so this worktree moves to the END of the insertion order (= most
    // recently set); evictToCap then drops the OLDEST (front) entries past the count
    // cap, approximating an LRU where each set() "touches" the worktree.
    delete map[worktreeId];
    map[worktreeId] = this.cap(data);
    this.evictToCap(map);
    this.write(map);
  }

  /** Evicts the least-recently-set entries so the map holds at most SCROLLBACK_MAX_ENTRIES. */
  private evictToCap(map: ScrollbackMap): void {
    const keys = Object.keys(map);
    if (keys.length <= SCROLLBACK_MAX_ENTRIES) return;
    for (const stale of keys.slice(0, keys.length - SCROLLBACK_MAX_ENTRIES)) delete map[stale];
  }

  /** Drops the entry for a worktree (no-op if absent), then persists. */
  remove(worktreeId: string): void {
    const map = this.load();
    if (!(worktreeId in map)) return; // nothing to do; avoid a pointless write
    delete map[worktreeId];
    this.write(map);
  }

  /**
   * Bounds a buffer to SCROLLBACK_MAX_BYTES of UTF-8, keeping the TAIL (the newest
   * screen content is at the end of a SerializeAddon dump). Slices on a code-point
   * boundary via Buffer so a multi-byte char is never split.
   */
  private cap(data: string): string {
    const buf = Buffer.from(data, 'utf8');
    if (buf.byteLength <= SCROLLBACK_MAX_BYTES) return data;
    // Keep the last SCROLLBACK_MAX_BYTES bytes. A cut landing mid-codepoint makes
    // toString emit a leading U+FFFD (3 bytes) in place of the 1-3 partial bytes,
    // which can push the result a few bytes OVER the cap. Strip those leading
    // replacement char(s) so the stored string is STRICTLY <= SCROLLBACK_MAX_BYTES.
    // (Real claude TUI output is box-drawing/CJK, so a multibyte cut is the common
    // case, not ASCII — the cap must hold for it.)
    return buf
      .subarray(buf.byteLength - SCROLLBACK_MAX_BYTES)
      .toString('utf8')
      .replace(/^�+/, '');
  }

  /** Projects an input to a string-only map (drops non-string values + non-objects). */
  private sanitize(raw: unknown): ScrollbackMap {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const source = raw as Record<string, unknown>;
    const out: ScrollbackMap = {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  private write(map: ScrollbackMap): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, this.filePath);
  }
}
