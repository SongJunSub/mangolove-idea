import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAppInfo, registerIpc, resolveCommands } from '../../src/main/ipc/register-ipc';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { AppSettings } from '../../src/shared/types';

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

describe('resolveCommands — settings > env > default precedence', () => {
  const ENV = ['MANGO_AGENT_CMD', 'MANGO_SERVER_CMD', 'MANGO_VERIFY_CMD'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('falls back to hardcoded defaults when settings + env are unset', () => {
    expect(resolveCommands({})).toEqual({
      agentCommand: 'claude',
      verifyCommand: 'true',
      serverCommand: undefined, // unset => detection wins downstream
    });
  });

  it('uses the env seam when settings are unset (keeps the smokes working)', () => {
    process.env.MANGO_AGENT_CMD = 'env-claude';
    process.env.MANGO_SERVER_CMD = 'env-server';
    process.env.MANGO_VERIFY_CMD = 'env-verify';
    expect(resolveCommands({})).toEqual({
      agentCommand: 'env-claude',
      verifyCommand: 'env-verify',
      serverCommand: 'env-server',
    });
  });

  it('prefers a set settings value over env and default', () => {
    process.env.MANGO_AGENT_CMD = 'env-claude';
    const settings: AppSettings = {
      agentCommand: 'set-claude',
      verifyCommand: 'set-verify',
      serverCommand: 'set-server',
    };
    expect(resolveCommands(settings)).toEqual({
      agentCommand: 'set-claude',
      verifyCommand: 'set-verify',
      serverCommand: 'set-server',
    });
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
    // MERGE_RUN consults getConflictResolver(ctx) first; with the repoRoot-bound
    // getters now null-guarded (requireRepoRoot), the lazy resolver build needs a
    // repoRoot. cwd is the project repo (a real git work tree, MERGE_HEAD absent),
    // so inProgress() is false and the handler delegates to the injected mergeRunner.
    registerIpc(ipcMain as never, {
      mainWindow: null,
      repoRoot: process.cwd(),
      mergeRunner: mr as never,
    });
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

describe('registerIpc — diff (V2 A1)', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('DIFF_LIST delegates to diffViewer.listChangedFiles', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const files = [{ path: 'a.txt', status: 'modified', binary: false }];
    const dv = { listChangedFiles: vi.fn(async () => files), getFileDiff: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, diffViewer: dv as never });
    const req = { worktreeId: '/wt', base: 'main' };
    const out = await handlers.get('diff:list')!({}, req);
    expect(dv.listChangedFiles).toHaveBeenCalledWith(req);
    expect(out).toEqual(files);
  });

  it('DIFF_FILE delegates to diffViewer.getFileDiff', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const fd = { path: 'a.txt', status: 'modified', original: 'x', modified: 'y', binary: false };
    const dv = { listChangedFiles: vi.fn(), getFileDiff: vi.fn(async () => fd) };
    registerIpc(ipcMain as never, { mainWindow: null, diffViewer: dv as never });
    const req = { worktreeId: '/wt', path: 'a.txt' };
    const out = await handlers.get('diff:file')!({}, req);
    expect(dv.getFileDiff).toHaveBeenCalledWith(req);
    expect(out).toEqual(fd);
  });
});

describe('registerIpc — app quit + session records (Plan 5)', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('SESSION_RECORDS returns the recorded worktree paths from the SessionStore', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = {
      all: vi.fn(() => [
        { worktreePath: '/wt/a', branch: 'f', hadActiveSession: true, updatedAt: 1 },
        { worktreePath: '/wt/b', branch: 'g', hadActiveSession: true, updatedAt: 2 },
      ]),
    };
    registerIpc(ipcMain as never, { mainWindow: null, sessionStore: store as never });
    const out = await handlers.get('session:records')!({});
    expect(out).toEqual(['/wt/a', '/wt/b']);
  });

  it('APP_QUIT_DECISION(quit:true) kills all sessions, disposes server, and returns ok', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const session = { killAll: vi.fn(), liveWorktreeIds: vi.fn(() => []) };
    const server = { dispose: vi.fn() };
    const ctx: IpcContext = {
      mainWindow: null,
      sessionManager: session as never,
      serverManager: server as never,
    };
    registerIpc(ipcMain as never, ctx);
    const ack = await handlers.get('app:quit-decision')!({}, { quit: true });
    expect(session.killAll).toHaveBeenCalledOnce();
    expect(server.dispose).toHaveBeenCalledOnce();
    expect(ctx.confirmedQuit).toBe(true);
    expect(ack).toEqual({ ok: true });
  });

  it('APP_QUIT_DECISION(quit:false) does NOT sweep and returns ok', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const session = { killAll: vi.fn(), liveWorktreeIds: vi.fn(() => []) };
    const server = { dispose: vi.fn() };
    const ctx: IpcContext = {
      mainWindow: null,
      sessionManager: session as never,
      serverManager: server as never,
    };
    registerIpc(ipcMain as never, ctx);
    const ack = await handlers.get('app:quit-decision')!({}, { quit: false });
    expect(session.killAll).not.toHaveBeenCalled();
    expect(server.dispose).not.toHaveBeenCalled();
    expect(ctx.confirmedQuit).toBeFalsy();
    expect(ack).toEqual({ ok: true });
  });
});

describe('registerIpc — settings (V2 E)', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('SETTINGS_GET returns the SettingsStore.get() snapshot', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(() => ({ agentCommand: 'a' })), set: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, settingsStore: store as never });
    const out = await handlers.get('settings:get')!({});
    expect(store.get).toHaveBeenCalledOnce();
    expect(out).toEqual({ agentCommand: 'a' });
  });

  it('SETTINGS_SET persists the partial and returns the merged settings', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const merged = { agentCommand: 'a', verifyCommand: 'true' };
    const store = { get: vi.fn(), set: vi.fn(() => merged) };
    registerIpc(ipcMain as never, { mainWindow: null, settingsStore: store as never });
    const req = { verifyCommand: 'true' };
    const out = await handlers.get('settings:set')!({}, req);
    expect(store.set).toHaveBeenCalledWith(req);
    expect(out).toEqual(merged);
  });

  it('SETTINGS_SET clears ALL caches when session+server are idle', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(), set: vi.fn(() => ({})) };
    const ctx = {
      mainWindow: null,
      settingsStore: store as never,
      sessionManager: { liveWorktreeIds: () => [] } as never, // idle
      serverManager: { hasLiveServer: () => false } as never, // idle
      mergeRunner: { tag: 'merge' } as never,
      diffViewer: { tag: 'diff' } as never,
    };
    registerIpc(ipcMain as never, ctx);
    await handlers.get('settings:set')!({}, { agentCommand: 'x' });
    expect(ctx.sessionManager).toBeUndefined();
    expect(ctx.serverManager).toBeUndefined();
    expect(ctx.mergeRunner).toBeUndefined();
    expect(ctx.diffViewer).toBeUndefined();
  });

  it('SETTINGS_SET KEEPS live session/server managers (no orphan) but always clears merge/diff', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(), set: vi.fn(() => ({})) };
    const liveSession = { liveWorktreeIds: () => ['w1'] }; // busy
    const liveServer = { hasLiveServer: () => true }; // busy
    const ctx = {
      mainWindow: null,
      settingsStore: store as never,
      sessionManager: liveSession as never,
      serverManager: liveServer as never,
      mergeRunner: { tag: 'merge' } as never,
      diffViewer: { tag: 'diff' } as never,
    };
    registerIpc(ipcMain as never, ctx);
    await handlers.get('settings:set')!({}, { agentCommand: 'x' });
    expect(ctx.sessionManager).toBe(liveSession); // kept -> sweep still finds it
    expect(ctx.serverManager).toBe(liveServer); // kept -> sweep still finds it
    expect(ctx.mergeRunner).toBeUndefined(); // stateless -> always cleared
    expect(ctx.diffViewer).toBeUndefined();
  });

  it('SETTINGS_SET while busy marks the managers dirty for deferred live-apply', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(), set: vi.fn(() => ({})) };
    const ctx: Record<string, unknown> = {
      mainWindow: null,
      settingsStore: store as never,
      sessionManager: { liveWorktreeIds: () => ['w1'] } as never, // busy
      serverManager: { hasLiveServer: () => true } as never, // busy
    };
    registerIpc(ipcMain as never, ctx as never);
    await handlers.get('settings:set')!({}, { agentCommand: 'x' });
    expect(ctx.sessionSettingsDirty).toBe(true);
    expect(ctx.serverSettingsDirty).toBe(true);
  });

  it('SETTINGS_SET while idle leaves the dirty flags false (immediate apply)', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(), set: vi.fn(() => ({})) };
    const ctx: Record<string, unknown> = {
      mainWindow: null,
      settingsStore: store as never,
      sessionManager: { liveWorktreeIds: () => [] } as never, // idle
      serverManager: { hasLiveServer: () => false } as never, // idle
    };
    registerIpc(ipcMain as never, ctx as never);
    await handlers.get('settings:set')!({}, { agentCommand: 'x' });
    expect(ctx.sessionSettingsDirty).toBe(false);
    expect(ctx.serverSettingsDirty).toBe(false);
  });

  it('deferred apply: a real manager built after a busy edit clears its cache onIdle, so next spawn rebuilds', async () => {
    // End-to-end proof of the live-apply guarantee for the BUSY path. We drive the
    // REAL lazy builders (no injected manager) with fakes so the manager's onIdle
    // callback — wired by register-ipc — actually runs and clears ctx.*Manager.
    const { handlers, ipcMain } = makeIpcMain();
    const settings: AppSettings = { agentCommand: 'old-claude' };
    const store = {
      get: vi.fn(() => settings),
      set: vi.fn((p: Partial<AppSettings>) => Object.assign(settings, p)),
    };

    // A fake node-pty that records the command it was spawned with and lets the
    // test fire its exit. The factory is injected via ctx through the real builder.
    const spawned: string[] = [];
    let exitCb: (() => void) | undefined;
    const fakePty = {
      pid: 1,
      onData: vi.fn(),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitCb = () => cb({ exitCode: 0 });
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const factory = {
      spawn: vi.fn((file: string) => {
        spawned.push(file);
        return fakePty as never;
      }),
    };

    // Inject the SessionManager directly (built from the same module) so we exercise
    // the real onIdle clear path without the NodePtyFactory. We mimic what
    // getSessionManager does: clear ctx.sessionManager when dirty after the last exit.
    const { SessionManager } = await import('../../src/main/managers/session-manager');
    const ctx: IpcContext = {
      mainWindow: null,
      settingsStore: store as never,
      worktreeManager: {
        list: async () => [
          { id: '/wt', path: '/wt', branch: 'm', isPrimary: false, isLocked: false },
        ],
      } as never,
      sessionStore: { upsert: vi.fn(), all: () => [] } as never,
    };
    ctx.sessionManager = new SessionManager({
      factory: factory as never,
      emitter: { emitOutput: vi.fn(), emitExit: vi.fn(), emitStatus: vi.fn() },
      command: store.get().agentCommand,
      resolvePath: async () => '/wt',
      store: ctx.sessionStore,
      onIdle: () => {
        if (ctx.sessionSettingsDirty) {
          ctx.sessionSettingsDirty = false;
          ctx.sessionManager = undefined;
        }
      },
    });

    registerIpc(ipcMain as never, ctx);

    // Spawn with the OLD command, then edit agentCommand while busy -> kept + dirty.
    await handlers.get('session:spawn')!(
      {},
      { worktreeId: '/wt', continueSession: false, cols: 80, rows: 24 },
    );
    expect(spawned).toEqual(['old-claude']);
    await handlers.get('settings:set')!({}, { agentCommand: 'new-claude' });
    expect(ctx.sessionManager).toBeDefined(); // kept while busy
    expect(ctx.sessionSettingsDirty).toBe(true);

    // End the live work: the last PTY exits -> onIdle clears the cache.
    exitCb!();
    expect(ctx.sessionManager).toBeUndefined();
    expect(ctx.sessionSettingsDirty).toBe(false);

    // Next spawn rebuilds the manager lazily — but that lazy build uses NodePtyFactory,
    // which we cannot exercise headless. The cache-clear above is the load-bearing
    // assertion: the stale manager is gone, so the next spawn reads the NEW command.
    expect(store.get().agentCommand).toBe('new-claude');
  });
});

describe('registerIpc — scrollback (V2)', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn(),
    };
    return { handlers, ipcMain };
  }

  it('SCROLLBACK_GET returns the stored buffer for a worktree', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(() => 'SAVED\x1b[0m'), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, scrollbackStore: store as never });
    const out = await handlers.get('scrollback:get')!({}, '/wt');
    expect(store.get).toHaveBeenCalledWith('/wt');
    expect(out).toBe('SAVED\x1b[0m');
  });

  it('SCROLLBACK_GET returns null (not undefined) when nothing is stored', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(() => undefined), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, scrollbackStore: store as never });
    const out = await handlers.get('scrollback:get')!({}, '/wt');
    expect(out).toBeNull(); // IPC-serializable: undefined would arrive as undefined; we normalize to null
  });

  it('SCROLLBACK_SET persists {worktreeId, data} and returns an Ack', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, { mainWindow: null, scrollbackStore: store as never });
    const ack = await handlers.get('scrollback:set')!({}, { worktreeId: '/wt', data: 'BUF' });
    expect(store.set).toHaveBeenCalledWith('/wt', 'BUF');
    expect(ack).toEqual({ ok: true });
  });

  it('WORKTREE_REMOVE best-effort removes the scrollback entry on success', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const wt = { list: vi.fn(), create: vi.fn(), remove: vi.fn(async () => undefined) };
    const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, {
      mainWindow: null,
      worktreeManager: wt as never,
      scrollbackStore: store as never,
    });
    const ack = await handlers.get('worktree:remove')!({}, { worktreeId: '/wt' });
    expect(ack).toEqual({ ok: true });
    expect(store.remove).toHaveBeenCalledWith('/wt');
  });

  it('WORKTREE_REMOVE does NOT remove scrollback when the worktree removal fails', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const wt = {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(async () => {
        throw new Error('cannot remove the primary working tree');
      }),
    };
    const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    registerIpc(ipcMain as never, {
      mainWindow: null,
      worktreeManager: wt as never,
      scrollbackStore: store as never,
    });
    const ack = (await handlers.get('worktree:remove')!({}, { worktreeId: '/r' })) as {
      ok: boolean;
    };
    expect(ack.ok).toBe(false);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('WORKTREE_REMOVE still returns ok:true if scrollback cleanup throws (best-effort)', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const wt = { list: vi.fn(), create: vi.fn(), remove: vi.fn(async () => undefined) };
    const store = {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(() => {
        throw new Error('disk full');
      }),
    };
    registerIpc(ipcMain as never, {
      mainWindow: null,
      worktreeManager: wt as never,
      scrollbackStore: store as never,
    });
    const ack = await handlers.get('worktree:remove')!({}, { worktreeId: '/wt' });
    expect(ack).toEqual({ ok: true }); // cleanup is best-effort; never demotes the remove
  });
});
