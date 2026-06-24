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
  LogSnapshotRequest,
  LogLine,
  MergeRequest,
  MergeResult,
  ChangedFile,
  FileDiff,
  DiffListRequest,
  DiffFileRequest,
  AppSettings,
  SessionPersistenceInfo,
  CrossMachineSessionPointer,
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
  RepoPickResult,
  FanoutStartRequest,
  FanoutStartResult,
  FanoutRun,
  FanoutSelectRequest,
} from '../../shared/types';
import { MergeRunner, type MergeEmitter } from '../git/merge-runner';
import { FanoutManager, type FanoutEmitter } from '../git/fanout-manager';
import { runLane } from '../git/fanout-run';
import { DiffViewer } from '../git/diff-viewer';
import { GhStatusReader, remoteHasBranch } from '../git/gh-status-reader';
import { ConflictResolver } from '../git/conflict-resolver';
import { probeNodePty, NodePtyFactory, type NodePtyProbe } from '../pty/pty-factory';
import { AbducoLauncher } from '../pty/abduco-launcher';
import { createAbducoExec } from '../pty/abduco-exec';
import type { AgentLauncher } from '../pty/agent-launcher';
import { SessionRefSync } from '../sync/session-ref-sync';
import { createRefSyncGit } from '../sync/session-ref-git';
import { getOrCreateMachineIdentity } from '../sync/machine-identity';
import { SessionPublisher, type LiveSession } from '../sync/session-publisher';
import { WorktreeManager } from '../managers/worktree-manager';
import { SessionManager, type SessionEmitter } from '../managers/session-manager';
import { ServerManager, type ServerEmitter } from '../managers/server-manager';
import { LogStore, type LogEmitter } from '../managers/log-store';
import { NodeProcessRunner, type IProcLike } from '../proc/process-runner';
import type { IpcContext } from './ipc-context';
import { requireCtxFrom, type CtxEventLike } from '../app/window-registry';
import type { SessionStore } from '../managers/session-store';
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Asserts a repo is selected and returns it. The renderer GATES all worktree ops
 * behind a non-null repoRoot, so this throw is DEFENSIVE only — it surfaces a
 * friendly message if a repoRoot-bound op is somehow invoked with no repo.
 */
function requireRepoRoot(ctx: IpcContext): string {
  if (ctx.repoRoot == null) throw new Error('no repository selected');
  return ctx.repoRoot;
}

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
 * Chooses the AgentLauncher for a SessionManager. Returns undefined — so
 * SessionManager defaults to a DirectLauncher built from agentCommand (the exact
 * b-lite behavior) — UNLESS sessionPersistence === 'full' AND an abduco binary was
 * resolved at boot (ctx.abducoPath). When 'full' is set but abducoPath is null
 * (abduco missing / non-darwin / not bundled), b-full degrades to b-lite here; the
 * Settings UI surfaces that effective mode so the downgrade is never silent.
 */
export function buildLauncher(
  settings: AppSettings,
  agentCommand: string,
  abducoPath: string | null | undefined,
): AgentLauncher | undefined {
  if (settings.sessionPersistence !== 'full' || !abducoPath) return undefined;
  return new AbducoLauncher({
    abducoPath,
    command: agentCommand,
    ...createAbducoExec(abducoPath),
  });
}

/**
 * Computes the EFFECTIVE session-persistence state (b-full loud fallback). 'full'
 * is only in effect when the user asked for it AND abduco was resolved at boot;
 * otherwise it falls back to 'lite'. The Settings UI surfaces a requested!==effective
 * mismatch so the downgrade is never silent. Pure + exported for unit tests.
 */
export function resolveEffectivePersistence(
  settings: AppSettings,
  abducoPath: string | null | undefined,
): SessionPersistenceInfo {
  const requested = settings.sessionPersistence === 'full' ? 'full' : 'lite';
  const abducoAvailable = Boolean(abducoPath);
  const effective = requested === 'full' && abducoAvailable ? 'full' : 'lite';
  return { requested, effective, abducoAvailable };
}

/**
 * Resolves the WorktreeManager: prefer the one already on ctx (tests inject a
 * fake); otherwise lazily build a real one from ctx.repoRoot and cache it.
 */
async function getWorktreeManager(ctx: IpcContext): Promise<WorktreeManager> {
  if (ctx.worktreeManager) return ctx.worktreeManager;
  const repoRoot = requireRepoRoot(ctx);
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
    emitExit: (e) => {
      send(IPC.SESSION_EXIT, e);
      // A session ended -> republish this machine's (now smaller) pointer set.
      getSessionPublisher(ctx).notifyChanged();
    },
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
  const settings = getSettingsStore(ctx).get();
  const agentCommand = resolveCommands(settings).agentCommand;
  ctx.sessionManager = new SessionManager({
    factory: new NodePtyFactory(),
    emitter: buildSessionEmitter(ctx),
    command: agentCommand,
    // b-full: an AbducoLauncher when sessionPersistence==='full' AND abduco is
    // available; undefined otherwise => SessionManager builds a DirectLauncher
    // (b-lite) from `command`, leaving the existing behavior byte-for-byte intact.
    launcher: buildLauncher(settings, agentCommand, ctx.abducoPath),
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

/**
 * Resolves the per-ctx SessionPublisher (V2 cross-machine sessions). Gated on the
 * crossMachineSessions opt-in (default off => notifyChanged is a no-op, zero git/network).
 * Reads live sessions from the EXISTING sessionManager instance (never reconstructs it)
 * and resolves each worktree's branch via the WorktreeManager; publishes through a
 * per-repo SessionRefSync. Best-effort: failures are swallowed (sync is never on the
 * critical path).
 */
function getSessionPublisher(ctx: IpcContext): SessionPublisher {
  if (ctx.sessionPublisher) return ctx.sessionPublisher;
  ctx.sessionPublisher = new SessionPublisher({
    // Read the optional store directly (NOT getSettingsStore, which throws when
    // uninitialized): absent settings => disabled. Sync is best-effort and must never
    // break a spawn/kill, so the gate defaults to OFF when anything is missing.
    isEnabled: () => ctx.settingsStore?.get().crossMachineSessions === 'on',
    identity: () => getOrCreateMachineIdentity(getSettingsStore(ctx)),
    liveSessions: async (): Promise<LiveSession[]> => {
      const manager = ctx.sessionManager;
      const live = manager?.liveWorktreeIds() ?? [];
      if (live.length === 0) return [];
      const trees = await (await getWorktreeManager(ctx)).list();
      const out: LiveSession[] = [];
      for (const id of live) {
        const branch = trees.find((t) => t.id === id)?.branch;
        if (branch) out.push({ branch, hasActiveTurn: manager!.hasActiveTurn(id) });
      }
      return out;
    },
    publish: (machineId, pointers) =>
      new SessionRefSync(createRefSyncGit(requireRepoRoot(ctx))).publish(machineId, pointers),
    now: Date.now,
  });
  return ctx.sessionPublisher;
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
  const repoRoot = requireRepoRoot(ctx);
  const { simpleGit } = await import('simple-git');
  const worktrees = await getWorktreeManager(ctx);
  ctx.mergeRunner = new MergeRunner({
    git: simpleGit(repoRoot),
    worktrees,
    verifyRunner: new NodeProcessRunner(),
    emitter: buildMergeEmitter(ctx),
    verifyCommand: resolveCommands(getSettingsStore(ctx).get()).verifyCommand,
    // cleanupWorktree removes the worktree directly (not via WORKTREE_REMOVE), so drop
    // its scrollback entry here too — otherwise it leaks in scrollback.json.
    onWorktreeRemoved: (id) => ctx.scrollbackStore?.remove(id),
  });
  return ctx.mergeRunner;
}

/** Forwards FanoutManager lane-status events to the renderer over FANOUT_STATUS (guarded). */
function buildFanoutEmitter(ctx: IpcContext): FanoutEmitter {
  return {
    emitLaneStatus: (e) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.FANOUT_STATUS, e);
    },
  };
}

/**
 * Resolves the FanoutManager: prefer ctx (tests inject); else build a real one.
 * MUST be async (main is ESM): reuses the cached WorktreeManager + MergeRunner and
 * injects a laneRunner that wraps runLane with the resolved agentCommand. resolveBase
 * reads settings.baseBranch (?? 'main') at start time so a base change applies live.
 */
async function getFanoutManager(ctx: IpcContext): Promise<FanoutManager> {
  if (ctx.fanoutManager) return ctx.fanoutManager;
  const repoRoot = requireRepoRoot(ctx); // obtain the non-null repo root EXACTLY as getMergeRunner does
  const worktrees = await getWorktreeManager(ctx);
  const merge = await getMergeRunner(ctx);
  const runner = new NodeProcessRunner();
  const { simpleGit } = await import('simple-git');
  const agentCommand = resolveCommands(getSettingsStore(ctx).get()).agentCommand;
  ctx.fanoutManager = new FanoutManager({
    worktrees,
    merge,
    resolveBase: async () => getSettingsStore(ctx).get().baseBranch ?? 'main',
    agentCommand,
    laneRunner: ({ agentCommand: cmd, prompt, model, cwd, skipPermissions, onDone }) => {
      // Wrap runLane in the LaneProc seam. Capture the child via onSpawn so kill()
      // actually SIGTERMs a still-running headless claude on abort() (not a no-op).
      let child: IProcLike | undefined;
      let killed = false;
      void runLane({
        runner,
        agentCommand: cmd,
        prompt,
        model,
        cwd,
        skipPermissions,
        onSpawn: (p) => {
          child = p;
          if (killed) p.kill();
        },
      }).then((r) => {
        if (!killed) onDone(r);
      });
      return {
        kill: () => {
          killed = true;
          child?.kill();
        },
      };
    },
    emitter: buildFanoutEmitter(ctx),
    genId: () => Date.now().toString(36),
    gitFactory: (cwd: string) => simpleGit(cwd),
    repoRoot,
  });
  return ctx.fanoutManager;
}

/**
 * Resolves the DiffViewer: prefer ctx (tests inject); else build a real one.
 * MUST be async: main is ESM (`verbatimModuleSyntax`), so `require` is undefined in
 * module scope — simple-git loads via dynamic `import`, reusing `getWorktreeManager`
 * exactly like `getMergeRunner`. DiffViewer is read-only so a fresh simpleGit is fine.
 */
async function getDiffViewer(ctx: IpcContext): Promise<DiffViewer> {
  if (ctx.diffViewer) return ctx.diffViewer;
  const repoRoot = requireRepoRoot(ctx);
  const { simpleGit } = await import('simple-git');
  ctx.diffViewer = new DiffViewer(simpleGit(repoRoot), repoRoot);
  return ctx.diffViewer;
}

/**
 * Resolves the GhStatusReader: prefer ctx (tests inject); else build a real one.
 * Copies getDiffViewer's lazy shape. owner/repo come from the origin remote URL;
 * resolveBranch/resolvePath read WorktreeManager.list() (Worktree.branch / .path);
 * hasUpstream runs `git rev-parse @{u}` (fast, local); isOnRemote runs
 * `git ls-remote --heads origin <branch>` — consulted ONLY when there's no local
 * upstream, to confirm a branch pushed without `-u` is on the remote (so it is not
 * mis-reported as not-pushed). NEVER reads a token; process.env only for PATH/keyring.
 */
async function getGhStatusReader(ctx: IpcContext): Promise<GhStatusReader> {
  if (ctx.ghStatusReader) return ctx.ghStatusReader;
  const repoRoot = requireRepoRoot(ctx);
  const { simpleGit } = await import('simple-git');
  const root = simpleGit(repoRoot);
  const remote = (await root.remote(['get-url', 'origin']).catch(() => '')) ?? '';
  const { owner, repo } = parseOwnerRepo(remote.trim());

  const manager = await getWorktreeManager(ctx);
  const treeOf = async (worktreeId: string): Promise<Worktree> => {
    const t = (await manager.list()).find((x) => x.id === worktreeId);
    if (!t) throw new Error(`unknown worktree ${worktreeId}`);
    return t;
  };
  const pathOf = async (worktreeId: string): Promise<string> => (await treeOf(worktreeId)).path;
  const branchOf = async (worktreeId: string): Promise<string> => (await treeOf(worktreeId)).branch;

  ctx.ghStatusReader = new GhStatusReader({
    runner: new NodeProcessRunner(),
    repoRoot,
    owner,
    repo,
    resolveBranch: branchOf,
    resolvePath: pathOf,
    hasUpstream: async (worktreeId) => {
      const wtPath = await pathOf(worktreeId);
      try {
        await simpleGit(wtPath).raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        return true;
      } catch {
        // exit 128 'fatal: no upstream configured for branch' => no LOCAL tracking.
        return false;
      }
    },
    // Authoritative remote-existence check (no API quota) for the no-upstream case: a
    // branch pushed without `-u` (or from another clone) has no local tracking but IS
    // on the remote, so ls-remote distinguishes it from a genuinely not-pushed branch.
    isOnRemote: async (worktreeId) => {
      const branch = await branchOf(worktreeId);
      try {
        const out = await simpleGit(await pathOf(worktreeId)).raw([
          'ls-remote',
          '--heads',
          'origin',
          branch,
        ]);
        return remoteHasBranch(out, branch);
      } catch {
        return false; // no remote / network error => treat as not-on-remote
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
  const repoRoot = requireRepoRoot(ctx);
  const { simpleGit } = await import('simple-git');
  const worktrees = await getWorktreeManager(ctx);
  ctx.conflictResolver = new ConflictResolver({
    git: simpleGit(repoRoot),
    worktrees,
    // continue(cleanup) removes the worktree directly (not via WORKTREE_REMOVE), so
    // drop its scrollback entry here too — otherwise it leaks in scrollback.json.
    onWorktreeRemoved: (id) => ctx.scrollbackStore?.remove(id),
  });
  return ctx.conflictResolver;
}

/**
 * Registers ALL main-process IPC handlers ONCE (channels are process-global). Each
 * handler resolves ITS window's IpcContext from the event sender via requireCtx; the
 * existing per-handler body is then UNCHANGED. APP_PING is repo-agnostic so it skips
 * the lookup.
 */
export function registerIpc(ipcMain: IpcMain, contexts: Map<number, IpcContext>): void {
  /** Resolve the sender's per-window ctx; fail-loud if the window is gone. */
  const requireCtx = (event: CtxEventLike): IpcContext => requireCtxFrom(contexts, event);

  ipcMain.handle(IPC.APP_PING, async (): Promise<AppInfo> => {
    const { app } = await import('electron');
    return buildAppInfo(app, process.versions, probeNodePty);
  });

  ipcMain.handle(IPC.WORKTREE_LIST, async (event): Promise<Worktree[]> => {
    const ctx = requireCtx(event);
    const manager = await getWorktreeManager(ctx);
    return manager.list();
  });

  ipcMain.handle(
    IPC.WORKTREE_CREATE,
    async (event, req: CreateWorktreeRequest): Promise<Worktree> => {
      const ctx = requireCtx(event);
      const manager = await getWorktreeManager(ctx);
      return manager.create(req);
    },
  );

  ipcMain.handle(IPC.WORKTREE_REMOVE, async (event, req: RemoveWorktreeRequest): Promise<Ack> => {
    const ctx = requireCtx(event);
    const manager = await getWorktreeManager(ctx);
    try {
      await manager.remove(req);
      try {
        ctx.scrollbackStore?.remove(req.worktreeId);
      } catch {
        // ignore — scrollback cleanup is non-essential; the size cap bounds growth anyway
      }
      // Reap any surviving b-full background session for the removed worktree — its
      // abduco master would otherwise be an orphan (we know the path here, so we can
      // end it deterministically). Only when a manager already exists (no agent ever
      // ran => nothing to reap, and we must not build one just to scan). No-op for
      // b-lite (endDetached has no master to kill). Best-effort.
      void ctx.sessionManager?.endDetached(req.worktreeId).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    IPC.SESSION_SPAWN,
    async (event, req: SpawnSessionRequest): Promise<AgentSession> => {
      const ctx = requireCtx(event);
      const session = await getSessionManager(ctx).spawn(req);
      // A session started -> publish this machine's pointer set (best-effort, gated).
      getSessionPublisher(ctx).notifyChanged();
      return session;
    },
  );

  ipcMain.handle(IPC.SESSION_KILL, async (event, req: { worktreeId: string }): Promise<Ack> => {
    const ctx = requireCtx(event);
    // In b-full, "kill" must actually END the session — close the front-end PTY AND
    // kill the surviving abduco master (endDetached), so the agent does not keep
    // running invisibly. For b-lite this is exactly the front-end kill (no master).
    const ack = await getSessionManager(ctx).endDetached(req.worktreeId);
    getSessionPublisher(ctx).notifyChanged(); // session ended -> republish
    return ack;
  });

  ipcMain.on(IPC.SESSION_INPUT, (event, req: SessionInputRequest) => {
    // requireCtx + the Map lookup are SYNCHRONOUS, so write() still runs synchronously
    // (the Plan-2 delegation tests assert sync write).
    const ctx = requireCtx(event);
    getSessionManager(ctx).write(req);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (event, req: SessionResizeRequest) => {
    const ctx = requireCtx(event);
    getSessionManager(ctx).resize(req);
  });

  ipcMain.handle(
    IPC.SERVER_START,
    async (event, req: StartServerRequest): Promise<ServerStatus> => {
      const ctx = requireCtx(event);
      return getServerManager(ctx).start(req);
    },
  );

  ipcMain.handle(IPC.SERVER_STOP, async (event, req: StopServerRequest): Promise<ServerStatus> => {
    const ctx = requireCtx(event);
    return getServerManager(ctx).stop(req);
  });

  ipcMain.handle(
    IPC.SERVER_STATUS,
    async (event, req: { worktreeId: string }): Promise<ServerStatus> => {
      const ctx = requireCtx(event);
      return getServerManager(ctx).status(req.worktreeId);
    },
  );

  ipcMain.handle(IPC.SERVER_STATUS_ALL, async (event): Promise<Record<string, ServerStatus>> => {
    const ctx = requireCtx(event);
    return getServerManager(ctx).statusAll();
  });

  ipcMain.handle(IPC.LOG_SNAPSHOT, async (event, req: LogSnapshotRequest): Promise<LogLine[]> => {
    const ctx = requireCtx(event);
    return getLogStore(ctx).snapshot(req.worktreeId);
  });

  ipcMain.handle(IPC.MERGE_RUN, async (event, req: MergeRequest): Promise<MergeResult> => {
    const ctx = requireCtx(event);
    const resolver = await getConflictResolver(ctx);
    if (await resolver.inProgress()) {
      const conflicted = (await resolver.list()).map((f) => f.path);
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
  });

  ipcMain.handle(IPC.DIFF_LIST, async (event, req: DiffListRequest): Promise<ChangedFile[]> => {
    const ctx = requireCtx(event);
    return (await getDiffViewer(ctx)).listChangedFiles(req);
  });

  ipcMain.handle(IPC.DIFF_FILE, async (event, req: DiffFileRequest): Promise<FileDiff> => {
    const ctx = requireCtx(event);
    return (await getDiffViewer(ctx)).getFileDiff(req);
  });

  ipcMain.handle(IPC.GH_STATUS, async (event, req: GhStatusRequest): Promise<GhStatus> => {
    const ctx = requireCtx(event);
    try {
      const reader = await getGhStatusReader(ctx);
      return await reader.status(req);
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_event, req: OpenExternalRequest): Promise<Ack> => {
    // APP_OPEN_EXTERNAL is repo-agnostic + github-pinned: body UNCHANGED, no ctx.
    try {
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
  });

  ipcMain.handle(
    IPC.MERGE_CONFLICTS,
    async (event, _req: ConflictListRequest): Promise<ConflictedFile[]> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).list();
    },
  );

  ipcMain.handle(
    IPC.MERGE_READ_CONFLICT,
    async (event, req: ConflictReadRequest): Promise<ConflictFileVersions> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).read(req.path);
    },
  );

  ipcMain.handle(
    IPC.MERGE_RESOLVE,
    async (event, req: ConflictResolveRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
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
    async (event, req: ConflictContinueRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).continue(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_ABORT,
    async (event, req: ConflictAbortRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).abort(req);
    },
  );

  ipcMain.handle(
    IPC.MERGE_IN_PROGRESS,
    async (event, _req: ConflictInProgressRequest): Promise<boolean> => {
      const ctx = requireCtx(event);
      return (await getConflictResolver(ctx)).inProgress();
    },
  );

  ipcMain.handle(IPC.MERGE_OWNER, async (event): Promise<string | null> => {
    const ctx = requireCtx(event);
    return (await getConflictResolver(ctx)).inProgressWorktreeId();
  });

  ipcMain.handle(
    IPC.FANOUT_START,
    async (event, req: FanoutStartRequest): Promise<FanoutStartResult> => {
      const ctx = requireCtx(event);
      return (await getFanoutManager(ctx)).start(req);
    },
  );

  ipcMain.handle(IPC.FANOUT_GET, async (event): Promise<FanoutRun | null> => {
    const ctx = requireCtx(event);
    return (await getFanoutManager(ctx)).get() ?? null;
  });

  ipcMain.handle(
    IPC.FANOUT_SELECT,
    async (event, req: FanoutSelectRequest): Promise<MergeResult> => {
      const ctx = requireCtx(event);
      return (await getFanoutManager(ctx)).select(req);
    },
  );

  ipcMain.handle(IPC.FANOUT_ABORT, async (event): Promise<Ack> => {
    const ctx = requireCtx(event);
    return (await getFanoutManager(ctx)).abort();
  });

  ipcMain.handle(IPC.SESSION_RECORDS, async (event): Promise<string[]> => {
    const ctx = requireCtx(event);
    return getSessionStore(ctx)
      .all()
      .map((r) => r.worktreePath);
  });

  ipcMain.handle(IPC.SESSION_STOP_ALL_BACKGROUND, async (event): Promise<Ack> => {
    const ctx = requireCtx(event);
    // b-full kill-switch: end EVERY surviving detached agent (no-op under b-lite).
    await getSessionManager(ctx).endAllDetached();
    return { ok: true };
  });

  ipcMain.handle(IPC.SESSION_PERSISTENCE_INFO, async (event): Promise<SessionPersistenceInfo> => {
    const ctx = requireCtx(event);
    return resolveEffectivePersistence(getSettingsStore(ctx).get(), ctx.abducoPath);
  });

  ipcMain.handle(IPC.CROSS_MACHINE_FETCH, async (event): Promise<CrossMachineSessionPointer[]> => {
    const ctx = requireCtx(event);
    // Opt-in gate: no network when off. Best-effort: a sync/network error surfaces as
    // an empty list (the panel shows "no sessions"), never a thrown IPC error.
    if (getSettingsStore(ctx).get().crossMachineSessions !== 'on') return [];
    try {
      return await new SessionRefSync(createRefSyncGit(requireRepoRoot(ctx))).fetchAll();
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    IPC.CROSS_MACHINE_START_HERE,
    async (event, req: { branch: string }): Promise<Worktree> => {
      const ctx = requireCtx(event);
      // Checks out the (existing, remote) branch into a local worktree so the renderer
      // can spawn a FRESH session on it. NOT best-effort — it is an explicit user action,
      // so a failure (unsafe branch name, checkout conflict) surfaces to the UI.
      return (await getWorktreeManager(ctx)).ensureForBranch(req.branch);
    },
  );

  ipcMain.handle(IPC.SETTINGS_GET, async (event): Promise<AppSettings> => {
    const ctx = requireCtx(event);
    return getSettingsStore(ctx).get();
  });

  ipcMain.handle(
    IPC.SETTINGS_SET,
    async (event, partial: Partial<AppSettings>): Promise<AppSettings> => {
      const ctx = requireCtx(event);
      const merged = getSettingsStore(ctx).set(partial);
      ctx.mergeRunner = undefined;
      ctx.diffViewer = undefined;
      if (ctx.fanoutManager && ctx.fanoutManager.get() === null) {
        ctx.fanoutManager = undefined;
      }
      if (!(await ctx.conflictResolver?.inProgress())) {
        ctx.conflictResolver = undefined;
      }
      if ((ctx.sessionManager?.liveWorktreeIds().length ?? 0) === 0) {
        ctx.sessionSettingsDirty = false;
        ctx.sessionManager = undefined;
      } else {
        ctx.sessionSettingsDirty = true;
      }
      if ((ctx.serverManager?.liveServerWorktreeIds().length ?? 0) === 0) {
        ctx.serverSettingsDirty = false;
        ctx.serverManager = undefined;
      } else {
        ctx.serverSettingsDirty = true;
      }
      return merged;
    },
  );

  ipcMain.handle(IPC.REPO_GET, async (event): Promise<string | null> => {
    const ctx = requireCtx(event);
    return ctx.repoRoot ?? null;
  });

  ipcMain.handle(IPC.REPO_PICK, async (event): Promise<RepoPickResult> => {
    const ctx = requireCtx(event);
    const { dialog } = await import('electron');
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a git repository',
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dir = res.filePaths[0];
    if (!existsSync(join(dir, '.git'))) {
      return { ok: false, error: 'not a git repository' };
    }
    // Multi-window: push to recentRepos (most-recent first, deduped) and ask main to
    // open or FOCUS a window for this repo — NEVER app.relaunch() (it would nuke every
    // other window). The same-repo-twice focus-guard lives in openRepo (index.ts).
    const store = getSettingsStore(ctx);
    const prev = store.get().recentRepos ?? [];
    const recentRepos = [dir, ...prev.filter((r) => r !== dir)];
    store.set({ recentRepos });
    ctx.openRepo?.(dir);
    return { ok: true, repoRoot: dir };
  });

  ipcMain.handle(IPC.SCROLLBACK_GET, async (event, worktreeId: string): Promise<string | null> => {
    const ctx = requireCtx(event);
    return getScrollbackStore(ctx).get(worktreeId) ?? null;
  });

  ipcMain.handle(IPC.SCROLLBACK_SET, async (event, req: ScrollbackSetRequest): Promise<Ack> => {
    const ctx = requireCtx(event);
    getScrollbackStore(ctx).set(req.worktreeId, req.data);
    return { ok: true };
  });

  ipcMain.handle(IPC.APP_QUIT_DECISION, async (event, req: { quit: boolean }): Promise<Ack> => {
    const ctx = requireCtx(event);
    if (!req.quit) return { ok: true };
    ctx.confirmedQuit = true;
    ctx.sessionManager?.killAll();
    ctx.serverManager?.dispose();
    ctx.requestQuit?.();
    return { ok: true };
  });
}
