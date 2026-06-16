import type { Worktree } from '../../shared/types';

/**
 * Converts a branch name into a filesystem-safe directory segment: every run of
 * characters outside [A-Za-z0-9._-] (notably '/') collapses to one '-', and
 * leading/trailing dashes are trimmed. Deterministic so the same branch always
 * maps to the same default worktree dir.
 */
export function sanitizeBranchToDir(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Parses `git worktree list --porcelain` output into Worktree[]. Stanzas are
 * blank-line separated. The first non-bare stanza is the primary working tree.
 * Bare stanzas (no working tree) are skipped.
 */
export function parseWorktreePorcelain(output: string): Worktree[] {
  const stanzas = output
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const trees: Worktree[] = [];
  let primaryAssigned = false;

  for (const stanza of stanzas) {
    const lines = stanza.split('\n').map((l) => l.trim());
    if (lines.some((l) => l === 'bare')) continue;

    const pathLine = lines.find((l) => l.startsWith('worktree '));
    if (!pathLine) continue;
    const treePath = pathLine.slice('worktree '.length).trim();

    const headLine = lines.find((l) => l.startsWith('HEAD '));
    const head = headLine ? headLine.slice('HEAD '.length).trim().slice(0, 7) : undefined;

    const branchLine = lines.find((l) => l.startsWith('branch '));
    const branch = branchLine
      ? branchLine.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      : '(detached)';

    const isLocked = lines.some((l) => l === 'locked' || l.startsWith('locked '));

    trees.push({
      id: treePath,
      path: treePath,
      branch,
      head,
      isPrimary: !primaryAssigned,
      isLocked,
    });
    primaryAssigned = true;
  }

  return trees;
}

/**
 * Maps a raw git error into a short, user-facing message for the known failure
 * modes of worktree add/remove. Falls back to the trimmed git message.
 */
export function classifyGitError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const branchExists = /a branch named '([^']+)' already exists/.exec(raw);
  if (branchExists) return `branch '${branchExists[1]}' already exists`;
  if (/is a main working tree/.test(raw)) return 'cannot remove the primary working tree';
  if (/is not a working tree/.test(raw)) return 'not a worktree';
  if (/use --force to delete it/.test(raw)) {
    return 'worktree has uncommitted changes; use force to remove';
  }
  return raw.replace(/^fatal:\s*/i, '').trim();
}
