import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { AppInfo, Worktree } from '../../shared/types';
import { probeNodePty, type NodePtyProbe } from '../pty/pty-factory';
import type { IpcContext } from './ipc-context';

/** Minimal slice of Electron `app` we depend on (keeps the logic testable). */
interface AppLike {
  getVersion(): string;
}

/** Minimal slice of `process.versions` we depend on. */
interface VersionsLike {
  readonly electron?: string;
  readonly node?: string;
  readonly chrome?: string;
}

/**
 * Pure assembler for the Plan-0 ping payload. Injected dependencies make it
 * testable without booting Electron (contract §1.4 windowless IPC test).
 */
export function buildAppInfo(
  app: AppLike,
  versions: VersionsLike,
  probe: () => NodePtyProbe,
): AppInfo {
  const pty = probe();
  return {
    appVersion: app.getVersion(),
    electronVersion: versions.electron ?? 'unknown',
    nodeVersion: versions.node ?? 'unknown',
    chromeVersion: versions.chrome ?? 'unknown',
    nodePtyVersion: pty.version,
    nodePtyLoaded: pty.loaded,
  };
}

/**
 * Registers ALL main-process IPC handlers in one place. Plan 0 wires the
 * `app:ping` probe and a `worktree:list` stub returning []. Later plans add
 * their handlers here, delegating to managers held on `ctx`.
 */
export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  void ctx; // managers attach here in later plans

  ipcMain.handle(IPC.APP_PING, async (): Promise<AppInfo> => {
    // Lazy import of Electron `app` keeps this module importable under plain
    // Node in tests; registerIpc is only CALLED from the real main process.
    const { app } = await import('electron');
    return buildAppInfo(app, process.versions, probeNodePty);
  });

  ipcMain.handle(IPC.WORKTREE_LIST, async (): Promise<Worktree[]> => {
    return []; // real WorktreeManager arrives in Plan 1
  });
}
