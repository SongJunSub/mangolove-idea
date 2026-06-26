// src/shared/ipc-contract.ts
import type {
  Worktree,
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Ack,
  AgentSession,
  SpawnSessionRequest,
  SessionInputRequest,
  SessionResizeRequest,
  SessionOutputEvent,
  SessionExitEvent,
  ServerStatus,
  StartServerRequest,
  StopServerRequest,
  LogLine,
  MergeRequest,
  MergeResult,
  MergeProgressEvent,
  ConflictedFile,
  ConflictFileVersions,
  ConflictListRequest,
  ConflictReadRequest,
  ConflictResolveRequest,
  ConflictContinueRequest,
  ConflictAbortRequest,
  ConflictInProgressRequest,
  QuitWarningEvent,
  AppInfo,
  ChangedFile,
  FileDiff,
  DiffListRequest,
  DiffFileRequest,
  TreeEntry,
  TreeListRequest,
  FileReadRequest,
  FileReadResult,
  FileWriteRequest,
  FileWriteResult,
  CodeNavQuery,
  CodeNavReferencesQuery,
  CodeNavResult,
  CodeNavCapabilities,
  AppSettings,
  SessionPersistenceInfo,
  CrossMachineSessionPointer,
  GhStatus,
  GhStatusRequest,
  OpenExternalRequest,
  ScrollbackSetRequest,
  RepoPickResult,
  FanoutRun,
  FanoutStartRequest,
  FanoutStartResult,
  FanoutSelectRequest,
  FanoutLaneStatusEvent,
  UpdateStatus,
  UpdatePerformRequest,
  UpdateApplyResult,
  UpdateProgress,
} from './types';

/** Unsubscribe handle returned by every on*() subscriber. */
export type Unsubscribe = () => void;

export interface MangoApi {
  app: {
    /** Plan-0 probe: typed round-trip + node-pty load report. */
    ping(): Promise<AppInfo>;
    onQuitWarning(cb: (e: QuitWarningEvent) => void): Unsubscribe;
    sendQuitDecision(quit: boolean): Promise<Ack>;
    /** Report this window's unsaved editor file count to main (fire-and-forget, A4). */
    setUnsaved(count: number): void;
    /** Open a URL in the OS default browser (read-only action; used by the PR panel). */
    openExternal(req: OpenExternalRequest): Promise<Ack>;
  };
  worktree: {
    list(): Promise<Worktree[]>;
    create(req: CreateWorktreeRequest): Promise<Worktree>;
    remove(req: RemoveWorktreeRequest): Promise<Ack>;
  };
  session: {
    spawn(req: SpawnSessionRequest): Promise<AgentSession>;
    sendInput(req: SessionInputRequest): void; // fire-and-forget
    resize(req: SessionResizeRequest): void; // fire-and-forget
    kill(worktreeId: string): Promise<Ack>;
    /** Recorded worktree paths that had an agent (=> spawn with --continue). */
    records(): Promise<string[]>;
    /** b-full kill-switch: end EVERY detached background agent session (stop-all). */
    stopAllBackground(): Promise<Ack>;
    /** Effective session-persistence mode for the Settings UI (loud fallback). */
    persistenceInfo(): Promise<SessionPersistenceInfo>;
    onOutput(cb: (e: SessionOutputEvent) => void): Unsubscribe;
    onExit(cb: (e: SessionExitEvent) => void): Unsubscribe;
    onStatus(cb: (s: AgentSession) => void): Unsubscribe;
  };
  crossMachine: {
    /** All machines' published session pointers; [] when opted out or on a sync error. */
    fetch(): Promise<CrossMachineSessionPointer[]>;
    /** Checks out `branch` into a local worktree (for a fresh session) and returns it. */
    startHere(branch: string): Promise<Worktree>;
  };
  server: {
    start(req: StartServerRequest): Promise<ServerStatus>;
    stop(req: StopServerRequest): Promise<ServerStatus>;
    /**
     * Snapshot for ONE worktree's server (absent => stopped). worktreeId is OPTIONAL
     * during the V2 migration so the renderer's old no-arg status() compiles; Task 5a
     * passes it; main reads it once it relies on it (Task 4).
     */
    status(worktreeId?: string): Promise<ServerStatus>;
    /** All known worktree server snapshots, keyed by worktreeId (mount rehydrate). */
    statusAll(): Promise<Record<string, ServerStatus>>;
    onState(cb: (s: ServerStatus) => void): Unsubscribe;
  };
  logs: {
    /** The ring buffer for ONE worktree's server run (worktreeId optional until Task 5a). */
    snapshot(worktreeId?: string): Promise<LogLine[]>;
    onLine(cb: (line: LogLine) => void): Unsubscribe;
  };
  merge: {
    run(req: MergeRequest): Promise<MergeResult>;
    onProgress(cb: (e: MergeProgressEvent) => void): Unsubscribe;
    /** Conflicted paths for the in-progress merge in the primary tree (empty if none). */
    conflicts(req: ConflictListRequest): Promise<ConflictedFile[]>;
    /** Base/ours/theirs/working contents + missing-stage flags for one conflicted file. */
    readConflict(req: ConflictReadRequest): Promise<ConflictFileVersions>;
    /** Resolve one file: 'ours' | 'theirs' | 'manual' (content) | 'keep' | 'remove'. */
    resolve(req: ConflictResolveRequest): Promise<MergeResult>;
    /** Create the merge commit (rejected unless zero conflicts remain). User-driven only. */
    continue(req: ConflictContinueRequest): Promise<MergeResult>;
    /** `git merge --abort`: restore the target branch, drop MERGE_HEAD. */
    abort(req: ConflictAbortRequest): Promise<MergeResult>;
    /**
     * True while a merge is paused (`.git/MERGE_HEAD` present), recomputed from git.
     * The ONLY truthful source for the 'all conflicts resolved but not yet committed'
     * window: list() returns [] there, but the merge is still in progress.
     */
    inProgress(req: ConflictInProgressRequest): Promise<boolean>;
    /**
     * The worktreeId whose feature branch is the in-progress merge's MERGE_HEAD,
     * or null when no merge is paused. The renderer attributes the Conflicts pane
     * to THIS worktree only — never to whatever worktree is currently selected —
     * so a global MERGE_HEAD is never mis-attributed across app restart/reselect.
     */
    owner(): Promise<string | null>;
  };
  diff: {
    /** PR-style changed-file list: worktree branch vs base (default 'main'). */
    list(req: DiffListRequest): Promise<ChangedFile[]>;
    /** Original (merge-base) + modified (branch) contents for one file. */
    file(req: DiffFileRequest): Promise<FileDiff>;
  };
  tree: {
    /** Lists a worktree's directory entries at relPath (scoped to the worktree; '' = root). */
    list(req: TreeListRequest): Promise<TreeEntry[]>;
  };
  file: {
    /** Reads one file as editable UTF-8 text, or a readOnly view (binary/large/non-utf8). */
    read(req: FileReadRequest): Promise<FileReadResult>;
    /** Writes one file (scoped + O_NOFOLLOW); returns ok + a fresh optimistic token. */
    write(req: FileWriteRequest): Promise<FileWriteResult>;
  };
  codenav: {
    /** Per-language Java/Kotlin LSP availability (PATH-detected); drives provider registration + Settings. */
    capabilities(worktreeId: string): Promise<CodeNavCapabilities>;
    /** Java/Kotlin go-to-definition; targets confined to the worktree ([] when degraded). */
    definition(req: CodeNavQuery): Promise<CodeNavResult>;
    /** Java/Kotlin find-references; targets confined to the worktree ([] when degraded). */
    references(req: CodeNavReferencesQuery): Promise<CodeNavResult>;
  };
  settings: {
    /** Current persisted settings (every field optional; unset => env/default). */
    get(): Promise<AppSettings>;
    /** Persists a partial; returns the merged, sanitized settings. */
    set(partial: Partial<AppSettings>): Promise<AppSettings>;
  };
  scrollback: {
    /** Last serialized terminal screen for a worktree, or null if none saved. */
    get(worktreeId: string): Promise<string | null>;
    /** Persist a worktree's serialized terminal screen (store caps the size). */
    set(req: ScrollbackSetRequest): Promise<Ack>;
  };
  gh: {
    /** Read-only PR/CI status for the worktree's branch (gh keyring auth; no token in app). */
    status(req: GhStatusRequest): Promise<GhStatus>;
  };
  repo: {
    /** The currently-selected repo root, or null when none is set. */
    get(): Promise<string | null>;
    /**
     * Open a native folder picker; on a valid git repo, push it to recentRepos and
     * open (or focus) a window for it (no relaunch). Returns {canceled} or {error}
     * when nothing was opened.
     */
    pick(): Promise<RepoPickResult>;
  };
  update: {
    /**
     * Check GitHub Releases for a newer stable version (read-only; never auto-installs —
     * the app is unsigned). Never rejects: a failed check returns a status with `error` set.
     */
    check(): Promise<UpdateStatus>;
    /**
     * One-click self-update: download + sha256-verify + swap the .app bundle + restart. On
     * SUCCESS the app quits (the invoke never resolves); a non-success result is returned and
     * nothing is changed. Progress arrives via onProgress.
     */
    perform(req: UpdatePerformRequest): Promise<UpdateApplyResult>;
    /** Live progress of an in-flight perform() (download %, verify, stage, apply). */
    onProgress(cb: (e: UpdateProgress) => void): Unsubscribe;
  };
  fanout: {
    /** Start ONE fan-out: N worktrees + N headless claude -p lanes. Rejects if a run is active or models out of [1,4]. */
    start(req: FanoutStartRequest): Promise<FanoutStartResult>;
    /** The current run state, or null when none is active. */
    get(): Promise<FanoutRun | null>;
    /** Merge the winning lane into base + discard the rest. User-initiated only. */
    select(req: FanoutSelectRequest): Promise<MergeResult>;
    /** Kill running lanes + remove every lane worktree. */
    abort(): Promise<Ack>;
    /** Live per-lane status stream (queued -> running -> done|failed). */
    onStatus(cb: (e: FanoutLaneStatusEvent) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    readonly mango: MangoApi;
  }
}
