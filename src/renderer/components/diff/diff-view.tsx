import './../../monaco-env';
import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { ChangedFile, FileDiff } from '../../../shared/types';
import { useDiff } from '../../hooks/use-diff';

export interface DiffViewProps {
  readonly worktreeId: string;
  /** Base branch to diff against; defaults to 'main' (main-side default). */
  readonly base?: string;
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

/**
 * PR-style diff for a worktree: a changed-file list (click -> loads that file) and
 * a readOnly Monaco DiffEditor (original = merge-base, modified = branch). Monaco +
 * its models are created on mount and disposed on unmount (mirrors AgentTerminal).
 */
export function DiffView({ worktreeId, base }: DiffViewProps): React.JSX.Element {
  const { files, loading, error } = useDiff(worktreeId, base);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Create the diff editor once on mount; dispose on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      theme: 'vs-dark',
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      model?.original.dispose();
      model?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // When a file is selected, fetch its diff and swap the editor's models.
  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    setFileError(null);
    window.mango.diff
      .file({ worktreeId, base, path: selectedPath })
      .then((d: FileDiff) => {
        const editor = editorRef.current;
        if (cancelled || !editor) return;
        const prev = editor.getModel();
        // A1 uses 'plaintext' for every file — this avoids monaco's heavier
        // LANGUAGE workers (ts/json/css/html) per file; the base editor.worker
        // still loads on first render (same-origin, allowed by worker-src 'self').
        // Per-extension syntax highlighting is a future enhancement.
        const lang = 'plaintext';
        const original = monaco.editor.createModel(
          d.binary ? '[binary file — diff not shown]' : d.original,
          lang,
        );
        const modified = monaco.editor.createModel(
          d.binary ? '[binary file — diff not shown]' : d.modified,
          lang,
        );
        editor.setModel({ original, modified });
        prev?.original.dispose();
        prev?.modified.dispose();
      })
      .catch((e: unknown) => {
        if (!cancelled) setFileError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, worktreeId, base]);

  return (
    <div data-testid="diff-view" style={{ display: 'flex', gap: 12, height: 460 }}>
      <ul
        style={{
          width: 240,
          margin: 0,
          padding: 0,
          listStyle: 'none',
          overflowY: 'auto',
          fontSize: 13,
          borderRight: '1px solid #333',
        }}
      >
        {loading && <li style={{ color: '#888' }}>Loading changes…</li>}
        {error && <li style={{ color: 'crimson' }}>error: {error}</li>}
        {!loading && !error && files.length === 0 && (
          <li style={{ color: '#888' }}>No changes vs base.</li>
        )}
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              data-testid="diff-file"
              onClick={() => setSelectedPath(f.path)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '4px 6px',
                background: selectedPath === f.path ? '#094771' : 'transparent',
                color: '#ddd',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'ui-monospace, Menlo, monospace',
              }}
            >
              <span style={{ opacity: 0.7, marginRight: 6 }}>{STATUS_LABEL[f.status]}</span>
              {f.path}
              {f.binary && <span style={{ opacity: 0.5 }}> (binary)</span>}
            </button>
          </li>
        ))}
      </ul>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {fileError && <p style={{ color: 'crimson', fontSize: 13 }}>error: {fileError}</p>}
        {!selectedPath && !fileError && (
          <p style={{ color: '#888', fontSize: 13 }}>Select a file to view its diff.</p>
        )}
        <div ref={hostRef} style={{ width: '100%', height: 460, borderRadius: 4 }} />
      </div>
    </div>
  );
}
