import type { MenuItemConstructorOptions } from 'electron';

/** Actions the application menu can trigger back into the app. */
export interface AppMenuActions {
  /** File > New Window: open a fresh window showing the repo picker (an empty-gate window). */
  onNewWindow(): void;
}

/**
 * The application menu template. The standard macro roles (appMenu / editMenu / viewMenu /
 * windowMenu) delegate to Electron's native handlers, so replacing the implicit default menu is
 * regression-free: undo/redo/cut/copy/paste/selectAll, quit, and the macOS Window menu's live
 * window LIST (each window shown by its document.title = "<repo> — MangoLove") all keep working.
 *
 * The one custom item is File > New Window, which opens a new empty-gate window — the menu entry
 * point to multi-window, complementing the sidebar's "open in new window". `isMac` gates the app
 * menu (macOS only) and the File tail (Close on macOS, where Quit lives in the app menu; Quit
 * elsewhere).
 */
export function buildAppMenuTemplate(
  actions: AppMenuActions,
  isMac: boolean,
): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => actions.onNewWindow(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
