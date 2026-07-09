import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { IpcContext } from '../ipc/ipc-context';
import type { QuitWindowInfo } from '../../shared/types';

/**
 * Canonicalizes a repo path (realpath: resolves symlinks like /tmp -> /private/tmp,
 * strips trailing slashes, normalizes case on case-insensitive volumes) so the
 * same-repo focus-guard (findCtxByRepoRoot) dedupes RELIABLY — without this, the same
 * repo reached via two path forms opens two windows that then race the one shared
 * .git/MERGE_HEAD + scrollback/session stores. Mirrors WorktreeManager's realpathSync.
 * A non-existent path falls back to itself (an unopenable repo fails later, loudly).
 */
export function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot;
  }
}

/**
 * Async form of canonicalRepoRoot — for fan-out over a LIST of paths (recentRepos, group repoPaths),
 * so a hung/stale entry (e.g. a dead NFS/automount) yields to the event loop instead of blocking the
 * whole single-threaded main process. Single KNOWN-LIVE path binds (window creation, the path being
 * opened) keep the sync canonicalRepoRoot. Falls back to the input on error, identically to the sync
 * form, so results match one-for-one.
 */
export async function canonicalRepoRootAsync(repoRoot: string): Promise<string> {
  try {
    return await realpath(repoRoot);
  } catch {
    return repoRoot;
  }
}

/** A window rectangle (position + size) — the subset of Electron's Rectangle these helpers need. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pixels a cascaded new window is offset from its anchor along each axis. */
export const CASCADE_STEP = 30;

/**
 * The top-left for a NEW window cascaded off `from`, CLAMPED to `workArea` so repeatedly opening
 * windows never marches them off-screen: each axis offsets by CASCADE_STEP, but if that would push
 * the window's far edge past the work area it wraps back to the work-area origin (a fresh cascade
 * run). `size` is the new window's width/height. Pure — unit-tested without Electron.
 */
export function cascadeWindowPosition(
  from: WindowRect,
  workArea: WindowRect,
  size: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  const axis = (start: number, span: number, waStart: number, waSpan: number): number => {
    const next = start + CASCADE_STEP;
    // Wrap to the work-area origin once the offset window would extend past the work-area end.
    if (next + span > waStart + waSpan) return waStart;
    return Math.max(waStart, next);
  };
  return {
    x: axis(from.x, size.width, workArea.x, workArea.width),
    y: axis(from.y, size.height, workArea.y, workArea.height),
  };
}

/** The minimal event slice requireCtxFrom needs — a sender carrying an id. */
export interface CtxEventLike {
  readonly sender: unknown;
}

/** Extracts the resolving id from an event. Injectable so tests pass a fake event. */
export type IdExtractor = (event: CtxEventLike) => number | undefined;

/** Default extractor: read event.sender.id (the webContents id). */
const defaultExtractId: IdExtractor = (event) => {
  const sender = event.sender as { id?: number } | null;
  return sender?.id;
};

/**
 * Resolves the per-window IpcContext for an IPC event by its sender's webContents
 * id. FAILS LOUD (throws) when the id maps to no registered context — a handler
 * must never silently operate on the wrong/no window. The id extractor is injected
 * so tests resolve a fake event {sender:{id}} without a real BrowserWindow.
 */
export function requireCtxFrom(
  contexts: Map<number, IpcContext>,
  event: CtxEventLike,
  extractId: IdExtractor = defaultExtractId,
): IpcContext {
  const id = extractId(event);
  const ctx = id == null ? undefined : contexts.get(id);
  if (!ctx) throw new Error(`no window context for sender id ${String(id)}`);
  return ctx;
}

/** Union of every window's live PTY worktree ids (orphan reasoning + sweep). */
export function aggregateLiveWorktreeIds(contexts: Map<number, IpcContext>): string[] {
  const out = new Set<string>();
  for (const ctx of contexts.values()) {
    for (const id of ctx.sessionManager?.liveWorktreeIds() ?? []) out.add(id);
  }
  return [...out];
}

/** Union of every window's active-turn worktree ids (the before-quit warning gate). */
export function aggregateActiveTurnWorktreeIds(contexts: Map<number, IpcContext>): string[] {
  const out = new Set<string>();
  for (const ctx of contexts.values()) {
    for (const id of ctx.sessionManager?.activeTurnWorktreeIds() ?? []) out.add(id);
  }
  return [...out];
}

/** Sum of every window's unsaved (dirty) editor file count — the before-quit dirty-guard (A4). */
export function aggregateUnsavedCount(contexts: Map<number, IpcContext>): number {
  let total = 0;
  for (const ctx of contexts.values()) total += ctx.unsavedFileCount ?? 0;
  return total;
}

/**
 * Per-window breakdown of what a quit would lose — ONLY the windows that actually have an active
 * turn or an unsaved file. Powers the quit dialog's multi-window attribution ("<repo>: 2 active").
 * repoName is the repo's basename (null for an empty-gate window). Pure over `contexts`.
 */
export function perWindowQuitInfo(contexts: Map<number, IpcContext>): QuitWindowInfo[] {
  const out: QuitWindowInfo[] = [];
  for (const ctx of contexts.values()) {
    const activeTurnCount = ctx.sessionManager?.activeTurnWorktreeIds().length ?? 0;
    const unsavedFileCount = ctx.unsavedFileCount ?? 0;
    if (activeTurnCount === 0 && unsavedFileCount === 0) continue;
    const repoName = ctx.repoRoot ? (ctx.repoRoot.split('/').filter(Boolean).pop() ?? null) : null;
    out.push({ repoName, activeTurnCount, unsavedFileCount });
  }
  return out;
}

/** killAll() + dispose() EVERY window's managers (no orphan claude/server/shell anywhere). */
export function sweepAll(contexts: Map<number, IpcContext>): void {
  for (const ctx of contexts.values()) {
    ctx.sessionManager?.killAll();
    ctx.serverManager?.dispose();
    ctx.lspManager?.dispose();
    ctx.shellManager?.dispose();
  }
}

/**
 * Sweeps the named window's managers (killAll + dispose — no orphan claude/server)
 * and removes its ctx from the registry. Guarded no-op for an unknown id. The
 * win.on('closed') handler in index.ts delegates here.
 */
export function teardownWindow(contexts: Map<number, IpcContext>, id: number): void {
  const ctx = contexts.get(id);
  if (!ctx) return;
  ctx.sessionManager?.killAll();
  ctx.serverManager?.dispose();
  ctx.lspManager?.dispose();
  ctx.shellManager?.dispose();
  contexts.delete(id);
}

/**
 * Rebinds a window's ctx to a DIFFERENT repo IN PLACE (one window, no new BrowserWindow).
 * Kills every live OS process the old repo's managers own (the teardownWindow kill set +
 * fan-out lanes), then NULLs every repo-scoped manager so register-ipc's lazy getters
 * rebuild them against the new root on the next call. Resets the per-window dirty flags
 * and sets the new (canonical) repoRoot. The caller must webContents.reload() after, so
 * the renderer remounts and re-reads REPO_GET. The 3 shared stores, the window ref, the
 * updater, abducoPath and injected callbacks are NOT repo-scoped and are kept. The ctx
 * stays in `contexts` under the SAME webContents.id (stable across reload).
 */
export function rebindCtxRepo(ctx: IpcContext, newRoot: string): void {
  // 1. Kill live processes (same set teardownWindow uses on close, plus fan-out lanes).
  //    Unlike teardownWindow, the window stays ALIVE here (we reload, not destroy), so use
  //    sessionManager.dispose() — killAll() + sessions.clear() — NOT bare killAll(): clearing
  //    the map makes the old PTYs' async exits register as stale (handleExit's identity guard
  //    drops them) instead of re-emitting a SESSION_EXIT for an old-repo worktree into the
  //    reloaded renderer. Mirrors ServerManager.killAll, which already clears its map.
  //    fanoutManager.abort() is async + fire-and-forget on purpose: rebindCtxRepo MUST stay
  //    synchronous so a window 'closed' event can't interleave mid-rebind (teardownWindow then
  //    no-ops on the already-nulled managers). The abort cleans old-repo .worktrees/branches in
  //    the background; an A->B->A switch-back during that window can briefly contend on A's .git
  //    locks (transient, self-healing, retried by the caller) — accepted to keep teardown sync.
  ctx.sessionManager?.dispose();
  ctx.serverManager?.dispose();
  ctx.lspManager?.dispose();
  ctx.shellManager?.dispose();
  void ctx.fanoutManager?.abort();
  // 2. Null every repo-scoped manager so the lazy getters rebuild against the new root.
  ctx.worktreeManager = undefined;
  ctx.sessionManager = undefined;
  ctx.shellManager = undefined;
  ctx.sessionPublisher = undefined;
  ctx.serverManager = undefined;
  ctx.logStore = undefined; // built with serverManager — null together
  ctx.mergeRunner = undefined;
  ctx.diffViewer = undefined;
  ctx.fileTreeReader = undefined;
  ctx.fileEditor = undefined;
  ctx.ghStatusReader = undefined; // caches owner/repo — must null
  ctx.codeNavService = undefined;
  ctx.lspManager = undefined;
  ctx.conflictResolver = undefined;
  ctx.fanoutManager = undefined;
  // 3. Reset per-window flags (new repo => no unsaved files, no stale-settings markers).
  ctx.unsavedFileCount = 0;
  ctx.sessionSettingsDirty = false;
  ctx.serverSettingsDirty = false;
  // 4. Bind the new repo (canonical, like createWindow).
  ctx.repoRoot = canonicalRepoRoot(newRoot);
}

/** First ctx whose repoRoot equals the given path (same-repo focus-guard), or undefined. */
export function findCtxByRepoRoot(
  contexts: Map<number, IpcContext>,
  repoRoot: string,
): IpcContext | undefined {
  for (const ctx of contexts.values()) {
    if (ctx.repoRoot === repoRoot) return ctx;
  }
  return undefined;
}

/** True for a window whose BrowserWindow is present and not destroyed. */
function isLiveCtx(ctx: IpcContext | undefined): ctx is IpcContext {
  return !!ctx?.mainWindow && !ctx.mainWindow.isDestroyed();
}

/**
 * The canonical repoRoots of all LIVE windows EXCEPT `exceptWcId` — the repos open in OTHER windows.
 * Powers REPO_LIST's `openElsewhere` flag (the project tree's "open in another window" badge).
 * Empty-gate windows (repoRoot null) and destroyed windows contribute nothing.
 */
export function openRepoRootsExcluding(
  contexts: Map<number, IpcContext>,
  exceptWcId: number,
): Set<string> {
  const out = new Set<string>();
  for (const [id, ctx] of contexts) {
    if (id !== exceptWcId && ctx.repoRoot && isLiveCtx(ctx)) out.add(ctx.repoRoot);
  }
  return out;
}

/**
 * The webContents id of a LIVE window owning canonical `root` (optionally excluding one ctx), or
 * undefined. The SINGLE owner-lookup behind the "one repo per window" focus guard — shared by
 * decideRepoSwitch (excludes the requesting window) and decideOpenNewWindow (no exclusion) so the
 * liveness + id-recovery logic exists once. Callers carry only the id into their actions (the apply
 * step re-fetches the ctx from `contexts`, since it may go stale between decide and apply).
 */
function findLiveCtxWcId(
  contexts: Map<number, IpcContext>,
  root: string,
  exclude?: IpcContext,
): number | undefined {
  for (const [id, ctx] of contexts) {
    if (ctx !== exclude && ctx.repoRoot === root && isLiveCtx(ctx)) return id;
  }
  return undefined;
}

/**
 * The action a repo switch resolves to, given the current windows. PURE (no side effects) so the
 * branching — the riskiest part of cross-repo worktree select — is unit-testable; index.ts owns the
 * interpretation (reload/focus/send). `root` must already be canonical.
 *  - `noop`     : already on this repo with no worktree to (re)select, or the source window is gone.
 *  - `reselect` : already on this repo but asked to select a worktree — this window selects it, no reload.
 *  - `focus`    : the repo is open in ANOTHER window (`targetWcId`) — focus it (+ deliver worktreeId).
 *  - `reload`   : rebind THIS window to the repo and reload (+ pend worktreeId for the mount pull).
 */
export type RepoSwitchAction =
  | { readonly kind: 'noop' }
  | { readonly kind: 'reselect'; readonly worktreeId: string }
  | { readonly kind: 'focus'; readonly targetWcId: number; readonly worktreeId?: string }
  | { readonly kind: 'reload'; readonly worktreeId?: string };

/** Decides how a switch of window `wcId` to canonical `root` (optionally selecting `worktreeId`) resolves. */
export function decideRepoSwitch(
  contexts: Map<number, IpcContext>,
  wcId: number,
  root: string,
  worktreeId?: string,
): RepoSwitchAction {
  const current = contexts.get(wcId);
  if (!isLiveCtx(current)) return { kind: 'noop' };
  if (current.repoRoot === root) {
    return worktreeId ? { kind: 'reselect', worktreeId } : { kind: 'noop' };
  }
  const otherWcId = findLiveCtxWcId(contexts, root, current);
  return otherWcId !== undefined
    ? { kind: 'focus', targetWcId: otherWcId, worktreeId }
    : { kind: 'reload', worktreeId };
}

/**
 * The action opening a repo in a NEW window resolves to. PURE; index.ts interprets it. `root` must
 * already be canonical. The "one repo per window" invariant means an already-open repo focuses its
 * existing window instead of duplicating it.
 *  - `focus`  : the repo is already open in a live window (`targetWcId`) — focus it, don't duplicate.
 *  - `create` : no window owns it — create a fresh one.
 */
export type OpenWindowAction =
  | { readonly kind: 'focus'; readonly targetWcId: number }
  | { readonly kind: 'create' };

/** Decides whether opening `root` in a new window focuses an existing window or creates one. */
export function decideOpenNewWindow(
  contexts: Map<number, IpcContext>,
  root: string,
): OpenWindowAction {
  const existingWcId = findLiveCtxWcId(contexts, root);
  return existingWcId !== undefined
    ? { kind: 'focus', targetWcId: existingWcId }
    : { kind: 'create' };
}

/** The side effects applyRepoSwitchAction performs — injected so it is unit-testable sans Electron. */
export interface RepoSwitchEffects {
  /** Rebind a window's ctx to a new repo root (managers torn down + repoRoot set). */
  rebind(ctx: IpcContext, root: string): void;
  /** Reload a window's renderer (it remounts, re-reads REPO_GET, and pulls the pending selection). */
  reload(ctx: IpcContext): void;
  /** Nudge a window to select a worktree (REPO_SELECT_WORKTREE). */
  selectWorktree(ctx: IpcContext, worktreeId: string): void;
  /** Bring a window to the foreground. */
  focus(ctx: IpcContext): void;
}

/**
 * Interprets a RepoSwitchAction into side effects — the counterpart to the pure decideRepoSwitch.
 * Sets `pendingSelectWorktreeId` on the target ctx as the durable, consume-once delivery channel
 * (ALWAYS overwritten on reload so a plain switch can't inherit a stale target). Effects are
 * injected, so the reload / focus / reselect branches are unit-testable without a real BrowserWindow.
 */
export function applyRepoSwitchAction(
  action: RepoSwitchAction,
  wcId: number,
  root: string,
  contexts: Map<number, IpcContext>,
  fx: RepoSwitchEffects,
): void {
  const current = contexts.get(wcId);
  switch (action.kind) {
    case 'noop':
      return;
    case 'reselect':
      // Already on this repo — just tell this window to select the worktree (no reload).
      if (isLiveCtx(current)) fx.selectWorktree(current, action.worktreeId);
      return;
    case 'focus': {
      // Open elsewhere -> focus it. Pend the selection durably (the nudge is lost if the target
      // isn't listening yet) AND nudge so it applies live if it is.
      const other = contexts.get(action.targetWcId);
      if (!isLiveCtx(other)) return;
      other.pendingSelectWorktreeId = action.worktreeId ?? null;
      if (action.worktreeId) fx.selectWorktree(other, action.worktreeId);
      fx.focus(other);
      return;
    }
    case 'reload':
      // Rebind THIS window + reload. ALWAYS set pending (null clears a stale target) so a plain
      // switch never inherits one; it survives the reload — ctx keeps its webContents.id.
      if (!isLiveCtx(current)) return;
      fx.rebind(current, root);
      current.pendingSelectWorktreeId = action.worktreeId ?? null;
      fx.reload(current);
      return;
  }
}

/** The side effects applyOpenWindowAction performs — injected so it is unit-testable sans Electron. */
export interface OpenWindowEffects {
  /** Create a fresh window for the repo (index.ts closes over the canonical root). */
  createWindow(): void;
  /** Bring an existing window to the foreground. */
  focus(ctx: IpcContext): void;
}

/** Interprets an OpenWindowAction into side effects — focus the existing window, or create a new one. */
export function applyOpenWindowAction(
  action: OpenWindowAction,
  contexts: Map<number, IpcContext>,
  fx: OpenWindowEffects,
): void {
  if (action.kind === 'create') {
    fx.createWindow();
    return;
  }
  const target = contexts.get(action.targetWcId);
  if (isLiveCtx(target)) fx.focus(target);
}

/**
 * The first context with NO repoRoot (the empty-gate window showing the picker), or
 * undefined when every window already owns a repo. The launcher attaches a picked
 * repo to this window rather than spawning a second window for it.
 */
export function pickEmptyGateCtx(contexts: Map<number, IpcContext>): IpcContext | undefined {
  for (const ctx of contexts.values()) {
    if (ctx.repoRoot == null) return ctx;
  }
  return undefined;
}
