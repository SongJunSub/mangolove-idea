import { execFile } from 'node:child_process';
import type { AbducoLauncherDeps, ProcInfo } from './abduco-launcher';

/** The child_process-backed slice of AbducoLauncherDeps (the testable rest is injected). */
type AbducoExec = Pick<AbducoLauncherDeps, 'runList' | 'psList' | 'cmdOfPid' | 'killPid'>;

/**
 * Parses `ps -axo pid=,command=` output into {pid, cmd}. Each line is a numeric
 * pid, whitespace, then the full command line; blank/garbage lines are skipped.
 */
export function parsePsList(stdout: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

/**
 * Builds the real child_process effects an AbducoLauncher needs, bound to a
 * resolved absolute `abducoPath`. `ps` is invoked by its absolute path; killPid
 * uses process.kill on an EXACT pid (the launcher only passes pids it verified
 * carry our unique session name). All execs are time-bounded.
 */
export function createAbducoExec(abducoPath: string): AbducoExec {
  return {
    runList: () =>
      new Promise((resolvePromise) => {
        // abduco with no args prints the session table and exits non-zero when
        // there are zero sessions — we only need stdout, so the error is ignored.
        execFile(abducoPath, [], { timeout: 4000 }, (_err, stdout) => resolvePromise(stdout ?? ''));
      }),
    psList: () =>
      new Promise((resolvePromise) => {
        execFile(
          '/bin/ps',
          ['-axo', 'pid=,command='],
          { timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
          (_err, stdout) => resolvePromise(parsePsList(stdout ?? '')),
        );
      }),
    cmdOfPid: (pid) =>
      new Promise((resolvePromise) => {
        // Current cmdline of ONE pid; empty string when the pid is gone. Used as the
        // recycle guard immediately before killPid (re-verify it is still abduco).
        execFile(
          '/bin/ps',
          ['-p', String(pid), '-o', 'command='],
          { timeout: 4000 },
          (_err, stdout) => resolvePromise((stdout ?? '').trim()),
        );
      }),
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone — nothing left to detach/kill
      }
    },
  };
}
