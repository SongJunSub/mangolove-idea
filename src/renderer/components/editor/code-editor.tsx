import './../../monaco-env';
import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { encodeMango } from '../../lib/mango-uri';
import { languageForPath } from '../../lib/language-for-path';
import { collectUsages, type UsageLocation } from '../../lib/code-nav/find-usages';
import { modelPoolEvictions } from '../../lib/code-nav/model-pool';
import { useI18n } from '../../i18n/i18n-context';

export interface CodeEditorProps {
  readonly worktreeId: string;
  readonly relPath: string;
  readonly theme: 'dark' | 'light';
  /** Baseline text to show; null = loading sentinel (a slow load never blanks the editor). */
  readonly content: string | null;
  readonly readOnly: boolean;
  /** The open tab relPaths for this worktree — the pool retains a live model per open tab and
   *  evicts a model only once its tab leaves this list (closed). */
  readonly openPaths: readonly string[];
  /** A position to reveal once after the model loads (code-nav jump target), or null. */
  readonly reveal: { line: number; column: number } | null;
  onChange(value: string): void;
  onSaveRequested(): void;
  /** Editor lost focus — auto-save flushes the buffer (App owns the write). */
  onBlur?(): void;
  /** Reports the cursor position (1-based) so App can remember the jump-from spot for Back. */
  onCursor?(line: number, column: number): void;
  /** Find-usages: reports loading then the results so App shows them in the usages panel. */
  onUsages?(usages: UsageLocation[] | null, loading: boolean): void;
}

/** A pooled model: `owns` when THIS editor created it (dispose on tab close) vs borrowed from the
 *  WorktreeModelRegistry (leave to the registry — disposing it would break cross-file nav). */
interface PoolEntry {
  readonly model: monaco.editor.ITextModel;
  readonly owns: boolean;
}

/**
 * Editable raw-monaco editor for the editor pane. Creates the editor ONCE and swaps its model in
 * place on (worktree,file) change; models for OPEN tabs are kept alive in a pool + their view state
 * saved/restored, so switching tabs preserves cursor, scroll and undo (approach A). A model is
 * disposed only when its tab closes (and only if this editor OWNS it — registry-seeded models are
 * borrowed and left to the registry). After a nav jump, `reveal` positions the cursor.
 */
export function CodeEditor({
  worktreeId,
  relPath,
  theme,
  content,
  readOnly,
  openPaths,
  reveal,
  onChange,
  onSaveRequested,
  onBlur,
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
  // Live model per open tab, keyed by mango URI string — kept alive across tab switches.
  const poolRef = useRef<Map<string, PoolEntry>>(new Map());
  // Per-tab editor view state (cursor, selections, scroll), keyed by the same URI string.
  const viewStateRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map());
  // The throwaway empty model monaco creates at mount — disposed once a real model is shown.
  const scratchRef = useRef<monaco.editor.ITextModel | null>(null);
  // URI awaiting a one-shot "did disk change while this tab was inactive?" reload check, set on a
  // switch to a pre-existing model and consumed on the first content arrival after it. The version
  // id captured when arming lets the reload bail if the user typed into the model before its content
  // load resolved — so a reload never discards keystrokes made in that gap.
  const reloadPendingRef = useRef<string | null>(null);
  const reloadVersionRef = useRef<number>(0);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveRequested);
  const onBlurRef = useRef(onBlur);
  const onCursorRef = useRef(onCursor);
  const onUsagesRef = useRef(onUsages);
  onChangeRef.current = onChange;
  onSaveRef.current = onSaveRequested;
  onBlurRef.current = onBlur;
  onCursorRef.current = onCursor;
  onUsagesRef.current = onUsages;

  // Create once on mount; dispose everything on unmount.
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
      // Jetendard (JetBrains Mono + Pretendard): aligns 한글/영문 monospace; ligatures on (JBM).
      fontFamily: "'Jetendard', ui-monospace, Menlo, monospace",
      fontLigatures: true,
    });
    editorRef.current = editor;
    scratchRef.current = editor.getModel(); // the initial empty model is ours to dispose
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    const cursorSub = editor.onDidChangeCursorPosition((e) =>
      onCursorRef.current?.(e.position.lineNumber, e.position.column),
    );
    // Widget (not text) blur: fires only when focus leaves the WHOLE editor — staying inside
    // (Find box, go-to-line, context menu, suggest widget) does NOT flush a mid-edit write.
    const blurSub = editor.onDidBlurEditorWidget(() => onBlurRef.current?.());
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
      blurSub.dispose();
      usagesAction.dispose();
      editor.setModel(null); // detach before disposing models so none is disposed while on screen
      for (const entry of poolRef.current.values()) if (entry.owns) entry.model.dispose();
      poolRef.current.clear();
      viewStateRef.current.clear();
      scratchRef.current?.dispose();
      scratchRef.current = null;
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

  // Swap to the (worktree,file) model, preserving cursor/scroll/undo. Saves the OUTGOING tab's view
  // state, borrows-or-creates the target model in the pool (never disposing the one we leave), and
  // restores the target tab's view state — unless a nav `reveal` positions the cursor instead.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const uri = monaco.Uri.from(encodeMango(worktreeId, relPath));
    const uriStr = uri.toString();
    const currentModel = editor.getModel();
    if (currentModel && currentModel.uri.toString() === uriStr) {
      // Same tab already on screen: the model IS the buffer (onChange keeps it synced), so never
      // setValue it from `content` — a switch lags `content` by a render and that write would nuke
      // the model's undo/cursor. The one exception is a ONE-SHOT reload right after arriving here:
      // if the file changed on disk while this tab was inactive (an agent edit), refresh it. The
      // incoming tab is always clean (block-on-failure flushed it on leave), so nothing is lost;
      // this fires exactly once (reloadPendingRef cleared), never during editing/saving.
      if (reloadPendingRef.current === uriStr) {
        const armedVersion = reloadVersionRef.current;
        reloadPendingRef.current = null;
        // Reload only if the model is unchanged since we arrived (no keystrokes in the load gap) and
        // disk actually differs — so an external edit refreshes but in-gap typing is never dropped.
        if (
          content !== null &&
          currentModel.getVersionId() === armedVersion &&
          currentModel.getValue() !== content
        ) {
          currentModel.setValue(content);
        }
      }
    } else {
      let entry = poolRef.current.get(uriStr);
      let freshlyCreated = false;
      if (!entry) {
        const borrowed = monaco.editor.getModel(uri); // registry-seeded (headless) model?
        if (borrowed) {
          entry = { model: borrowed, owns: false }; // BORROW — never disposed here
        } else {
          // Creating a model needs THIS file's text. `content` is null until it's loaded for the
          // current relPath (use-file-editor gates the lag), so defer the switch until it arrives.
          if (content === null) return;
          entry = {
            model: monaco.editor.createModel(content, languageForPath(relPath), uri),
            owns: true,
          };
          freshlyCreated = true;
        }
        poolRef.current.set(uriStr, entry);
      }
      // Save the OUTGOING tab's cursor/scroll before swapping so returning to it restores them.
      if (currentModel)
        viewStateRef.current.set(currentModel.uri.toString(), editor.saveViewState());
      editor.setModel(entry.model);
      if (scratchRef.current && scratchRef.current !== entry.model) {
        scratchRef.current.dispose(); // drop the throwaway empty model once a real one is shown
        scratchRef.current = null;
      }
      // A model we didn't just create (a kept-alive pool model, or a registry model seeded before a
      // change) may be stale vs disk — arm a one-shot reload check for when fresh content arrives,
      // capturing the model version so in-gap typing can veto it.
      reloadPendingRef.current = freshlyCreated ? null : uriStr;
      reloadVersionRef.current = entry.model.getVersionId();
      if (!reveal) {
        const vs = viewStateRef.current.get(uriStr);
        if (vs) editor.restoreViewState(vs); // return to this tab's last cursor/scroll
      }
    }
    if (reveal) {
      const pos = { lineNumber: reveal.line, column: reveal.column };
      editor.revealPositionInCenter(pos);
      editor.setPosition(pos);
      editor.focus();
    }
  }, [worktreeId, relPath, content, reveal]);

  // Evict pooled models whose tab has closed (or belongs to a worktree we left). Declared AFTER the
  // swap effect so, when closing the active tab, the swap to a neighbour runs first and the model
  // being evicted is never the one on screen. Only OWNED models are disposed.
  useEffect(() => {
    const editor = editorRef.current;
    const currentUri = editor?.getModel()?.uri.toString() ?? null;
    const openUris = new Set(
      openPaths.map((p) => monaco.Uri.from(encodeMango(worktreeId, p)).toString()),
    );
    for (const uriStr of modelPoolEvictions(poolRef.current.keys(), openUris, currentUri)) {
      const entry = poolRef.current.get(uriStr);
      if (entry?.owns) entry.model.dispose(); // borrowed models: leave to the registry
      poolRef.current.delete(uriStr);
      viewStateRef.current.delete(uriStr);
    }
  }, [worktreeId, openPaths]);

  return (
    <div className="code-editor" data-testid="code-editor">
      <div ref={hostRef} className="code-editor-host" />
    </div>
  );
}
