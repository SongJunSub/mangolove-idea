/**
 * Persisted form of the terminal TILE layout (A2g), keyed by worktreeId in AppSettings. The
 * RUNTIME tree (tile-math.ts) carries live terminalIds; this strips them to a structural
 * descriptor — leaf KIND (agent | shell+cwd) + split dir/ratio — because the live ids, shell
 * PTYs and scrollback cannot survive a restart. On rehydrate: the agent leaf re-binds the
 * worktree's claude; each shell leaf respawns FRESH in its saved cwd. Shared by the main-process
 * SettingsStore sanitizer (validate on read+write) and the renderer bridge — one source of truth,
 * mirroring the pane-layout / coercePaneLayout boundary-coherence pattern.
 */

import { coerceWorktreeMap } from './coerce-worktree-map';

export type PersistedLeaf =
  | { readonly kind: 'agent' }
  | { readonly kind: 'shell'; readonly cwd: string };
export interface PersistedSplit {
  readonly dir: 'row' | 'col';
  readonly ratio: number;
  readonly a: PersistedNode;
  readonly b: PersistedNode;
}
export type PersistedNode = PersistedLeaf | PersistedSplit;
export interface TerminalLayout {
  readonly root: PersistedNode;
}

/** At most this many leaves; at most ONE agent leaf — mirrors the runtime MAX_TILES + single agent. */
const MAX_LEAVES = 4;

const isSplit = (n: PersistedNode): n is PersistedSplit => 'dir' in n;

function clampRatio(r: number): number {
  return Math.min(0.9, Math.max(0.1, r));
}

/** Recursively validate one node; undefined if malformed (NO partial-collapse — strict + safe). */
function validNode(raw: unknown): PersistedNode | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if ('dir' in o) {
    if (o.dir !== 'row' && o.dir !== 'col') return undefined;
    if (typeof o.ratio !== 'number' || !Number.isFinite(o.ratio)) return undefined;
    const a = validNode(o.a);
    const b = validNode(o.b);
    if (!a || !b) return undefined;
    return { dir: o.dir, ratio: clampRatio(o.ratio), a, b };
  }
  if (o.kind === 'agent') return { kind: 'agent' };
  if (o.kind === 'shell' && typeof o.cwd === 'string' && o.cwd !== '') {
    return { kind: 'shell', cwd: o.cwd };
  }
  return undefined;
}

/** Counts agent leaves + total leaves to enforce the single-agent + <=4 invariants. */
function counts(n: PersistedNode): { agents: number; leaves: number } {
  if (!isSplit(n)) return { agents: n.kind === 'agent' ? 1 : 0, leaves: 1 };
  const a = counts(n.a);
  const b = counts(n.b);
  return { agents: a.agents + b.agents, leaves: a.leaves + b.leaves };
}

/**
 * Projects an unknown (a persisted settings value) to a valid TerminalLayout, or undefined when
 * malformed / over budget — treated as UNSET (default single agent tile), same delete-on-invalid
 * rule as the other settings keys.
 */
export function coerceTerminalLayout(raw: unknown): TerminalLayout | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const root = validNode((raw as Record<string, unknown>).root);
  if (!root) return undefined;
  const { agents, leaves } = counts(root);
  if (agents > 1 || leaves > MAX_LEAVES || leaves < 1) return undefined;
  return { root };
}

/** Per-worktree map; drops any entry that fails to coerce. undefined if NONE survive. */
export function coerceTerminalLayouts(raw: unknown): Record<string, TerminalLayout> | undefined {
  return coerceWorktreeMap(raw, coerceTerminalLayout);
}
