// ─────────────────────────────────────────────────────────────────────────────
// src/shared/types.ts  —  imported by BOTH main and renderer. No side effects.
// ─────────────────────────────────────────────────────────────────────────────
import type { TerminalLayout } from './terminal-layout';
import type { OpenTabs } from './open-tabs';
import type { ProjectGroup, ProjectTreeExpanded } from './project-groups';

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

// ── plain shell terminals (multi-terminal panel) — keyed by a renderer-generated terminalId ──
export interface TermSpawnRequest {
  readonly terminalId: string;
  /** Absolute cwd the $SHELL starts in (a worktree path, or the repo root). */
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TermInputRequest {
  readonly terminalId: string;
  readonly data: string;
}

export interface TermResizeRequest {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TermOutputEvent {
  readonly terminalId: string;
  readonly data: string;
}

export interface TermExitEvent {
  readonly terminalId: string;
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
  /**
   * Count of unsaved editor files across all windows at quit (A4). Unlike an in-flight
   * turn, a dirty buffer is NOT recoverable on quit (it never reached disk), so the
   * before-quit warning fires when EITHER this is > 0 OR activeWorktreeIds is non-empty.
   */
  readonly unsavedFileCount: number;
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

/** One entry in a worktree's file tree (A3 file explorer). */
export interface TreeEntry {
  readonly name: string;
  readonly isDir: boolean;
}

/** Lists the entries of `relPath` within a worktree. relPath unset/'' = the worktree root. */
export interface TreeListRequest {
  /** The worktree to read; validated against the known worktrees (its id IS its path). */
  readonly worktreeId: string;
  /** Path relative to the worktree root; must not escape it. */
  readonly relPath?: string;
}

/** file content (A4) — read/write ONE file in a worktree, scoped exactly like the tree. */
export interface FileReadRequest {
  readonly worktreeId: string;
  /** Path relative to the worktree root; must not escape it. */
  readonly relPath: string;
}

export interface FileReadResult {
  /** UTF-8 text; '' when readOnly (binary/tooLarge/encoding — never savable). */
  readonly content: string;
  /** true => view-only: the file cannot round-trip as UTF-8 text, so Save is disabled. */
  readonly readOnly: boolean;
  /** Why it is readOnly (absent when editable). */
  readonly reason?: 'binary' | 'tooLarge' | 'encoding';
  /** Size in bytes. */
  readonly size: number;
  /** Optimistic-concurrency token (`mtimeMs:size`); echoed back on write. */
  readonly baseToken: string;
}

export interface FileWriteRequest {
  readonly worktreeId: string;
  readonly relPath: string;
  /** Full UTF-8 contents to write. */
  readonly content: string;
  /** The token from the read (or the previous write); rejects the write if the file
   *  changed on disk since. Omitted for a brand-new file. */
  readonly baseToken?: string;
}

/** Ack plus a FRESH token after a successful write (for the next optimistic check). */
export interface FileWriteResult extends Ack {
  readonly baseToken?: string;
}

/** code navigation (Phase B) — Java/Kotlin go-to-definition/find-usages over an external
 *  LSP server. TS/JS nav is served entirely in-browser by monaco and never uses this IPC.
 *  Positions are 0-based (LSP convention); the renderer converts to/from monaco 1-based. */
export interface CodeNavQuery {
  readonly worktreeId: string;
  readonly relPath: string;
  readonly line: number; // 0-based
  readonly character: number; // 0-based
}

export interface CodeNavReferencesQuery extends CodeNavQuery {
  readonly includeDeclaration: boolean;
}

/** A nav target, confined to the worktree (relPath is relative to the worktree root). */
export interface CodeNavLocation {
  readonly relPath: string;
  readonly startLine: number; // 0-based
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface CodeNavResult {
  readonly locations: readonly CodeNavLocation[];
}

/** Per-language availability for the Settings degradation surface (loud fallback). */
export interface CodeNavLangStatus {
  readonly available: boolean;
  readonly reason?: string;
}

/** Capabilities for the IPC-backed languages only (TS/JS are always available, no IPC). */
export interface CodeNavCapabilities {
  readonly java: CodeNavLangStatus;
  readonly kotlin: CodeNavLangStatus;
}

/**
 * Runtime state of a Java/Kotlin language server, pushed to the renderer so a nav that returns
 * [] is no longer indistinguishable from "no result": `starting` (spawned, initializing),
 * `indexing` (importing the project — results are empty until done), `ready`, or `failed`.
 */
export type CodeNavRuntimeState = 'starting' | 'indexing' | 'ready' | 'failed';

/** A per-(worktree, language) server-state change (event-pushed on CODENAV_STATUS). */
export interface CodeNavStatus {
  readonly worktreeId: string;
  readonly lang: 'java' | 'kotlin';
  readonly state: CodeNavRuntimeState;
  /** Short, safe reason when state is 'failed' (e.g. "exited (code 1)"); omitted otherwise. */
  readonly detail?: string;
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

/** gh's pre-bucketed per-check status (we switch ONLY on this, never raw states). */
export type GhBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

/** One CI check row for the expandable per-check list (name + bucket + link). */
export interface GhCheckItem {
  readonly name: string;
  readonly bucket: GhBucket;
  /** Details URL gh reports for the check, or '' when none. */
  readonly link: string;
}

/** Collapsed CI summary derived from gh's per-check `bucket` field + the raw rows. */
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
  /** Per-check rows for the expandable panel (empty for the pending/none paths). */
  readonly checks: readonly GhCheckItem[];
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
  /**
   * UI theme. Unset / 'system' (default): follow the OS appearance. 'dark' / 'light':
   * pinned. Resolved + applied to <html data-theme> by the renderer (lib/theme.ts).
   * Any value other than 'dark' / 'light' is treated as 'system'.
   */
  readonly theme?: 'dark' | 'light' | 'system';
  /**
   * UI language. Unset / 'system' (default): follow the OS locale (Korean when it starts
   * with 'ko', else English). 'ko' / 'en': pinned. Resolved by the renderer (i18n/resolve-locale).
   * Any value other than 'ko' / 'en' is treated as 'system'.
   */
  readonly locale?: 'system' | 'ko' | 'en';
  /** Agent binary to spawn; unset => MANGO_AGENT_CMD ?? 'claude'. */
  readonly agentCommand?: string;
  /** Verify hook command; unset => MANGO_VERIFY_CMD ?? 'true'. */
  readonly verifyCommand?: string;
  /** Server start override; unset => MANGO_SERVER_CMD ?? auto-detection. */
  readonly serverCommand?: string;
  /** Absolute path override for the Java LSP server (jdtls); unset => PATH-dir probe. */
  readonly lspJavaPath?: string;
  /** Absolute path override for the Kotlin LSP server; unset => PATH-dir probe. */
  readonly lspKotlinPath?: string;
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
  /**
   * Cross-machine session visibility (V2). Unset / 'off' (default): no session
   * metadata leaves this machine. 'on': this machine PUBLISHES its session pointers
   * (branch + status only — never conversation) to the shared remote's dedicated
   * `mangolove-sessions` orphan branch and FETCHES other machines' pointers. Opt-in
   * because pointers reach the shared remote. Any value other than 'on' => 'off'.
   */
  readonly crossMachineSessions?: 'off' | 'on';
  /**
   * Stable, NON-identifying id for THIS machine, generated once (crypto.randomUUID)
   * and persisted. Namespaces this machine's pointer file (`<machineId>.json`) on the
   * sync branch. Deliberately NOT the OS hostname (which would leak PII to the remote).
   */
  readonly machineId?: string;
  /**
   * Human-friendly label for this machine shown in the cross-machine UI (e.g.
   * "work-mac"). User-settable; defaults to a non-identifying "machine-<id4>". Never
   * derived from the OS hostname.
   */
  readonly machineLabel?: string;
  /**
   * The app version whose update banner the user last dismissed ("Later"). The banner
   * stays hidden for THIS version but reappears for a newer one. Unset => never dismissed.
   */
  readonly lastDismissedUpdateVersion?: string;
  /**
   * User-adjusted sizes of the workspace's FOUR independent splitters (drag-to-resize).
   * Unset => the CSS defaults win. Persisted on drag-end only (SETTINGS_SET is heavyweight).
   * Always coerced + clamped on read AND write by the shared sanitizer, which also MIGRATES
   * the legacy 2-field `{leftColWidth, topRowFraction(fr)}` shape, so a hand-edited/stale/old
   * value can never collapse a pane.
   */
  readonly paneLayout?: PaneLayout;
  /**
   * Per-worktree terminal TILE layout (multi-terminal panel, A2g), keyed by worktreeId. Stores
   * the STRUCTURE + leaf kind (agent | shell+cwd) + split ratios — never the live terminalIds /
   * PTYs. Coerced + clamped on read AND write by the shared sanitizer (single-agent, <=4 leaves);
   * see shared/terminal-layout.ts. Unset for a worktree => a single agent tile (the default).
   */
  readonly terminalLayouts?: Record<string, TerminalLayout>;
  /**
   * Per-worktree editor tabs (open file relPaths + the active one), keyed by worktreeId. Only
   * paths are stored — auto-save keeps disk authoritative, so no buffer contents. Coerced on read
   * AND write by the shared sanitizer, and MERGED per worktree key on write (never whole-map
   * replaced) so a second window/repo cannot stomp another's tabs. See shared/open-tabs.ts.
   */
  readonly openTabs?: OpenTabs;
  /**
   * User-defined project groups (the "프로젝트 트리" grouping layer): named buckets of related
   * repos, e.g. "CRS" holding crs/crs-admin/crs-be. A repo belongs to at most one group. Purely
   * a VIEW over recentRepos (the source of truth for which repos exist) — a group referencing a
   * repo no longer in recentRepos is pruned by the GROUPS_GET handler (fs-canonical). Coerced on
   * read AND write by the shared sanitizer; see shared/project-groups.ts. Unset => no groups.
   */
  readonly projectGroups?: readonly ProjectGroup[];
  /**
   * Which project-tree nodes are EXPANDED (groups by id, repos by canonical path). Persisted so the
   * tree keeps its shape across the renderer reloads a repo switch causes. Unset => all collapsed.
   */
  readonly projectTreeExpanded?: ProjectTreeExpanded;
}

/**
 * Geometry of the workspace's FOUR independent splitters (A2d). The layout nests:
 * a top region over a bottom region (split by `topRowFraction`), each region split into a
 * left column over the editor/terminal, and the top-left column itself split into the repo
 * list over the file tree. The two column widths are INDEPENDENT (top vs bottom). All four
 * are clamped to safe ranges (see shared/pane-layout.ts) — the single source of truth for
 * bounds, shared by the main-process sanitizer and the renderer Split drag handlers.
 */
export interface PaneLayout {
  /** Top region height as a fraction (0..1) of the workspace height. */
  readonly topRowFraction: number;
  /** Top-left (repo list + file tree) column width in px. */
  readonly topLeftWidth: number;
  /** Bottom-left (worktree list) column width in px — independent of topLeftWidth. */
  readonly bottomLeftWidth: number;
  /** Repo-list height as a fraction (0..1) of the top-left column height. */
  readonly repoFraction: number;
}

/**
 * Result of an in-app update check against the project's GitHub Releases (macOS, unsigned).
 * A flat struct (not a union) so the renderer always has `currentVersion`. On a failed
 * check, `error` is set and `updateAvailable` is false (the banner stays hidden); a manual
 * check surfaces the reason, the silent launch check does not. Every newer-version field is
 * null on failure. The app is UNSIGNED so this only NOTIFIES + links the download — it never
 * silently replaces the bundle (see docs/UPDATE-MECHANISM if added).
 */
export interface UpdateStatus {
  /** The running app version (app.getVersion()), always present. */
  readonly currentVersion: string;
  /** Latest STABLE release version (tag without 'v'), or null when the check failed. */
  readonly latestVersion: string | null;
  /** True iff a strictly-newer stable release exists (X.Y.Z numeric compare). */
  readonly updateAvailable: boolean;
  /** GitHub release page URL (release notes), or null. */
  readonly releaseUrl: string | null;
  /** Direct .dmg asset download URL, or null when absent/failed. */
  readonly dmgUrl: string | null;
  /** Lowercase-hex sha256 of the .dmg from the release asset digest, when GitHub provides it. */
  readonly sha256: string | null;
  /** ISO publish timestamp of the latest release, or null. */
  readonly publishedAt: string | null;
  /** Set ONLY when the check failed; classifies why for the manual-check surface. */
  readonly error?: 'offline' | 'rate_limited' | 'failed';
}

/**
 * One Claude usage limit window (from the OAuth usage endpoint). `percent` is 0–100 of the
 * limit consumed; `resetsAt` is when that window rolls over. Read-only metadata — no token cost.
 */
export interface UsageLimit {
  /** 'session' (5-hour) | 'weekly_all' (every model) | 'weekly_scoped' (one model) | other. */
  readonly kind: string;
  /** A short human label, e.g. '세션 (5시간)', '주간 (전체)', '주간 (Sonnet)'. */
  readonly label: string;
  /** Percent of this limit used (0–100). */
  readonly percent: number;
  /** 'normal' | 'warning' | 'critical' (drives color); pass-through from the API. */
  readonly severity: string;
  /** When this window resets (ISO 8601), or null. */
  readonly resetsAt: string | null;
  /** Model display name for a per-model (weekly_scoped) limit, else null. */
  readonly model: string | null;
}

/**
 * Claude Code subscription usage (the 5-hour session + weekly limits + resets), read from the
 * user's own OAuth token (macOS Keychain) via the same endpoint Claude Code's `/usage` uses.
 * Read-only, NO token cost. On failure `error` is set and `limits` is empty.
 *  - no-login     : no Claude Code credential found (the user never logged in to `claude`).
 *  - denied       : the Keychain read was refused.
 *  - rate_limited : the usage endpoint returned 429.
 *  - offline      : the request could not be made.
 *  - failed       : anything else (parse / non-200).
 */
export interface UsageStatus {
  readonly limits: readonly UsageLimit[];
  readonly error?: 'no-login' | 'denied' | 'rate_limited' | 'offline' | 'failed';
}

/** Renderer request to perform a one-click update (download + verify + swap + restart). */
export interface UpdatePerformRequest {
  /** Direct .dmg asset URL (from UpdateStatus.dmgUrl). */
  readonly dmgUrl: string;
  /** Expected sha256 of the .dmg (UpdateStatus.sha256). Auto-install is REFUSED when null. */
  readonly sha256: string | null;
}

/** Live progress for a one-click update (main -> renderer event, UPDATE_PROGRESS). */
export interface UpdateProgress {
  readonly phase: 'downloading' | 'verifying' | 'staging' | 'applying';
  /** Bytes received so far (downloading phase). */
  readonly receivedBytes?: number;
  /** Total bytes if the server sent Content-Length (downloading phase), else undefined. */
  readonly totalBytes?: number;
}

/**
 * Result of UPDATE_PERFORM. On SUCCESS the app quits to let the helper swap the bundle, so
 * the invoke never resolves — the renderer relies on UPDATE_PROGRESS + the app exiting. A
 * non-success status means nothing was changed and the renderer falls back to a manual
 * download:
 *  - blocked     : unsaved editors exist — save first (no download, no restart).
 *  - ineligible  : can't safely swap in place (dev / translocated / Homebrew / read-only /
 *                  no checksum) — `reason` says which; fall back to opening the .dmg.
 *  - error       : download / checksum / mount / stage failed — `reason` is a short message.
 */
export interface UpdateApplyResult {
  /** 'started' = staged + helper launched + app quitting; the others left everything unchanged. */
  readonly status: 'started' | 'blocked' | 'ineligible' | 'error';
  readonly reason: string;
}

/**
 * Effective session-persistence state for the Settings UI (b-full LOUD fallback).
 * Surfaces when 'full' was requested but is NOT actually in effect because abduco
 * is unavailable — so the downgrade to b-lite is never silent.
 */
export interface SessionPersistenceInfo {
  /** What the user asked for (settings.sessionPersistence, defaulting to 'lite'). */
  readonly requested: 'lite' | 'full';
  /** What is ACTUALLY in effect — 'full' only when 'full' was asked AND abduco is available. */
  readonly effective: 'lite' | 'full';
  /** True iff an abduco binary was resolved at boot (b-full is possible at all). */
  readonly abducoAvailable: boolean;
}

// ── Cross-machine sessions (V2, visibility-only) ──

/**
 * One machine's view of one of its sessions, as published to / read from the shared
 * `mangolove-sessions` branch. METADATA ONLY — never conversation content and never a
 * claude session id (cross-machine resume is out of scope; `claude --resume` is
 * cwd-bucket-bound, so an id would carry no value and only widen exposure). A reopen
 * on another machine starts a FRESH session on `branch`, it does not resume this one.
 */
export interface CrossMachineSessionPointer {
  /** Branch the session is on — the worktree key the other machine acts on. */
  readonly branch: string;
  /** Lifecycle as last seen by the publishing machine. */
  readonly status: 'running' | 'idle' | 'ended';
  /** Whether a turn was in flight at publish time (output-activity heuristic). */
  readonly hasActiveTurn: boolean;
  /** Non-identifying id of the publishing machine (namespaces its pointer file). */
  readonly machineId: string;
  /** Friendly label of the publishing machine for display (never the OS hostname). */
  readonly machineLabel: string;
  /** Epoch ms when this pointer was last published. */
  readonly updatedAt: number;
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

/** One entry in the sidebar repo switcher: a known recent repo + whether it's the active one. */
export interface RecentRepo {
  /** Canonical absolute path of the repo root. */
  readonly path: string;
  /** True when this is the repo THIS window is bound to (ctx.repoRoot). */
  readonly active: boolean;
}

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
