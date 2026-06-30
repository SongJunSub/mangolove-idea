import type {
  Ack,
  TermInputRequest,
  TermResizeRequest,
  TermSpawnRequest,
} from '../../shared/types';
import type { IPtyLike, PtyFactory } from '../pty/pty-factory';

/** One live shell PTY. */
interface ShellTerminal {
  readonly pty: IPtyLike;
  exited: boolean;
}

export interface ShellManagerDeps {
  readonly factory: PtyFactory;
  /** Absolute path of the login shell to spawn (e.g. $SHELL or /bin/zsh). */
  readonly shellPath: string;
  /** Args for the shell — a login shell loads the user's profile (PATH, etc.). */
  readonly shellArgs?: readonly string[];
  /** Env for the spawned shell (defaults to the factory's process env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Stream a chunk of PTY output to the renderer (TERM_OUTPUT). */
  emitOutput(terminalId: string, data: string): void;
  /** Notify the renderer a shell exited (TERM_EXIT). */
  emitExit(terminalId: string, exitCode: number, signal?: number): void;
}

/**
 * Owns the window's plain shell PTYs for the multi-terminal panel — one node-pty per
 * `terminalId` running the user's login `$SHELL` in a worktree cwd. Deliberately MINIMAL and
 * ephemeral: NO abduco/b-full persistence, NO cross-machine pointers, NO status bookkeeping —
 * those belong to the agent SessionManager. A shell is created on TERM_SPAWN, streams output,
 * and is dropped when it exits or is killed; nothing survives a window close. The PtyFactory is
 * injected so this is unit-tested against a fake PTY with no native node-pty.
 */
export class ShellManager {
  private readonly terminals = new Map<string, ShellTerminal>();

  constructor(private readonly deps: ShellManagerDeps) {}

  /** Spawns (or respawns) the shell for `terminalId`. Re-spawning kills the prior one first. */
  spawn(req: TermSpawnRequest): Ack {
    const { terminalId, cwd, cols, rows } = req;
    // EAGERLY retire the prior pty BEFORE killing it (mirrors SessionManager): set exited +
    // unmap so its in-flight onData stops emitting and a late onExit is recognized as stale —
    // otherwise, because ShellTerminal reuses the SAME terminalId across a remount, the dying
    // pty's trailing bytes would bleed into the freshly-mounted xterm.
    const existing = this.terminals.get(terminalId);
    if (existing) {
      existing.exited = true;
      this.terminals.delete(terminalId);
      existing.pty.kill();
    }

    let pty: IPtyLike;
    try {
      pty = this.deps.factory.spawn(this.deps.shellPath, this.deps.shellArgs ?? ['-l'], {
        cwd,
        cols: cols > 0 ? cols : 80,
        rows: rows > 0 ? rows : 24,
        env: this.deps.env,
      });
    } catch (err) {
      // Surface the failure IN the terminal instead of leaving a silent, blank, dead tab.
      const error = err instanceof Error ? err.message : String(err);
      this.deps.emitOutput(terminalId, `\r\n\x1b[31m[shell failed to start: ${error}]\x1b[0m\r\n`);
      return { ok: false, error };
    }

    const term: ShellTerminal = { pty, exited: false };
    this.terminals.set(terminalId, term);
    pty.onData((data) => {
      if (!term.exited) this.deps.emitOutput(terminalId, data);
    });
    pty.onExit((e) => {
      // Identity guard: a respawn replaces the map entry; a late exit from the OLD pty must
      // not drop the NEW one or emit a stale exit.
      if (this.terminals.get(terminalId) !== term) return;
      term.exited = true;
      this.terminals.delete(terminalId);
      this.deps.emitExit(terminalId, e.exitCode, e.signal);
    });
    return { ok: true };
  }

  /** Writes raw bytes (xterm onData) into the shell. No-op for an unknown/exited terminal. */
  input(req: TermInputRequest): void {
    const term = this.terminals.get(req.terminalId);
    if (term && !term.exited) term.pty.write(req.data);
  }

  /** Resizes the shell PTY. No-op for an unknown/exited terminal. */
  resize(req: TermResizeRequest): void {
    const term = this.terminals.get(req.terminalId);
    if (term && !term.exited && req.cols > 0 && req.rows > 0) term.pty.resize(req.cols, req.rows);
  }

  /** Kills one shell. Idempotent: eagerly flags+unmaps before kill so a second kill is a no-op
   *  and the dying pty's late output/exit is recognized as stale (no bleed into a reused id). */
  kill(terminalId: string): Ack {
    const term = this.terminals.get(terminalId);
    if (term && !term.exited) {
      term.exited = true;
      this.terminals.delete(terminalId);
      term.pty.kill();
    }
    return { ok: true };
  }

  /** Kills every live shell (window close / repo rebind). */
  killAll(): void {
    for (const term of this.terminals.values()) {
      if (!term.exited) {
        term.exited = true;
        term.pty.kill();
      }
    }
  }

  /** killAll + clear, so late exits from the killed PTYs register as stale and are dropped. */
  dispose(): void {
    this.killAll();
    this.terminals.clear();
  }

  /** Count of live shells (tests / introspection). */
  liveCount(): number {
    let n = 0;
    for (const term of this.terminals.values()) if (!term.exited) n++;
    return n;
  }
}
