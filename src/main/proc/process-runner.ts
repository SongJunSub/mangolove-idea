import { spawn } from 'node:child_process';

/** Exit payload shared by child_process and the test fake. */
export interface ProcExitEvent {
  readonly code: number | null;
  readonly signal: string | null;
}

/** Options forwarded to the runner (subset we use). */
export interface ProcSpawnOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Minimal child-process surface ServerManager depends on. Callback-shaped on
 * purpose (mirrors IPtyLike): the real adapter wires Node streams down to these
 * callbacks so the SAME ServerManager runs against the real runner and the fake.
 */
export interface IProcLike {
  readonly pid: number | undefined;
  /** Best-effort terminate (SIGTERM by default). */
  kill(signal?: NodeJS.Signals): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (e: ProcExitEvent) => void): void;
}

/** Factory abstraction so ServerManager is unit-testable with a fake runner. */
export interface ProcessRunner {
  /** Spawns `command` as a shell line in opts.cwd with piped stdout/stderr. */
  spawn(command: string, opts: ProcSpawnOptions): IProcLike;
}

/**
 * Production ProcessRunner over node:child_process. shell:true lets us run a
 * command STRING ('./gradlew bootRun', 'npm run dev'); stdout/stderr are piped
 * and adapted to string callbacks. Servers are non-interactive — we capture
 * output, we do NOT allocate a PTY (that is Plan 2's interactive agent).
 */
export class NodeProcessRunner implements ProcessRunner {
  spawn(command: string, opts: ProcSpawnOptions): IProcLike {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    return {
      pid: child.pid,
      kill: (signal) => void child.kill(signal ?? 'SIGTERM'),
      onStdout: (cb) => void child.stdout?.on('data', (c: string) => cb(c)),
      onStderr: (cb) => void child.stderr?.on('data', (c: string) => cb(c)),
      onExit: (cb) => void child.on('exit', (code, signal) => cb({ code, signal })),
    };
  }
}
