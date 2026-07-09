// src/shared/ipc-channels.ts  —  the ONLY place channel strings are defined.
export const IPC = {
  // Plan-0 probe (renderer -> main, invoke). Template every later channel copies.
  APP_PING: 'app:ping',

  // worktree CRUD (renderer -> main, invoke)
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_LIST_FOR: 'worktree:list-for', // invoke (repoPath -> Worktree[]; repoPath validated against recentRepos; [] on reject/error). read-only cross-repo listing for the project tree
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_REMOVE: 'worktree:remove',

  // project groups (project tree grouping layer) — persisted view over recentRepos
  GROUPS_GET: 'groups:get', // invoke (-> ProjectGroup[]; pruned to live canonical recentRepos)
  GROUPS_SET: 'groups:set', // invoke (ProjectGroup[] -> ProjectGroup[]; shape-coerced + canonicalized + pruned + 1-repo-1-group; returns the stored form)
  GROUPS_CHANGED: 'groups:changed', // main -> renderer, event (another window changed groups; re-fetch)

  // agent session (mixed)
  SESSION_SPAWN: 'session:spawn', // invoke
  SESSION_INPUT: 'session:input', // renderer -> main, fire-and-forget (on)
  SESSION_RESIZE: 'session:resize', // renderer -> main, fire-and-forget (on)
  SESSION_KILL: 'session:kill', // invoke
  SESSION_OUTPUT: 'session:output', // main -> renderer, event
  SESSION_EXIT: 'session:exit', // main -> renderer, event
  SESSION_STATUS: 'session:status', // main -> renderer, event (AgentSession changed)
  SESSION_RECORDS: 'session:records', // invoke (recorded worktree paths for rehydrate)
  SESSION_STOP_ALL_BACKGROUND: 'session:stop-all-background', // invoke (-> Ack; b-full kill-switch)
  SESSION_PERSISTENCE_INFO: 'session:persistence-info', // invoke (-> SessionPersistenceInfo; loud fallback)

  // plain shell terminals (multi-terminal panel) — ephemeral $SHELL PTYs keyed by terminalId,
  // separate from the agent session machinery above (no abduco/b-full/cross-machine).
  TERM_SPAWN: 'term:spawn', // invoke ({terminalId, cwd, cols, rows} -> Ack)
  TERM_INPUT: 'term:input', // renderer -> main, fire-and-forget (on)
  TERM_RESIZE: 'term:resize', // renderer -> main, fire-and-forget (on)
  TERM_KILL: 'term:kill', // invoke (terminalId -> Ack)
  TERM_OUTPUT: 'term:output', // main -> renderer, event
  TERM_EXIT: 'term:exit', // main -> renderer, event

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
  APP_SET_UNSAVED: 'app:set-unsaved', // renderer -> main, send (per-window unsaved file count, A4)

  // diff viewer (V2 A1) — read-only PR-style diff (renderer -> main, invoke)
  DIFF_LIST: 'diff:list', // invoke (worktreeId, base? -> ChangedFile[])
  DIFF_FILE: 'diff:file', // invoke (worktreeId, base?, path -> FileDiff)

  // file tree (A3) — read the selected worktree's dir tree, scoped (renderer -> main, invoke)
  TREE_LIST: 'tree:list', // invoke ({worktreeId, relPath?} -> TreeEntry[])

  // file content (A4) — read/write ONE file in the selected worktree, scoped + O_NOFOLLOW
  FILE_READ: 'file:read', // invoke ({worktreeId, relPath} -> FileReadResult)
  FILE_WRITE: 'file:write', // invoke ({worktreeId, relPath, content, baseToken?} -> FileWriteResult)

  // code navigation (Phase B) — Java/Kotlin go-to-def/find-usages via external LSP on PATH.
  // TS/JS nav is in-browser (monaco) and never touches these. Targets are worktree-confined.
  CODENAV_CAPABILITIES: 'codenav:capabilities', // invoke ({worktreeId} -> CodeNavCapabilities)
  CODENAV_DEFINITION: 'codenav:definition', // invoke (CodeNavQuery -> CodeNavResult)
  CODENAV_REFERENCES: 'codenav:references', // invoke (CodeNavReferencesQuery -> CodeNavResult)
  CODENAV_STATUS: 'codenav:status', // push (main -> renderer: CodeNavStatus on server-state change)

  // PR/CI status panel (V2) — read-only gh-backed status + the open-in-browser action
  GH_STATUS: 'gh:status', // invoke (worktreeId -> GhStatus)
  APP_OPEN_EXTERNAL: 'app:open-external', // invoke (url -> Ack; shell.openExternal)

  // settings (V2 E) — persisted per-project config (renderer -> main, invoke)
  SETTINGS_GET: 'settings:get', // invoke (-> AppSettings)
  SETTINGS_SET: 'settings:set', // invoke (Partial<AppSettings> -> AppSettings)

  // cross-machine sessions (V2, visibility-only) — fetch all machines' session pointers
  CROSS_MACHINE_FETCH: 'cross-machine:fetch', // invoke (-> CrossMachineSessionPointer[]; [] when opted out)
  CROSS_MACHINE_START_HERE: 'cross-machine:start-here', // invoke ({branch} -> Worktree; checks out the branch for a FRESH session)

  // scrollback (V2) — per-worktree serialized terminal screen for conflict-free replay
  SCROLLBACK_GET: 'scrollback:get', // invoke (worktreeId -> string | null)
  SCROLLBACK_SET: 'scrollback:set', // invoke ({worktreeId, data} -> Ack)

  // repo root (V2 packaging) — pick/persist the git repo MangoLove operates on
  REPO_GET: 'repo:get', // invoke (-> string | null = ctx.repoRoot)
  REPO_PICK: 'repo:pick', // invoke (-> RepoPickResult; native picker; persists to recentRepos + opens/focuses a window, no relaunch)
  REPO_LIST: 'repo:list', // invoke (-> RecentRepo[]; recentRepos filtered to live .git dirs, canonicalized, active flagged)
  REPO_OPEN: 'repo:open', // invoke ((path, opts?{worktreeId}) -> RepoPickResult; switch to a KNOWN recent repo by path = openOrFocus its window, optionally selecting a worktree)
  REPO_FORGET: 'repo:forget', // invoke (path -> RecentRepo[]; drop a repo from recentRepos (never the active one; disk untouched), returns the updated list)
  REPO_TAKE_PENDING_SELECT: 'repo:take-pending-select', // invoke (-> string|null; consume-once worktree id to select after a cross-repo switch reload)
  REPO_SELECT_WORKTREE: 'repo:select-worktree', // main -> renderer event ({worktreeId}); focus/reselect-path delivery of a cross-repo worktree selection

  // multimodel fan-out (V2) — one prompt to N claude --model lanes in parallel worktrees
  FANOUT_START: 'fanout:start', // invoke ({prompt, models, skipPermissions} -> {id, lanes})
  FANOUT_GET: 'fanout:get', // invoke (-> FanoutRun | null = current run)
  FANOUT_SELECT: 'fanout:select', // invoke ({laneId} -> MergeResult; merge winner + clean rest)
  FANOUT_ABORT: 'fanout:abort', // invoke (-> Ack; kill running lanes + remove all worktrees)
  FANOUT_STATUS: 'fanout:status', // main -> renderer, event (FanoutLaneStatusEvent)

  // in-app update check (renderer -> main, invoke; read-only GitHub Releases query)
  UPDATE_CHECK: 'update:check', // invoke (-> UpdateStatus)
  UPDATE_PERFORM: 'update:perform', // invoke (UpdatePerformRequest -> UpdateApplyResult; success quits)
  UPDATE_PROGRESS: 'update:progress', // main -> renderer, event (UpdateProgress)

  // Claude Code subscription usage (renderer -> main, invoke; read-only OAuth usage endpoint, no cost)
  USAGE_GET: 'usage:get', // invoke (-> UsageStatus)
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
