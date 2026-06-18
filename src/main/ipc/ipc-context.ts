import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { SessionManager } from '../managers/session-manager';
import type { ServerManager } from '../managers/server-manager';
import type { LogStore } from '../managers/log-store';
import type { MergeRunner } from '../git/merge-runner';
import type { SessionStore } from '../managers/session-store';
import type { SettingsStore } from '../managers/settings-store';
import type { DiffViewer } from '../git/diff-viewer';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 1 adds the WorktreeManager; Plan 2 adds the SessionManager.
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
  /** Absolute path of the repo MangoLove operates on (set by main/index.ts). */
  repoRoot?: string;
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
  /** Set true once the user confirms quit so before-quit stops re-intercepting (Plan 5). */
  confirmedQuit?: boolean;
  /** Lazily constructed in register-ipc; injectable in tests (V2 A1). */
  diffViewer?: DiffViewer;
  /** Injected by index.ts so the quit handler can actually quit (app.quit). */
  requestQuit?: () => void;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
