import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { CreateWorktreeRequest, RemoveWorktreeRequest, Worktree } from '../../shared/types';

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
      ? branchLine
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '')
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

/** True iff the string contains an ASCII control char (git rejects these in refs). */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Rejects a branch name that could be option-injected into `git worktree add` argv,
 * names a special pseudo-ref, or is not a normal branch ref. The branch comes from
 * another machine's published pointer (semi-trusted, attacker-influenceable) and reaches
 * `git worktree add` argv (simple-git uses no shell, so option-confusion is the only
 * injection vector). We therefore enforce the relevant git check-ref-format rules:
 *  - never a leading '-' (git would read it as an option);
 *  - no whitespace, control chars, or git's illegal metas (~ ^ : ? * [ \ ( ));
 *  - no `..` or `@{` sequence, and not the pseudo-refs `@` / `HEAD`;
 *  - no leading/trailing '/' or '.', and no `.lock` suffix;
 *  - must yield a NON-EMPTY worktree dir segment (else the target would collapse onto
 *    the `.worktrees` container — the `@`-sanitizes-to-empty hole).
 * Slashes are allowed (feature/foo). NOT a full git validator — git still rejects the
 * residual illegal refs loudly; this closes the dangerous/ambiguous cases up front.
 */
export function assertSafeBranchName(branch: string): void {
  const ok =
    branch !== '' &&
    !branch.startsWith('-') &&
    !/[\s~^:?*[\\()]/.test(branch) &&
    !hasControlChar(branch) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    branch !== '@' &&
    branch !== 'HEAD' &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.startsWith('.') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock') &&
    sanitizeBranchToDir(branch) !== '';
  if (!ok) throw new Error(`unsafe branch name: ${JSON.stringify(branch)}`);
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
  if (/cannot remove a locked working tree/.test(raw)) {
    return 'worktree is locked; unlock it first';
  }
  if (/already exists/.test(raw)) return 'a worktree already exists at that path';
  return raw.replace(/^fatal:\s*/i, '').trim();
}

/**
 * Real git-worktree CRUD over simple-git. Constructor-injected with a SimpleGit
 * bound to `repoRoot`, so it is unit-testable against a temp repo and never
 * reaches for a global repo path itself.
 */
export class WorktreeManager {
  private readonly git: SimpleGit;
  private readonly repoRoot: string;

  constructor(git: SimpleGit, repoRoot: string) {
    this.git = git;
    // Canonicalize the root: `git worktree list --porcelain` emits realpath'd
    // paths (on macOS /var -> /private/var via symlink), so we must store the
    // canonical root for resolve()'d targets to equal the porcelain output —
    // otherwise create()'s `trees.find(t => t.path === target)` never matches.
    this.repoRoot = realpathSync(repoRoot);
  }

  /** Lists every managed worktree (primary first). */
  async list(): Promise<Worktree[]> {
    const out = await this.git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(out);
  }

  /**
   * Creates a new branch `newBranch` off `baseBranch` and checks it out in a new
   * worktree. Target dir is `req.path` (resolved against repoRoot) or, by default,
   * `<repoRoot>/.worktrees/<sanitized-branch>`. Returns the created Worktree.
   */
  async create(req: CreateWorktreeRequest): Promise<Worktree> {
    const target = req.path
      ? resolve(this.repoRoot, req.path)
      : resolve(this.repoRoot, '.worktrees', sanitizeBranchToDir(req.newBranch));

    // Guard against an explicit req.path escaping the repo root (path traversal).
    // Not reachable from the current UI (the toolbar never sends `path`), but
    // closes the door before any future path input is wired up.
    if (target !== this.repoRoot && !target.startsWith(this.repoRoot + sep)) {
      throw new Error('worktree path must be inside the repository');
    }

    try {
      await this.git.raw(['worktree', 'add', target, '-b', req.newBranch, req.baseBranch]);
    } catch (error) {
      throw new Error(classifyGitError(error));
    }

    const trees = await this.list();
    const created = trees.find((t) => t.path === target);
    if (!created) {
      throw new Error(`worktree created at ${target} but not found in listing`);
    }
    return created;
  }

  /**
   * Ensures a worktree exists for an EXISTING branch (checking it out — NOT creating a
   * new branch) and returns it. Used by cross-machine "start here": the branch already
   * lives on the remote (another machine published a pointer for it). If a worktree for
   * the branch is already checked out, it is returned unchanged. Otherwise the remote is
   * fetched (best-effort, so a remote-only branch resolves) and `git worktree add <dir>
   * <branch>` checks it out — git's DWIM creates a local tracking branch when only
   * `origin/<branch>` exists. The default dir is `<repoRoot>/.worktrees/<sanitized>`.
   */
  async ensureForBranch(branch: string): Promise<Worktree> {
    assertSafeBranchName(branch);
    const existing = (await this.list()).find((t) => t.branch === branch);
    if (existing) return existing;

    const target = resolve(this.repoRoot, '.worktrees', sanitizeBranchToDir(branch));
    // Defense-in-depth (mirrors create()): the computed dir must stay strictly INSIDE
    // the repo and not collapse onto repoRoot/.worktrees itself. assertSafeBranchName
    // already blocks the names that could do this, but this is the same belt-and-suspenders
    // guard create() uses against any future gap in the sanitizer.
    const worktreesDir = resolve(this.repoRoot, '.worktrees');
    if (target === worktreesDir || !target.startsWith(worktreesDir + sep)) {
      throw new Error('worktree path must be inside the repository');
    }
    // Best-effort fetch so a remote-only branch is resolvable; ignore failure (offline).
    try {
      await this.git.fetch();
    } catch {
      // no remote / offline — fall through and let `worktree add` fail loudly if needed
    }
    try {
      await this.git.raw(['worktree', 'add', target, branch]);
    } catch (error) {
      throw new Error(classifyGitError(error));
    }

    const created = (await this.list()).find((t) => t.path === target || t.branch === branch);
    if (!created) {
      throw new Error(`worktree for '${branch}' created at ${target} but not found in listing`);
    }
    return created;
  }

  /** Removes the worktree identified by its path (id), optionally with --force. */
  async remove(req: RemoveWorktreeRequest): Promise<void> {
    const args = ['worktree', 'remove', req.worktreeId];
    if (req.force) args.push('--force');
    try {
      await this.git.raw(args);
    } catch (error) {
      throw new Error(classifyGitError(error));
    }
  }
}
