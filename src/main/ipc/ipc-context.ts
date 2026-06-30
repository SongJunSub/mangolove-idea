import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { SessionManager } from '../managers/session-manager';
import type { ShellManager } from '../managers/shell-manager';
import type { ServerManager } from '../managers/server-manager';
import type { LogStore } from '../managers/log-store';
import type { MergeRunner } from '../git/merge-runner';
import type { SessionStore } from '../managers/session-store';
import type { SettingsStore } from '../managers/settings-store';
import type { ScrollbackStore } from '../managers/scrollback-store';
import type { DiffViewer } from '../git/diff-viewer';
import type { FileTreeReader } from '../fs/file-tree-reader';
import type { FileEditor } from '../fs/file-editor';
import type { CodeNavService } from '../codenav/code-nav-service';
import type { LspManager } from '../lsp/lsp-manager';
import type { UpdaterService } from '../update/updater-service';
import type { ConflictResolver } from '../git/conflict-resolver';
import type { GhStatusReader } from '../git/gh-status-reader';
import type { FanoutManager } from '../git/fanout-manager';
import type { SessionPublisher } from '../sync/session-publisher';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 1 adds the WorktreeManager; Plan 2 adds the SessionManager.
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
  /**
   * Absolute path of the repo MangoLove operates on, or null/undefined when no
   * repo is selected (Finder launch with cwd='/' and no persisted repoRoot). Set by
   * main/index.ts via resolveRepoRoot(). The repoRoot-bound getters assert it via
   * requireRepoRoot (throws a friendly error if absent); the renderer gates the
   * worktree UI behind a non-null repoRoot so the assert is defensive.
   */
  repoRoot?: string | null;
  /** Lazily constructed in register-ipc from repoRoot; injectable in tests. */
  worktreeManager?: WorktreeManager;
  /** Lazily constructed in register-ipc; injectable in tests. */
  sessionManager?: SessionManager;
  /**
   * Lazily constructed in register-ipc — the multi-terminal panel's plain $SHELL PTYs (keyed
   * by terminalId). Owns live OS processes, so it MUST be killed on window teardown / repo
   * rebind / quit (like sessionManager). Ephemeral: not nulled on SETTINGS_SET.
   */
  shellManager?: ShellManager;
  /**
   * Lazily constructed in register-ipc (V2 cross-machine sessions). Publishes this
   * machine's session pointers on lifecycle changes when crossMachineSessions==='on';
   * a no-op when opted out. Injectable in tests.
   */
  sessionPublisher?: SessionPublisher;
  /** Lazily constructed in register-ipc; injectable in tests (Plan 3). */
  serverManager?: ServerManager;
  /** The single LogStore (Map<worktreeId, partition>) backing every worktree's server logs. */
  logStore?: LogStore;
  /** Lazily constructed in register-ipc; injectable in tests (Plan 4). */
  mergeRunner?: MergeRunner;
  /** Lazily constructed in register-ipc; injectable in tests (Plan 5). */
  sessionStore?: SessionStore;
  /** Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 E). */
  settingsStore?: SettingsStore;
  /**
   * Per-worktree serialized-terminal cache for conflict-free scrollback replay.
   * Constructed EAGERLY in index.ts before registerIpc; injectable in tests (V2 scrollback).
   */
  scrollbackStore?: ScrollbackStore;
  /** Set true once the user confirms quit so before-quit stops re-intercepting (Plan 5). */
  confirmedQuit?: boolean;
  /**
   * This window's count of unsaved (dirty) editor files, pushed by the renderer via
   * APP_SET_UNSAVED (A4). Summed across windows for the before-quit dirty-guard. Holds
   * no live process, so it is NOT nulled on SETTINGS_SET.
   */
  unsavedFileCount?: number;
  /**
   * Set true by SETTINGS_SET when the live sessionManager was KEPT (busy) so its
   * cached agentCommand is stale. The manager's onIdle callback consumes this once
   * the last PTY exits, clearing ctx.sessionManager so the next spawn rebuilds with
   * the new settings — delivering live-apply "once the live work ends" (V2 E).
   */
  sessionSettingsDirty?: boolean;
  /** Same as sessionSettingsDirty, for a busy serverManager's stale serverCommand. */
  serverSettingsDirty?: boolean;
  /** Lazily constructed in register-ipc; injectable in tests (V2 A1). */
  diffViewer?: DiffViewer;
  /** Lazily constructed file-tree reader for the worktree file explorer (A3). */
  fileTreeReader?: FileTreeReader;
  /**
   * Lazily constructed file reader/writer for the editor pane (A4). Like fileTreeReader,
   * holds no live OS process and no settings-derived command, so it is NOT nulled on
   * SETTINGS_SET. Scoped to known worktrees via the shared scoped-path gate.
   */
  fileEditor?: FileEditor;
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 PR/CI panel). Holds
   * NO live OS process and NO settings-derived command, so it is NOT nulled on
   * SETTINGS_SET. The RESULT is never cached — only the reader.
   */
  ghStatusReader?: GhStatusReader;
  /**
   * Code navigation (Phase B). The CodeNavService facade confines every LSP nav target
   * to the worktree; the LspManager owns the live jdtls/kotlin-ls children and MUST be
   * disposed on window teardown / quit (mirrors serverManager). Lazily constructed.
   */
  codeNavService?: CodeNavService;
  lspManager?: LspManager;
  /** One-click self-updater (download + verify + bundle swap + restart). Lazily constructed. */
  updaterService?: UpdaterService;
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 merge conflict).
   * STATEFUL only in the sense that it owns the in-progress merge — it is NOT nulled
   * on SETTINGS_SET while inProgress() (it recomputes truth from MERGE_HEAD per call).
   */
  conflictResolver?: ConflictResolver;
  /**
   * Lazily constructed in register-ipc; injectable in tests (V2 multimodel fan-out).
   * Owns the ONE active fan-out run. Cleared on SETTINGS_SET only when IDLE (get()
   * === null) so a base/agentCommand change applies on the next start — never nulled
   * while a run is active (mirrors the conflictResolver keep-while-busy discipline).
   */
  fanoutManager?: FanoutManager;
  /**
   * Absolute path to the abduco binary resolved ONCE at boot (index.ts), or null
   * when unavailable (non-darwin / not installed / not bundled). getSessionManager
   * reads it to build an AbducoLauncher when sessionPersistence==='full'; null =>
   * b-full degrades to b-lite (DirectLauncher). Resolved by ABSOLUTE path only —
   * never a $PATH lookup (the packaged app overwrites PATH from the user shell).
   */
  abducoPath?: string | null;
  /** Injected by index.ts so the quit handler can actually quit (app.quit). */
  requestQuit?: () => void;
  /**
   * Injected by index.ts: open (or focus an existing window for) a repo by path.
   * REPO_PICK delegates here instead of relaunching, so picking a repo opens/focuses
   * a window in this process (multi-window). Optional so windowless tests omit it.
   */
  openRepo?: (repoRoot: string) => void;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
