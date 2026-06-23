// ─────────────────────────────────────────────────────────────────────────────
// src/shared/types.ts  —  imported by BOTH main and renderer. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

/** A git worktree managed by MangoLove IDEA. */
export interface Worktree {
  /** Stable id (we use the absolute worktree path as the id). */
  readonly id: string;
  /** Absolute filesystem path of the worktree. */
  readonly path: string;
  /** Branch checked out in this worktree, e.g. 'feature/login'. */
  readonly branch: string;
  /** Short HEAD sha of the worktree, if known. */
  readonly head?: string;
  /** True for the repo's primary (main) working copy. */
  readonly isPrimary: boolean;
  /** True if the worktree dir is locked by git. */
  readonly isLocked: boolean;
}

/** Lifecycle state of the embedded agent (claude) PTY for a worktree. */
export type AgentStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

/** A live embedded agent terminal session (one PTY per worktree). */
export interface AgentSession {
  /** Same value as the owning Worktree.id (1:1). */
  readonly worktreeId: string;
  /** OS process id of the PTY's claude process, if alive. */
  readonly pid?: number;
  readonly status: AgentStatus;
  /** True when a turn was in flight (used for quit warning, MVP item 6). */
  readonly hasActiveTurn: boolean;
  /** Was this session spawned with `claude --continue` (rehydrated)? */
  readonly continued: boolean;
}

/** Which local server runtime we detected for a worktree. */
export type ServerKind = 'spring-gradle' | 'npm' | 'unknown';

/** Lifecycle of the single local server (ONE at a time, MVP item 3). */
export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

/** The single running (or last) local server process. */
export interface ServerProcess {
  /** Worktree that owns THIS server snapshot (always set for an emitted state). */
  readonly worktreeId: string | null;
  readonly kind: ServerKind;
  readonly state: ServerState;
  readonly pid?: number;
  /** The resolved command line we ran, e.g. './gradlew bootRun'. */
  readonly command?: string;
  /** Epoch ms when it entered 'running'. */
  readonly startedAt?: number;
  /** Exit code if it stopped/crashed. */
  readonly exitCode?: number | null;
}

/** Convenience snapshot returned by server:status. */
export interface ServerStatus {
  readonly process: ServerProcess;
}

/** Persisted, restart-surviving record per worktree (MVP item 6, session b-lite). */
export interface SessionRecord {
  readonly worktreePath: string;
  readonly branch: string;
  /** True if an agent session existed at last quit (=> spawn `claude --continue`). */
  readonly hadActiveSession: boolean;
  /** Epoch ms of last update. */
  readonly updatedAt: number;
}

/** One line of server log (LogStore ring buffer + file). */
export interface LogLine {
  /**
   * Worktree that produced this line (every line self-attributes; renderer demuxes).
   * REQUIRED: every producer stamps it (LogStore.push) — the V2 migration shim is gone.
   */
  readonly worktreeId: string;
  /** Monotonic sequence number within THIS worktree's current server run. */
  readonly seq: number;
  readonly ts: number; // epoch ms
  readonly stream: 'stdout' | 'stderr';
  /** Best-effort parsed level; 'raw' when unknown. */
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'raw';
  readonly text: string;
}

// ── Request / response payloads (mirrored in ipc-contract.ts) ──

export interface CreateWorktreeRequest {
  /** Base branch to fork from, e.g. 'main' (MVP item 1: base branch select). */
  readonly baseBranch: string;
  /** New branch name to create + check out in the worktree. */
  readonly newBranch: string;
  /** Optional explicit target dir; default is derived from branch name. */
  readonly path?: string;
}

export interface RemoveWorktreeRequest {
  readonly worktreeId: string;
  /** Force removal even if dirty (passes git --force). */
  readonly force?: boolean;
}

export interface SpawnSessionRequest {
  readonly worktreeId: string;
  /** When true, spawn `claude --continue` instead of fresh `claude`. */
  readonly continueSession: boolean;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionInputRequest {
  readonly worktreeId: string;
  /** Raw bytes from xterm onData to write into the PTY. */
  readonly data: string;
}

export interface SessionResizeRequest {
  readonly worktreeId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionOutputEvent {
  readonly worktreeId: string;
  /** Raw PTY output bytes to feed xterm.write(). */
  readonly data: string;
}

export interface SessionExitEvent {
  readonly worktreeId: string;
  readonly exitCode: number;
  readonly signal?: number;
}

export interface StartServerRequest {
  readonly worktreeId: string;
  // NOTE: no renderer-supplied command override — the command comes only from
  // auto-detection (gradlew vs npm) or the main-side env seam (MANGO_SERVER_CMD),
  // so a renderer cannot inject a command into the shell:true child spawn.
}

export interface StopServerRequest {
  /** Stops the named worktree's server (REQUIRED — the migration shim is gone). */
  readonly worktreeId: string;
}

/** Asks for one worktree's log ring buffer snapshot. */
export interface LogSnapshotRequest {
  readonly worktreeId: string;
}

export interface MergeRequest {
  /** Worktree (feature) branch to merge. */
  readonly worktreeId: string;
  /** Target branch to merge INTO, e.g. 'main'. */
  readonly targetBranch: string;
  /** Run the MangoLove verify hook before merging (MVP item 5). */
  readonly runVerifyHook: boolean;
  /** Remove the worktree + delete branch after a successful merge. */
  readonly cleanup: boolean;
}

export type MergeStage = 'verify' | 'merge' | 'conflict' | 'cleanup' | 'done';

export interface MergeProgressEvent {
  readonly worktreeId: string;
  readonly stage: MergeStage;
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Outcome of a merge attempt. `status` discriminates the paused-conflict case.
 * NOTE: `status` is a REQUIRED field — this is a deliberate required-field WIDENING
 * of MergeResult, not a backward-optional addition. It is safe because every
 * existing producer is updated in the same change (merge-runner's success path
 * sets 'merged' and fail() sets 'failed'; the conflict/continue/abort producers
 * added in Tasks 2-3 set the remaining values) and the existing merge-runner
 * tests assert via field access / toMatchObject (never a whole-object .toEqual),
 * so no existing assertion regresses.
 */
export interface MergeResult {
  readonly worktreeId: string;
  readonly merged: boolean;
  readonly cleanedUp: boolean;
  /**
   * 'merged'  — merge commit created (merged === true).
   * 'conflict'— merge is PAUSED in the primary tree (MERGE_HEAD present); resolve then continue/abort.
   * 'failed'  — non-conflict failure; tree was auto-aborted to a clean state (merged === false).
   */
  readonly status: 'merged' | 'conflict' | 'failed';
  /** Conflicted paths, present when status === 'conflict'. */
  readonly conflicted?: readonly string[];
  /** Present when status === 'failed'. */
  readonly error?: string;
}

/** Which index stages a conflicted path has (modify/delete & add/add lack some). */
export interface ConflictedFile {
  readonly path: string;
  /** Porcelain unmerged XY code: UU, AA, DU, UD, DD, AU, UA. */
  readonly code: string;
  /** Stage :2 (ours/target) present — false for an add/add-missing or theirs-only case. */
  readonly hasOurs: boolean;
  /** Stage :3 (theirs/feature) present. */
  readonly hasTheirs: boolean;
}

/** The four blob views for one conflicted file (absent stages return ''). */
export interface ConflictFileVersions {
  readonly path: string;
  readonly code: string;
  /** Stage :1 — common ancestor; '' if absent (e.g. add/add). */
  readonly base: string;
  /** Stage :2 — OURS = the TARGET branch (e.g. main); '' if absent (e.g. ours deleted). */
  readonly ours: string;
  /** Stage :3 — THEIRS = the FEATURE branch; '' if absent (e.g. theirs deleted). */
  readonly theirs: string;
  /** The working-tree file with git's raw <<<<<<< ======= >>>>>>> markers. */
  readonly working: string;
  readonly hasOurs: boolean;
  readonly hasTheirs: boolean;
}

export interface ConflictListRequest {
  readonly worktreeId: string;
}

export interface ConflictReadRequest {
  readonly worktreeId: string;
  readonly path: string;
}

export interface ConflictResolveRequest {
  readonly worktreeId: string;
  readonly path: string;
  /**
   * 'ours'   — checkout --ours + add (target/main version).
   * 'theirs' — checkout --theirs + add (feature version).
   * 'manual' — write `content` + add.
   * 'keep'   — git add the working file as-is (modify/delete: keep the file).
   * 'remove' — git rm the path (modify/delete: drop the file).
   */
  readonly choice: 'ours' | 'theirs' | 'manual' | 'keep' | 'remove';
  /** Required when choice === 'manual'. */
  readonly content?: string;
  /** Target branch (so the resolver can run cleanup with the right feature branch). */
  readonly targetBranch: string;
}

export interface ConflictContinueRequest {
  readonly worktreeId: string;
  readonly targetBranch: string;
  /** Remove the worktree + delete the feature branch after the commit (mirrors MergeRequest). */
  readonly cleanup: boolean;
}

export interface ConflictAbortRequest {
  readonly worktreeId: string;
}

export interface ConflictInProgressRequest {
  readonly worktreeId: string;
}

/**
 * Emitted to the renderer at quit when an agent TURN is in flight, so the user can
 * confirm before the PTYs are swept. As of V2 C this is driven by TURN DETECTION
 * (output-activity heuristic: a session that emitted output within ACTIVE_TURN_MS),
 * NOT by mere liveness — an idle live session is lossless to quit (b-lite re-spawns
 * it via `claude --continue`). The kill-sweep on confirmed quit still kills ALL live
 * PTYs; only this WARNING keys on active turns.
 */
export interface QuitWarningEvent {
  /** worktreeIds that currently have an ACTIVE TURN (live PTY, output within ACTIVE_TURN_MS). */
  readonly activeWorktreeIds: readonly string[];
}

/** Generic OK/err envelope for invoke handlers that don't return data. */
export interface Ack {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Plan-0 IPC probe payload: proves the typed round-trip + native-rebuild story.
 * Returned by the APP_PING channel. NOT part of any MVP feature — it is the
 * template every later plan's invoke handler copies.
 */
export interface AppInfo {
  /** Electron app version (app.getVersion()). */
  readonly appVersion: string;
  /** process.versions.electron in main. */
  readonly electronVersion: string;
  /** process.versions.node in main. */
  readonly nodeVersion: string;
  /** process.versions.chrome in main. */
  readonly chromeVersion: string;
  /** node-pty package version, resolved by requiring it in main (the ABI trap probe). */
  readonly nodePtyVersion: string;
  /** True if `require('node-pty')` loaded without an ABI mismatch error. */
  readonly nodePtyLoaded: boolean;
}

// ── Diff viewer (V2 item A1) ──

/** Per-file change kind in a PR-style diff. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One changed file in the worktree branch vs its base (merge-base) diff. */
export interface ChangedFile {
  /** Path shown to the user (the new/destination path for renames). */
  readonly path: string;
  readonly status: ChangeStatus;
  /** Original path when status === 'renamed' (the pre-rename path), else undefined. */
  readonly oldPath?: string;
  /** True if git treats the file as binary (no text diff possible). */
  readonly binary: boolean;
}

/** Full original/modified contents for one file, for Monaco's DiffEditor. */
export interface FileDiff {
  readonly path: string;
  readonly status: ChangeStatus;
  /** Base (merge-base) contents; '' for added or binary files. */
  readonly original: string;
  /** Branch contents; '' for deleted or binary files. */
  readonly modified: string;
  readonly binary: boolean;
}

export interface DiffListRequest {
  readonly worktreeId: string;
  /** Base branch to diff against; defaults to 'main' in the main process. */
  readonly base?: string;
}

export interface DiffFileRequest {
  readonly worktreeId: string;
  readonly base?: string;
  /** The changed file's path (the new path for renames). */
  readonly path: string;
}

// ── PR/CI status panel (V2) ──

/** Request the gh-backed PR/CI status for one worktree. */
export interface GhStatusRequest {
  readonly worktreeId: string;
}

/** Ask main to open a URL in the OS default browser (the only "action"). */
export interface OpenExternalRequest {
  readonly url: string;
}

/** Payload for SCROLLBACK_SET: persist one worktree's serialized terminal screen. */
export interface ScrollbackSetRequest {
  readonly worktreeId: string;
  /** SerializeAddon ANSI string (capped by the store to SCROLLBACK_MAX_BYTES). */
  readonly data: string;
}

/** Collapsed CI summary derived ONLY from gh's per-check `bucket` field. */
export interface GhCiSummary {
  /** 'none' = a PR with zero reported checks. */
  readonly summary: 'passing' | 'failing' | 'pending' | 'none';
  readonly counts: {
    readonly pass: number;
    readonly fail: number;
    readonly pending: number;
    readonly skipping: number;
    readonly cancel: number;
  };
}

/** PR header for an open/merged/closed PR on the worktree's branch. */
export interface GhPrInfo {
  readonly number: number;
  /** gh `state`: OPEN | MERGED | CLOSED. */
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  /**
   * gh `reviewDecision`: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' (the
   * EMPTY STRING when no review is required — handle it, do not assume one of three).
   */
  readonly reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}

/**
 * Discriminated union on `kind`. The COMMON path here is not-pushed / no-pr (repo
 * merges to main directly); those are calm first-class states, NOT errors.
 *  - gh-missing   : the gh binary is not installed (spawn ENOENT).
 *  - not-authed   : gh is installed but not logged in (exit 4 / 'gh auth login').
 *  - no-remote    : no git/GitHub remote configured.
 *  - not-pushed   : the branch has no upstream — detected LOCALLY, gh never spawned.
 *  - no-pr        : pushed but no PR exists yet.
 *  - open-pr      : a PR exists (state may be OPEN | MERGED | CLOSED); carries pr + ci.
 *  - rate-limited : GitHub API rate limit / HTTP 403.
 *  - error        : anything else; carries a trimmed friendly message.
 */
export type GhStatus =
  | { readonly kind: 'gh-missing' }
  | { readonly kind: 'not-authed' }
  | { readonly kind: 'no-remote' }
  | { readonly kind: 'not-pushed' }
  | { readonly kind: 'no-pr' }
  | { readonly kind: 'open-pr'; readonly pr: GhPrInfo; readonly ci: GhCiSummary }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'error'; readonly message: string };

// ── Settings (V2 item E) ──

/**
 * Persisted, user-editable per-project config (V2 item E). EVERY field is
 * OPTIONAL: an unset field means "fall back to the existing env seam, then the
 * hardcoded default" (precedence: settings > env > default), so the dev/test env
 * seams — and the existing Playwright smokes — keep working when settings are unset.
 */
export interface AppSettings {
  /** Agent binary to spawn; unset => MANGO_AGENT_CMD ?? 'claude'. */
  readonly agentCommand?: string;
  /** Verify hook command; unset => MANGO_VERIFY_CMD ?? 'true'. */
  readonly verifyCommand?: string;
  /** Server start override; unset => MANGO_SERVER_CMD ?? auto-detection. */
  readonly serverCommand?: string;
  /** Default base branch for merge target + diff; unset => 'main'. */
  readonly baseBranch?: string;
  /**
   * Absolute path of the git repo MangoLove operates on. Set ONLY via the
   * repo-picker flow (REPO_PICK), never surfaced in the Settings modal. Unset =>
   * resolveRepoRoot() falls back to cwd (dev) or null (Finder launch w/ bad cwd).
   */
  readonly repoRoot?: string;
  /**
   * Absolute paths of recently-opened repos (multi-window). The launcher reopens
   * the most-recent on boot; REPO_PICK pushes the picked repo to the front. Empty
   * array unsets the key. Seeded from the legacy single `repoRoot` on first read.
   */
  readonly recentRepos?: readonly string[];
  /**
   * Session persistence mode (V2 b-full). Unset / 'lite' (default): claude runs as
   * a child PTY; reopen offers `claude --continue` so the CONVERSATION is restored,
   * but an in-flight TURN is lost on quit/crash. 'full': claude runs inside an
   * `abduco` detached session so an in-flight turn SURVIVES quit/crash and is
   * re-attached on reopen. 'full' degrades to 'lite' when abduco is unavailable
   * (surfaced in the Settings UI — never a silent downgrade). Any value other than
   * the exact string 'full' is treated as 'lite'.
   */
  readonly sessionPersistence?: 'lite' | 'full';
}

// ── Repo root picker (V2 packaging) ──

/**
 * Result of the REPO_PICK flow. On success the main process has pushed the repo to
 * recentRepos and opened (or focused) a window for it — no relaunch — so the renderer
 * observes `ok:true` normally (its empty-gate window may be reloaded to attach the
 * repo). The error/canceled shapes let the renderer keep the empty-state up.
 */
export type RepoPickResult =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly canceled: true }
  | { readonly ok: false; readonly error: string };

// ── Multimodel fan-out (V2) ──

/** Per-lane lifecycle for a headless claude -p run in a fan-out worktree. */
export type LaneStatus = 'queued' | 'running' | 'done' | 'failed';

/** One lane of a fan-out: a worktree + a headless claude run on one model tier. */
export interface FanoutLane {
  /** Stable id within the run (we use the model slug). */
  readonly laneId: string;
  /** The --model tier token, e.g. 'opus' | 'sonnet' | 'haiku'. */
  readonly model: string;
  /** The worktree this lane runs in (= Worktree.id = absolute path); reused for DIFF_*. */
  readonly worktreeId: string;
  /** The lane's branch, `fanout/<id>/<modelSlug>`. */
  readonly branch: string;
  readonly status: LaneStatus;
  /** Exit code of the claude -p run (present once done/failed). */
  readonly exitCode?: number | null;
  /** Last slice of the lane's stdout (capped) for a quick preview. */
  readonly stdoutTail?: string;
  /** Failure reason (present when status === 'failed'). */
  readonly error?: string;
}

/**
 * The ONE active fan-out run (MVP: a single run at a time). Held on
 * ctx.fanoutManager; a second start() while a run is active is rejected.
 */
export interface FanoutRun {
  /** Short run id (slug-safe); drives the worktree/branch naming. */
  readonly id: string;
  readonly prompt: string;
  /** Base branch every lane worktree forks from + merges back into. */
  readonly base: string;
  /** When true, lanes add --dangerously-skip-permissions (bash-heavy tasks). */
  readonly skipPermissions: boolean;
  readonly lanes: readonly FanoutLane[];
}

export interface FanoutStartRequest {
  readonly prompt: string;
  /** 1..4 model tiers; >4 or <1 is rejected by the manager. */
  readonly models: readonly string[];
  /** Default false; true => --dangerously-skip-permissions on every lane. */
  readonly skipPermissions: boolean;
}

export interface FanoutStartResult {
  readonly id: string;
  readonly lanes: readonly FanoutLane[];
}

export interface FanoutSelectRequest {
  /** The winning lane to merge into base (the rest are discarded). */
  readonly laneId: string;
}

/** main -> renderer per-lane status push (mirrors MergeProgressEvent). */
export interface FanoutLaneStatusEvent {
  readonly id: string;
  readonly lane: FanoutLane;
}
