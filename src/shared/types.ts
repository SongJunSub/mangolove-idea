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
  /** Worktree that owns the currently selected server (null when stopped/none). */
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
  /** Monotonic sequence number within the current server run. */
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
  /** Optional override; otherwise ServerManager auto-detects (gradlew vs npm). */
  readonly commandOverride?: string;
}

export interface StopServerRequest {
  /** Stops whatever single server is running; id is advisory. */
  readonly worktreeId?: string;
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

export type MergeStage = 'verify' | 'merge' | 'cleanup' | 'done';

export interface MergeProgressEvent {
  readonly worktreeId: string;
  readonly stage: MergeStage;
  readonly ok: boolean;
  readonly message: string;
}

export interface MergeResult {
  readonly worktreeId: string;
  readonly merged: boolean;
  readonly cleanedUp: boolean;
  /** Present when merged === false. */
  readonly error?: string;
}

/**
 * Emitted to the renderer at quit (MVP item 6) when agent sessions are live, so
 * the user can confirm before the PTYs are swept. NOTE: this is driven by LIVE
 * (running, non-exited) PTYs, not by turn detection — `hasActiveTurn` stays false
 * (b-lite declines real turn detection; warning-on-live-session is the honest MVP).
 */
export interface QuitWarningEvent {
  /** worktreeIds that currently have a running (non-exited) claude PTY. */
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
