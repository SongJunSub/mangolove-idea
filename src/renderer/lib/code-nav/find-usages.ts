import * as monaco from 'monaco-editor';
import { decodeMango, encodeMango } from '../mango-uri';
import { TSJS_LANGUAGES } from '../language-for-path';

/**
 * Collects find-usages (find-references) results for a symbol into a flat list the
 * usages panel renders — a persistent alternative to monaco's inline Shift+F12 peek.
 *
 * Mirrors the two nav engines: TS/JS go through monaco's built-in ts.worker
 * (getReferencesAtPosition over the seeded mango:// models); Java/Kotlin go through the
 * codenav IPC (CodeNavService, confined to the worktree, [] when the LSP is absent).
 * Every result's file is decoded back to a worktree-relative relPath via the mango URI,
 * fail-closed — a non-mango target is dropped, never navigated. Results are capped at
 * MAX_USAGES so a heavily-referenced symbol can't pin the UI thread building previews + DOM.
 */
export interface UsageLocation {
  readonly relPath: string;
  readonly line: number; // 1-based (monaco)
  readonly column: number; // 1-based
  /** Trimmed source line for context, or '' when the target model isn't loaded. */
  readonly preview: string;
}

const MAX_USAGES = 1000;

// monaco 0.55 ships getTypeScriptWorker at runtime but types getReferencesAtPosition as
// any[]; reach the members through a narrow local interface (no `any`, per the style guide).
interface ReferenceEntryLike {
  readonly fileName: string;
  readonly textSpan: { readonly start: number; readonly length: number };
  /** TS flags the declaration site; we exclude it so the count is real USAGES (IntelliJ-style). */
  readonly isDefinition?: boolean;
}
interface TsWorkerClient {
  getReferencesAtPosition(
    fileName: string,
    position: number,
  ): Promise<ReferenceEntryLike[] | undefined>;
}
interface TsWorkerHost {
  getTypeScriptWorker(): Promise<(...uris: monaco.Uri[]) => Promise<TsWorkerClient>>;
}

function previewAt(model: monaco.editor.ITextModel | null, line: number): string {
  if (!model) return '';
  try {
    return model.getLineContent(line).trim();
  } catch {
    return '';
  }
}

function buildUsage(
  relPath: string,
  line: number,
  column: number,
  target: monaco.editor.ITextModel | null,
): UsageLocation {
  return { relPath, line, column, preview: previewAt(target, line) };
}

async function collectTsUsages(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): Promise<UsageLocation[]> {
  const host = (monaco.languages as unknown as { typescript: TsWorkerHost }).typescript;
  const getWorker = await host.getTypeScriptWorker();
  const client = await getWorker(model.uri);
  const offset = model.getOffsetAt(position);
  const all = (await client.getReferencesAtPosition(model.uri.toString(), offset)) ?? [];
  const refs = all.filter((r) => !r.isDefinition); // usages only — drop the declaration site
  const out: UsageLocation[] = [];
  for (const ref of refs.slice(0, MAX_USAGES)) {
    const uri = monaco.Uri.parse(ref.fileName);
    const decoded = decodeMango({ scheme: uri.scheme, path: uri.path });
    if (!decoded) continue; // non-mango / fail-closed
    const target = monaco.editor.getModel(uri);
    if (!target) continue; // not seeded -> can't map the offset to a line; skip
    const pos = target.getPositionAt(ref.textSpan.start);
    out.push(buildUsage(decoded.relPath, pos.lineNumber, pos.column, target));
  }
  return out;
}

async function collectLspUsages(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): Promise<UsageLocation[]> {
  const ctx = decodeMango({ scheme: model.uri.scheme, path: model.uri.path });
  if (!ctx) return [];
  const res = await window.mango.codenav.references({
    worktreeId: ctx.worktreeId,
    relPath: ctx.relPath,
    line: position.lineNumber - 1, // monaco 1-based -> LSP 0-based
    character: position.column - 1,
    includeDeclaration: false, // usages only — exclude the declaration (IntelliJ "Find Usages")
  });
  return res.locations.slice(0, MAX_USAGES).map((loc) => {
    const target = monaco.editor.getModel(
      monaco.Uri.from(encodeMango(ctx.worktreeId, loc.relPath)),
    );
    return buildUsage(loc.relPath, loc.startLine + 1, loc.startCharacter + 1, target);
  });
}

/** Find-usages for the symbol at `position` in `model`, or [] for an unsupported language. */
export async function collectUsages(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): Promise<UsageLocation[]> {
  const lang = model.getLanguageId();
  if (TSJS_LANGUAGES.has(lang)) return collectTsUsages(model, position);
  if (lang === 'java' || lang === 'kotlin') return collectLspUsages(model, position);
  return [];
}
