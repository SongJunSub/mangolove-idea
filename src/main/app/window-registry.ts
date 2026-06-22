import type { IpcContext } from '../ipc/ipc-context';

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

/** killAll() + dispose() EVERY window's managers (no orphan claude/server anywhere). */
export function sweepAll(contexts: Map<number, IpcContext>): void {
  for (const ctx of contexts.values()) {
    ctx.sessionManager?.killAll();
    ctx.serverManager?.dispose();
  }
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
