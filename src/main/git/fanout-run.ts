import type { IProcLike, ProcessRunner } from '../proc/process-runner';

/**
 * Maps a model token (a tier like 'haiku' or a full id like
 * 'claude-opus-4-20250514') to a filesystem/branch-safe slug: every run of
 * characters outside [A-Za-z0-9._-] collapses to one '-', leading/trailing
 * dashes are trimmed. Deterministic (mirrors worktree-manager.sanitizeBranchToDir).
 */
export function slugModel(model: string): string {
  return model
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Rejects a model token claude could misparse as an OPTION (leading '-') or an
 * empty token. No shell injection is possible (spawnArgs uses an arg array) — this
 * only guards claude's own arg parsing for the renderer-supplied model (mirrors
 * DiffViewer.assertSafeRef / GhStatusReader.assertSafeRef).
 */
export function assertSafeModel(model: string): void {
  if (model.length === 0 || model.startsWith('-')) {
    throw new Error(`invalid model token: ${model}`);
  }
}

/**
 * The discrete argv for a headless lane run. The prompt is its OWN argv element —
 * NEVER shell-interpolated — so a prompt containing shell metacharacters is inert.
 * Permission default is acceptEdits (auto file edits; bash/other tools still gated);
 * skipPermissions adds --dangerously-skip-permissions for bash-heavy tasks.
 */
export function buildLaneArgs(prompt: string, model: string, skipPermissions: boolean): string[] {
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--model', model];
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  return args;
}

/** Result of buffering one headless claude -p run to completion. */
export interface LaneRunResult {
  /** Real exit code, or null when the spawn fired an error (e.g. ENOENT) or timed out. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Constructor-free deps for a single lane run (all injectable for tests). */
export interface RunLaneDeps {
  readonly runner: ProcessRunner;
  /** Agent binary (default 'claude' via resolveCommands.agentCommand); swappable in tests. */
  readonly agentCommand: string;
  readonly prompt: string;
  readonly model: string;
  /** Worktree cwd — the lane's isolated checkout. */
  readonly cwd: string;
  readonly skipPermissions: boolean;
  /** Per-lane timeout; kills the child + resolves to an error (default 30 min). */
  readonly timeoutMs?: number;
  /** Called with the spawned child the instant it starts, so the caller can kill() it
   *  on abort (the headless run otherwise self-resolves and ignores its flag). */
  readonly onSpawn?: (proc: IProcLike) => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Spawns `claude -p "<prompt>" --permission-mode acceptEdits --model <model>` in
 * `cwd` via the non-shell argv path, buffers stdout/stderr, and resolves on exit OR
 * on a spawn 'error' (ENOENT etc.) OR on a timeout (kill + resolve). Mirrors
 * gh-status-reader.ts#runToCompletion — claude -p needs no TTY, so a child_process
 * is simpler than node-pty. The auto-accepted file edits leave a real git diff in cwd.
 */
export function runLane(deps: RunLaneDeps): Promise<LaneRunResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<LaneRunResult>((resolve, reject) => {
    // Validate INSIDE the executor so an unsafe model surfaces as a promise
    // REJECTION (matching the Promise<LaneRunResult> contract) rather than a
    // synchronous throw — and no child is spawned (mirrors GhStatusReader.status,
    // where assertSafeRef rejects inside the async boundary before runToCompletion).
    try {
      assertSafeModel(deps.model);
    } catch (e) {
      reject(e);
      return;
    }
    const args = buildLaneArgs(deps.prompt, deps.model, deps.skipPermissions);
    const proc: IProcLike = deps.runner.spawnArgs(deps.agentCommand, args, {
      cwd: deps.cwd,
      env: process.env,
    });
    deps.onSpawn?.(proc);
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: LaneRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      // finish() BEFORE kill(): kill() synchronously emits 'exit' (the fake) — settle
      // the timeout stderr first so it is not lost (mirrors gh-status-reader timing).
      finish({ code: null, stdout: out, stderr: err || 'lane timed out' });
      proc.kill();
    }, timeoutMs);
    proc.onStdout((c) => {
      out += c;
    });
    proc.onStderr((c) => {
      err += c;
    });
    proc.onError((e) => {
      const raw = e instanceof Error ? e.message : String(e);
      finish({ code: null, stdout: out, stderr: err || raw });
    });
    proc.onExit((e) => finish({ code: e.code, stdout: out, stderr: err }));
  });
}
