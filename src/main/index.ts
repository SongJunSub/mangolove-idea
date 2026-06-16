import { resolve } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createIpcContext } from './ipc/ipc-context';
import { registerIpc } from './ipc/register-ipc';

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

app.whenReady().then(() => {
  registerIpc(ipcMain, ctx);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
