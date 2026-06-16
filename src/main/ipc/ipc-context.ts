import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { SessionManager } from '../managers/session-manager';

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
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
