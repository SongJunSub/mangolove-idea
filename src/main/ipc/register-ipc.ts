import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type {
  Ack,
  AppInfo,
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Worktree,
  SpawnSessionRequest,
  SessionInputRequest,
  SessionResizeRequest,
  AgentSession,
  ServerStatus,
  StartServerRequest,
  StopServerRequest,
  LogLine,
  MergeRequest,
  MergeResult,
  ChangedFile,
  FileDiff,
  DiffListRequest,
  DiffFileRequest,
  AppSettings,
  ConflictedFile,
  ConflictFileVersions,
  ConflictListRequest,
  ConflictReadRequest,
  ConflictResolveRequest,
  ConflictContinueRequest,
  ConflictAbortRequest,
  ConflictInProgressRequest,
  GhStatus,
  GhStatusRequest,
  OpenExternalRequest,
  ScrollbackSetRequest,
} from '../../shared/types';
import { MergeRunner, type MergeEmitter } from '../git/merge-runner';
import { DiffViewer } from '../git/diff-viewer';
import { GhStatusReader } from '../git/gh-status-reader';
import { ConflictResolver } from '../git/conflict-resolver';
import { probeNodePty, NodePtyFactory, type NodePtyProbe } from '../pty/pty-factory';
import { WorktreeManager } from '../managers/worktree-manager';
import { SessionManager, type SessionEmitter } from '../managers/session-manager';
import { ServerManager, type ServerEmitter } from '../managers/server-manager';
import { LogStore, type LogEmitter } from '../managers/log-store';
import { NodeProcessRunner } from '../proc/process-runner';
import type { IpcContext } from './ipc-context';
import type { SessionStore } from '../managers/session-store';
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';

/** Minimal slice of Electron `app` we depend on (keeps the logic testable). */
interface AppLike {
  getVersion(): string;
}

/** Minimal slice of `process.versions` we depend on. */
interface VersionsLike {
  readonly electron?: string;
  readonly node?: string;
  readonly chrome?: string;
}

/**
 * Pure assembler for the Plan-0 ping payload. Injected dependencies make it
 * testable without booting Electron (contract §1.4 windowless IPC test).
 */
export function buildAppInfo(
  app: AppLike,
  versions: VersionsLike,
  probe: () => NodePtyProbe,
): AppInfo {
  const pty = probe();
  return {
    appVersion: app.getVersion(),
    electronVersion: versions.electron ?? 'unknown',
    nodeVersion: versions.node ?? 'unknown',
    chromeVersion: versions.chrome ?? 'unknown',
    nodePtyVersion: pty.version,
    nodePtyLoaded: pty.loaded,
  };
}

/** The three command seams resolved with precedence: settings > env > default. */
export interface ResolvedCommands {
  readonly agentCommand: string;
  readonly verifyCommand: string;
  /** undefined => no override; ServerManager auto-detection (gradle/npm) wins. */
  readonly serverCommand: string | undefined;
}

/**
 * Resolves the agent/verify/server command seams from persisted settings, falling
 * back to the existing env seams, then the hardcoded defaults. Pure + exported so
 * the precedence is unit-tested without Electron. KEEPING the env tier is what lets
 * the existing Playwright smokes (which set MANGO_*_CMD with no persisted settings)
 * still resolve to the env value.
 */
export function resolveCommands(settings: AppSettings): ResolvedCommands {
  return {
    agentCommand: settings.agentCommand ?? process.env.MANGO_AGENT_CMD ?? 'claude',
    verifyCommand: settings.verifyCommand ?? process.env.MANGO_VERIFY_CMD ?? 'true',
    serverCommand: settings.serverCommand ?? process.env.MANGO_SERVER_CMD,
  };
}

/**
 * Resolves the WorktreeManager: prefer the one already on ctx (tests inject a
 * fake); otherwise lazily build a real one from ctx.repoRoot and cache it.
 */
async function getWorktreeManager(ctx: IpcContext): Promise<WorktreeManager> {
  if (ctx.worktreeManager) return ctx.worktreeManager;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  ctx.worktreeManager = new WorktreeManager(simpleGit(repoRoot), repoRoot);
  return ctx.worktreeManager;
}

/**
 * Builds the production SessionEmitter that forwards SessionManager events to the
 * renderer over ctx.mainWindow. Null/destroyed-window guarded so a late event
 * after window close is a no-op (never throws).
 */
function buildSessionEmitter(ctx: IpcContext): SessionEmitter {
  const send = (channel: string, payload: unknown): void => {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  return {
    emitOutput: (e) => send(IPC.SESSION_OUTPUT, e),
    emitExit: (e) => send(IPC.SESSION_EXIT, e),
    emitStatus: (s) => send(IPC.SESSION_STATUS, s),
  };
}

/**
 * Resolves the SessionManager: prefer the one on ctx (tests inject a fake);
 * otherwise lazily build a real one with the node-pty factory, an emitter bound
 * to ctx.mainWindow, and a resolvePath backed by the WorktreeManager listing.
 * getSessionManager stays SYNCHRONOUS so SESSION_INPUT/SESSION_RESIZE handlers
 * call write/resize synchronously (the Plan-2 delegation tests assert this).
 */
function getSessionManager(ctx: IpcContext): SessionManager {
  if (ctx.sessionManager) return ctx.sessionManager;
  ctx.sessionManager = new SessionManager({
    factory: new NodePtyFactory(),
    emitter: buildSessionEmitter(ctx),
    command: resolveCommands(getSettingsStore(ctx).get()).agentCommand,
    resolvePath: async (worktreeId) => {
      const manager = await getWorktreeManager(ctx);
      const trees = await manager.list();
      return trees.find((t) => t.id === worktreeId)?.path;
    },
    resolveBranch: async (worktreeId) => {
      const manager = await getWorktreeManager(ctx);
      const trees = await manager.list();
      return trees.find((t) => t.id === worktreeId)?.branch;
    },
    store: getSessionStore(ctx),
    clock: Date.now,
    // Deferred live-apply: if SETTINGS_SET edited the agentCommand while this
    // manager was busy, it was KEPT (so the quit sweep + keystrokes still find the
    // live PTY). Once the last PTY exits, drop the cache so the next spawn rebuilds
    // with the new agentCommand. Guarded by the dirty flag so a plain session end
    // (no pending edit) keeps the warm, correctly-configured manager.
    onIdle: () => {
      if (ctx.sessionSettingsDirty) {
        ctx.sessionSettingsDirty = false;
        ctx.sessionManager = undefined;
      }
    },
  });
  return ctx.sessionManager;
}

/** Forwards each LogStore line to the renderer over LOG_LINE (window-guarded). */
function buildLogEmitter(ctx: IpcContext): LogEmitter {
  return {
    emitLine: (line: LogLine) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.LOG_LINE, line);
    },
  };
}

/** Forwards ServerManager state to the renderer over SERVER_STATE (guarded). */
function buildServerEmitter(ctx: IpcContext): ServerEmitter {
  return {
    emitState: (status: ServerStatus) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.SERVER_STATE, status);
    },
  };
}

/** Resolves the LogStore: prefer ctx (tests inject); else lazily build one. */
function getLogStore(ctx: IpcContext): LogStore {
  if (ctx.logStore) return ctx.logStore;
  ctx.logStore = new LogStore(buildLogEmitter(ctx));
  return ctx.logStore;
}

/**
 * Resolves the SessionStore SYNCHRONOUSLY. It is constructed eagerly in
 * `index.ts` (which holds the real electron `app` for the userData path) and
 * assigned to `ctx.sessionStore` BEFORE `registerIpc`; tests inject
 * `ctx.sessionStore` directly. Kept sync so `getSessionManager` and the
 * `SESSION_INPUT`/`SESSION_RESIZE` `ipcMain.on` handlers stay synchronous — the
 * existing Plan-2 delegation tests assert `write`/`resize` was called synchronously.
 */
function getSessionStore(ctx: IpcContext): SessionStore {
  if (ctx.sessionStore) return ctx.sessionStore;
  throw new Error(
    'sessionStore not initialized — index.ts must set ctx.sessionStore before registerIpc',
  );
}

/**
 * Resolves the SettingsStore SYNCHRONOUSLY. Constructed eagerly in index.ts (which
 * holds the real electron `app` for the userData path) and assigned to
 * ctx.settingsStore BEFORE registerIpc; tests inject ctx.settingsStore directly.
 * Kept sync so getSessionManager (and the SESSION_INPUT/RESIZE on-handlers it feeds)
 * stay synchronous — the Plan-2 delegation tests assert that.
 */
export function getSettingsStore(ctx: IpcContext): SettingsStore {
  if (ctx.settingsStore) return ctx.settingsStore;
  throw new Error(
    'settingsStore not initialized — index.ts must set ctx.settingsStore before registerIpc',
  );
}

/**
 * Resolves the ScrollbackStore SYNCHRONOUSLY. Constructed eagerly in index.ts (which holds
 * the real electron `app` for the userData path) and assigned to ctx.scrollbackStore BEFORE
 * registerIpc; tests inject ctx.scrollbackStore directly. Kept sync (mirrors getSessionStore)
 * so the SCROLLBACK_GET/SET handlers delegate without an await hop.
 */
export function getScrollbackStore(ctx: IpcContext): ScrollbackStore {
  if (ctx.scrollbackStore) return ctx.scrollbackStore;
  throw new Error(
    'scrollbackStore not initialized — index.ts must set ctx.scrollbackStore before registerIpc',
  );
}

/** Resolves the ServerManager: prefer ctx (tests inject); else build a real one. */
function getServerManager(ctx: IpcContext): ServerManager {
  if (ctx.serverManager) return ctx.serverManager;
  ctx.serverManager = new ServerManager({
    runner: new NodeProcessRunner(),
    logStore: getLogStore(ctx),
    emitter: buildServerEmitter(ctx),
    resolvePath: async (worktreeId) => {
      const manager = await getWorktreeManager(ctx);
      const trees = await manager.list();
      return trees.find((t) => t.id === worktreeId)?.path;
    },
    // Smoke seam: a harmless line-emitting command can be injected via env so a
    // manual/Playwright smoke runs WITHOUT a real gradle/npm server.
    // Command source precedence: persisted setting > env seam (smoke) > undefined
    // (=> ServerManager auto-detection of gradle/npm wins).
    commandOverride: resolveCommands(getSettingsStore(ctx).get()).serverCommand,
    // Deferred live-apply (mirror of getSessionManager): if SETTINGS_SET edited the
    // serverCommand while a server was live, the manager was KEPT. Once the server
    // stops/exits, drop the cache so the next start rebuilds with the new command.
    onIdle: () => {
      if (ctx.serverSettingsDirty) {
        ctx.serverSettingsDirty = false;
        ctx.serverManager = undefined;
      }
    },
  });
  return ctx.serverManager;
}

/** Forwards MergeRunner progress to the renderer over MERGE_PROGRESS (guarded). */
function buildMergeEmitter(ctx: IpcContext): MergeEmitter {
  return {
    emitProgress: (e) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.MERGE_PROGRESS, e);
    },
  };
}

/**
 * Resolves the MergeRunner: prefer ctx (tests inject); else build a real one.
 * MUST be async: main is ESM (`verbatimModuleSyntax`), so `require` is undefined in
 * module scope — simple-git loads via dynamic `import`, and we reuse the cached,
 * canonicalized `getWorktreeManager` rather than constructing a second WorktreeManager.
 */
async function getMergeRunner(ctx: IpcContext): Promise<MergeRunner> {
  if (ctx.mergeRunner) return ctx.mergeRunner;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  const worktrees = await getWorktreeManager(ctx);
  ctx.mergeRunner = new MergeRunner({
    git: simpleGit(repoRoot),
    worktrees,
    verifyRunner: new NodeProcessRunner(),
    emitter: buildMergeEmitter(ctx),
    verifyCommand: resolveCommands(getSettingsStore(ctx).get()).verifyCommand,
  });
  return ctx.mergeRunner;
}

/**
 * Resolves the DiffViewer: prefer ctx (tests inject); else build a real one.
 * MUST be async: main is ESM (`verbatimModuleSyntax`), so `require` is undefined in
 * module scope — simple-git loads via dynamic `import`, reusing `getWorktreeManager`
 * exactly like `getMergeRunner`. DiffViewer is read-only so a fresh simpleGit is fine.
 */
async function getDiffViewer(ctx: IpcContext): Promise<DiffViewer> {
  if (ctx.diffViewer) return ctx.diffViewer;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  ctx.diffViewer = new DiffViewer(simpleGit(repoRoot), repoRoot);
  return ctx.diffViewer;
}

/**
 * Resolves the GhStatusReader: prefer ctx (tests inject); else build a real one.
 * Copies getDiffViewer's lazy shape. owner/repo come from the origin remote URL;
 * resolveBranch/resolvePath read WorktreeManager.list() (Worktree.branch / .path);
 * hasUpstream runs a per-worktree
 * `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (no upstream => not-pushed).
 * NEVER reads a token; passes process.env through only for PATH/keyring.
 */
async function getGhStatusReader(ctx: IpcContext): Promise<GhStatusReader> {
  if (ctx.ghStatusReader) return ctx.ghStatusReader;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  const root = simpleGit(repoRoot);
  const remote = (await root.remote(['get-url', 'origin']).catch(() => '')) ?? '';
  const { owner, repo } = parseOwnerRepo(remote.trim());

  const manager = await getWorktreeManager(ctx);
  const pathOf = async (worktreeId: string): Promise<string> => {
    const trees = await manager.list();
    const t = trees.find((x) => x.id === worktreeId);
    if (!t) throw new Error(`unknown worktree ${worktreeId}`);
    return t.path;
  };

  ctx.ghStatusReader = new GhStatusReader({
    runner: new NodeProcessRunner(),
    repoRoot,
    owner,
    repo,
    resolveBranch: async (worktreeId) => {
      const trees = await manager.list();
      const t = trees.find((x) => x.id === worktreeId);
      if (!t) throw new Error(`unknown worktree ${worktreeId}`);
      return t.branch;
    },
    resolvePath: pathOf,
    hasUpstream: async (worktreeId) => {
      const wtPath = await pathOf(worktreeId);
      try {
        await simpleGit(wtPath).raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        return true;
      } catch {
        // exit 128 'fatal: no upstream configured for branch' => not pushed.
        return false;
      }
    },
  });
  return ctx.ghStatusReader;
}

/** Parses an origin URL (ssh or https) into {owner, repo}; empty on no match. */
export function parseOwnerRepo(url: string): { owner: string; repo: string } {
  // git@github.com:owner/repo.git  OR  https://github.com/owner/repo(.git)
  const m = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : { owner: '', repo: '' };
}

/**
 * Resolves the ConflictResolver: prefer ctx (tests inject); else build a real one
 * bound to the PRIMARY repoRoot (where MERGE_HEAD lives). Reuses the cached
 * WorktreeManager exactly like getMergeRunner. STATELESS — it recomputes truth from
 * MERGE_HEAD/git.status() per call — so it is safe to cache across settings changes.
 */
async function getConflictResolver(ctx: IpcContext): Promise<ConflictResolver> {
  if (ctx.conflictResolver) return ctx.conflictResolver;
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const { simpleGit } = await import('simple-git');
  const worktrees = await getWorktreeManager(ctx);
  ctx.conflictResolver = new ConflictResolver({ git: simpleGit(repoRoot), worktrees });
  return ctx.conflictResolver;
}

/**
 * Registers ALL main-process IPC handlers in one place. Plan 1 wires the real
 * WORKTREE_LIST/CREATE/REMOVE handlers, delegating to the WorktreeManager on ctx.
 */
export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle(IPC.APP_PING, async (): Promise<AppInfo> => {
    const { app } = await import('electron');
    return buildAppInfo(app, process.versions, probeNodePty);
  });

  ipcMain.handle(IPC.WORKTREE_LIST, async (): Promise<Worktree[]> => {
    const manager = await getWorktreeManager(ctx);
    return manager.list();
  });

  ipcMain.handle(
    IPC.WORKTREE_CREATE,
    async (_event: unknown, req: CreateWorktreeRequest): Promise<Worktree> => {
      const manager = await getWorktreeManager(ctx);
      return manager.create(req);
    },
  );

  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    async (_event: unknown, req: RemoveWorktreeRequest): Promise<Ack> => {
      const manager = await getWorktreeManager(ctx);
      try {
        await manager.remove(req);
        // Best-effort: drop the stale scrollback so removed worktrees do not accumulate
        // buffers. Guarded (store may be absent in a partial test ctx) and try/catch'd so a
        // cleanup failure NEVER demotes the successful removal Ack. Relies on the per-entry
        // size cap as the backstop if this ever no-ops.
        try {
          ctx.scrollbackStore?.remove(req.worktreeId);
        } catch {
          // ignore — scrollback cleanup is non-essential; the size cap bounds growth anyway
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.SESSION_SPAWN,
    async (_event: unknown, req: SpawnSessionRequest): Promise<AgentSession> => {
      return getSessionManager(ctx).spawn(req);
    },
  );

  ipcMain.handle(
    IPC.SESSION_KILL,
    async (_event: unknown, req: { worktreeId: string }): Promise<Ack> => {
      return getSessionManager(ctx).kill(req.worktreeId);
    },
  );

  ipcMain.on(IPC.SESSION_INPUT, (_event: unknown, req: SessionInputRequest) => {
    getSessionManager(ctx).write(req);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event: unknown, req: SessionResizeRequest) => {
    getSessionManager(ctx).resize(req);
  });

  ipcMain.handle(
    IPC.SERVER_START,
    async (_event: unknown, req: StartServerRequest): Promise<ServerStatus> => {
      return getServerManager(ctx).start(req);
    },
  );

  ipcMain.handle(
    IPC.SERVER_STOP,
    async (_event: unknown, req: StopServerRequest): Promise<ServerStatus> => {
      return getServerManager(ctx).stop(req);
    },
  );

  ipcMain.handle(IPC.SERVER_STATUS, async (): Promise<ServerStatus> => {
    return getServerManager(ctx).status();
  });

  ipcMain.handle(IPC.LOG_SNAPSHOT, async (): Promise<LogLine[]> => {
    return getLogStore(ctx).snapshot();
  });

  ipcMain.handle(
    IPC.MERGE_RUN,
    async (_event: unknown, req: MergeRequest): Promise<MergeResult> => {
      // Re-surface an in-progress merge instead of running run() from the top
      // (which would trip the dirty-tree gate on the conflicted target tree).
      const resolver = await getConflictResolver(ctx);
      if (await resolver.inProgress()) {
        const conflicted = (await resolver.list()).map((f) => f.path);
        // There is exactly ONE global MERGE_HEAD. The paused merge may belong to a
        // DIFFERENT worktree than the one just clicked, so attribute the conflict to
        // its TRUE owner (the worktree whose feature branch is MERGE_HEAD) — never to
        // req.worktreeId. Otherwise Continue would commit the owner's merge but run
        // cleanup against the clicked worktree, wiping the wrong tree/branch.
        const ownerId = (await resolver.inProgressWorktreeId()) ?? req.worktreeId;
        return {
          worktreeId: ownerId,
          merged: false,
          cleanedUp: false,
          status: 'conflict',
          conflicted,
        };
      }
      return (await getMergeRunner(ctx)).run(req);
    },
  );

  ipcMain.handle(
    IPC.DIFF_LIST,
    async (_event: unknown, req: DiffListRequest): Promise<ChangedFile[]> => {
      return (await getDiffViewer(ctx)).listChangedFiles(req);
    },
  );

  ipcMain.handle(
    IPC.DIFF_FILE,
    async (_event: unknown, req: DiffFileRequest): Promise<FileDiff> => {
      return (await getDiffViewer(ctx)).getFileDiff(req);
    },
  );

  ipcMain.handle(
    IPC.GH_STATUS,
    async (_event: unknown, req: GhStatusRequest): Promise<GhStatus> => {
      // GH_STATUS NEVER throws raw across the boundary — any failure becomes {kind:'error'}.
      try {
        const reader = await getGhStatusReader(ctx);
        return await reader.status(req);
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.APP_OPEN_EXTERNAL,
    async (_event: unknown, req: OpenExternalRequest): Promise<Ack> => {
      try {
        // Pin this sink to the PR-URL contract: only https github.com URLs.
        // A malformed URL throws here and lands in the {ok:false} branch.
        const u = new URL(req.url);
        if (
          u.protocol !== 'https:' ||
          (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com'))
        ) {
          return { ok: false, error: 'refused: only https github.com URLs may be opened' };
        }
        const { shell } = await import('electron');
        await shell.openExternal(req.url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.MERGE_CONFLICTS,
    async (_event: unknown, _req: ConflictListRequest): Promise<ConflictedFile[]> => {
      return (await getConflictResolver(ctx)).list();
    },
  );

  ipcMain.handle(
    IPC.MERGE_READ_CONFLICT,
    async (_event: unknown, req: ConflictReadRequest): Promise<ConflictFileVersions> => {
      return (await getConflictResolver(ctx)).read(req.path);
    },
  );

  ipcMain.handle(
    IPC.MERGE_RESOLVE,
    async (_event: unknown, req: ConflictResolveRequest): Promise<MergeResult> => {
      const resolver = await getConflictResolver(ctx);
      await resolver.resolve({ path: req.path, choice: req.choice, content: req.content });
      const conflicted = (await resolver.list()).map((f) => f.path);
      return {
        worktreeId: req.worktreeId,
        merged: false,
        cleanedUp: false,
        status: 'conflict',
        conflicted,
      };
    },
  );

  ipcMain.handle(
    IPC.MERGE_CONTINUE,
    async (_event: unknown, req: ConflictContinueRequest): Promise<MergeResult> => {
      return (await getConflictResolver(ctx)).continue(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_ABORT,
    async (_event: unknown, req: ConflictAbortRequest): Promise<MergeResult> => {
      return (await getConflictResolver(ctx)).abort(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_IN_PROGRESS,
    async (_event: unknown, _req: ConflictInProgressRequest): Promise<boolean> => {
      return (await getConflictResolver(ctx)).inProgress();
    },
  );

  ipcMain.handle(IPC.MERGE_OWNER, async (): Promise<string | null> => {
    // Which worktree the single in-flight MERGE_HEAD actually belongs to — the
    // renderer attributes the Conflicts pane to THIS, never to whatever worktree
    // happens to be selected.
    return (await getConflictResolver(ctx)).inProgressWorktreeId();
  });

  ipcMain.handle(IPC.SESSION_RECORDS, async (): Promise<string[]> => {
    return getSessionStore(ctx)
      .all()
      .map((r) => r.worktreePath);
  });

  ipcMain.handle(IPC.SETTINGS_GET, async (): Promise<AppSettings> => {
    return getSettingsStore(ctx).get();
  });

  ipcMain.handle(
    IPC.SETTINGS_SET,
    async (_event: unknown, partial: Partial<AppSettings>): Promise<AppSettings> => {
      const merged = getSettingsStore(ctx).set(partial);
      // Live-apply: the managers bake their command/base in at CONSTRUCTION and are
      // cached on ctx; clearing a cache makes it REBUILD lazily with the new settings.
      // mergeRunner/diffViewer hold NO live OS process, so clearing them is always
      // safe — an edited verifyCommand/baseBranch applies on the next merge/diff.
      ctx.mergeRunner = undefined; // verifyCommand (+ base via renderer)
      ctx.diffViewer = undefined; // base (rebuilt with current settings on next diff)
      // The ConflictResolver owns the in-progress merge. It recomputes truth from
      // MERGE_HEAD/git.status() per call, so nulling it would only re-bind a fresh
      // SimpleGit — harmless — BUT while a merge is in progress we keep the same
      // instance to mirror the sessionManager 'keep-while-busy' discipline and to
      // guarantee the resolution capability is never dropped mid-conflict.
      if (!(await ctx.conflictResolver?.inProgress())) {
        ctx.conflictResolver = undefined; // idle: rebuilt on next conflict call
      }
      // sessionManager/serverManager own LIVE children that the before-quit sweep
      // (index.ts) and the SESSION_INPUT/RESIZE handlers find THROUGH ctx. Nulling
      // them mid-run would orphan the running claude/server from the sweep AND detach
      // it from the next keystroke (a fresh manager has no record of it). So when
      // IDLE we clear immediately (next spawn/start rebuilds); when BUSY we KEEP the
      // manager but mark it dirty, and its injected onIdle callback clears the cache
      // once the last child exits — so the new agent/server command truly takes
      // effect "once the live work ends", not only on a later idle SETTINGS_SET.
      if ((ctx.sessionManager?.liveWorktreeIds().length ?? 0) === 0) {
        ctx.sessionSettingsDirty = false;
        ctx.sessionManager = undefined; // idle: agentCommand applies on next spawn
      } else {
        ctx.sessionSettingsDirty = true; // busy: onIdle clears it after the last exit
      }
      if (!(ctx.serverManager?.hasLiveServer() ?? false)) {
        ctx.serverSettingsDirty = false;
        ctx.serverManager = undefined; // idle: serverCommand applies on next start
      } else {
        ctx.serverSettingsDirty = true; // busy: onIdle clears it after the server stops
      }
      return merged;
    },
  );

  ipcMain.handle(
    IPC.SCROLLBACK_GET,
    async (_event: unknown, worktreeId: string): Promise<string | null> => {
      // Normalize undefined -> null so the invoke result is an explicit, serializable value.
      return getScrollbackStore(ctx).get(worktreeId) ?? null;
    },
  );

  ipcMain.handle(
    IPC.SCROLLBACK_SET,
    async (_event: unknown, req: ScrollbackSetRequest): Promise<Ack> => {
      getScrollbackStore(ctx).set(req.worktreeId, req.data);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.APP_QUIT_DECISION,
    async (_event: unknown, req: { quit: boolean }): Promise<Ack> => {
      if (!req.quit) return { ok: true }; // user cancelled — stay open.
      ctx.confirmedQuit = true;
      ctx.sessionManager?.killAll(); // PTY kill-sweep: no orphan claude survives.
      ctx.serverManager?.dispose(); // keep Plan 3's server cleanup.
      ctx.requestQuit?.(); // index.ts wires this to app.quit().
      return { ok: true };
    },
  );
}
