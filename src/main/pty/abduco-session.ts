import { createHash } from 'node:crypto';

/** Namespaces OUR abduco sessions so reap/list never touch the user's others. */
const SESSION_PREFIX = 'mango-';

/**
 * A stable, collision-resistant, filesystem-safe abduco session name for a
 * worktree: `mango-` + the first 16 hex chars of sha256(worktreePath).
 *
 * SECURITY: the hash output is `[a-f0-9]` only, so the worktree path — which may
 * contain spaces, `..`, `;`, quotes, or other shell/path metacharacters — NEVER
 * reaches abduco's `$HOME/.abduco/<name>` socket path or its argv. This removes
 * the path-escape / argument-injection surface the raw path would create.
 *
 * The name is stable across app runs for the same path (so reopen finds the same
 * detached session) and bounded to 22 chars (well under any socket filename
 * limit). 64 bits of hash make accidental collisions across a user's handful of
 * worktrees negligible.
 */
export function sessionNameFor(worktreePath: string): string {
  const hash = createHash('sha256').update(worktreePath).digest('hex').slice(0, 16);
  return `${SESSION_PREFIX}${hash}`;
}

/** True iff `name` is one of OUR sessions (used to scope reap to mango sessions). */
export function isMangoSession(name: string): boolean {
  return name.startsWith(SESSION_PREFIX);
}
