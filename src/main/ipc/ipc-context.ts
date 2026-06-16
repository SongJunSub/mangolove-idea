import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 1 adds the WorktreeManager (lazily created on first use from repoRoot).
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
  /** Absolute path of the repo MangoLove operates on (set by main/index.ts). */
  repoRoot?: string;
  /** Lazily constructed in register-ipc from repoRoot; injectable in tests. */
  worktreeManager?: WorktreeManager;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
