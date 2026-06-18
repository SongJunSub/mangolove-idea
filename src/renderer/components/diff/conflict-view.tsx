import './../../monaco-env';
import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { ConflictFileVersions } from '../../../shared/types';
import { useConflicts } from '../../hooks/use-conflicts';

export interface ConflictViewProps {
  readonly worktreeId: string;
  /** Merge target branch (e.g. 'main'); passed to resolve/continue. */
  readonly targetBranch: string;
  /** Remove worktree + delete branch after a successful continue (mirrors the merge flow). */
  readonly cleanup: boolean;
  /** Called after a successful Continue or Abort so App can clear selection + refresh. */
  onResolved(merged: boolean): void;
}

/**
 * Contextual merge-conflict pane: a changed-file list + a SINGLE editable Monaco
 * editor over the working-tree file WITH git's raw <<<<<<< ======= >>>>>>> markers.
 * Per-file Use ours (target) / Use theirs (feature) / Mark resolved (manual) + global
 * Continue (enabled only when zero conflicts remain) + always-available Abort.
 * monaco 0.55.1 has NO merge editor — this is the supported single-editor approach.
 * Disposes model + editor + content disposable on unmount and on every file switch
 * (mirrors DiffView). Plaintext only, so just editor.worker loads (lazy chunk).
 */
export function ConflictView({
  worktreeId,
  targetBranch,
  cleanup,
  onResolved,
}: ConflictViewProps): React.JSX.Element {
  const { files, loading, error, resolve, continueMerge, abort, refresh } =
    useConflicts(worktreeId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [versions, setVersions] = useState<ConflictFileVersions | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // Create the editable editor once on mount; dispose on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      readOnly: false,
      automaticLayout: true,
      theme: 'vs-dark',
      minimap: { enabled: false },
    });
    editorRef.current = editor;
    return () => {
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Load the selected conflicted file's working-tree marker text into a fresh model.
  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    setFileError(null);
    void (async () => {
      try {
        const v = await window.mango.merge.readConflict({ worktreeId, path: selectedPath });
        if (cancelled) return;
        setVersions(v);
        const editor = editorRef.current;
        if (!editor) return;
        const prev = editor.getModel();
        const model = monaco.editor.createModel(v.working, 'plaintext');
        editor.setModel(model);
        prev?.dispose();
      } catch (e) {
        if (!cancelled) setFileError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPath, worktreeId]);

  const onResolveChoice = async (
    path: string,
    choice: 'ours' | 'theirs' | 'manual' | 'keep' | 'remove',
  ): Promise<void> => {
    setBusy(true);
    setFileError(null);
    try {
      const content =
        choice === 'manual' ? (editorRef.current?.getModel()?.getValue() ?? '') : undefined;
      await resolve(path, choice, targetBranch, content);
      if (path === selectedPath) {
        setSelectedPath(null);
        setVersions(null);
        editorRef.current?.getModel()?.dispose();
        editorRef.current?.setModel(monaco.editor.createModel('', 'plaintext'));
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onContinue = async (): Promise<void> => {
    setBusy(true);
    setFileError(null);
    try {
      const res = await continueMerge(targetBranch, cleanup);
      if (res.status === 'merged') onResolved(true);
      else await refresh();
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAbort = async (): Promise<void> => {
    setBusy(true);
    setFileError(null);
    try {
      await abort();
      onResolved(false);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasConflicts = files.length > 0;

  return (
    <div data-testid="conflict-view" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong style={{ color: '#e0a030', fontSize: 13 }}>
          Merge conflict — {files.length} file(s) to resolve
        </strong>
        <button
          type="button"
          data-testid="conflict-continue"
          disabled={hasConflicts || busy}
          onClick={() => void onContinue()}
          title={hasConflicts ? 'resolve all conflicts first' : 'create the merge commit'}
        >
          Continue merge
        </button>
        <button
          type="button"
          data-testid="conflict-abort"
          disabled={busy}
          onClick={() => void onAbort()}
        >
          Abort merge
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, height: 460 }}>
        <ul
          style={{
            width: 260,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            overflowY: 'auto',
            fontSize: 13,
            borderRight: '1px solid #333',
          }}
        >
          {loading && <li style={{ color: '#888' }}>Loading conflicts…</li>}
          {error && <li style={{ color: 'crimson' }}>error: {error}</li>}
          {!loading && !error && files.length === 0 && (
            <li style={{ color: '#888' }}>No conflicts remaining — Continue merge.</li>
          )}
          {files.map((f) => (
            <li key={f.path} style={{ marginBottom: 6 }}>
              <button
                type="button"
                data-testid="conflict-file"
                onClick={() => setSelectedPath(f.path)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 6px',
                  background: selectedPath === f.path ? '#5a3a14' : 'transparent',
                  color: '#ddd',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'ui-monospace, Menlo, monospace',
                }}
              >
                <span style={{ opacity: 0.7, marginRight: 6 }}>{f.code}</span>
                {f.path}
              </button>
              <div style={{ display: 'flex', gap: 4, padding: '2px 6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  data-testid="conflict-ours"
                  disabled={busy || !f.hasOurs}
                  title={
                    f.hasOurs
                      ? 'use the target (main) version'
                      : 'no target version (missing stage)'
                  }
                  onClick={() => void onResolveChoice(f.path, 'ours')}
                >
                  Use ours (target)
                </button>
                <button
                  type="button"
                  data-testid="conflict-theirs"
                  disabled={busy || !f.hasTheirs}
                  title={
                    f.hasTheirs ? 'use the feature version' : 'no feature version (missing stage)'
                  }
                  onClick={() => void onResolveChoice(f.path, 'theirs')}
                >
                  Use theirs (feature)
                </button>
                <button
                  type="button"
                  data-testid="conflict-manual"
                  disabled={busy || selectedPath !== f.path}
                  title="stage the edited buffer as the resolution"
                  onClick={() => void onResolveChoice(f.path, 'manual')}
                >
                  Mark resolved (manual)
                </button>
                {(!f.hasOurs || !f.hasTheirs) && (
                  <>
                    <button
                      type="button"
                      data-testid="conflict-keep"
                      disabled={busy}
                      title="keep the file (git add)"
                      onClick={() => void onResolveChoice(f.path, 'keep')}
                    >
                      Keep file
                    </button>
                    <button
                      type="button"
                      data-testid="conflict-remove"
                      disabled={busy}
                      title="remove the file (git rm)"
                      onClick={() => void onResolveChoice(f.path, 'remove')}
                    >
                      Remove file
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {fileError && <p style={{ color: 'crimson', fontSize: 13 }}>error: {fileError}</p>}
          {!selectedPath && !fileError && (
            <p style={{ color: '#888', fontSize: 13 }}>
              Select a conflicted file to edit its markers, or use the per-file buttons.
            </p>
          )}
          {versions && !versions.hasOurs !== !versions.hasTheirs && (
            <p style={{ color: '#e0a030', fontSize: 12 }}>
              Missing index stage ({versions.code}) — content ours/theirs unavailable; edit manually
              or keep/remove the file.
            </p>
          )}
          <div ref={hostRef} style={{ width: '100%', height: 420, borderRadius: 4 }} />
        </div>
      </div>
    </div>
  );
}
