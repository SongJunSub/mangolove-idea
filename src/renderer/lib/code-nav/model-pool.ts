/**
 * Pure reconciliation for the editor's monaco model pool (A4 tabs, approach A). The pool keeps one
 * live model per OPEN tab so switching tabs preserves cursor/scroll/undo; a model is evicted only
 * when its tab closes. This computes WHICH pooled models to evict, kept side-effect-free so it can
 * be unit-tested without a real monaco editor (the dispose/setModel glue lives in CodeEditor).
 */

/**
 * URIs of pooled models to evict: every pooled URI that is NEITHER the model currently on screen
 * (never evict what's being shown) NOR still in the open-tab set. The caller disposes the OWNED
 * ones and leaves borrowed (registry-seeded) models to the WorktreeModelRegistry.
 */
export function modelPoolEvictions(
  poolUris: Iterable<string>,
  openUris: ReadonlySet<string>,
  currentUri: string | null,
): string[] {
  const evict: string[] = [];
  for (const uri of poolUris) {
    if (uri !== currentUri && !openUris.has(uri)) evict.push(uri);
  }
  return evict;
}
