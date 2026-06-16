import type { BrowserWindow } from 'electron';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 0 only needs the window ref; managers are added by later plans.
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
