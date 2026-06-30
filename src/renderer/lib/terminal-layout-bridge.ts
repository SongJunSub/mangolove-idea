import { isLeaf, type TileNode } from '../components/layout/tile-math';
import type { PersistedNode, TerminalLayout } from '../../shared/terminal-layout';

/** What a runtime tile leaf actually is (the registry value the renderer keeps per terminalId). */
export interface LeafKind {
  readonly kind: 'agent' | 'shell';
  /** Absolute cwd a shell was spawned in (used to respawn on rehydrate). */
  readonly cwd?: string;
}

/**
 * Projects the RUNTIME tile tree (live terminalIds) to the PERSISTED descriptor — replacing each
 * leaf id with its kind (agent | shell+cwd) so the structure survives a restart without the
 * ephemeral ids/PTYs. An unknown leaf or a shell missing its cwd degrades to an agent leaf
 * (harmless — the coercer would reject a cwd-less shell anyway).
 */
export function toPersisted(
  tree: TileNode,
  kindOf: (id: string) => LeafKind | undefined,
  fallbackCwd: string,
): PersistedNode {
  if (isLeaf(tree)) {
    const k = kindOf(tree.id);
    if (tree.id === 'agent' || k?.kind === 'agent') return { kind: 'agent' };
    // Any non-agent leaf — including an unknown/registry-less one — persists as a SHELL (never a
    // 2nd agent, which the coercer would reject → silently reset the whole layout).
    return { kind: 'shell', cwd: k?.cwd ?? fallbackCwd };
  }
  return {
    dir: tree.dir,
    ratio: tree.ratio ?? 0.5,
    a: toPersisted(tree.a, kindOf, fallbackCwd),
    b: toPersisted(tree.b, kindOf, fallbackCwd),
  };
}

/**
 * Rehydrates a persisted layout to a RUNTIME tree + a registry, minting a fresh id for each shell
 * leaf (the agent leaf is always id 'agent'). The caller respawns a ShellTerminal in each shell
 * entry's cwd. Pure given `mintShellId`.
 */
export function fromPersisted(
  layout: TerminalLayout,
  mintShellId: () => string,
): { tree: TileNode; registry: Map<string, LeafKind> } {
  const registry = new Map<string, LeafKind>();
  const walk = (n: PersistedNode): TileNode => {
    if ('dir' in n) return { dir: n.dir, ratio: n.ratio, a: walk(n.a), b: walk(n.b) };
    if (n.kind === 'agent') {
      registry.set('agent', { kind: 'agent' });
      return { id: 'agent' };
    }
    const id = mintShellId();
    registry.set(id, { kind: 'shell', cwd: n.cwd });
    return { id };
  };
  return { tree: walk(layout.root), registry };
}
