import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { createIpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';
import type { GhStatusReader } from '../../src/main/git/gh-status-reader';

function makeIpcMain() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, arg: unknown) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  } as unknown as Parameters<typeof registerIpc>[0];
  return { ipcMain, handlers };
}

function baseCtx() {
  const ctx = createIpcContext();
  ctx.sessionStore = { all: () => [] } as never;
  ctx.settingsStore = { get: () => ({}), set: (p: unknown) => p } as never;
  return ctx;
}

describe('gh IPC wiring', () => {
  it('routes GH_STATUS to the injected ghStatusReader', async () => {
    const reader = {
      status: vi.fn().mockResolvedValue({ kind: 'no-pr' }),
    } as unknown as GhStatusReader;
    const ctx = baseCtx();
    ctx.ghStatusReader = reader;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const out = await handlers.get(IPC.GH_STATUS)!(null, { worktreeId: 'w' });
    expect(out).toEqual({ kind: 'no-pr' });
    expect(reader.status).toHaveBeenCalledWith({ worktreeId: 'w' });
  });

  it('GH_STATUS never throws raw — a reader throw maps to {kind:error}', async () => {
    const reader = {
      status: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as GhStatusReader;
    const ctx = baseCtx();
    ctx.ghStatusReader = reader;
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);

    const out = await handlers.get(IPC.GH_STATUS)!(null, { worktreeId: 'w' });
    expect(out).toMatchObject({ kind: 'error', message: 'boom' });
  });

  it('APP_OPEN_EXTERNAL handler is registered (open action)', () => {
    const ctx = baseCtx();
    const { ipcMain, handlers } = makeIpcMain();
    registerIpc(ipcMain, ctx);
    expect(handlers.has(IPC.APP_OPEN_EXTERNAL)).toBe(true);
  });
});

describe('token hygiene (static)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(resolve(here, '../../', rel), 'utf8');
  const sources = [
    'src/main/git/gh-status-reader.ts',
    'src/main/ipc/register-ipc.ts',
    'src/main/proc/process-runner.ts',
  ].map(read);

  it('never calls `gh auth status`', () => {
    for (const s of sources) expect(s).not.toMatch(/auth\s+status/);
  });

  it('never sets GH_TOKEN', () => {
    for (const s of sources) expect(s).not.toMatch(/GH_TOKEN/);
  });

  it('never writes gh stderr into the LogStore', () => {
    const reader = read('src/main/git/gh-status-reader.ts');
    // The reader must not import or call a LogStore append for gh stderr.
    expect(reader).not.toMatch(/logStore|\.append\(/i);
  });
});
