import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';
import { IPC } from '../shared/ipc-channels';
import { QuitController } from './app/quit-controller';
import { SessionStore, getDefaultSessionsPath } from './managers/session-store';
import { SettingsStore, getDefaultSettingsPath } from './managers/settings-store';
import { ScrollbackStore, getDefaultScrollbackPath } from './managers/scrollback-store';
import type { QuitWarningEvent } from '../shared/types';
import { resolveRepoRoot } from './util/resolve-repo-root';

const ctx = createIpcContext();

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
      // Enables the <webview> tag (DISABLED by default) for the embedded Browser pane
      // (V2 B). Safe here: single-user local dev tool; the host renderer loads only our
      // bundled app under a strict CSP (minimal XSS surface), and a <webview> GUEST gets
      // its own WebContents with contextIsolation ON + nodeIntegration OFF (we add no
      // `nodeintegration` attr) so the embedded localhost page cannot reach window.mango /
      // ipcRenderer. No new IPC; APP_OPEN_EXTERNAL is untouched.
      webviewTag: true,
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
  // PATH FIX (packaged macOS only): a Finder-launched .app inherits launchd's
  // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), NOT the user's login-shell
  // PATH — so `claude` (~/.local/bin), `gh`/`git`/`npm` (/opt/homebrew/bin) would
  // ENOENT. Run the login shell once to capture its real PATH and use it (a login
  // shell's PATH is a superset that already contains the launchd entries). env
  // passthrough is already wired in every spawner (pty-factory, process-runner,
  // gh-status-reader), so fixing process.env.PATH once fixes them all. Guarded by
  // app.isPackaged so `npm run dev` (which already has the dev shell PATH) is a
  // literal no-op; try/catch keeps the launchd PATH on any failure (degrade quietly).
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      // `-il` runs the user's interactive rc files (where nvm/asdf/etc. set PATH).
      // Those rc files can ALSO print banners to STDOUT, which would otherwise be
      // prepended to the captured value and corrupt PATH. Wrap the value in sentinels
      // and extract ONLY between them, so any banner noise is ignored.
      const out = execFileSync(
        process.env.SHELL || '/bin/zsh',
        ['-ilc', 'printf "__MLPATH__%s__MLPATH__" "$PATH"'],
        { encoding: 'utf8', timeout: 5000 },
      );
      const match = out.match(/__MLPATH__([\s\S]*?)__MLPATH__/);
      const captured = match?.[1]?.trim();
      if (captured) process.env.PATH = captured;
    } catch {
      // keep the launchd PATH; spawning degrades gracefully (gh -> gh-missing etc.)
    }
  }
  // Construct the SessionStore eagerly (we hold the real electron `app` for the
  // userData path) and assign it BEFORE registerIpc, so getSessionStore /
  // getSessionManager stay synchronous and the SESSION_INPUT/RESIZE on-handlers
  // keep their synchronous delegation (the Plan-2 tests assert it).
  ctx.sessionStore = new SessionStore(getDefaultSessionsPath(() => app.getPath('userData')));
  // Construct the SettingsStore eagerly (same reason as SessionStore: we hold
  // the real electron `app` for the userData path) and assign it BEFORE
  // registerIpc so getSettingsStore stays synchronous.
  ctx.settingsStore = new SettingsStore(getDefaultSettingsPath(() => app.getPath('userData')));
  // Finder-launched .app has cwd='/', so cwd is NOT a safe repoRoot. Prefer the
  // persisted repoRoot (SettingsStore), else cwd if it is itself a git work tree
  // (the dev case), else null (renderer shows the repo-picker empty-state). ctx.repoRoot
  // is read LAZILY by the getters, so setting it here (before registerIpc) is in time.
  ctx.repoRoot = resolveRepoRoot({
    persisted: ctx.settingsStore.get().repoRoot,
    cwd: process.cwd(),
  });
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
