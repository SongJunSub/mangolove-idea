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

  // server (ONE per worktree, concurrent)
  SERVER_START: 'server:start', // invoke (worktreeId)
  SERVER_STOP: 'server:stop', // invoke (worktreeId)
  SERVER_STATUS: 'server:status', // invoke (worktreeId -> ServerStatus)
  SERVER_STATUS_ALL: 'server:status-all', // invoke (-> Record<worktreeId, ServerStatus>) mount rehydrate
  SERVER_STATE: 'server:state', // main -> renderer, event (one worktree's ServerStatus changed)

  // logs
  LOG_LINE: 'log:line', // main -> renderer, event (one LogLine, carries worktreeId)
  LOG_SNAPSHOT: 'log:snapshot', // invoke (worktreeId -> that worktree's ring buffer)

  // merge + cleanup (MVP item 5) + conflict resolution (V2)
  MERGE_RUN: 'merge:run', // invoke
  MERGE_PROGRESS: 'merge:progress', // main -> renderer, event (now also the 'conflict' stage)
  MERGE_CONFLICTS: 'merge:conflicts', // invoke (worktreeId -> ConflictedFile[])
  MERGE_READ_CONFLICT: 'merge:read-conflict', // invoke (worktreeId, path -> ConflictFileVersions)
  MERGE_RESOLVE: 'merge:resolve', // invoke (resolve one file -> MergeResult)
  MERGE_CONTINUE: 'merge:continue', // invoke (commit --no-edit + optional cleanup -> MergeResult)
  MERGE_ABORT: 'merge:abort', // invoke (merge --abort -> MergeResult)
  MERGE_IN_PROGRESS: 'merge:in-progress', // invoke (worktreeId -> boolean; MERGE_HEAD present?)
  MERGE_OWNER: 'merge:owner', // invoke (-> worktreeId of MERGE_HEAD's feature branch, or null)

  // app quit warning (MVP item 6)
  APP_QUIT_WARNING: 'app:quit-warning', // main -> renderer, event
  APP_QUIT_DECISION: 'app:quit-decision', // renderer -> main, invoke (user said quit/cancel)

  // diff viewer (V2 A1) — read-only PR-style diff (renderer -> main, invoke)
  DIFF_LIST: 'diff:list', // invoke (worktreeId, base? -> ChangedFile[])
  DIFF_FILE: 'diff:file', // invoke (worktreeId, base?, path -> FileDiff)

  // PR/CI status panel (V2) — read-only gh-backed status + the open-in-browser action
  GH_STATUS: 'gh:status', // invoke (worktreeId -> GhStatus)
  APP_OPEN_EXTERNAL: 'app:open-external', // invoke (url -> Ack; shell.openExternal)

  // settings (V2 E) — persisted per-project config (renderer -> main, invoke)
  SETTINGS_GET: 'settings:get', // invoke (-> AppSettings)
  SETTINGS_SET: 'settings:set', // invoke (Partial<AppSettings> -> AppSettings)

  // scrollback (V2) — per-worktree serialized terminal screen for conflict-free replay
  SCROLLBACK_GET: 'scrollback:get', // invoke (worktreeId -> string | null)
  SCROLLBACK_SET: 'scrollback:set', // invoke ({worktreeId, data} -> Ack)

  // repo root (V2 packaging) — pick/persist the git repo MangoLove operates on
  REPO_GET: 'repo:get', // invoke (-> string | null = ctx.repoRoot)
  REPO_PICK: 'repo:pick', // invoke (-> RepoPickResult; persists + relaunches on success)

  // multimodel fan-out (V2) — one prompt to N claude --model lanes in parallel worktrees
  FANOUT_START: 'fanout:start', // invoke ({prompt, models, skipPermissions} -> {id, lanes})
  FANOUT_GET: 'fanout:get', // invoke (-> FanoutRun | null = current run)
  FANOUT_SELECT: 'fanout:select', // invoke ({laneId} -> MergeResult; merge winner + clean rest)
  FANOUT_ABORT: 'fanout:abort', // invoke (-> Ack; kill running lanes + remove all worktrees)
  FANOUT_STATUS: 'fanout:status', // main -> renderer, event (FanoutLaneStatusEvent)
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
