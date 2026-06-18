import type { GhCiSummary, GhStatus } from '../../shared/types';

/**
 * Sentinel exit "code" for the gh-MISSING case. gh-missing is NOT a real exit code:
 * Electron's child_process.spawn of a missing binary fires an 'error' event with
 * err.code === 'ENOENT' and NO exit code (a bare shell would give 127, but spawn does
 * not surface that). The reader's onError(ENOENT) path feeds THIS sentinel to the
 * classifier instead of inventing an exit-127 branch.
 */
export const GH_MISSING_SENTINEL = -100;

/** One row of `gh pr checks --json bucket,...`. We switch ONLY on `bucket`. */
export interface GhCheckRow {
  readonly bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
}

/**
 * PURE, table-driven mapping of (exit code, stdout, stderr) to a GhStatus kind.
 * Mirrors classifyGitError in worktree-manager.ts. ZERO spawning, ZERO token reads.
 *
 * IMPORTANT: this is only ever applied when gh ACTUALLY launched (exit-code table),
 * PLUS the GH_MISSING_SENTINEL fed by the reader's onError(ENOENT) path. The exact
 * strings/codes are verified against gh 2.89.0.
 */
export function classifyGhStatus(code: number | null, stdout: string, stderr: string): GhStatus {
  void stdout; // header parsing happens in the reader on the success path; not here.
  if (code === GH_MISSING_SENTINEL) return { kind: 'gh-missing' };

  const err = stderr ?? '';
  // not-authed: exit 4 OR the canonical not-logged-in message.
  if (code === 4 || /not logged into any GitHub hosts|gh auth login/i.test(err)) {
    return { kind: 'not-authed' };
  }
  // no-remote: any of the "no usable GitHub remote" signatures.
  if (/no git remotes found|not a github repository|known GitHub host/i.test(err)) {
    return { kind: 'no-remote' };
  }
  // no-pr: the verified exit-1 stderr from `gh pr view`/`gh pr checks` on a PR-less branch.
  if (/no pull requests found for branch/i.test(err)) {
    return { kind: 'no-pr' };
  }
  // rate-limited: a distinct calm state, never a hard error.
  if (/rate limit|HTTP 403/i.test(err)) {
    return { kind: 'rate-limited' };
  }
  return { kind: 'error', message: trimFriendly(err) };
}

/** Strips a leading 'fatal:'/'error:' prefix and trims (mirrors classifyGitError). */
function trimFriendly(raw: string): string {
  return raw
    .trim()
    .replace(/^(fatal|error):\s*/i, '')
    .trim();
}

/**
 * PURE roll-up of `gh pr checks` rows into a collapsed GhCiSummary, switching ONLY on
 * the pre-bucketed `bucket` field (pass|fail|pending|skipping|cancel) — never on the
 * ~17 raw state/conclusion values. Precedence: any fail/cancel => failing; else any
 * pending => pending; else (pass/skipping) => passing; empty => none.
 */
export function summarizeChecks(rows: readonly GhCheckRow[]): GhCiSummary {
  const counts = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  for (const r of rows) {
    if (r.bucket === 'pass') counts.pass += 1;
    else if (r.bucket === 'fail') counts.fail += 1;
    else if (r.bucket === 'pending') counts.pending += 1;
    else if (r.bucket === 'skipping') counts.skipping += 1;
    else if (r.bucket === 'cancel') counts.cancel += 1;
    // unknown buckets are ignored defensively
  }
  let summary: GhCiSummary['summary'];
  if (rows.length === 0) summary = 'none';
  else if (counts.fail > 0 || counts.cancel > 0) summary = 'failing';
  else if (counts.pending > 0) summary = 'pending';
  else summary = 'passing';
  return { summary, counts };
}
