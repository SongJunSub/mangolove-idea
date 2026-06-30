// Crisp currentColor SVG icons shared across panes (16x16 viewBox, matching tree-icons.tsx).
// Callers size them via CSS (.pane-head-ico svg => 13px, .repo-item-check svg => 14px, etc.).

/** A check mark — the selected-repo affordance. */
export function CheckIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A git-branch glyph (two nodes + a branch) — the worktrees pane head icon. */
export function BranchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.5" cy="3.6" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="3.6" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.5 5.3v5.4M11.5 5.3v1.1a3.2 3.2 0 0 1-3.2 3.2H4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
