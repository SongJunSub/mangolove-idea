import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { MangoApi, Unsubscribe } from '../shared/ipc-contract';

/** Subscribe to a main->renderer event channel; returns an unsubscribe handle. */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: MangoApi = {
  app: {
    ping: () => ipcRenderer.invoke(IPC.APP_PING),
    onQuitWarning: (cb) => subscribe(IPC.APP_QUIT_WARNING, cb), // wired in Plan 5
    sendQuitDecision: (quit) => ipcRenderer.invoke(IPC.APP_QUIT_DECISION, { quit }),
  },
  worktree: {
    list: () => ipcRenderer.invoke(IPC.WORKTREE_LIST),
    create: (req) => ipcRenderer.invoke(IPC.WORKTREE_CREATE, req),
    remove: (req) => ipcRenderer.invoke(IPC.WORKTREE_REMOVE, req),
  },
  session: {
    spawn: (req) => ipcRenderer.invoke(IPC.SESSION_SPAWN, req),
    sendInput: (req) => ipcRenderer.send(IPC.SESSION_INPUT, req),
    resize: (req) => ipcRenderer.send(IPC.SESSION_RESIZE, req),
    kill: (worktreeId) => ipcRenderer.invoke(IPC.SESSION_KILL, { worktreeId }),
    records: () => ipcRenderer.invoke(IPC.SESSION_RECORDS),
    onOutput: (cb) => subscribe(IPC.SESSION_OUTPUT, cb),
    onExit: (cb) => subscribe(IPC.SESSION_EXIT, cb),
    onStatus: (cb) => subscribe(IPC.SESSION_STATUS, cb),
  },
  server: {
    start: (req) => ipcRenderer.invoke(IPC.SERVER_START, req),
    stop: (req) => ipcRenderer.invoke(IPC.SERVER_STOP, req),
    status: () => ipcRenderer.invoke(IPC.SERVER_STATUS),
    onState: (cb) => subscribe(IPC.SERVER_STATE, cb),
  },
  logs: {
    snapshot: () => ipcRenderer.invoke(IPC.LOG_SNAPSHOT),
    onLine: (cb) => subscribe(IPC.LOG_LINE, cb),
  },
  merge: {
    run: (req) => ipcRenderer.invoke(IPC.MERGE_RUN, req),
    onProgress: (cb) => subscribe(IPC.MERGE_PROGRESS, cb),
    // conflict-resolution bindings (Task 5): forward the contract methods to main over IPC
    conflicts: (req) => ipcRenderer.invoke(IPC.MERGE_CONFLICTS, req),
    readConflict: (req) => ipcRenderer.invoke(IPC.MERGE_READ_CONFLICT, req),
    resolve: (req) => ipcRenderer.invoke(IPC.MERGE_RESOLVE, req),
    continue: (req) => ipcRenderer.invoke(IPC.MERGE_CONTINUE, req),
    abort: (req) => ipcRenderer.invoke(IPC.MERGE_ABORT, req),
    inProgress: (req) => ipcRenderer.invoke(IPC.MERGE_IN_PROGRESS, req),
  },
  diff: {
    list: (req) => ipcRenderer.invoke(IPC.DIFF_LIST, req),
    file: (req) => ipcRenderer.invoke(IPC.DIFF_FILE, req),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (partial) => ipcRenderer.invoke(IPC.SETTINGS_SET, partial),
  },
};

contextBridge.exposeInMainWorld('mango', api);
