import { resolve } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';
import { IPC } from '../shared/ipc-channels';
import { QuitController } from './app/quit-controller';
import { SessionStore, getDefaultSessionsPath } from './managers/session-store';
import { SettingsStore, getDefaultSettingsPath } from './managers/settings-store';
import { ScrollbackStore, getDefaultScrollbackPath } from './managers/scrollback-store';
import type { QuitWarningEvent } from '../shared/types';

const ctx = createIpcContext();
ctx.repoRoot = process.cwd();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: resolve(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node built-ins (node:module via pty-factory chain)
    },
  });
  ctx.mainWindow = win;

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(resolve(import.meta.dirname, '../renderer/index.html'));
  }
}

/** Sends APP_QUIT_WARNING to the renderer (window-guarded; no-op if destroyed). */
function emitQuitWarning(activeWorktreeIds: readonly string[]): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  const payload: QuitWarningEvent = { activeWorktreeIds };
  win.webContents.send(IPC.APP_QUIT_WARNING, payload);
}

const quitController = new QuitController({
  liveWorktreeIds: () => ctx.sessionManager?.liveWorktreeIds() ?? [],
  emitQuitWarning,
  sweep: () => {
    ctx.sessionManager?.killAll(); // orphan-claude prevention (binding invariant §7).
    ctx.serverManager?.dispose(); // Plan 3 server cleanup.
  },
  quitNow: () => app.quit(),
});

// The APP_QUIT_DECISION handler (in register-ipc) calls ctx.requestQuit when the
// user confirms; route that to the controller so the confirmed flag + sweep + quit
// all flow through one place, and the re-fired before-quit is let through.
ctx.requestQuit = () => quitController.decide(true);

app.whenReady().then(() => {
  // Construct the SessionStore eagerly (we hold the real electron `app` for the
  // userData path) and assign it BEFORE registerIpc, so getSessionStore /
  // getSessionManager stay synchronous and the SESSION_INPUT/RESIZE on-handlers
  // keep their synchronous delegation (the Plan-2 tests assert it).
  ctx.sessionStore = new SessionStore(getDefaultSessionsPath(() => app.getPath('userData')));
  // Construct the SettingsStore eagerly (same reason as SessionStore: we hold
  // the real electron `app` for the userData path) and assign it BEFORE
  // registerIpc so getSettingsStore stays synchronous.
  ctx.settingsStore = new SettingsStore(getDefaultSettingsPath(() => app.getPath('userData')));
  // Construct the ScrollbackStore eagerly (same reason as the others: we hold the real
  // electron `app` for the userData path) and assign it BEFORE registerIpc so the sync
  // getScrollbackStore resolver finds it on the SCROLLBACK_GET/SET handlers.
  ctx.scrollbackStore = new ScrollbackStore(
    getDefaultScrollbackPath(() => app.getPath('userData')),
  );
  registerIpc(ipcMain, ctx);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  quitController.onBeforeQuit(e);
});
