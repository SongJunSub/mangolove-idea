import * as monaco from 'monaco-editor';

/**
 * Configures monaco's BUILT-IN TypeScript/JavaScript language service ONCE for code
 * navigation. Setting a model's language to 'typescript'/'javascript' then auto-registers
 * monaco's own definition/reference providers (no custom providers needed) — this just
 * tunes the compiler options + enables eager model sync so the WorktreeModelRegistry's
 * headless models are all visible to the single in-worker TS Program (cross-file nav).
 *
 * monaco 0.55 ships `languages.typescript` at RUNTIME but types it as a deprecated stub
 * (`{ deprecated: true }`) in editor.api.d.ts, so we reach it through a narrow local
 * interface (no `any`) — the runtime members + enum values are all present.
 *
 * v1 scope (per the design): DEFAULT compilerOptions only — the built-in service does NOT
 * read tsconfig.json, so path aliases / monorepo project-references are not resolved.
 * Relative imports + same-package navigation work; alias misses are an accepted v1 gap.
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

let configured = false;

export function setupTsNav(): void {
  if (configured) return;
  configured = true;

  const ts = (monaco.languages as unknown as { typescript: TsNamespace }).typescript;

  const compilerOptions: Record<string, unknown> = {
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ESNext,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);

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
