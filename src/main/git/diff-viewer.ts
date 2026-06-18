import type {
  ChangedFile,
  ChangeStatus,
  DiffFileRequest,
  DiffListRequest,
  FileDiff,
} from '../../shared/types';
import type { SimpleGit } from 'simple-git';
import { realpathSync } from 'node:fs';

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

const DEFAULT_BASE = 'main';

/**
 * Read-only PR-style diff for a worktree branch vs its base. Constructor-injected
 * with a SimpleGit bound to repoRoot (mirrors WorktreeManager) so it is unit-testable
 * on a temp repo. NEVER writes. The "original" side comes from the merge-base of
 * (base, branch) so the three-dot PR semantics hold even when base has advanced.
 */
export class DiffViewer {
  private readonly git: SimpleGit;

  constructor(git: SimpleGit, _repoRoot: string) {
    this.git = git;
  }

  /** Resolves worktreeId -> branch (canonicalized id match like SessionManager). */
  private async resolveBranch(worktreeId: string): Promise<string> {
    const out = await this.git.raw(['worktree', 'list', '--porcelain']);
    let canonical: string;
    try {
      canonical = realpathSync(worktreeId);
    } catch {
      canonical = worktreeId; // non-existent path: use as-is (will not match)
    }
    const stanzas = out.split(/\n\s*\n/);
    for (const stanza of stanzas) {
      const lines = stanza.split('\n').map((l) => l.trim());
      const pathLine = lines.find((l) => l.startsWith('worktree '));
      if (!pathLine) continue;
      const p = pathLine.slice('worktree '.length).trim();
      let realP: string;
      try {
        realP = realpathSync(p);
      } catch {
        continue; // stale worktree: directory removed from disk — skip it
      }
      if (realP !== canonical) continue;
      const br = lines.find((l) => l.startsWith('branch '));
      if (!br) throw new Error(`worktree ${worktreeId} has no branch (detached)`);
      return br
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    }
    throw new Error(`unknown worktree ${worktreeId}`);
  }

  /** PR-style changed-file list: branch vs base (default 'main'), with binary flags. */
  async listChangedFiles(req: DiffListRequest): Promise<ChangedFile[]> {
    const base = req.base ?? DEFAULT_BASE;
    const branch = await this.resolveBranch(req.worktreeId);
    const range = `${base}...${branch}`; // three-dot: PR semantics (verified).
    const nameStatus = await this.git.raw(['diff', '--name-status', '-M', range]);
    const numstat = await this.git.raw(['diff', '--numstat', '-M', range]);
    const binary = parseBinaryPaths(numstat);
    return parseNameStatus(nameStatus).map((f) => ({ ...f, binary: binary.has(f.path) }));
  }

  /** Original (merge-base) + modified (branch tip) contents for one changed file. */
  async getFileDiff(req: DiffFileRequest): Promise<FileDiff> {
    const base = req.base ?? DEFAULT_BASE;
    const files = await this.listChangedFiles({ worktreeId: req.worktreeId, base });
    const entry = files.find((f) => f.path === req.path);
    if (!entry) throw new Error(`${req.path} is not a changed file in this diff`);

    if (entry.binary) {
      return { path: entry.path, status: entry.status, original: '', modified: '', binary: true };
    }

    const branch = await this.resolveBranch(req.worktreeId);
    const mergeBase = (await this.git.raw(['merge-base', base, branch])).trim();
    // Original side: the merge-base version of the OLD path (pre-rename for renames).
    const originalPath = entry.oldPath ?? entry.path;
    const original =
      entry.status === 'added' ? '' : await this.showOrEmpty(`${mergeBase}:${originalPath}`);
    const modified =
      entry.status === 'deleted' ? '' : await this.showOrEmpty(`${branch}:${entry.path}`);
    return { path: entry.path, status: entry.status, original, modified, binary: false };
  }

  /** `git show <ref>:<path>`; returns '' when the path is absent at that ref. */
  private async showOrEmpty(spec: string): Promise<string> {
    try {
      return await this.git.show([spec]);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/does not exist|exists on disk, but not in|no such path/i.test(raw)) return '';
      throw error;
    }
  }
}
