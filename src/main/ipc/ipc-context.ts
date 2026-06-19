import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { SessionManager } from '../managers/session-manager';
import type { ServerManager } from '../managers/server-manager';
import type { LogStore } from '../managers/log-store';
import type { MergeRunner } from '../git/merge-runner';
import type { SessionStore } from '../managers/session-store';
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';
import type { DiffViewer } from '../git/diff-viewer';
import type { ConflictResolver } from '../git/conflict-resolver';
import type { GhStatusReader } from '../git/gh-status-reader';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 1 adds the WorktreeManager; Plan 2 adds the SessionManager.
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
  /**
   * Absolute path of the repo MangoLove operates on, or null/undefined when no
   * repo is selected (Finder launch with cwd='/' and no persisted repoRoot). Set by
   * main/index.ts via resolveRepoRoot(). The repoRoot-bound getters assert it via
   * requireRepoRoot (throws a friendly error if absent); the renderer gates the
   * worktree UI behind a non-null repoRoot so the assert is defensive.
   */
  repoRoot?: string | null;
  /** Lazily constructed in register-ipc from repoRoot; injectable in tests. */
  worktreeManager?: WorktreeManager;
  /** Lazily constructed in register-ipc; injectable in tests. */
  sessionManager?: SessionManager;
  /** Lazily constructed in register-ipc; injectable in tests (Plan 3). */
  serverManager?: ServerManager;
  /** The LogStore backing the running server's logs (Plan 3). */
  logStore?: LogStore;
  /** Lazily constructed in register-ipc; injectable in tests (Plan 4). */
  mergeRunner?: MergeRunner;
  /** Lazily constructed in register-ipc; injectable in tests (Plan 5). */
  sessionStore?: SessionStore;
  /** Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 E). */
  settingsStore?: SettingsStore;
  /**
   * Per-worktree serialized-terminal cache for conflict-free scrollback replay.
   * Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 scrollback).
   */
  scrollbackStore?: ScrollbackStore;
  /** Set true once the user confirms quit so before-quit stops re-intercepting (Plan 5). */
  confirmedQuit?: boolean;
  /**
   * Set true by SETTINGS_SET when the live sessionManager was KEPT (busy) so its
   * cached agentCommand is stale. The manager's onIdle callback consumes this once
   * the last PTY exits, clearing ctx.sessionManager so the next spawn rebuilds with
   * the new settings — delivering live-apply "once the live work ends" (V2 E).
   */
  sessionSettingsDirty?: boolean;
  /** Same as sessionSettingsDirty, for a busy serverManager's stale serverCommand. */
  serverSettingsDirty?: boolean;
  /** Lazily constructed in register-ipc; injectable in tests (V2 A1). */
  diffViewer?: DiffViewer;
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 PR/CI panel). Holds
   * NO live OS process and NO settings-derived command, so it is NOT nulled on
   * SETTINGS_SET. The RESULT is never cached — only the reader.
   */
  ghStatusReader?: GhStatusReader;
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 merge conflict).
   * STATEFUL only in the sense that it owns the in-progress merge — it is NOT nulled
   * on SETTINGS_SET while inProgress() (it recomputes truth from MERGE_HEAD per call).
   */
  conflictResolver?: ConflictResolver;
  /** Injected by index.ts so the quit handler can actually quit (app.quit). */
  requestQuit?: () => void;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
