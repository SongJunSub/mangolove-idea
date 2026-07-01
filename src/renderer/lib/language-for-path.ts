/**
 * Maps a file path to a monaco languageId — what drives BOTH syntax highlighting (every language's
 * grammar is registered by the full `import 'monaco-editor'`) and, for the four NAV_LANGUAGES, the
 * code-navigation providers. TS/JS use monaco's in-worker definition/reference providers; Java/Kotlin
 * use the external-LSP-backed providers (registered only when available); every other language gets
 * coloring only. Unknown files fall back to 'plaintext'.
 */

/** Extension (lowercase, no dot) -> monaco languageId. */
const BY_EXT: Readonly<Record<string, string>> = {
  // ── code-navigation languages (drive NAV_LANGUAGES + providers) ──
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  // ── markup / docs / data ──
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  svg: 'xml',
  plist: 'xml',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  graphql: 'graphql',
  gql: 'graphql',
  // ── config ──
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  toml: 'ini',
  properties: 'ini',
  env: 'ini',
  dockerfile: 'dockerfile',
  // ── shells / scripts ──
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  psm1: 'powershell',
  // ── general-purpose languages ──
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  php: 'php',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  cs: 'csharp',
  m: 'objective-c',
  mm: 'objective-c',
  scala: 'scala',
  sc: 'scala',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  pl: 'perl',
  pm: 'perl',
  jl: 'julia',
  fs: 'fsharp',
  fsx: 'fsharp',
  vb: 'vb',
  coffee: 'coffeescript',
  sql: 'sql',
};

/** Whole (lowercased) filename -> languageId, for common extensionless files + dotfiles. */
const BY_NAME: Readonly<Record<string, string>> = {
  // build / project files
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  brewfile: 'ruby',
  vagrantfile: 'ruby',
  // dotfiles (a leading '.' is not an extension, so match by name)
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  '.gitconfig': 'ini',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.zshenv': 'shell',
  '.profile': 'shell',
};

/** Languages that participate in Phase B code navigation. */
export const NAV_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'java',
  'kotlin',
]);

/** The TS/JS languages whose nav is served entirely by monaco's built-in service. */
export const TSJS_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript']);

/** Returns the monaco languageId for a relPath, or 'plaintext' when unknown. */
export function languageForPath(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName; // extensionless files (Dockerfile, Gemfile, .bashrc, …)
  if (/^\.env(\..+)?$/.test(lower)) return 'ini'; // .env, .env.local, .env.production … (not .envrc)
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'plaintext'; // no extension, or a dotfile like '.gitignore'
  const ext = base.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? 'plaintext';
}
