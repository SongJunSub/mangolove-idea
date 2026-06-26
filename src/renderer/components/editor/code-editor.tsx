import './../../monaco-env';
import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { encodeMango } from '../../lib/mango-uri';
import { languageForPath } from '../../lib/language-for-path';
import { collectUsages, type UsageLocation } from '../../lib/code-nav/find-usages';
import { useI18n } from '../../i18n/i18n-context';

export interface CodeEditorProps {
  readonly worktreeId: string;
  readonly relPath: string;
  readonly theme: 'dark' | 'light';
  /** Baseline text to show; null = loading sentinel (a slow load never blanks the editor). */
  readonly content: string | null;
  readonly readOnly: boolean;
  readonly dirty: boolean;
  /** A position to reveal once after the model loads (code-nav jump target), or null. */
  readonly reveal: { line: number; column: number } | null;
  onChange(value: string): void;
  onSaveRequested(): void;
  /** Reports the cursor position (1-based) so App can remember the jump-from spot for Back. */
  onCursor?(line: number, column: number): void;
  /** Find-usages: reports loading then the results so App shows them in the usages panel. */
  onUsages?(usages: UsageLocation[] | null, loading: boolean): void;
}

/**
 * Editable raw-monaco editor for the editor pane. Creates the editor ONCE, swaps the model
 * in place on (worktree,file,content) change, disposes on unmount. NOT keyed by file in App.
 *
 * Phase B: each model carries a worktree-scoped `mango:` URI + its real language (so monaco's
 * built-in TS/JS providers + our Java/Kotlin providers activate). Models seeded by the
 * WorktreeModelRegistry are BORROWED (monaco enforces one model per URI) and never disposed
 * here — only models THIS editor created are owned + disposed. After a nav jump, `reveal`
 * scrolls the target line into view once the content has loaded.
 */
export function CodeEditor({
  worktreeId,
  relPath,
  theme,
  content,
  readOnly,
  dirty,
  reveal,
  onChange,
  onSaveRequested,
  onCursor,
  onUsages,
}: CodeEditorProps): React.JSX.Element {
  const { t } = useI18n();
  // Read t at mount-time inside the create-once effect without making it a dep (which would
  // recreate the whole editor on locale change). The context-menu label is captured on mount.
  const tRef = useRef(t);
  tRef.current = t;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The model THIS editor created (to dispose on swap/unmount). null while borrowing a
  // registry-owned model (those outlive the editor and are disposed by the registry).
  const ownedModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveRequested);
  const onCursorRef = useRef(onCursor);
  const onUsagesRef = useRef(onUsages);
  onChangeRef.current = onChange;
  onSaveRef.current = onSaveRequested;
  onCursorRef.current = onCursor;
  onUsagesRef.current = onUsages;

  // Create once on mount; dispose on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      readOnly: false,
      automaticLayout: true,
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    ownedModelRef.current = editor.getModel(); // the initial empty model is ours to dispose
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    const cursorSub = editor.onDidChangeCursorPosition((e) =>
      onCursorRef.current?.(e.position.lineNumber, e.position.column),
    );
    // addCommand (not a window keydown — monaco swallows keys while focused).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    // Find-usages into the persistent panel (context menu + Cmd/Ctrl+Shift+F12). Distinct from
    // monaco's built-in Shift+F12 inline references peek, which is kept.
    const usagesAction = editor.addAction({
      id: 'mango.findUsagesPanel',
      label: tRef.current('editor.findAllUsages'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.6,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.F12],
      run: async (ed) => {
        const m = ed.getModel();
        const p = ed.getPosition();
        if (!m || !p) return;
        onUsagesRef.current?.(null, true); // loading
        const usages = await collectUsages(m, p);
        onUsagesRef.current?.(usages, false);
      },
    });
    return () => {
      sub.dispose();
      cursorSub.dispose();
      usagesAction.dispose();
      ownedModelRef.current?.dispose(); // dispose ONLY our own model, never a borrowed one
      ownedModelRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
    // Mount-only: theme/readOnly/content are applied by the effects below.
  }, []);

  // Theme is process-global in monaco; set it whenever ours changes.
  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Swap to the (worktree,file) model + reveal a nav target. Borrows a seeded model when one
  // exists for the mango URI; otherwise creates + owns one. Disposes only the prior OWNED model.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || content === null) return; // loading: don't blank the prior file
    const uri = monaco.Uri.from(encodeMango(worktreeId, relPath));
    const current = editor.getModel();
    if (!current || current.uri.toString() !== uri.toString()) {
      let model = monaco.editor.getModel(uri);
      const owns = !model;
      if (!model) {
        model = monaco.editor.createModel(content, languageForPath(relPath), uri);
      } else if (model.getValue() !== content) {
        model.setValue(content); // refresh a borrowed/stale model to the freshly-loaded bytes
      }
      editor.setModel(model);
      if (ownedModelRef.current && ownedModelRef.current !== model) ownedModelRef.current.dispose();
      ownedModelRef.current = owns ? model : null;
    } else if (current.getValue() !== content) {
      current.setValue(content); // same file, content changed (e.g. post-discard re-open)
    }
    if (reveal) {
      const pos = { lineNumber: reveal.line, column: reveal.column };
      editor.revealPositionInCenter(pos);
      editor.setPosition(pos);
      editor.focus();
    }
  }, [worktreeId, relPath, content, reveal]);

  return (
    <div className="code-editor" data-testid="code-editor">
      <div className="code-editor-tab">
        <span className="code-editor-path">{relPath}</span>
        {dirty && (
          <span
            className="code-editor-dot"
            data-testid="editor-dirty-dot"
            title={t('editor.unsavedChanges')}
          />
        )}
      </div>
      <div ref={hostRef} className="code-editor-host" />
    </div>
  );
}
