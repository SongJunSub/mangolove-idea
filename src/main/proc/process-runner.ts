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
  /** Spawn-level failure (e.g. ENOENT for a missing binary). Fires INSTEAD of onExit. */
  onError(cb: (err: Error) => void): void;
}

/** Factory abstraction so ServerManager is unit-testable with a fake runner. */
export interface ProcessRunner {
  /** Spawns `command` as a shell line in opts.cwd with piped stdout/stderr. */
  spawn(command: string, opts: ProcSpawnOptions): IProcLike;
  /**
   * Spawns an argv array WITHOUT a shell (no shell:true injection surface). Used for
   * structured commands like gh where args (e.g. a branch token) must not be word-split.
   */
  spawnArgs(file: string, args: readonly string[], opts: ProcSpawnOptions): IProcLike;
}

/**
 * A child with a WRITABLE stdin and RAW (Buffer) stdout — for byte-accurate JSON-RPC
 * framing with a language server. Separate from IProcLike so the existing string-based
 * spawn paths (ServerManager) are untouched and their fakes don't need to grow.
 */
export interface IRpcProc {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  /** Write a framed JSON-RPC chunk to the child's stdin. */
  write(data: Buffer): void;
  /** RAW stdout bytes (NO utf-8 decode — Content-Length counts bytes). */
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (e: ProcExitEvent) => void): void;
  onError(cb: (err: Error) => void): void;
}

/** Runner that can spawn an interactive (stdin-writable, raw-stdout) child for LSP. */
export interface RpcProcessRunner {
  /**
   * Spawns an argv WITHOUT a shell, with stdin:'pipe' and RAW (Buffer) stdout, so the
   * caller can write JSON-RPC and frame responses by byte length. NodeProcessRunner
   * implements this; LspManager depends on it.
   */
  spawnArgsRpc(file: string, args: readonly string[], opts: ProcSpawnOptions): IRpcProc;
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
      onError: (cb) => void child.on('error', (e: Error) => cb(e)),
    };
  }

  spawnArgs(file: string, args: readonly string[], opts: ProcSpawnOptions): IProcLike {
    const child = spawn(file, [...args], {
      shell: false,
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
      onError: (cb) => void child.on('error', (e: Error) => cb(e)),
    };
  }

  spawnArgsRpc(file: string, args: readonly string[], opts: ProcSpawnOptions): IRpcProc {
    const child = spawn(file, [...args], {
      shell: false, // no word-split / injection; file is an ABSOLUTE resolveLspServerPath
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'], // stdin writable; stdout RAW (no setEncoding)
    });
    child.stderr?.setEncoding('utf8');
    return {
      pid: child.pid,
      kill: (signal) => void child.kill(signal ?? 'SIGTERM'),
      write: (data) => void child.stdin?.write(data),
      onStdout: (cb) => void child.stdout?.on('data', (c: Buffer) => cb(c)),
      onStderr: (cb) => void child.stderr?.on('data', (c: string) => cb(c)),
      onExit: (cb) => void child.on('exit', (code, signal) => cb({ code, signal })),
      onError: (cb) => void child.on('error', (e: Error) => cb(e)),
    };
  }
}
