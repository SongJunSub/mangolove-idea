import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SYNC_BRANCH, type MachineFile, type RefSyncGitOps } from './session-ref-sync';

/** The remote-tracking ref the sync branch is fetched into (never checked out). */
const TRACKING_REF = `refs/remotes/origin/${SYNC_BRANCH}`;
const REMOTE_REF = `refs/heads/${SYNC_BRANCH}`;

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one git command in `repoRoot`. Never rejects — the caller inspects `code`. */
function runGit(
  repoRoot: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      'git',
      args,
      { cwd: repoRoot, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolvePromise({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/**
 * True iff a push was rejected because the remote branch MOVED (a real, retryable
 * non-fast-forward), as opposed to a hard, non-retryable rejection. git prints the
 * specific reason in parentheses: a true non-ff is `(non-fast-forward)` / `(fetch
 * first)` / `(stale info)`, whereas a hard rejection is `! [remote rejected] ...
 * (pre-receive hook declined)` / `(unpacker error)` / permission denial. We match
 * ONLY the non-ff reasons — never the bare word `rejected`, which both forms share —
 * so a hard rejection falls through to a thrown error instead of futile retries that
 * would swallow the real cause (no push permission / branch protection).
 */
function isNonFastForward(r: GitResult): boolean {
  const s = `${r.stderr}\n${r.stdout}`;
  return /\b(non-fast-forward|fetch first|stale info)\b/i.test(s);
}

/**
 * Real `RefSyncGitOps` for the `mangolove-sessions` orphan branch, bound to `repoRoot`.
 * NEVER checks out the branch or mutates a local branch ref / the working tree: pointer
 * commits are built in a throwaway index and pushed by commit sha directly. The exact
 * command sequence is the one validated by the 2-clone plumbing spike (2026-06-23).
 */
export function createRefSyncGit(repoRoot: string): RefSyncGitOps {
  const git = (args: string[], opts?: { input?: string; env?: NodeJS.ProcessEnv }) =>
    runGit(repoRoot, args, opts);

  /** Fetches the sync branch into the tracking ref; returns its sha or null if absent. */
  async function fetchSyncTip(): Promise<string | null> {
    // A missing branch makes fetch exit non-zero ("couldn't find remote ref") — that is
    // the normal first-run state, so we don't treat it as an error; rev-parse decides.
    await git(['fetch', 'origin', `${REMOTE_REF}:${TRACKING_REF}`]);
    const rev = await git(['rev-parse', '--verify', '-q', `${TRACKING_REF}^{commit}`]);
    const sha = rev.stdout.trim();
    return rev.code === 0 && sha !== '' ? sha : null;
  }

  return {
    fetchSyncTip,

    async remoteBranches(): Promise<string[]> {
      const r = await git(['ls-remote', '--heads', 'origin']);
      if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim()}`);
      const names: string[] = [];
      for (const line of r.stdout.split('\n')) {
        const m = /\srefs\/heads\/(.+)$/.exec(line);
        if (m && m[1] !== SYNC_BRANCH) names.push(m[1]);
      }
      return names;
    },

    async listFiles(): Promise<MachineFile[]> {
      const tip = await fetchSyncTip();
      if (!tip) return []; // branch doesn't exist yet -> no machines have published
      const ls = await git(['ls-tree', '--name-only', tip]);
      if (ls.code !== 0) throw new Error(`git ls-tree failed: ${ls.stderr.trim()}`);
      const files: MachineFile[] = [];
      for (const name of ls.stdout.split('\n')) {
        if (!name.endsWith('.json')) continue;
        const blob = await git(['cat-file', 'blob', `${tip}:${name}`]);
        if (blob.code !== 0) continue; // skip an unreadable entry rather than fail the whole read
        files.push({ machineId: name.slice(0, -'.json'.length), content: blob.stdout });
      }
      return files;
    },

    async buildOwnFileCommit(parentSha, machineId, content): Promise<string> {
      const indexFile = join(tmpdir(), `mango-sync-${randomUUID()}.idx`);
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      try {
        if (parentSha) {
          const rt = await git(['read-tree', `${parentSha}^{tree}`], { env });
          if (rt.code !== 0) throw new Error(`git read-tree failed: ${rt.stderr.trim()}`);
        }
        const hash = await git(['hash-object', '-w', '--stdin'], { input: content });
        if (hash.code !== 0) throw new Error(`git hash-object failed: ${hash.stderr.trim()}`);
        const blob = hash.stdout.trim();
        const ui = await git(
          ['update-index', '--add', '--cacheinfo', '100644', blob, `${machineId}.json`],
          { env },
        );
        if (ui.code !== 0) throw new Error(`git update-index failed: ${ui.stderr.trim()}`);
        const wt = await git(['write-tree'], { env });
        if (wt.code !== 0) throw new Error(`git write-tree failed: ${wt.stderr.trim()}`);
        const tree = wt.stdout.trim();
        const commitArgs = ['commit-tree', tree, '-m', `mangolove session sync (${machineId})`];
        if (parentSha) commitArgs.splice(2, 0, '-p', parentSha);
        const ct = await git(commitArgs);
        if (ct.code !== 0) throw new Error(`git commit-tree failed: ${ct.stderr.trim()}`);
        return ct.stdout.trim();
      } finally {
        await rm(indexFile, { force: true }).catch(() => undefined);
      }
    },

    async pushSyncTip(commitSha): Promise<boolean> {
      // Push the commit OBJECT directly to the remote branch — no local branch ref is
      // created or moved, so nothing in the user's repo view changes.
      const push = await git(['push', 'origin', `${commitSha}:${REMOTE_REF}`]);
      if (push.code === 0) return true;
      if (isNonFastForward(push)) return false; // someone advanced the branch -> orchestrator retries
      throw new Error(`git push (sync) failed: ${push.stderr.trim()}`);
    },
  };
}
