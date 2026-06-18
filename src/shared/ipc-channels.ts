// src/shared/ipc-channels.ts  —  the ONLY place channel strings are defined.
export const IPC = {
  // Plan-0 probe (renderer -> main, invoke). Template every later channel copies.
  APP_PING: 'app:ping',

  // worktree CRUD (renderer -> main, invoke)
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_REMOVE: 'worktree:remove',

  // agent session (mixed)
  SESSION_SPAWN: 'session:spawn', // invoke
  SESSION_INPUT: 'session:input', // renderer -> main, fire-and-forget (on)
  SESSION_RESIZE: 'session:resize', // renderer -> main, fire-and-forget (on)
  SESSION_KILL: 'session:kill', // invoke
  SESSION_OUTPUT: 'session:output', // main -> renderer, event
  SESSION_EXIT: 'session:exit', // main -> renderer, event
  SESSION_STATUS: 'session:status', // main -> renderer, event (AgentSession changed)
  SESSION_RECORDS: 'session:records', // invoke (recorded worktree paths for rehydrate)

  // server (ONE at a time)
  SERVER_START: 'server:start', // invoke
  SERVER_STOP: 'server:stop', // invoke
  SERVER_STATUS: 'server:status', // invoke (snapshot)
  SERVER_STATE: 'server:state', // main -> renderer, event (ServerStatus changed)

  // logs
  LOG_LINE: 'log:line', // main -> renderer, event (one LogLine)
  LOG_SNAPSHOT: 'log:snapshot', // invoke (full ring buffer for current run)

  // merge + cleanup (MVP item 5)
  MERGE_RUN: 'merge:run', // invoke
  MERGE_PROGRESS: 'merge:progress', // main -> renderer, event

  // app quit warning (MVP item 6)
  APP_QUIT_WARNING: 'app:quit-warning', // main -> renderer, event
  APP_QUIT_DECISION: 'app:quit-decision', // renderer -> main, invoke (user said quit/cancel)

  // diff viewer (V2 A1) — read-only PR-style diff (renderer -> main, invoke)
  DIFF_LIST: 'diff:list', // invoke (worktreeId, base? -> ChangedFile[])
  DIFF_FILE: 'diff:file', // invoke (worktreeId, base?, path -> FileDiff)

  // settings (V2 E) — persisted per-project config (renderer -> main, invoke)
  SETTINGS_GET: 'settings:get', // invoke (-> AppSettings)
  SETTINGS_SET: 'settings:set', // invoke (Partial<AppSettings> -> AppSettings)
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
