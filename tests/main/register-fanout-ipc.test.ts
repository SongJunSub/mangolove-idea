import { describe, it, expect, vi } from 'vitest';
import { registerIpcForTest } from '../helpers/register-ipc-for-test';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { FanoutManager } from '../../src/main/git/fanout-manager';

describe('fanout IPC wiring', () => {
  it('routes the fanout channels to the injected FanoutManager', async () => {
    const lane = {
      laneId: 'haiku',
      model: 'haiku',
      worktreeId: '/w/h',
      branch: 'fanout/r1/haiku',
      status: 'done',
    };
    const manager = {
      start: vi.fn().mockResolvedValue({ id: 'r1', lanes: [lane] }),
      get: vi.fn().mockReturnValue({
        id: 'r1',
        prompt: 'p',
        base: 'main',
        skipPermissions: false,
        lanes: [lane],
      }),
      select: vi
        .fn()
        .mockResolvedValue({ worktreeId: '/w/h', merged: true, cleanedUp: true, status: 'merged' }),
      abort: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as FanoutManager;

    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    const started = await handlers.get(IPC.FANOUT_START)!(fakeEvent, {
      prompt: 'p',
      models: ['haiku'],
      skipPermissions: false,
    });
    expect(started).toMatchObject({ id: 'r1' });
    expect(manager.start).toHaveBeenCalledWith({
      prompt: 'p',
      models: ['haiku'],
      skipPermissions: false,
    });

    const got = await handlers.get(IPC.FANOUT_GET)!(fakeEvent, undefined);
    expect(got).toMatchObject({ id: 'r1', lanes: [lane] });

    const sel = await handlers.get(IPC.FANOUT_SELECT)!(fakeEvent, { laneId: 'haiku' });
    expect(sel).toMatchObject({ merged: true, status: 'merged' });
    expect(manager.select).toHaveBeenCalledWith({ laneId: 'haiku' });

    const ab = await handlers.get(IPC.FANOUT_ABORT)!(fakeEvent, undefined);
    expect(ab).toMatchObject({ ok: true });
    expect(manager.abort).toHaveBeenCalled();
  });

  it('FANOUT_START surfaces a manager rejection as an Error across the boundary', async () => {
    const manager = {
      start: vi.fn().mockRejectedValue(new Error('a fan-out run is already active')),
      get: vi.fn(),
      select: vi.fn(),
      abort: vi.fn(),
    } as unknown as FanoutManager;
    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    await expect(
      handlers.get(IPC.FANOUT_START)!(fakeEvent, {
        prompt: 'p',
        models: ['opus'],
        skipPermissions: false,
      }),
    ).rejects.toThrow(/already active/i);
  });

  it('SETTINGS_SET clears an idle fanoutManager so a new base/agentCommand applies', async () => {
    const manager = {
      get: vi.fn().mockReturnValue(null), // idle: no active run
    } as unknown as FanoutManager;
    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    await handlers.get(IPC.SETTINGS_SET)!(fakeEvent, { baseBranch: 'develop' });
    expect(ctx.fanoutManager).toBeUndefined();
  });

  it('SETTINGS_SET keeps the fanoutManager while a run is active', async () => {
    const manager = {
      get: vi.fn().mockReturnValue({
        id: 'r1',
        prompt: 'p',
        base: 'main',
        skipPermissions: false,
        lanes: [],
      }),
    } as unknown as FanoutManager;
    const ctx = createIpcContext();
    ctx.fanoutManager = manager;
    ctx.sessionStore = { all: () => [] } as never;
    ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
    const { handlers, fakeEvent } = registerIpcForTest(ctx);

    await handlers.get(IPC.SETTINGS_SET)!(fakeEvent, { baseBranch: 'develop' });
    expect(ctx.fanoutManager).toBe(manager); // NOT nulled while a run is active
  });
});
