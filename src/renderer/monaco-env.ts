// Monaco worker wiring for raw monaco-editor under electron-vite / Vite 7.
// Each '?worker' import is a Vite-bundled worker entry. electron-vite forces the
// renderer base to './', so Vite emits `new Worker(new URL("…worker-*.js",
// import.meta.url))` — a SAME-ORIGIN worker that resolves under file:// and is
// permitted by the renderer CSP (default-src 'self'). NOT @monaco-editor/react,
// whose default loader pulls monaco from a CDN and would violate script-src 'self'.
// Brings monaco's ambient `declare global { var MonacoEnvironment }` into scope —
// this file otherwise imports only ?worker modules, so without it `tsc` errors
// TS2339 on `self.MonacoEnvironment`. Harmless to bundle: monaco-env is imported
// ONLY by the lazy DiffView, so this stays in the lazy chunk.
import 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
