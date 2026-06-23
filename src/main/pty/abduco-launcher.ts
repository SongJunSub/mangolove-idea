import type { AgentLauncher, LaunchContext, LaunchSpec } from './agent-launcher';
import { isMangoSession, sessionNameFor } from './abduco-session';

/** One running process as seen by the injected `psList` (pid + full cmdline). */
export interface ProcInfo {
  readonly pid: number;
  readonly cmd: string;
}

/** Injected effects so AbducoLauncher is unit-testable without a real abduco. */
export interface AbducoLauncherDeps {
  /** Absolute path to the abduco binary (bundled — NEVER a PATH lookup). */
  readonly abducoPath: string;
  /** The agent binary abduco wraps (e.g. 'claude'); same token DirectLauncher uses. */
  readonly command: string;
  /** Runs `abduco` with no args and returns its session-table stdout. */
  readonly runList: () => Promise<string>;
  /** Returns the running processes (pid + cmdline) — default `ps -axo pid=,command=`. */
  readonly psList: () => Promise<ProcInfo[]>;
  /**
   * Returns the CURRENT cmdline of one pid (or '' if it is gone) — default
   * `ps -p <pid> -o command=`. Used to RE-VERIFY a kill target immediately before
   * signalling, closing the ps-capture→kill TOCTOU window where the OS could have
   * recycled the pid onto an unrelated process.
   */
  readonly cmdOfPid: (pid: number) => Promise<string>;
  /** Sends a signal to an EXACT pid (default process.kill). */
  readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
}

/** Extracts every `mango-<16hex>` session token from a command line (exact tokens). */
function mangoTokens(cmd: string): string[] {
  return [...cmd.matchAll(/mango-[a-f0-9]{16}/g)].map((m) => m[0]);
}

/**
 * b-full launcher: wraps the agent in an `abduco` detached session so the agent
 * SURVIVES the app quitting/crashing and can be RE-ATTACHED on reopen.
 *
 *   fresh    -> abduco -A <name> <command>              (attach-or-create, fresh agent)
 *   continue -> abduco -A <name> <command> --continue   (create => claude rehydrates JSONL)
 *   attach   -> abduco -a <name>                        (re-attach to the LIVE session)
 *
 * `<name>` is a hashed, namespaced, injection-safe slug of the worktree path
 * (see abduco-session). With `-A`, the trailing command is only used when the
 * session must be CREATED; if it already exists abduco just attaches, so the
 * 3-way decision (taken in SessionManager.spawn) is the single source of truth.
 *
 * Detached-session liveness keys on abduco's OWN listing: a probe confirmed
 * abduco ENDS the session the moment the wrapped program exits, so "listed" is a
 * faithful proxy for "agent still running". endDetached kills the session's
 * master process (a probe confirmed killing the wrapped child alone does NOT tear
 * the session down) — found by an EXACT match on the unique session name in the
 * abduco cmdline, so no broad process-pattern kill is ever issued.
 */
export class AbducoLauncher implements AgentLauncher {
  readonly detachSignal: NodeJS.Signals = 'SIGTERM';
  private readonly deps: AbducoLauncherDeps;

  constructor(deps: AbducoLauncherDeps) {
    this.deps = deps;
  }

  resolveLaunch(ctx: LaunchContext): LaunchSpec {
    const name = sessionNameFor(ctx.worktreeId);
    const { abducoPath, command } = this.deps;
    if (ctx.mode === 'attach') {
      return { file: abducoPath, args: ['-a', name] };
    }
    const tail = ctx.mode === 'continue' ? [command, '--continue'] : [command];
    return { file: abducoPath, args: ['-A', name, ...tail] };
  }

  async isLiveDetached(worktreeId: string): Promise<boolean> {
    const name = sessionNameFor(worktreeId);
    return (await this.listLiveDetached()).includes(name);
  }

  async listLiveDetached(): Promise<string[]> {
    const out = await this.deps.runList();
    // Robust to the table layout: pull every `mango-<16 hex>` token from stdout.
    const names = new Set<string>();
    for (const m of out.matchAll(/mango-[a-f0-9]{16}/g)) {
      if (isMangoSession(m[0])) names.add(m[0]);
    }
    return [...names];
  }

  async endDetached(worktreeId: string): Promise<void> {
    const name = sessionNameFor(worktreeId);
    // EXACT token match (not substring): the cmdline must carry THIS 16-hex session
    // token, so a name can never match another session that merely contains it.
    await this.killMatching((cmd) => mangoTokens(cmd).includes(name));
  }

  async endAllDetached(): Promise<void> {
    // Global kill-switch: end EVERY one of OUR sessions. Scoped to the `mango-`
    // namespace so a user's other abduco sessions are never touched.
    await this.killMatching((cmd) => mangoTokens(cmd).length > 0);
  }

  /**
   * Kills the abduco master (and any client) for the sessions whose cmdline
   * satisfies `match`. Killing the master ends the session and SIGHUPs the wrapped
   * agent. Two safety layers against killing the wrong process:
   *  1. the candidate cmdline must contain `abduco` AND satisfy `match` (an exact
   *     `mango-<hash>` token — never a broad pattern);
   *  2. immediately before signalling, the pid's CURRENT cmdline is re-read and must
   *     STILL be an abduco process carrying a mango token — closing the
   *     ps-capture→kill TOCTOU window where the OS could recycle the pid onto an
   *     unrelated process (the "never kill a process you didn't start" guard).
   */
  private async killMatching(match: (cmd: string) => boolean): Promise<void> {
    const procs = await this.deps.psList();
    for (const p of procs) {
      if (!p.cmd.includes('abduco') || !match(p.cmd)) continue;
      // Re-verify the pid right before killing (recycle guard).
      const current = await this.deps.cmdOfPid(p.pid);
      if (current.includes('abduco') && mangoTokens(current).length > 0) {
        this.deps.killPid(p.pid, this.detachSignal);
      }
    }
  }
}
