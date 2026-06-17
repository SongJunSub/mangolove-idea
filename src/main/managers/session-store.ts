import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRecord } from '../../shared/types';

/**
 * Resolves the default sessions.json path under Electron's userData dir.
 * Kept separate so register-ipc can build the store lazily while tests inject
 * an explicit temp path into the SessionStore constructor instead.
 */
export function getDefaultSessionsPath(getUserDataPath: () => string): string {
  return join(getUserDataPath(), 'sessions.json');
}

/**
 * Persists the b-lite SessionRecord[] (MVP item 6) to a single JSON file whose
 * path is injected (tests use a temp file). HARD INVARIANT: only the four
 * SessionRecord contract fields are written — NEVER conversation content. claude
 * owns conversation rehydration via `--continue`; this store only records WHICH
 * worktrees had a session. Never throws on a missing/corrupt file (treated as
 * empty). Writes are atomic-ish (temp file + rename) so a crash mid-write cannot
 * leave a half-written sessions.json that would then read as empty.
 */
export class SessionStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Reads + parses the records, returning [] on missing/corrupt/non-array files.
   *
   * DESIGN (b-lite, intentional — NOT a bug): a corrupt file is treated as empty,
   * so the next `upsert` rewrites it from scratch and previously-recorded worktrees
   * lose their `--continue` eligibility. Acceptable for an MVP convenience cache:
   * the store holds NO durable state (claude owns rehydration via its own JSONL),
   * so the worst case is one missed auto-continue, not data loss. The atomic
   * temp+rename write makes self-corruption rare.
   */
  load(): SessionRecord[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return []; // corrupt JSON -> recover as empty (see DESIGN note above)
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => this.sanitize(r as SessionRecord));
  }

  /** Alias for load() — present so callers reading "all records" read clearly. */
  all(): SessionRecord[] {
    return this.load();
  }

  /** Inserts or replaces (by worktreePath) a record, then persists. */
  upsert(record: SessionRecord): void {
    const clean = this.sanitize(record);
    const records = this.load().filter((r) => r.worktreePath !== clean.worktreePath);
    records.push(clean);
    this.write(records);
  }

  /** Drops the record for a worktreePath (no-op if absent), then persists. */
  remove(worktreePath: string): void {
    const records = this.load();
    const next = records.filter((r) => r.worktreePath !== worktreePath);
    if (next.length === records.length) return; // nothing to do; avoid a pointless write
    this.write(next);
  }

  /** Projects an input down to EXACTLY the four contract fields (drops anything else). */
  private sanitize(r: SessionRecord): SessionRecord {
    return {
      worktreePath: r.worktreePath,
      branch: r.branch,
      hadActiveSession: r.hadActiveSession,
      updatedAt: r.updatedAt,
    };
  }

  private write(records: SessionRecord[]): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2));
    renameSync(tmp, this.filePath);
  }
}
