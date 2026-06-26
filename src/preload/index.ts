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
    setUnsaved: (count) => ipcRenderer.send(IPC.APP_SET_UNSAVED, { count }),
    openExternal: (req) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, req),
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
    stopAllBackground: () => ipcRenderer.invoke(IPC.SESSION_STOP_ALL_BACKGROUND),
    persistenceInfo: () => ipcRenderer.invoke(IPC.SESSION_PERSISTENCE_INFO),
    onOutput: (cb) => subscribe(IPC.SESSION_OUTPUT, cb),
    onExit: (cb) => subscribe(IPC.SESSION_EXIT, cb),
    onStatus: (cb) => subscribe(IPC.SESSION_STATUS, cb),
  },
  crossMachine: {
    fetch: () => ipcRenderer.invoke(IPC.CROSS_MACHINE_FETCH),
    startHere: (branch) => ipcRenderer.invoke(IPC.CROSS_MACHINE_START_HERE, { branch }),
  },
  server: {
    start: (req) => ipcRenderer.invoke(IPC.SERVER_START, req),
    stop: (req) => ipcRenderer.invoke(IPC.SERVER_STOP, req),
    status: (worktreeId) => ipcRenderer.invoke(IPC.SERVER_STATUS, { worktreeId }),
    statusAll: () => ipcRenderer.invoke(IPC.SERVER_STATUS_ALL),
    onState: (cb) => subscribe(IPC.SERVER_STATE, cb),
  },
  logs: {
    snapshot: (worktreeId) => ipcRenderer.invoke(IPC.LOG_SNAPSHOT, { worktreeId }),
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
    owner: () => ipcRenderer.invoke(IPC.MERGE_OWNER),
  },
  diff: {
    list: (req) => ipcRenderer.invoke(IPC.DIFF_LIST, req),
    file: (req) => ipcRenderer.invoke(IPC.DIFF_FILE, req),
  },
  tree: {
    list: (req) => ipcRenderer.invoke(IPC.TREE_LIST, req),
  },
  file: {
    read: (req) => ipcRenderer.invoke(IPC.FILE_READ, req),
    write: (req) => ipcRenderer.invoke(IPC.FILE_WRITE, req),
  },
  codenav: {
    capabilities: (worktreeId) => ipcRenderer.invoke(IPC.CODENAV_CAPABILITIES, { worktreeId }),
    definition: (req) => ipcRenderer.invoke(IPC.CODENAV_DEFINITION, req),
    references: (req) => ipcRenderer.invoke(IPC.CODENAV_REFERENCES, req),
  },
  gh: {
    status: (req) => ipcRenderer.invoke(IPC.GH_STATUS, req),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (partial) => ipcRenderer.invoke(IPC.SETTINGS_SET, partial),
  },
  scrollback: {
    get: (worktreeId) => ipcRenderer.invoke(IPC.SCROLLBACK_GET, worktreeId),
    set: (req) => ipcRenderer.invoke(IPC.SCROLLBACK_SET, req),
  },
  repo: {
    get: () => ipcRenderer.invoke(IPC.REPO_GET),
    pick: () => ipcRenderer.invoke(IPC.REPO_PICK),
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    perform: (req) => ipcRenderer.invoke(IPC.UPDATE_PERFORM, req),
    onProgress: (cb) => subscribe(IPC.UPDATE_PROGRESS, cb),
  },
  fanout: {
    start: (req) => ipcRenderer.invoke(IPC.FANOUT_START, req),
    get: () => ipcRenderer.invoke(IPC.FANOUT_GET),
    select: (req) => ipcRenderer.invoke(IPC.FANOUT_SELECT, req),
    abort: () => ipcRenderer.invoke(IPC.FANOUT_ABORT),
    onStatus: (cb) => subscribe(IPC.FANOUT_STATUS, cb),
  },
};

contextBridge.exposeInMainWorld('mango', api);
