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
} from '../../shared/types';
import { MergeRunner, type MergeEmitter } from '../git/merge-runner';
import { probeNodePty, NodePtyFactory, type NodePtyProbe } from '../pty/pty-factory';
import { WorktreeManager } from '../managers/worktree-manager';
import { SessionManager, type SessionEmitter } from '../managers/session-manager';
import { ServerManager, type ServerEmitter } from '../managers/server-manager';
import { LogStore, type LogEmitter } from '../managers/log-store';
import { NodeProcessRunner } from '../proc/process-runner';
import type { IpcContext } from './ipc-context';
import type { SessionStore } from '../managers/session-store';

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
    command: 'claude',
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
    commandOverride: process.env.MANGO_SERVER_CMD,
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
  });
  return ctx.mergeRunner;
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
      return (await getMergeRunner(ctx)).run(req);
    },
  );

  ipcMain.handle(IPC.SESSION_RECORDS, async (): Promise<string[]> => {
    return getSessionStore(ctx)
      .all()
      .map((r) => r.worktreePath);
  });

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
