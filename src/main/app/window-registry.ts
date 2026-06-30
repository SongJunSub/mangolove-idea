import { realpathSync } from 'node:fs';
import type { IpcContext } from '../ipc/ipc-context';

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
