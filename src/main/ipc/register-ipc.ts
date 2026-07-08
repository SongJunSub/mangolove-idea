import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type {
  Ack,
  AppInfo,
  UpdateStatus,
  UpdatePerformRequest,
  UpdateApplyResult,
  UpdateProgress,
  UsageStatus,
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Worktree,
  SpawnSessionRequest,
  SessionInputRequest,
  SessionResizeRequest,
  TermSpawnRequest,
  TermInputRequest,
  TermResizeRequest,
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
  TreeListRequest,
  TreeEntry,
  FileReadRequest,
  FileReadResult,
  FileWriteRequest,
  FileWriteResult,
  CodeNavQuery,
  CodeNavReferencesQuery,
  CodeNavResult,
  CodeNavCapabilities,
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
  RecentRepo,
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
import { coerceProjectGroups, type ProjectGroup } from '../../shared/project-groups';
import { SessionManager, type SessionEmitter } from '../managers/session-manager';
import { ShellManager } from '../managers/shell-manager';
import { ServerManager, type ServerEmitter } from '../managers/server-manager';
import { LogStore, type LogEmitter } from '../managers/log-store';
import { NodeProcessRunner, type IProcLike } from '../proc/process-runner';
import type { IpcContext } from './ipc-context';
import {
  requireCtxFrom,
  aggregateUnsavedCount,
  sweepAll,
  canonicalRepoRoot,
  type CtxEventLike,
} from '../app/window-registry';
import type { SessionStore } from '../managers/session-store';
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';
import {
  existsSync,
  readdirSync,
  realpathSync,
  lstatSync,
  statSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  fstatSync,
  mkdirSync,
  constants as fsConstants,
} from 'node:fs';
import { FileTreeReader } from '../fs/file-tree-reader';
import { FileEditor } from '../fs/file-editor';
import { CodeNavService } from '../codenav/code-nav-service';
import { LspManager } from '../lsp/lsp-manager';
import { checkForUpdate } from '../update/update-checker';
import { UpdaterService } from '../update/updater-service';
import { createRealUpdaterSystem } from '../update/real-updater-system';
import { getUsage, createRealUsageDeps, type UsageDeps } from '../usage/usage-service';
import { execFile } from 'node:child_process';

/** Resolves the installed `claude` version once (for the usage endpoint User-Agent). */
let claudeVersionPromise: Promise<string> | null = null;
function resolveClaudeVersion(): Promise<string> {
  if (!claudeVersionPromise) {
    claudeVersionPromise = new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 5000 }, (_err, stdout) => {
        const m = /(\d+\.\d+\.\d+)/.exec(stdout ?? '');
        resolve(m?.[1] ?? '2.1.0');
      });
    });
  }
  return claudeVersionPromise;
}

/** Lazily builds the usage deps (claude version + real Keychain/HTTPS), cached for the process. */
let usageDepsPromise: Promise<UsageDeps> | null = null;
function getUsageDeps(): Promise<UsageDeps> {
  if (!usageDepsPromise) {
    usageDepsPromise = resolveClaudeVersion().then((v) => createRealUsageDeps(v));
  }
  return usageDepsPromise;
}
import { resolveLspServerPath, unavailableReason, type NavServerLanguage } from '../lsp/lsp-detect';
import { join } from 'node:path';

/**
 * The single github.com-pinned URL guard, shared by APP_OPEN_EXTERNAL (open a link) and
 * UPDATE_PERFORM (download the dmg) — both are SSRF/off-host boundaries, so the allow policy
 * must have ONE source. True iff `raw` is an https URL on github.com (or a subdomain).
 */
function isHttpsGithubUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.github.com'))
    );
  } catch {
    return false;
  }
}

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
 * Module-level cache of read-only WorktreeManagers for repos OTHER than a window's active one
 * (powers the project tree's cross-repo listing). Keyed by canonical repo path; a WorktreeManager
 * is stateless (a SimpleGit bound to a path), so sharing it across windows is safe and avoids a
 * fresh simpleGit init + realpath on every tree expand / re-render.
 */
const worktreeManagersByPath = new Map<string, WorktreeManager>();

/**
 * The canonical repo roots that CURRENTLY exist as git repos, in recentRepos order, deduped. The
 * SINGLE definition of "which recentRepos are live": REPO_LIST maps it to RecentRepo (adding the
 * active flag), WORKTREE_LIST_FOR uses it as the security allowlist, and project groups use it as
 * the pruning oracle — only a repo the user actually opened (and that still has a `.git`) may be
 * listed or grouped. Pure over the passed array so callers read settings once.
 */
function liveCanonicalRepos(recentRepos: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of recentRepos) {
    if (!existsSync(join(raw, '.git'))) continue; // stale: dir gone or no longer a repo
    const path = canonicalRepoRoot(raw);
    if (seen.has(path)) continue; // two raw forms of the same repo collapse to one
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Lists worktrees for a canonical repo path, reusing the window's manager for its active repo
 *  (also honors a test-injected ctx.worktreeManager) and a shared cache for the rest. */
async function listWorktreesForCanonical(ctx: IpcContext, canonical: string): Promise<Worktree[]> {
  if (ctx.repoRoot === canonical) return (await getWorktreeManager(ctx)).list();
  let manager = worktreeManagersByPath.get(canonical);
  if (!manager) {
    const { simpleGit } = await import('simple-git');
    manager = new WorktreeManager(simpleGit(canonical), canonical);
    worktreeManagersByPath.set(canonical, manager);
  }
  return manager.list();
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
 * Resolves the ShellManager: prefer ctx (tests inject a fake); else lazily build one with the
 * node-pty factory and the user's login $SHELL, emitting TERM_OUTPUT/TERM_EXIT to this window.
 * SYNCHRONOUS so TERM_INPUT/TERM_RESIZE on-handlers write/resize synchronously.
 */
function getShellManager(ctx: IpcContext): ShellManager {
  if (ctx.shellManager) return ctx.shellManager;
  const send = (channel: string, payload: unknown): void => {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  ctx.shellManager = new ShellManager({
    factory: new NodePtyFactory(),
    shellPath: process.env.SHELL ?? '/bin/zsh',
    emitOutput: (terminalId, data) => send(IPC.TERM_OUTPUT, { terminalId, data }),
    emitExit: (terminalId, exitCode, signal) =>
      send(IPC.TERM_EXIT, { terminalId, exitCode, signal }),
  });
  return ctx.shellManager;
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

async function getFileTreeReader(ctx: IpcContext): Promise<FileTreeReader> {
  if (ctx.fileTreeReader) return ctx.fileTreeReader;
  const manager = await getWorktreeManager(ctx);
  ctx.fileTreeReader = new FileTreeReader({
    // Trusted worktree ids (= absolute paths) — the reader rejects any other path.
    knownWorktreeIds: async () => new Set((await manager.list()).map((w) => w.id)),
    realpathSync,
    readdirSync: (p) => readdirSync(p, { withFileTypes: true }),
  });
  return ctx.fileTreeReader;
}

/**
 * Resolves the FileEditor (A4) — same trusted worktree set + realpath/lstat seams as the
 * tree reader, plus the WRITE seam writeNoFollow: it opens the FINAL path component with
 * O_NOFOLLOW (so a symlink there throws ELOOP and is never written through) and fstats
 * the fd to reject a non-regular file. This is the load-bearing write security seam.
 */
async function getFileEditor(ctx: IpcContext): Promise<FileEditor> {
  if (ctx.fileEditor) return ctx.fileEditor;
  const manager = await getWorktreeManager(ctx);
  ctx.fileEditor = new FileEditor({
    knownWorktreeIds: async () => new Set((await manager.list()).map((w) => w.id)),
    realpathSync,
    lstatSync, // does NOT follow the final symlink (dangling/looping links route to reject)
    statSync,
    readFileSync,
    writeNoFollow: (parentReal, name, content) => {
      const target = join(parentReal, name);
      const fd = openSync(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        0o644,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
        writeSync(fd, content, null, 'utf8');
      } finally {
        closeSync(fd);
      }
    },
  });
  return ctx.fileEditor;
}

/**
 * Resolves the CodeNavService (Phase B Java/Kotlin nav). Builds an LspManager (stored on
 * ctx.lspManager so window teardown/quit can dispose its child servers) wired to the
 * spawnArgsRpc seam + a per-(worktree,lang) isolated -data dir under userData; the service
 * confines every nav target to the worktree. Server paths are ABSOLUTE-probed (resolveLsp-
 * ServerPath) with optional Settings overrides — never $PATH. Absent toolchain => the
 * service reports unavailable + every query degrades to []. TS/JS never reach this.
 */
async function getCodeNavService(ctx: IpcContext): Promise<CodeNavService> {
  if (ctx.codeNavService) return ctx.codeNavService;
  const manager = await getWorktreeManager(ctx);
  const { app } = await import('electron');
  const userData = app.getPath('userData');
  const resolveServer = (lang: NavServerLanguage): string | null => {
    const settings = getSettingsStore(ctx).get();
    return resolveLspServerPath(lang, {
      exists: existsSync,
      overrides: { java: settings.lspJavaPath, kotlin: settings.lspKotlinPath },
    });
  };
  const runner = new NodeProcessRunner();
  const lspManager = new LspManager({
    spawnRpc: (serverPath, args, cwd) => runner.spawnArgsRpc(serverPath, args, { cwd }),
    resolveServer,
    readFileText: (absPath) => readFileSync(absPath, 'utf8'),
    dataDir: (worktreeId, lang) => {
      const dir = join(userData, 'lsp-data', Buffer.from(worktreeId).toString('base64url'), lang);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    onStatus: (status) => {
      // Push server lifecycle to THIS window so an empty nav is distinguishable from a
      // starting/indexing/failed server (the renderer shows it in the status bar).
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(IPC.CODENAV_STATUS, status);
    },
  });
  ctx.lspManager = lspManager;
  ctx.codeNavService = new CodeNavService({
    knownWorktreeIds: async () => new Set((await manager.list()).map((w) => w.id)),
    realpathSync,
    resolveServer,
    reasonFor: unavailableReason,
    query: (kind, worktreeId, lang, q) => lspManager.query(kind, worktreeId, lang, q),
  });
  return ctx.codeNavService;
}

/**
 * Resolves the UpdaterService (one-click self-update). Wires the REAL macOS system
 * (hdiutil/ditto/xattr/detached-helper) to the tested orchestrator and emits UPDATE_PROGRESS
 * to the invoking window. A self-update restarts the WHOLE process, so the unsaved guard +
 * the teardown are REGISTRY-WIDE (aggregateUnsavedCount / sweepAll over EVERY window) — not
 * just this window — mirroring the QuitController. onQuit sweeps all windows' child processes
 * (no orphan claude/server/LSP) then hard-exits (app.exit bypasses the before-quit guard so
 * the detached swap helper is never deadlocked by an active turn; unsaved work was already
 * blocked by the orchestrator).
 */
async function getUpdaterService(
  ctx: IpcContext,
  contexts: Map<number, IpcContext>,
): Promise<UpdaterService> {
  if (ctx.updaterService) return ctx.updaterService;
  const { app } = await import('electron');
  const emit = (e: UpdateProgress): void => {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(IPC.UPDATE_PROGRESS, e);
  };
  const system = createRealUpdaterSystem({
    userDataDir: app.getPath('userData'),
    exePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    onQuit: () => {
      sweepAll(contexts); // kill EVERY window's PTYs / servers / LSP children (no orphans)
      app.exit(0);
    },
  });
  ctx.updaterService = new UpdaterService(system, emit, () => aggregateUnsavedCount(contexts));
  return ctx.updaterService;
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

  const reader = new GhStatusReader({
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
  // An in-place repo switch (rebindCtxRepo) can rebind ctx DURING the `git remote get-url`
  // await above (a real child process), nulling ghStatusReader meanwhile. Only cache when
  // ctx still points at the repo we built for — otherwise this OLD-repo reader would poison
  // the NEW repo's PR/CI panel until the next switch. A non-cached return still satisfies the
  // in-flight (now-stale) request; the new repo re-enters this getter and rebuilds fresh.
  if (ctx.repoRoot === repoRoot && !ctx.ghStatusReader) ctx.ghStatusReader = reader;
  return ctx.ghStatusReader ?? reader;
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

  ipcMain.handle(IPC.TERM_SPAWN, async (event, req: TermSpawnRequest): Promise<Ack> => {
    const ctx = requireCtx(event);
    return getShellManager(ctx).spawn(req);
  });

  ipcMain.handle(IPC.TERM_KILL, async (event, terminalId: string): Promise<Ack> => {
    const ctx = requireCtx(event);
    return getShellManager(ctx).kill(terminalId);
  });

  ipcMain.on(IPC.TERM_INPUT, (event, req: TermInputRequest) => {
    const ctx = requireCtx(event);
    getShellManager(ctx).input(req);
  });

  ipcMain.on(IPC.TERM_RESIZE, (event, req: TermResizeRequest) => {
    const ctx = requireCtx(event);
    getShellManager(ctx).resize(req);
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

  ipcMain.handle(IPC.TREE_LIST, async (event, req: TreeListRequest): Promise<TreeEntry[]> => {
    const ctx = requireCtx(event);
    try {
      return await (await getFileTreeReader(ctx)).list(req);
    } catch (error) {
      // Normalize so a raw fs path (ENOENT etc.) never reaches the renderer
      // (defense-in-depth; mirrors GH_STATUS). The real cause is logged main-side.
      console.error('TREE_LIST failed:', error);
      throw new Error('failed to read directory');
    }
  });

  ipcMain.handle(IPC.FILE_READ, async (event, req: FileReadRequest): Promise<FileReadResult> => {
    const ctx = requireCtx(event);
    try {
      return await (await getFileEditor(ctx)).read(req);
    } catch (error) {
      // Normalize so a raw fs path never reaches the renderer (mirrors TREE_LIST).
      console.error('FILE_READ failed:', error);
      throw new Error('failed to read file');
    }
  });

  ipcMain.handle(IPC.FILE_WRITE, async (event, req: FileWriteRequest): Promise<FileWriteResult> => {
    const ctx = requireCtx(event);
    try {
      const { baseToken } = await (await getFileEditor(ctx)).write(req);
      return { ok: true, baseToken };
    } catch (error) {
      // The renderer keeps the buffer dirty on a failed write. Surface ONLY our own
      // semantic errors (plain Error, no path) so the user sees actionable messages
      // ('file changed on disk', 'file too large', the scoped-path rejects). A raw fs
      // syscall error (EACCES/EISDIR/ENOSPC...) carries a `code` AND embeds an absolute
      // path — collapse it to a generic message so no fs path reaches the renderer
      // (mirrors FILE_READ/TREE_LIST normalization).
      console.error('FILE_WRITE failed:', error);
      const isSyscall = !!(error as NodeJS.ErrnoException | undefined)?.code;
      const message = error instanceof Error && !isSyscall ? error.message : 'failed to write file';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(
    IPC.CODENAV_CAPABILITIES,
    async (event, req: { worktreeId: string }): Promise<CodeNavCapabilities> => {
      const ctx = requireCtx(event);
      try {
        return await (await getCodeNavService(ctx)).capabilities(req.worktreeId);
      } catch {
        // Never block the editor — report both unavailable so providers stay unregistered.
        const reason = 'code navigation unavailable';
        return { java: { available: false, reason }, kotlin: { available: false, reason } };
      }
    },
  );

  ipcMain.handle(
    IPC.CODENAV_DEFINITION,
    async (event, req: CodeNavQuery): Promise<CodeNavResult> => {
      const ctx = requireCtx(event);
      try {
        return await (await getCodeNavService(ctx)).definition(req);
      } catch (error) {
        console.error('CODENAV_DEFINITION failed:', error);
        return { locations: [] }; // degrade to monaco's 'No definition found'
      }
    },
  );

  ipcMain.handle(
    IPC.CODENAV_REFERENCES,
    async (event, req: CodeNavReferencesQuery): Promise<CodeNavResult> => {
      const ctx = requireCtx(event);
      try {
        return await (await getCodeNavService(ctx)).references(req);
      } catch (error) {
        console.error('CODENAV_REFERENCES failed:', error);
        return { locations: [] };
      }
    },
  );

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
    // Repo-agnostic + github-pinned (shared guard), no ctx.
    if (!isHttpsGithubUrl(req.url)) {
      return { ok: false, error: 'refused: only https github.com URLs may be opened' };
    }
    try {
      const { shell } = await import('electron');
      await shell.openExternal(req.url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.UPDATE_CHECK, async (): Promise<UpdateStatus> => {
    // Repo-agnostic + GitHub-pinned (no ctx, no user input): read-only release check.
    // checkForUpdate NEVER throws — a failed check returns a status with `error` set.
    const { app } = await import('electron');
    return checkForUpdate({ currentVersion: app.getVersion() });
  });

  ipcMain.handle(
    IPC.UPDATE_PERFORM,
    async (event, req: UpdatePerformRequest): Promise<UpdateApplyResult> => {
      const ctx = requireCtx(event);
      // Pin the download to https github.com BEFORE anything runs (shared openExternal guard)
      // so a hostile API response cannot point the downloader off-host.
      if (!isHttpsGithubUrl(req.dmgUrl)) {
        return { status: 'ineligible', reason: 'refused: the download URL is not on github.com' };
      }
      return (await getUpdaterService(ctx, contexts)).perform(req);
    },
  );

  ipcMain.handle(IPC.USAGE_GET, async (): Promise<UsageStatus> => {
    // Read-only Claude subscription usage (no ctx, no token cost). getUsage NEVER throws.
    return getUsage(await getUsageDeps());
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
      // A paneLayout-only change is pure UI geometry — it affects NO repo-scoped manager, so
      // skip the heavyweight cache teardown below (which other keys like baseBranch/agentCommand
      // DO require). Without this, a single pane drag would needlessly drop diffViewer/mergeRunner
      // and dirty the session/server managers. The guard is intentionally narrow (paneLayout ONLY)
      // so every existing settings flow stays byte-identical.
      const keys = Object.keys(partial);
      const uiGeometryOnly =
        keys.length > 0 && keys.every((k) => k === 'paneLayout' || k === 'terminalLayouts');
      if (!uiGeometryOnly) {
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
    // Store the CANONICAL path so recentRepos is keyed consistently with REPO_LIST's
    // canonicalized read (else a symlinked repo's raw + canonical forms both persist).
    const store = getSettingsStore(ctx);
    const root = canonicalRepoRoot(dir);
    const prev = store.get().recentRepos ?? [];
    const recentRepos = [root, ...prev.map(canonicalRepoRoot).filter((r) => r !== root)];
    store.set({ recentRepos });
    ctx.openRepo?.(root);
    return { ok: true, repoRoot: root };
  });

  // The sidebar repo switcher's list: recentRepos filtered to repos that STILL exist
  // (a deleted/moved dir is dropped), canonicalized + deduped (recentRepos holds raw
  // dialog paths), with the active one (= THIS window's canonical repoRoot) flagged.
  ipcMain.handle(IPC.REPO_LIST, async (event): Promise<RecentRepo[]> => {
    const ctx = requireCtx(event);
    const store = getSettingsStore(ctx);
    const active = ctx.repoRoot ?? null; // already canonical (set in createWindow)
    const live = liveCanonicalRepos(store.get().recentRepos ?? []);
    const repos: RecentRepo[] = live.map((path) => ({ path, active: path === active }));
    // Defensive: surface the active repo even if recentRepos somehow lost it.
    if (active && !live.includes(active) && existsSync(join(active, '.git'))) {
      repos.unshift({ path: active, active: true });
    }
    return repos;
  });

  // Switch to a KNOWN recent repo by path (no native dialog): same dedupe-write as
  // REPO_PICK, then openOrFocus its window. The same-repo-twice focus-guard lives in
  // openRepo (index.ts), so clicking a repo already open elsewhere just FOCUSES it.
  ipcMain.handle(IPC.REPO_OPEN, async (event, path: unknown): Promise<RepoPickResult> => {
    const ctx = requireCtx(event);
    if (typeof path !== 'string' || !existsSync(join(path, '.git'))) {
      return { ok: false, error: 'not a git repository' };
    }
    const store = getSettingsStore(ctx);
    const root = canonicalRepoRoot(path); // canonical-key (matches REPO_LIST + REPO_PICK)
    const prev = store.get().recentRepos ?? [];
    const recentRepos = [root, ...prev.map(canonicalRepoRoot).filter((r) => r !== root)];
    store.set({ recentRepos });
    ctx.openRepo?.(root);
    return { ok: true, repoRoot: root };
  });

  // Read-only worktree listing for an ARBITRARY known repo (the project tree's cross-repo
  // expansion). SECURITY: the repoPath is honored ONLY if it canonicalizes into the live
  // recentRepos allowlist AND still has a `.git` — main never runs git in a path the renderer
  // merely asserts. Any rejection or git error resolves to [] (never throws to the renderer).
  ipcMain.handle(IPC.WORKTREE_LIST_FOR, async (event, repoPath: unknown): Promise<Worktree[]> => {
    const ctx = requireCtx(event);
    if (typeof repoPath !== 'string' || repoPath === '') return [];
    const store = getSettingsStore(ctx);
    try {
      const canonical = canonicalRepoRoot(repoPath);
      const live = new Set(liveCanonicalRepos(store.get().recentRepos ?? []));
      if (!live.has(canonical)) return [];
      if (!existsSync(join(canonical, '.git'))) return [];
      return await listWorktreesForCanonical(ctx, canonical);
    } catch {
      return []; // realpath/git failure -> empty (defensive; the allowlist already gated it)
    }
  });

  // Project groups (the tree's grouping layer): a persisted VIEW over recentRepos. GET returns the
  // stored groups pruned to repos still present in the live canonical set (a repo removed/moved
  // since drops out of its group). No write on read — pruning is a pure view transform, so two
  // windows never race on it.
  ipcMain.handle(IPC.GROUPS_GET, async (event): Promise<ProjectGroup[]> => {
    const ctx = requireCtx(event);
    const settings = getSettingsStore(ctx).get(); // read settings ONCE for both the live set + groups
    const live = new Set(liveCanonicalRepos(settings.recentRepos ?? []));
    return (settings.projectGroups ?? []).map((g) => ({
      ...g,
      repoPaths: g.repoPaths.filter((p) => live.has(p)),
    }));
  });

  // Replace the whole group set. Shape-coerce (drops blank id/name, dedups ids, enforces
  // 1-repo-1-group), canonicalize + prune repoPaths to the live set, RE-coerce so the invariant
  // holds on canonical paths, persist, then broadcast GROUPS_CHANGED to every OTHER window so
  // their trees re-fetch. Returns the STORED form for the caller to adopt.
  ipcMain.handle(IPC.GROUPS_SET, async (event, groups: unknown): Promise<ProjectGroup[]> => {
    const ctx = requireCtx(event);
    const store = getSettingsStore(ctx);
    const live = new Set(liveCanonicalRepos(store.get().recentRepos ?? []));
    const normalized = (coerceProjectGroups(groups) ?? []).map((g) => ({
      ...g,
      repoPaths: g.repoPaths.map((p) => canonicalRepoRoot(p)).filter((p) => live.has(p)),
    }));
    const final = coerceProjectGroups(normalized) ?? [];
    store.set({ projectGroups: final });
    const senderId = event.sender.id;
    const { BrowserWindow } = await import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.id !== senderId && !win.isDestroyed()) {
        win.webContents.send(IPC.GROUPS_CHANGED);
      }
    }
    return final;
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
    ctx.lspManager?.dispose();
    ctx.requestQuit?.();
    return { ok: true };
  });

  // Renderer reports this window's unsaved (dirty) editor file count (A4). Fire-and-forget
  // send, like SESSION_INPUT/RESIZE (requireCtx directly — no special teardown handling).
  // Clamped to a non-negative integer so a bad/hostile payload can't make the guard misfire.
  ipcMain.on(IPC.APP_SET_UNSAVED, (event, req: { count: number }) => {
    const ctx = requireCtx(event);
    const n = Number(req?.count);
    ctx.unsavedFileCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  });
}
