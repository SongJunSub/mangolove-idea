import * as monaco from 'monaco-editor';
import { encodeMango } from '../mango-uri';
import { languageForPath, TSJS_LANGUAGES } from '../language-for-path';

/**
 * Seeds the selected worktree's first-party TS/JS files as HEADLESS monaco models (not
 * opened in any editor) so monaco's in-worker TS service can resolve go-to-definition /
 * find-references into files the user hasn't opened. Created once per worktree; fully
 * disposed on worktree switch.
 *
 * Bounded by design: only first-party globs (node_modules/dist/build/.git/out/coverage
 * excluded), a file-count cap, and a per-file size cap — eager models live on the main
 * thread AND in the single ts.worker Program, so memory scales with total LOC.
 *
 * Models are keyed by the SAME mango URI the editor uses, so the editor BORROWS a seeded
 * model (monaco enforces one model per URI) rather than duplicating it.
 */

// Caps validated by a sizing spike (2026-06-25): the worst-case 1st-party monorepo on hand
// (CRS — 1554 TS/JS files, 3.7MB) stays UNDER both caps, so every file is seeded; building
// its single ts.worker Program costs ~0.9s and ~276MB worker heap (~180KB/file of AST+symbols).
// MAX_FILES=2000 therefore admits up to ~380MB worker heap — the intended ceiling against a
// runaway monorepo. MAX_SIZE guards generated/bundled files (none tripped it; max observed 49KB).
// A repo that trips MAX_FILES loses cross-file nav for the overflow (warned below); switch to
// lazy-seed-on-first-nav only if such repos appear — lazy trades nav completeness for memory,
// since TS cross-file resolution needs the whole Program.
const MAX_FILES = 2000;
const MAX_SIZE = 512 * 1024;
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.gradle',
  'target',
]);

export class WorktreeModelRegistry {
  private readonly models: monaco.editor.ITextModel[] = [];
  private disposed = false;

  private constructor(private readonly worktreeId: string) {}

  /** Builds + seeds a registry for a worktree. Resolves once the initial seed completes. */
  static async create(worktreeId: string): Promise<WorktreeModelRegistry> {
    const reg = new WorktreeModelRegistry(worktreeId);
    await reg.seed();
    return reg;
  }

  private async seed(): Promise<void> {
    const files = await this.enumerate('');
    let count = 0;
    for (const relPath of files) {
      if (this.disposed) return;
      if (count >= MAX_FILES) {
        console.warn(
          `[code-nav] model seeding capped at ${MAX_FILES} files; some cross-file nav may miss`,
        );
        break;
      }
      const uri = monaco.Uri.from(encodeMango(this.worktreeId, relPath));
      if (monaco.editor.getModel(uri)) continue; // the editor's active file already has a model
      let content: string;
      try {
        const res = await window.mango.file.read({ worktreeId: this.worktreeId, relPath });
        if (res.readOnly || res.size > MAX_SIZE) continue;
        content = res.content;
      } catch {
        continue; // unreadable -> skip, never fail the whole seed
      }
      if (this.disposed) return;
      if (monaco.editor.getModel(uri)) continue; // raced with the editor opening it
      this.models.push(monaco.editor.createModel(content, languageForPath(relPath), uri));
      count++;
    }
  }

  /** Recursively lists first-party TS/JS relPaths under `dir`, pruning excluded dirs. */
  private async enumerate(dir: string): Promise<string[]> {
    if (this.disposed) return [];
    let entries: Awaited<ReturnType<typeof window.mango.tree.list>>;
    try {
      entries = await window.mango.tree.list({ worktreeId: this.worktreeId, relPath: dir });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDir) {
        if (EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        out.push(...(await this.enumerate(rel)));
      } else if (TSJS_LANGUAGES.has(languageForPath(rel))) {
        out.push(rel);
      }
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    for (const m of this.models) m.dispose();
    this.models.length = 0;
  }
}
