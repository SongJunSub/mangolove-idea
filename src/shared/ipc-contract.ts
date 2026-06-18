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
  QuitWarningEvent,
  AppInfo,
  ChangedFile,
  FileDiff,
  DiffListRequest,
  DiffFileRequest,
  AppSettings,
} from './types';

/** Unsubscribe handle returned by every on*() subscriber. */
export type Unsubscribe = () => void;

export interface MangoApi {
  app: {
    /** Plan-0 probe: typed round-trip + node-pty load report. */
    ping(): Promise<AppInfo>;
    onQuitWarning(cb: (e: QuitWarningEvent) => void): Unsubscribe;
    sendQuitDecision(quit: boolean): Promise<Ack>;
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
    onOutput(cb: (e: SessionOutputEvent) => void): Unsubscribe;
    onExit(cb: (e: SessionExitEvent) => void): Unsubscribe;
    onStatus(cb: (s: AgentSession) => void): Unsubscribe;
  };
  server: {
    start(req: StartServerRequest): Promise<ServerStatus>;
    stop(req: StopServerRequest): Promise<ServerStatus>;
    status(): Promise<ServerStatus>;
    onState(cb: (s: ServerStatus) => void): Unsubscribe;
  };
  logs: {
    snapshot(): Promise<LogLine[]>;
    onLine(cb: (line: LogLine) => void): Unsubscribe;
  };
  merge: {
    run(req: MergeRequest): Promise<MergeResult>;
    onProgress(cb: (e: MergeProgressEvent) => void): Unsubscribe;
  };
  diff: {
    /** PR-style changed-file list: worktree branch vs base (default 'main'). */
    list(req: DiffListRequest): Promise<ChangedFile[]>;
    /** Original (merge-base) + modified (branch) contents for one file. */
    file(req: DiffFileRequest): Promise<FileDiff>;
  };
  settings: {
    /** Current persisted settings (every field optional; unset => env/default). */
    get(): Promise<AppSettings>;
    /** Persists a partial; returns the merged, sanitized settings. */
    set(partial: Partial<AppSettings>): Promise<AppSettings>;
  };
}

declare global {
  interface Window {
    readonly mango: MangoApi;
  }
}
