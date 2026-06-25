import * as monaco from 'monaco-editor';
import { navBaseUrl } from '../mango-uri';
import type { TsconfigNav } from './tsconfig-loader';

/**
 * Configures monaco's BUILT-IN TypeScript/JavaScript language service for code navigation.
 * Setting a model's language to 'typescript'/'javascript' auto-registers monaco's own
 * definition/reference providers (no custom providers needed); this just tunes the compiler
 * options + enables eager model sync so the WorktreeModelRegistry's headless models are all
 * visible to the single in-worker TS Program (cross-file nav).
 *
 * Two seams:
 *  - setupTsNav(): process-global, idempotent. Eager sync + diagnostics + DEFAULT compiler
 *    options, so nav works even before a worktree is selected.
 *  - applyTsconfigToNav(): re-applies compiler options on EACH worktree switch, layering the
 *    worktree's tsconfig baseUrl/paths (mapped into mango:// space) on top of the defaults so
 *    path aliases like '@/foo' resolve. The compiler options are process-global, so only the
 *    active worktree's aliases are live at a time — this is called in lockstep with the model
 *    registry create/dispose.
 *
 * monaco 0.55 ships `languages.typescript` at RUNTIME but types it as a deprecated stub
 * (`{ deprecated: true }`) in editor.api.d.ts, so we reach it through a narrow local
 * interface (no `any`) — the runtime members + enum values are all present.
 */

interface TsLanguageDefaults {
  setCompilerOptions(options: Record<string, unknown>): void;
  setEagerModelSync(value: boolean): void;
  setDiagnosticsOptions(options: Record<string, unknown>): void;
}

interface TsNamespace {
  readonly typescriptDefaults: TsLanguageDefaults;
  readonly javascriptDefaults: TsLanguageDefaults;
  readonly ModuleKind: { readonly ESNext: number };
  readonly ModuleResolutionKind: { readonly NodeJs: number };
  readonly ScriptTarget: { readonly ESNext: number };
  readonly JsxEmit: { readonly React: number };
}

function tsNamespace(): TsNamespace {
  return (monaco.languages as unknown as { typescript: TsNamespace }).typescript;
}

/** The shared default compiler options (no tsconfig). setCompilerOptions REPLACES, not merges,
 * so every call must include these — applyTsconfigToNav spreads them under baseUrl/paths. */
function baseCompilerOptions(ts: TsNamespace): Record<string, unknown> {
  return {
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ESNext,
  };
}

let configured = false;

export function setupTsNav(): void {
  if (configured) return;
  configured = true;

  const ts = tsNamespace();
  const options = baseCompilerOptions(ts);
  ts.typescriptDefaults.setCompilerOptions(options);
  ts.javascriptDefaults.setCompilerOptions(options);

  // Sync EVERY 'typescript'/'javascript' model to the worker (not just the focused one),
  // so a definition in an unopened-but-seeded file resolves.
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);

  // We do project-wide nav, not a linter — silence the noisy cross-file diagnostics that
  // appear because node_modules type roots aren't loaded (the editor stays usable).
  const diag = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diag);
  ts.javascriptDefaults.setDiagnosticsOptions(diag);
}

/**
 * Applies a worktree's tsconfig path aliases to the shared TS service. Re-callable on every
 * worktree switch; each call REPLACES the compiler options (defaults + this worktree's
 * baseUrl/paths), which disposes+rebuilds the worker so seeded models re-resolve. An empty
 * nav still sets baseUrl to the worktree's mango root (harmless; relative imports unaffected).
 */
export function applyTsconfigToNav(worktreeId: string, nav: TsconfigNav): void {
  const ts = tsNamespace();
  const options: Record<string, unknown> = {
    ...baseCompilerOptions(ts),
    baseUrl: navBaseUrl(worktreeId, nav.baseDir),
    paths: nav.paths,
  };
  ts.typescriptDefaults.setCompilerOptions(options);
  ts.javascriptDefaults.setCompilerOptions(options);
}
