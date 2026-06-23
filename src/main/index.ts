import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext, type IpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';
import { IPC } from '../shared/ipc-channels';
import { QuitController } from './app/quit-controller';
import {
  aggregateLiveWorktreeIds,
  aggregateActiveTurnWorktreeIds,
  sweepAll,
  teardownWindow,
  findCtxByRepoRoot,
  pickEmptyGateCtx,
  canonicalRepoRoot,
} from './app/window-registry';
import { SessionStore, getDefaultSessionsPath } from './managers/session-store';
import { SettingsStore, getDefaultSettingsPath } from './managers/settings-store';
import { ScrollbackStore, getDefaultScrollbackPath } from './managers/scrollback-store';
import { resolveAbducoPath } from './pty/abduco-path';
import type { QuitWarningEvent } from '../shared/types';
import { resolveRepoRoot } from './util/resolve-repo-root';

/** One IpcContext per OS BrowserWindow, keyed by webContents.id (multi-window). */
const contexts = new Map<number, IpcContext>();

/** The three GLOBAL stores, constructed once in whenReady and injected into every ctx. */
let sessionStore: SessionStore;
let settingsStore: SettingsStore;
let scrollbackStore: ScrollbackStore;
/**
 * The abduco binary path resolved ONCE at boot (or null when unavailable), shared
 * by every window's ctx so getSessionManager can build an AbducoLauncher for
 * sessionPersistence==='full'. null => b-full degrades to b-lite.
 */
let abducoPath: string | null = null;

/**
 * Opens a window for `repoRoot`, OR focuses the existing window if that repo is
 * already open (SAME REPO IN TWO WINDOWS = FORBIDDEN — shared .git/MERGE_HEAD +
 * scrollback/session races). If an empty-gate window (no repo) exists, ATTACH the
 * repo to it (bind ctx.repoRoot + reload so its renderer re-reads REPO_GET) instead of
 * spawning a duplicate window.
 */
function openOrFocusRepo(repoRoot: string): void {
  // Canonicalize FIRST so the focus-guard compares against the same form createWindow
  // stores on ctx.repoRoot — else /tmp/x vs /private/tmp/x (or a trailing slash) would
  // dodge the dedup and open a duplicate window racing the shared .git/MERGE_HEAD.
  const root = canonicalRepoRoot(repoRoot);
  const existing = findCtxByRepoRoot(contexts, root);
  if (existing?.mainWindow && !existing.mainWindow.isDestroyed()) {
    existing.mainWindow.focus();
    return;
  }
  const gate = pickEmptyGateCtx(contexts);
  if (gate?.mainWindow && !gate.mainWindow.isDestroyed()) {
    // Attach: set this window's repoRoot, then reload it. The reload re-runs the
    // renderer's mount-time REPO_GET, which now returns the new ctx.repoRoot, so the
    // picker is replaced by the worktree UI. NO new REPO_OPENED channel. webContents.id
    // is STABLE across reload (empirically confirmed on Electron 42.4.0), so the
    // contexts key for this window is unaffected.
    gate.repoRoot = root;
    gate.mainWindow.webContents.reload();
    return;
  }
  createWindow(root);
}

/**
 * Builds a BrowserWindow + a per-window IpcContext bound to `repoRoot`, sharing the
 * 3 global stores. Captures webContents.id AT CREATION and registers the ctx under it
 * BEFORE loading content (so the quit sweep never misses a window), and sweeps THAT
 * window's managers on 'closed'. repoRoot=null opens the empty-gate window (renderer
 * shows the picker).
 */
function createWindow(repoRoot: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: resolve(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  // Capture the webContents id NOW. On Electron 42.4.0, reading win.webContents.id
  // inside win.on('closed', ...) THROWS "Object has been destroyed" (the webContents is
  // already gone when 'closed' fires). The id is constant for the window's lifetime
  // (stable across loadURL/reload), so capturing it up front is correct.
  const wcId = win.webContents.id;

  const ctx = createIpcContext();
  ctx.mainWindow = win;
  // Store the CANONICAL repo path (realpath) so the same-repo focus-guard dedupes
  // reliably; null = the empty-gate window (renderer shows the picker).
  ctx.repoRoot = repoRoot == null ? null : canonicalRepoRoot(repoRoot);
  ctx.sessionStore = sessionStore;
  ctx.settingsStore = settingsStore;
  ctx.scrollbackStore = scrollbackStore;
  ctx.abducoPath = abducoPath;
  ctx.requestQuit = () => quitController.decide(true);
  ctx.openRepo = (root) => openOrFocusRepo(root);
  // Register BEFORE loading content so a quit during load still sweeps this window.
  contexts.set(wcId, ctx);

  win.on('closed', () => {
    // Sweep ONLY this window's processes (no orphan claude/server), then drop the ctx.
    // Use the CAPTURED wcId — reading win.webContents.id here would throw post-destroy.
    teardownWindow(contexts, wcId);
  });

  // Show the window when its content is ready — UNLESS MANGO_HEADLESS=1 (automated
  // GUI smokes / CI): then keep it hidden so it never appears on screen or steals
  // focus. A hidden BrowserWindow still renders its DOM + handles IPC, so Playwright
  // drives it identically; app.close() tears it down with no manual cleanup.
  if (process.env.MANGO_HEADLESS !== '1') {
    win.on('ready-to-show', () => win.show());
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(resolve(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * Sends APP_QUIT_WARNING to EVERY live window (each window's renderer owns its own
 * warning modal). Window-guarded; a destroyed window is skipped.
 */
function emitQuitWarning(activeWorktreeIds: readonly string[]): void {
  const payload: QuitWarningEvent = { activeWorktreeIds };
  for (const ctx of contexts.values()) {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(IPC.APP_QUIT_WARNING, payload);
  }
}

const quitController = new QuitController({
  // Deps fan out across the WHOLE registry — the warn-vs-quit decision and the
  // kill-sweep both span every window (no orphan claude/server in any window).
  liveWorktreeIds: () => aggregateLiveWorktreeIds(contexts),
  activeTurnWorktreeIds: () => aggregateActiveTurnWorktreeIds(contexts),
  emitQuitWarning,
  sweep: () => sweepAll(contexts),
  quitNow: () => app.quit(),
});

app.whenReady().then(() => {
  if (app.isPackaged && process.platform === 'darwin') {
    try {
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
  // Resolve abduco ONCE by absolute path (b-full). Done AFTER the PATH fix-up above
  // but using ONLY isPackaged/resourcesPath/known-absolute-paths — never $PATH — so
  // the user-shell PATH we just imported can't redirect us to a hijacked binary.
  abducoPath = resolveAbducoPath({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    exists: existsSync,
  });

  // Construct the 3 GLOBAL stores ONCE (one process / one userData) and inject them
  // into every per-window ctx that createWindow() builds.
  sessionStore = new SessionStore(getDefaultSessionsPath(() => app.getPath('userData')));
  settingsStore = new SettingsStore(getDefaultSettingsPath(() => app.getPath('userData')));
  scrollbackStore = new ScrollbackStore(getDefaultScrollbackPath(() => app.getPath('userData')));

  // Channels are process-global: register the handlers ONCE over the registry.
  registerIpc(ipcMain, contexts);

  // Multi-window boot: reopen the MOST-RECENT repo (recentRepos[0]) if valid; else
  // fall back to the legacy single repoRoot / cwd resolve; else open the empty gate.
  const recent = settingsStore.get().recentRepos ?? [];
  const seed = recent[0] ?? settingsStore.get().repoRoot;
  const bootRepo = resolveRepoRoot({ persisted: seed, cwd: process.cwd() });
  createWindow(bootRepo);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const last = settingsStore.get().recentRepos?.[0] ?? settingsStore.get().repoRoot;
      const root = resolveRepoRoot({ persisted: last, cwd: process.cwd() });
      createWindow(root);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  quitController.onBeforeQuit(e);
});
