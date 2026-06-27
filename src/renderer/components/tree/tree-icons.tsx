// Crisp currentColor SVG icons for the file tree (replaces the old 📁/📄 emoji). The
// caller sets `color` (folders inherit --muted; files are tinted by extension via fileAccent).

/** Disclosure chevron; rotates 90° to point down when the folder is open. */
export function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className={`tree-chevron${open ? ' tree-chevron--open' : ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Folder glyph; a distinct open-flap variant when expanded. */
export function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return open ? (
    <svg className="tree-ico-svg" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.7 4.3A1.3 1.3 0 0 1 3 3h2.4l1.5 1.6h6.1A1.3 1.3 0 0 1 14.3 5.9v1H5.3a1.6 1.6 0 0 0-1.53 1.13L1.7 12.4V4.3z"
        fill="currentColor"
        opacity="0.5"
      />
      <path
        d="M4.5 7.4A1.1 1.1 0 0 1 5.55 6.65H14.4a.75.75 0 0 1 .715.97l-1.45 4.7A1.1 1.1 0 0 1 12.6 13H2.3a.62.62 0 0 1-.59-.81L3.6 7.4z"
        fill="currentColor"
      />
    </svg>
  ) : (
    <svg className="tree-ico-svg" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.7 4.3A1.3 1.3 0 0 1 3 3h2.4l1.5 1.6h6.1A1.3 1.3 0 0 1 14.3 5.9v5.8A1.3 1.3 0 0 1 13 13H3a1.3 1.3 0 0 1-1.3-1.3V4.3z"
        fill="currentColor"
      />
    </svg>
  );
}

/** File glyph: a document with a folded corner. */
export function FileIcon(): React.JSX.Element {
  const d = 'M4 2.3h5L12.2 5.5V13a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V3.1a.8.8 0 0 1 .8-.8z';
  return (
    <svg className="tree-ico-svg" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} fill="currentColor" opacity="0.16" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path
        d="M9 2.5V5.5h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Curated, slightly-desaturated file-type colors (fall back to --faint for the unknown). */
const EXT_COLOR: Record<string, string> = {
  ts: '#4a9eea',
  tsx: '#4a9eea',
  mts: '#4a9eea',
  cts: '#4a9eea',
  js: '#e8c14e',
  jsx: '#e8c14e',
  mjs: '#e8c14e',
  cjs: '#e8c14e',
  json: '#cbcb55',
  jsonc: '#cbcb55',
  md: '#7fb0cc',
  mdx: '#7fb0cc',
  css: '#d56fa3',
  scss: '#d56fa3',
  sass: '#d56fa3',
  less: '#d56fa3',
  html: '#e3805a',
  htm: '#e3805a',
  svg: '#c98bd0',
  png: '#c98bd0',
  jpg: '#c98bd0',
  jpeg: '#c98bd0',
  gif: '#c98bd0',
  webp: '#c98bd0',
  ico: '#c98bd0',
  yml: '#d97a6c',
  yaml: '#d97a6c',
  toml: '#9a9ba0',
  ini: '#9a9ba0',
  env: '#d9b24e',
  sh: '#86c06a',
  bash: '#86c06a',
  zsh: '#86c06a',
  py: '#5a9fd4',
  go: '#46c0d8',
  rs: '#d6a07a',
  rb: '#d4604e',
  php: '#8a8fc4',
  java: '#c08a4a',
  kt: '#b388ff',
  kts: '#b388ff',
  swift: '#f0805a',
  c: '#6a9fd4',
  h: '#6a9fd4',
  cpp: '#6a9fd4',
  cc: '#6a9fd4',
  hpp: '#6a9fd4',
  cs: '#6aa84f',
  sql: '#e38c5a',
  vue: '#69c98c',
  svelte: '#e3805a',
  lock: '#9a9ba0',
  gitignore: '#9a9ba0',
  dockerfile: '#7fb0cc',
};

/** The file icon's tint for `name`, by extension (dotfiles use the whole name). */
export function fileAccent(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : lower; // .gitignore => 'gitignore'
  return EXT_COLOR[ext] ?? 'var(--faint)';
}
