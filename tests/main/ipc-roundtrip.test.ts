import { describe, it, expect, vi } from 'vitest';
import { buildAppInfo, registerIpc } from '../../src/main/ipc/register-ipc';

describe('buildAppInfo', () => {
  it('assembles AppInfo from injected version sources + node-pty probe', () => {
    const info = buildAppInfo(
      { getVersion: () => '0.1.0' },
      {
        electron: '42.4.0',
        node: '22.12.0',
        chrome: '136.0.0.0',
      },
      () => ({ version: '1.1.0', loaded: true }),
    );
    expect(info).toEqual({
      appVersion: '0.1.0',
      electronVersion: '42.4.0',
      nodeVersion: '22.12.0',
      chromeVersion: '136.0.0.0',
      nodePtyVersion: '1.1.0',
      nodePtyLoaded: true,
    });
  });

  it('reports a failed node-pty probe without throwing', () => {
    const info = buildAppInfo(
      { getVersion: () => '0.1.0' },
      { electron: '42.4.0', node: '22.12.0', chrome: '136.0.0.0' },
      () => ({ version: 'unknown', loaded: false }),
    );
    expect(info.nodePtyLoaded).toBe(false);
    expect(info.nodePtyVersion).toBe('unknown');
  });
});

describe('registerIpc', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const onHandlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      on: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        onHandlers.set(channel, fn);
      }),
    };
    return { handlers, onHandlers, ipcMain };
  }

  it('registers a handler for app:ping that returns AppInfo', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    registerIpc(ipcMain as never, { mainWindow: null });
    expect(handlers.has('app:ping')).toBe(true);
    const pingResult = (await handlers.get('app:ping')!({})) as { electronVersion: string };
    expect(typeof pingResult.electronVersion).toBe('string');
  });

  it('worktree:list delegates to the injected WorktreeManager', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fakeManager = {
      list: vi.fn(async () => [
        { id: '/r', path: '/r', branch: 'main', isPrimary: true, isLocked: false },
      ]),
      create: vi.fn(),
      remove: vi.fn(),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const list = await handlers.get('worktree:list')!({});
    expect(fakeManager.list).toHaveBeenCalledOnce();
    expect(list).toEqual([
      { id: '/r', path: '/r', branch: 'main', isPrimary: true, isLocked: false },
    ]);
  });

  it('worktree:create delegates the request and returns the Worktree', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const created = {
      id: '/r/.worktrees/feat',
      path: '/r/.worktrees/feat',
      branch: 'feat',
      isPrimary: false,
      isLocked: false,
    };
    const fakeManager = {
      list: vi.fn(),
      create: vi.fn(async () => created),
      remove: vi.fn(),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const req = { baseBranch: 'main', newBranch: 'feat' };
    const result = await handlers.get('worktree:create')!({}, req);
    expect(fakeManager.create).toHaveBeenCalledWith(req);
    expect(result).toEqual(created);
  });

  it('worktree:remove returns Ack ok:true on success', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fakeManager = {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(async () => undefined),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const req = { worktreeId: '/r/.worktrees/feat' };
    const ack = await handlers.get('worktree:remove')!({}, req);
    expect(fakeManager.remove).toHaveBeenCalledWith(req);
    expect(ack).toEqual({ ok: true });
  });

  it('worktree:remove returns Ack ok:false with the error message on failure', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fakeManager = {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(async () => {
        throw new Error('cannot remove the primary working tree');
      }),
    };
    registerIpc(ipcMain as never, { mainWindow: null, worktreeManager: fakeManager as never });
    const ack = (await handlers.get('worktree:remove')!({}, { worktreeId: '/r' })) as {
      ok: boolean;
      error?: string;
    };
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('cannot remove the primary working tree');
  });
});

describe('registerIpc — session', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const onHandlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void onHandlers.set(c, fn)),
    };
    return { handlers, onHandlers, ipcMain };
  }

  function fakeSession() {
    return {
      spawn: vi.fn(async () => ({
        worktreeId: '/wt',
        pid: 7,
        status: 'running',
        hasActiveTurn: false,
        continued: false,
      })),
      kill: vi.fn(() => ({ ok: true })),
      write: vi.fn(),
      resize: vi.fn(),
      killAll: vi.fn(),
    };
  }

  it('SESSION_SPAWN delegates to sessionManager.spawn and returns the AgentSession', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const req = { worktreeId: '/wt', continueSession: false, cols: 80, rows: 24 };
    const session = await handlers.get('session:spawn')!({}, req);
    expect(sm.spawn).toHaveBeenCalledWith(req);
    expect(session).toMatchObject({ worktreeId: '/wt', status: 'running', pid: 7 });
  });

  it('SESSION_KILL delegates to sessionManager.kill and returns the Ack', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const ack = await handlers.get('session:kill')!({}, { worktreeId: '/wt' });
    expect(sm.kill).toHaveBeenCalledWith('/wt');
    expect(ack).toEqual({ ok: true });
  });

  it('SESSION_INPUT is an ipcMain.on handler that delegates to write', () => {
    const { onHandlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const req = { worktreeId: '/wt', data: 'ls\r' };
    onHandlers.get('session:input')!({}, req);
    expect(sm.write).toHaveBeenCalledWith(req);
  });

  it('SESSION_RESIZE is an ipcMain.on handler that delegates to resize', () => {
    const { onHandlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const req = { worktreeId: '/wt', cols: 120, rows: 40 };
    onHandlers.get('session:resize')!({}, req);
    expect(sm.resize).toHaveBeenCalledWith(req);
  });
});

describe('registerIpc — merge', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('MERGE_RUN delegates to mergeRunner.run and returns the MergeResult', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const result = { worktreeId: '/wt', merged: true, cleanedUp: true };
    const mr = { run: vi.fn(async () => result) };
    registerIpc(ipcMain as never, { mainWindow: null, mergeRunner: mr as never });
    const req = { worktreeId: '/wt', targetBranch: 'main', runVerifyHook: true, cleanup: true };
    const out = await handlers.get('merge:run')!({}, req);
    expect(mr.run).toHaveBeenCalledWith(req);
    expect(out).toEqual(result);
  });
});

describe('registerIpc — server + logs', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  function fakeServer() {
    const status = { process: { worktreeId: '/wt', kind: 'npm', state: 'running', pid: 9 } };
    return {
      start: vi.fn(async () => status),
      stop: vi.fn(async () => ({
        process: { worktreeId: null, kind: 'unknown', state: 'stopped' },
      })),
      status: vi.fn(() => status),
      dispose: vi.fn(),
    };
  }
  function fakeLogStore() {
    return {
      snapshot: vi.fn(() => [{ seq: 0, ts: 1, stream: 'stdout', level: 'info', text: 'x' }]),
    };
  }

  it('SERVER_START delegates to serverManager.start and returns the ServerStatus', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeServer();
    registerIpc(ipcMain as never, { mainWindow: null, serverManager: sm as never });
    const req = { worktreeId: '/wt' };
    const out = await handlers.get('server:start')!({}, req);
    expect(sm.start).toHaveBeenCalledWith(req);
    expect(out).toMatchObject({ process: { state: 'running', pid: 9 } });
  });

  it('SERVER_STOP delegates to serverManager.stop', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeServer();
    registerIpc(ipcMain as never, { mainWindow: null, serverManager: sm as never });
    const out = await handlers.get('server:stop')!({}, {});
    expect(sm.stop).toHaveBeenCalledWith({});
    expect(out).toMatchObject({ process: { state: 'stopped' } });
  });

  it('SERVER_STATUS delegates to serverManager.status', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeServer();
    registerIpc(ipcMain as never, { mainWindow: null, serverManager: sm as never });
    const out = await handlers.get('server:status')!({});
    expect(sm.status).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ process: { state: 'running' } });
  });

  it('LOG_SNAPSHOT returns the LogStore snapshot', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const ls = fakeLogStore();
    registerIpc(ipcMain as never, { mainWindow: null, logStore: ls as never });
    const out = await handlers.get('log:snapshot')!({});
    expect(ls.snapshot).toHaveBeenCalledOnce();
    expect(out).toEqual([{ seq: 0, ts: 1, stream: 'stdout', level: 'info', text: 'x' }]);
  });
});
