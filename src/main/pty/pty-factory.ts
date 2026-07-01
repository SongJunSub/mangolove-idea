import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface NodePtyProbe {
  readonly version: string;
  readonly loaded: boolean;
}

/**
 * Plan-0 node-pty health probe. Attempts to load node-pty (an N-API native addon
 * with ABI-stable prebuilds) and report its version. node-pty 1.1.0 normally loads
 * via its prebuild even without a rebuild; a failure in a real Electron run means
 * the addon is genuinely unloadable for this platform/Electron — re-run
 * `npm run rebuild` and check Xcode CLT. Spawning actual PTYs is Plan 2, not here.
 */
export function probeNodePty(): NodePtyProbe {
  try {
    // Touch the addon so an ABI mismatch surfaces as a throw, not a lazy crash.
    require('node-pty');
    const version: string = require('node-pty/package.json').version;
    return { version, loaded: true };
  } catch {
    return { version: 'unknown', loaded: false };
  }
}

// ── Plan 2: the spawnable PTY seam ───────────────────────────────────────────

/** Exit payload shape shared by node-pty and the test fake. */
export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * The minimal PTY surface SessionManager depends on. Callback-shaped on purpose:
 * node-pty's real onData/onExit return disposables, but NodePtyFactory adapts
 * them down to this plain-callback form so the SAME SessionManager code runs
 * against both the real addon and tests/helpers/fake-pty.ts (FakePtyHandle).
 */
export interface IPtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: PtyExitEvent) => void): void;
}

/** Spawn options forwarded to node-pty.spawn (subset we use). */
export interface PtySpawnOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly name?: string;
}

/** Factory abstraction so SessionManager is unit-testable with a fake PTY. */
export interface PtyFactory {
  spawn(file: string, args: readonly string[], opts: PtySpawnOptions): IPtyLike;
}

/** Shape of the node-pty module members we touch (avoids `any`). */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { cwd: string; cols: number; rows: number; env?: NodeJS.ProcessEnv; name?: string },
  ): {
    readonly pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(cb: (data: string) => void): { dispose(): void };
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  };
}

/**
 * Production PtyFactory wrapping node-pty. Lazily requires the addon (so plain
 * Node unit tests that never call this never load the native binary) and adapts
 * node-pty's disposable-returning onData/onExit to IPtyLike's callback form.
 */
export class NodePtyFactory implements PtyFactory {
  private readonly nodePty: NodePtyModule;

  constructor(nodePty?: NodePtyModule) {
    this.nodePty = nodePty ?? (require('node-pty') as NodePtyModule);
  }

  spawn(file: string, args: readonly string[], opts: PtySpawnOptions): IPtyLike {
    const proc = this.nodePty.spawn(file, [...args], {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      // Advertise the terminal's REAL color capability: our renderer is xterm.js, which
      // supports 256-color + 24-bit truecolor. node-pty's legacy default TERM=xterm-color
      // is only 16-color, so color-capability detectors (chalk/supports-color in claude,
      // etc.) downgrade and map brand/accent colors to the nearest ANSI-16 — which is why
      // claude's orange rendered RED. TERM=xterm-256color + COLORTERM=truecolor fixes it.
      env: { ...(opts.env ?? process.env), COLORTERM: 'truecolor' },
      name: opts.name ?? 'xterm-256color',
    });
    return {
      pid: proc.pid,
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => proc.kill(signal),
      onData: (cb) => void proc.onData(cb),
      onExit: (cb) => void proc.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
    };
  }
}
