import { describe, it, expect } from 'vitest';
import { AbducoLauncher } from '../../src/main/pty/abduco-launcher';
import { sessionNameFor } from '../../src/main/pty/abduco-session';

const WT = '/repo/.worktrees/feat';
const NAME = sessionNameFor(WT);
const CTX = { worktreeId: WT, cwd: WT };

function makeLauncher(
  over: {
    listed?: string[];
    ps?: { pid: number; cmd: string }[];
  } = {},
) {
  const listed = over.listed ?? [];
  const ps = over.ps ?? [];
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const l = new AbducoLauncher({
    abducoPath: '/opt/homebrew/bin/abduco',
    command: 'claude',
    // abduco's listing is a tab/space table; emit one line per session.
    runList: async () => listed.map((n) => `+ Tue\t 2026-06-23 11:00:00\t${n}`).join('\n'),
    psList: async () => ps,
    killPid: (pid, signal) => void killed.push({ pid, signal }),
  });
  return { l, killed };
}

describe('AbducoLauncher.resolveLaunch', () => {
  it('fresh => abduco -A <name> <command> (attach-or-create a fresh agent)', () => {
    const { l } = makeLauncher();
    expect(l.resolveLaunch({ ...CTX, mode: 'fresh' })).toEqual({
      file: '/opt/homebrew/bin/abduco',
      args: ['-A', NAME, 'claude'],
    });
  });

  it('continue => abduco -A <name> <command> --continue', () => {
    const { l } = makeLauncher();
    expect(l.resolveLaunch({ ...CTX, mode: 'continue' })).toEqual({
      file: '/opt/homebrew/bin/abduco',
      args: ['-A', NAME, 'claude', '--continue'],
    });
  });

  it('attach => abduco -a <name> (re-attach to the live detached session, no command)', () => {
    const { l } = makeLauncher();
    expect(l.resolveLaunch({ ...CTX, mode: 'attach' })).toEqual({
      file: '/opt/homebrew/bin/abduco',
      args: ['-a', NAME],
    });
  });
});

describe('AbducoLauncher detached-session queries', () => {
  it('isLiveDetached is true iff the worktree session is listed', async () => {
    expect(await makeLauncher({ listed: [NAME] }).l.isLiveDetached(WT)).toBe(true);
    expect(await makeLauncher({ listed: [] }).l.isLiveDetached(WT)).toBe(false);
    expect(await makeLauncher({ listed: ['mango-deadbeefdeadbeef'] }).l.isLiveDetached(WT)).toBe(
      false,
    );
  });

  it('listLiveDetached returns only OUR (mango-) session names', async () => {
    const other = 'user-tmux-thing';
    const { l } = makeLauncher({ listed: [NAME, other, 'mango-0123456789abcdef'] });
    const names = await l.listLiveDetached();
    expect(names).toContain(NAME);
    expect(names).toContain('mango-0123456789abcdef');
    expect(names).not.toContain(other);
  });

  it('detachSignal is SIGTERM (explicit detach, not node-pty default SIGHUP)', () => {
    expect(makeLauncher().l.detachSignal).toBe('SIGTERM');
  });
});

describe('AbducoLauncher.endDetached', () => {
  it('kills ONLY the exact pids whose abduco cmdline carries this session name', async () => {
    const masterPid = 5001;
    const otherPid = 5002;
    const { l, killed } = makeLauncher({
      ps: [
        { pid: masterPid, cmd: `/opt/homebrew/bin/abduco -A ${NAME} claude` },
        { pid: otherPid, cmd: `/opt/homebrew/bin/abduco -A mango-ffffffffffffffff claude` },
        { pid: 9999, cmd: 'some unrelated process' },
      ],
    });
    await l.endDetached(WT);
    expect(killed.map((k) => k.pid)).toEqual([masterPid]);
    expect(killed[0].signal).toBe('SIGTERM');
  });

  it('is a no-op when no matching abduco process exists', async () => {
    const { l, killed } = makeLauncher({ ps: [{ pid: 1, cmd: 'init' }] });
    await l.endDetached(WT);
    expect(killed).toEqual([]);
  });
});

describe('AbducoLauncher.endAllDetached (global kill-switch)', () => {
  it('kills EVERY mango abduco master, sparing non-mango abduco and unrelated procs', async () => {
    const { l, killed } = makeLauncher({
      ps: [
        { pid: 1, cmd: `/opt/homebrew/bin/abduco -A ${NAME} claude` },
        { pid: 2, cmd: '/opt/homebrew/bin/abduco -A mango-ffffffffffffffff claude' },
        { pid: 3, cmd: '/opt/homebrew/bin/abduco -A user-session vim' }, // non-mango abduco
        { pid: 4, cmd: 'some unrelated process' },
      ],
    });
    await l.endAllDetached();
    expect(killed.map((k) => k.pid).sort()).toEqual([1, 2]);
    expect(killed.every((k) => k.signal === 'SIGTERM')).toBe(true);
  });
});
