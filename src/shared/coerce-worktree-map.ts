/**
 * Coerces a persisted `Record<worktreeId, T>` settings map: drops empty keys and any entry that
 * fails `coerceEntry`, and returns undefined when NONE survive (treated as UNSET, the delete-on-
 * invalid rule the other settings keys use). The per-worktree map shell is shared by every such
 * setting (terminalLayouts, openTabs, …); only the per-entry coercer differs — pass it in.
 */
export function coerceWorktreeMap<T>(
  raw: unknown,
  coerceEntry: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = coerceEntry(value);
    if (key !== '' && entry) out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
