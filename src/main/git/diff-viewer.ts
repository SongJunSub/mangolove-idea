import type { ChangedFile, ChangeStatus } from '../../shared/types';

/** Maps a git name-status letter to our ChangeStatus (copy -> added). */
function statusFromCode(code: string): ChangeStatus | null {
  const c = code[0];
  if (c === 'A') return 'added';
  if (c === 'M' || c === 'T') return 'modified';
  if (c === 'D') return 'deleted';
  if (c === 'R') return 'renamed';
  if (c === 'C') return 'added';
  return null;
}

/**
 * Parses `git diff --name-status -M <base>...<branch>` output. Rename/copy lines
 * are `R<score>\told\tnew`; we report the NEW path (and oldPath for renames).
 * Binary-ness is folded in separately (parseBinaryPaths) — set later by the caller.
 */
export function parseNameStatus(out: string): Omit<ChangedFile, 'binary'>[] {
  const files: Omit<ChangedFile, 'binary'>[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = statusFromCode(parts[0]);
    if (!status) continue;
    if (status === 'renamed') {
      files.push({ path: parts[2], status, oldPath: parts[1] });
    } else if (parts[0][0] === 'C') {
      files.push({ path: parts[2], status }); // copy: destination only
    } else {
      files.push({ path: parts[1], status });
    }
  }
  return files;
}

/**
 * Resolves a numstat path field that may use git's rename notation to the
 * DESTINATION path: "old => new" -> "new", and the brace form
 * "pre/{old => new}/post" -> "pre/new/post". Plain paths pass through.
 */
export function numstatDest(field: string): string {
  if (!field.includes(' => ')) return field;
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
  const arrow = field.split(' => ');
  return arrow[arrow.length - 1];
}

/**
 * Parses `git diff --numstat -M <base>...<branch>` and returns the set of paths
 * git treats as binary (numstat columns are '-' '-'). For a renamed file git puts
 * the rename notation in the single path field, so we resolve to the destination
 * (numstatDest) — matching the NEW path that parseNameStatus reports.
 */
export function parseBinaryPaths(out: string): Set<string> {
  const bin = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts[0] === '-' && parts[1] === '-') {
      bin.add(numstatDest(parts[parts.length - 1]));
    }
  }
  return bin;
}
