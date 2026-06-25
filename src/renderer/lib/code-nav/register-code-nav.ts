import * as monaco from 'monaco-editor';
import type { CodeNavLocation } from '../../../shared/types';
import { encodeMango, decodeMango } from '../mango-uri';
import { setupTsNav } from './ts-nav';

/**
 * Process-global, idempotent code-nav bootstrap. monaco providers + the editor-opener are
 * shared across ALL editors/windows, so this runs ONCE and resolves the worktree+relPath
 * from each model's mango URI (never a captured closure).
 *
 *  - TS/JS: setupTsNav() tunes the BUILT-IN service; its providers are auto-registered.
 *  - Java/Kotlin: register Definition/Reference providers that call the codenav IPC. When
 *    the toolchain is absent the IPC returns [] (CodeNavService degrades) and monaco shows
 *    its native 'No definition found' — so unconditional registration == the capability gate.
 *  - Cross-file jump: registerEditorOpener routes a target mango URI through onOpen (App's
 *    dirty-guarded requestOpenFile), with the target line/column for post-load reveal.
 */

export interface CodeNavCallbacks {
  /** Open relPath (within worktreeId) in the editor pane, optionally revealing a position. */
  onOpen(worktreeId: string, relPath: string, position?: { line: number; column: number }): void;
}

let registered = false;

/** 0-based LSP range -> 1-based monaco Location, keyed by the target's mango URI. */
function toMonacoLocation(worktreeId: string, loc: CodeNavLocation): monaco.languages.Location {
  return {
    uri: monaco.Uri.from(encodeMango(worktreeId, loc.relPath)),
    range: new monaco.Range(
      loc.startLine + 1,
      loc.startCharacter + 1,
      loc.endLine + 1,
      loc.endCharacter + 1,
    ),
  };
}

/** The (worktreeId, relPath) a model belongs to, or null for a non-mango model. */
function ctxOf(model: monaco.editor.ITextModel): { worktreeId: string; relPath: string } | null {
  return decodeMango({ scheme: model.uri.scheme, path: model.uri.path });
}

function toPos(
  sel?: monaco.IRange | monaco.IPosition,
): { line: number; column: number } | undefined {
  if (!sel) return undefined;
  if ('startLineNumber' in sel) return { line: sel.startLineNumber, column: sel.startColumn };
  if ('lineNumber' in sel) return { line: sel.lineNumber, column: sel.column };
  return undefined;
}

export function registerCodeNav(cb: CodeNavCallbacks): void {
  if (registered) return;
  registered = true;

  setupTsNav();

  // Cross-file navigation: monaco calls this when a definition/reference target lives in a
  // DIFFERENT model than the active editor. We own the open so it routes through App's
  // dirty-guard + FILE_READ instead of monaco trying to mount the model itself.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const decoded = decodeMango({ scheme: resource.scheme, path: resource.path });
      if (!decoded) return false; // not ours / fail-closed -> let monaco handle (it won't)
      cb.onOpen(decoded.worktreeId, decoded.relPath, toPos(selectionOrPosition));
      return true;
    },
  });

  for (const language of ['java', 'kotlin'] as const) {
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position) {
        const ctx = ctxOf(model);
        if (!ctx) return null;
        const res = await window.mango.codenav.definition({
          worktreeId: ctx.worktreeId,
          relPath: ctx.relPath,
          line: position.lineNumber - 1, // monaco 1-based -> LSP 0-based
          character: position.column - 1,
        });
        return res.locations.map((l) => toMonacoLocation(ctx.worktreeId, l));
      },
    });
    monaco.languages.registerReferenceProvider(language, {
      async provideReferences(model, position, context) {
        const ctx = ctxOf(model);
        if (!ctx) return null;
        const res = await window.mango.codenav.references({
          worktreeId: ctx.worktreeId,
          relPath: ctx.relPath,
          line: position.lineNumber - 1,
          character: position.column - 1,
          includeDeclaration: context.includeDeclaration,
        });
        return res.locations.map((l) => toMonacoLocation(ctx.worktreeId, l));
      },
    });
  }
}
