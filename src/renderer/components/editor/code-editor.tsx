import './../../monaco-env';
import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

export interface CodeEditorProps {
  readonly worktreeId: string;
  readonly relPath: string;
  readonly theme: 'dark' | 'light';
  /** Baseline text to show; null = loading sentinel (a slow load never blanks the editor). */
  readonly content: string | null;
  readonly readOnly: boolean;
  readonly dirty: boolean;
  onChange(value: string): void;
  onSaveRequested(): void;
}

/**
 * Editable raw-monaco editor for the A4 pane. Mirrors conflict-view: create the editor
 * ONCE on mount, swap the model in place on (worktree,file,content) change, dispose on
 * unmount. Intentionally NOT keyed by file in App — keying would remount and lose the
 * create-once editor + focus/scroll.
 *
 * onChange / onSaveRequested are read through refs so the content subscription and the
 * Cmd/Ctrl+S command bind exactly ONCE and never tear down the editor on a prop change.
 */
export function CodeEditor({
  worktreeId,
  relPath,
  theme,
  content,
  readOnly,
  dirty,
  onChange,
  onSaveRequested,
}: CodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveRequested);
  onChangeRef.current = onChange;
  onSaveRef.current = onSaveRequested;

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
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    // addCommand (not a window keydown — monaco swallows keys while focused).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    return () => {
      sub.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Mount-only: theme/readOnly/content are applied by the effects below.
  }, []);

  // Theme is process-global in monaco; set it whenever ours changes (App feeds the same
  // resolvedTheme to DiffView/ConflictView so the three panes never disagree).
  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Swap the model on file/content change. Skip when the model already equals content
  // (e.g. right after a successful save: content := value, so no spurious cursor reset).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || content === null) return; // loading: don't blank the prior file
    if (editor.getModel()?.getValue() === content) return;
    const prev = editor.getModel();
    const model = monaco.editor.createModel(content, 'plaintext');
    editor.setModel(model);
    prev?.dispose();
  }, [worktreeId, relPath, content]);

  return (
    <div className="code-editor" data-testid="code-editor">
      <div className="code-editor-tab">
        <span className="code-editor-path">{relPath}</span>
        {dirty && (
          <span
            className="code-editor-dot"
            data-testid="editor-dirty-dot"
            title="unsaved changes"
          />
        )}
      </div>
      <div ref={hostRef} className="code-editor-host" />
    </div>
  );
}
