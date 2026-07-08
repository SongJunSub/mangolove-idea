// ─────────────────────────────────────────────────────────────────────────────
// src/shared/project-groups.ts — project-group model + PURE coercers.
// Imported by BOTH main (settings-store) and renderer. NO side effects, NO fs:
// the coercers validate SHAPE only. Canonical pruning (realpath + `.git` existence)
// against the live recentRepos set is done in the main-process IPC handlers, which
// have fs access — mirrors how coercePaneLayout stays pure while REPO_LIST does the
// fs filtering. Keeping these pure keeps them trivially unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A user-defined project group: a named bucket of related repos (e.g. "CRS" holding
 * crs, crs-admin, crs-be…). `repoPaths` are canonical repo roots. INVARIANT: a repo
 * belongs to at most ONE group — the coercer enforces this by dropping later duplicates.
 */
export interface ProjectGroup {
  /** Stable id (UUID); React key + expand-state key + the target of group ops. */
  readonly id: string;
  /** Display name; must be non-empty (blank names are dropped by the coercer). */
  readonly name: string;
  /** Canonical repo roots in this group (deduped, at most one group per repo). */
  readonly repoPaths: readonly string[];
}

/**
 * The set of EXPANDED project-tree nodes, persisted so the tree remembers its shape
 * across window reloads (repo switches reload the renderer). Groups keyed by id, repos
 * by canonical path. Absence from a list => that node is COLLAPSED (the default).
 */
export interface ProjectTreeExpanded {
  /** Expanded group ids. */
  readonly groups: readonly string[];
  /** Expanded repo canonical paths. */
  readonly repos: readonly string[];
}

/** True for a non-empty string (the only shape a valid id/name/path may take). */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

/** Projects an unknown to an array of unique non-empty strings (order-preserving). */
function uniqueNonEmptyStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (isNonEmptyString(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Projects an unknown (a persisted settings.json value) to a clean ProjectGroup[], or
 * `undefined` when it is not a recognizable / non-empty list (treated as UNSET — the same
 * empty-means-unset rule paneLayout/openTabs use). Enforces every model invariant purely:
 *  - each group needs a non-empty `id` and non-empty `name` (else the group is dropped);
 *  - duplicate group ids collapse to the FIRST occurrence (React-key + op-target safety);
 *  - `repoPaths` are deduped WITHIN a group AND ACROSS groups — a repo already claimed by an
 *    earlier group is removed from later ones (the "1 repo = 1 group" invariant);
 *  - empty groups are KEPT (a user may create a group before filling it).
 * Note: does NOT canonicalize or existence-check paths — that is the IPC handler's job.
 */
export function coerceProjectGroups(raw: unknown): ProjectGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: ProjectGroup[] = [];
  const seenIds = new Set<string>();
  const claimedRepos = new Set<string>(); // a repo may be in at most one group
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (!isNonEmptyString(o.id)) continue;
    // Reject blank / whitespace-only names here too, so main (not just the client) enforces it —
    // a hand-edited settings.json or any non-UI caller can't persist a nameless group.
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name === '') continue;
    if (seenIds.has(o.id)) continue;
    seenIds.add(o.id);
    const repoPaths = uniqueNonEmptyStrings(o.repoPaths).filter((p) => {
      if (claimedRepos.has(p)) return false;
      claimedRepos.add(p);
      return true;
    });
    groups.push({ id: o.id, name, repoPaths });
  }
  return groups.length > 0 ? groups : undefined;
}

/**
 * Projects an unknown to a ProjectTreeExpanded (deduped id/path lists), or `undefined`
 * when neither list has any valid entry (treated as UNSET => everything collapsed).
 */
export function coerceProjectTreeExpanded(raw: unknown): ProjectTreeExpanded | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const groups = uniqueNonEmptyStrings(o.groups);
  const repos = uniqueNonEmptyStrings(o.repos);
  if (groups.length === 0 && repos.length === 0) return undefined;
  return { groups, repos };
}
