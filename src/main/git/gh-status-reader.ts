import type { GhCiSummary, GhPrInfo, GhStatus, GhStatusRequest } from '../../shared/types';
import type { IProcLike, ProcessRunner } from '../proc/process-runner';

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

/**
 * True iff `git ls-remote --heads origin <branch>` stdout shows the branch on the
 * remote — i.e. a line ending in exactly `\trefs/heads/<branch>`. Used to confirm a
 * branch is REALLY pushed when it has no local upstream config (pushed without `-u`,
 * or from another clone), so such a branch is not mis-reported as not-pushed. Pure.
 */
export function remoteHasBranch(lsRemoteStdout: string, branch: string): boolean {
  const suffix = `\trefs/heads/${branch}`;
  return lsRemoteStdout.split('\n').some((line) => line.trimEnd().endsWith(suffix));
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

/** Raw `gh pr view --json number,title,state,isDraft,url,reviewDecision` shape. */
interface GhPrViewRaw {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly reviewDecision: string;
}

/** Result of buffering one gh invocation to completion. */
interface RunResult {
  /** Real exit code, or GH_MISSING_SENTINEL when the spawn fired ENOENT. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Constructor deps — all injectable so the reader is unit-testable with a fake runner. */
export interface GhStatusReaderDeps {
  readonly runner: ProcessRunner;
  readonly repoRoot: string;
  readonly owner: string;
  readonly repo: string;
  /** worktreeId -> branch (copy of DiffViewer.resolveBranch in register-ipc's closure). */
  readonly resolveBranch: (worktreeId: string) => Promise<string>;
  /** worktreeId -> absolute worktree path (= gh cwd). */
  readonly resolvePath: (worktreeId: string) => Promise<string>;
  /** True if the branch has a LOCAL upstream config (fast, no network). */
  readonly hasUpstream: (worktreeId: string) => Promise<boolean>;
  /**
   * True if the branch ACTUALLY exists on the remote (authoritative, no API quota),
   * via `git ls-remote`. Only consulted when hasUpstream is false — it disambiguates a
   * genuinely not-pushed branch from one pushed without local tracking, which the
   * upstream check alone would wrongly report as not-pushed.
   */
  readonly isOnRemote: (worktreeId: string) => Promise<boolean>;
  /** Per-call timeout (default 12_000ms); kills the child + resolves to error. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Read-only, per-worktree PR/CI status over the gh CLI. Mirrors DiffViewer: stateless,
 * constructor-injected, NEVER writes, NEVER touches a token. LOCAL pre-checks first
 * (branch + upstream) make the no-pr/not-pushed COMMON path cheap; gh only spawns when
 * the branch is pushed. The RESULT is never cached (gh state changes out-of-band).
 */
export class GhStatusReader {
  private readonly runner: ProcessRunner;
  private readonly owner: string;
  private readonly repo: string;
  private readonly resolveBranch: (worktreeId: string) => Promise<string>;
  private readonly resolvePath: (worktreeId: string) => Promise<string>;
  private readonly hasUpstream: (worktreeId: string) => Promise<boolean>;
  private readonly isOnRemote: (worktreeId: string) => Promise<boolean>;
  private readonly timeoutMs: number;

  constructor(deps: GhStatusReaderDeps) {
    this.runner = deps.runner;
    this.owner = deps.owner;
    this.repo = deps.repo;
    this.resolveBranch = deps.resolveBranch;
    this.resolvePath = deps.resolvePath;
    this.hasUpstream = deps.hasUpstream;
    this.isOnRemote = deps.isOnRemote;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Computes the GhStatus for a worktree. Never throws — degrades to a kind. */
  async status(req: GhStatusRequest): Promise<GhStatus> {
    const branch = await this.resolveBranch(req.worktreeId);
    this.assertSafeRef(branch);
    const cwd = await this.resolvePath(req.worktreeId);

    // Pre-check (no gh, no API quota): a configured upstream means pushed (fast, local).
    // With NO upstream the branch could STILL be on the remote (pushed without `-u`, or
    // from another clone), so confirm authoritatively via ls-remote before reporting
    // not-pushed — && short-circuits so ls-remote only runs in the no-upstream case.
    if (!(await this.hasUpstream(req.worktreeId)) && !(await this.isOnRemote(req.worktreeId))) {
      return { kind: 'not-pushed' };
    }

    const repoSlug = `${this.owner}/${this.repo}`;
    // The branch is the EXPLICIT POSITIONAL arg (gh pr view/checks take it positionally,
    // NOT a --head flag). NEVER call bare `gh pr view -R <repo>` (errors exit 1).
    const viewArgs = [
      'pr',
      'view',
      branch,
      '-R',
      repoSlug,
      '--json',
      'number,title,state,isDraft,url,reviewDecision',
    ];
    const view = await this.runToCompletion('gh', viewArgs, cwd);

    // Any non-success that is NOT a clean JSON header => classify (no-pr/not-authed/...).
    if (view.code !== 0 || !view.stdout.trim().startsWith('{')) {
      return classifyGhStatus(view.code, view.stdout, view.stderr);
    }

    let raw: GhPrViewRaw;
    try {
      raw = JSON.parse(view.stdout) as GhPrViewRaw;
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    const pr = toPrInfo(raw);

    // Only fetch checks when a PR exists.
    const checksArgs = ['pr', 'checks', branch, '-R', repoSlug, '--json', 'name,state,bucket,link'];
    const checks = await this.runToCompletion('gh', checksArgs, cwd);
    const ci = this.parseCi(checks);
    return { kind: 'open-pr', pr, ci };
  }

  /**
   * exit 8 = 'checks pending' is NORMAL (not an error). exit 1 + 'no checks reported'
   * => none. Otherwise parse the rows and summarize on bucket. On any spawn/parse
   * failure for checks we degrade to a 'none' CI rather than dropping the whole PR.
   */
  private parseCi(checks: RunResult): GhCiSummary {
    if (checks.code === GH_MISSING_SENTINEL) {
      return summarizeChecks([]); // unreachable in practice (view would have caught it)
    }
    if (!checks.stdout.trim().startsWith('[')) {
      // exit 8 (pending), exit 1 (no checks), or empty — treat as no usable rows.
      if (checks.code === 8) return { summary: 'pending', counts: empties() };
      return summarizeChecks([]);
    }
    try {
      const rows = JSON.parse(checks.stdout) as { bucket: GhCheckRow['bucket'] }[];
      return summarizeChecks(rows.map((r) => ({ bucket: r.bucket })));
    } catch {
      return summarizeChecks([]);
    }
  }

  /**
   * Spawns gh via the non-shell argv path, buffers stdout/stderr, resolves on exit OR
   * on a spawn 'error' (ENOENT -> GH_MISSING_SENTINEL), and has a JS setTimeout +
   * kill() guard (no macOS `timeout` binary) so a hung/missing gh NEVER hangs the
   * promise. Pass process.env through ONLY for PATH + keyring; nothing token-related.
   */
  private runToCompletion(file: string, args: readonly string[], cwd: string): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const proc: IProcLike = this.runner.spawnArgs(file, args, { cwd, env: process.env });
      let out = '';
      let err = '';
      let settled = false;
      const finish = (r: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        // finish() BEFORE kill(): kill() synchronously emits 'exit' -> onExit -> finish,
        // and finish() is settle-once, so finishing first makes the timeout stderr win
        // (otherwise the exit's empty stderr would settle first and 'gh timed out' is lost).
        finish({ code: null, stdout: out, stderr: 'gh timed out' });
        proc.kill();
      }, this.timeoutMs);
      proc.onStdout((c) => {
        out += c;
      });
      proc.onStderr((c) => {
        err += c;
      });
      proc.onError((e) => {
        const code = (e as NodeJS.ErrnoException).code;
        finish({ code: code === 'ENOENT' ? GH_MISSING_SENTINEL : null, stdout: out, stderr: err });
      });
      proc.onExit((e) => finish({ code: e.code, stdout: out, stderr: err }));
    });
  }

  /** Reject a branch token git/gh could misparse as an OPTION (leading '-'). */
  private assertSafeRef(ref: string): void {
    if (ref.startsWith('-')) throw new Error(`invalid branch ref: ${ref}`);
  }
}

/** Narrows the raw gh state/reviewDecision strings to our typed enums. */
function toPrInfo(raw: GhPrViewRaw): GhPrInfo {
  const state: GhPrInfo['state'] =
    raw.state === 'MERGED' ? 'MERGED' : raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const rd = raw.reviewDecision;
  const reviewDecision: GhPrInfo['reviewDecision'] =
    rd === 'APPROVED' || rd === 'CHANGES_REQUESTED' || rd === 'REVIEW_REQUIRED' ? rd : '';
  return {
    number: raw.number,
    state,
    title: raw.title,
    url: raw.url,
    isDraft: raw.isDraft,
    reviewDecision,
  };
}

function empties(): GhCiSummary['counts'] {
  return { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
}
