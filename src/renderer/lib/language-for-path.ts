/**
 * Maps a file path to a monaco languageId. This is the ONLY thing that activates the
 * right built-in language service per file — TS/JS get monaco's in-worker definition/
 * reference providers automatically once the model language is 'typescript'/'javascript';
 * 'java'/'kotlin' get the external-LSP-backed providers (registered only when available).
 * Everything else falls back to 'plaintext' (the A4 default — no nav, no heavy worker).
 */

/** Extension (lowercase, no dot) -> monaco languageId. */
const BY_EXT: Readonly<Record<string, string>> = {
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
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'plaintext'; // no extension, or a dotfile like '.gitignore'
  const ext = base.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? 'plaintext';
}
