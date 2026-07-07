/**
 * Persisted form of the editor's open TABS, keyed by worktreeId in AppSettings. Only the file
 * PATHS + which one is active are stored — NOT buffer contents (auto-save keeps disk authoritative)
 * and NOT the preview flag (a preview tab restores as a normal pinned tab). Shared by the
 * main-process SettingsStore sanitizer (validate on read+write) and the renderer's useOpenTabs, so
 * one coercer is the single source of truth — mirroring the pane-layout / terminal-layout boundary.
 *
 * worktreeId is the worktree's ABSOLUTE PATH (stable across restarts), so entries rebind correctly;
 * a restored path whose file no longer exists simply surfaces a load error and can be closed.
 */
import { coerceWorktreeMap } from './coerce-worktree-map';

export interface WorktreeTabs {
  /** Ordered open file relPaths (deduped). */
  readonly open: readonly string[];
  /** The active relPath — always a member of `open`, or null. */
  readonly active: string | null;
}

/** Per-worktree map of open tabs. */
export type OpenTabs = Record<string, WorktreeTabs>;

/** Sanity cap on persisted tabs per worktree — far above real use; guards a corrupt file. */
const MAX_TABS = 100;

/**
 * Projects an unknown to a valid WorktreeTabs, or undefined when malformed / empty — an empty
 * `open` is treated as UNSET (that worktree simply has no tabs), the same delete-on-invalid rule
 * as the other settings keys. Dedupes paths, drops empties, and clamps `active` into `open`.
 */
export function coerceWorktreeTabs(raw: unknown): WorktreeTabs | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.open)) return undefined;
  const seen = new Set<string>();
  const open: string[] = [];
  for (const p of o.open) {
    if (typeof p !== 'string' || p === '' || seen.has(p)) continue;
    seen.add(p);
    open.push(p);
    if (open.length >= MAX_TABS) break;
  }
  if (open.length === 0) return undefined; // no tabs -> unset this worktree
  const active = typeof o.active === 'string' && seen.has(o.active) ? o.active : null;
  return { open, active };
}

/** Per-worktree map; drops any entry that fails to coerce. undefined if NONE survive. */
export function coerceOpenTabs(raw: unknown): OpenTabs | undefined {
  return coerceWorktreeMap(raw, coerceWorktreeTabs);
}
