import type { UsageLocation } from './find-usages';

/**
 * Pure routing for a resolved find-usages list (kept monaco-free so it unit-tests in jsdom,
 * unlike find-usages.ts which imports monaco). What to do with the results:
 */
export type UsagesAction =
  | { readonly kind: 'jump'; readonly target: UsageLocation }
  | { readonly kind: 'show'; readonly usages: readonly UsageLocation[] };

/**
 * IntelliJ "Show Usages": exactly ONE usage jumps straight there (no popup); 0 or 2+ open the
 * panel (0 gives the "no usages" feedback, 2+ the selectable list).
 */
export function decideUsages(usages: readonly UsageLocation[]): UsagesAction {
  return usages.length === 1 ? { kind: 'jump', target: usages[0] } : { kind: 'show', usages };
}
