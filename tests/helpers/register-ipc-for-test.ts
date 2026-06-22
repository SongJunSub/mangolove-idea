import { vi } from 'vitest';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

/** Fixed fake webContents id every test ctx registers under. */
export const TEST_WC_ID = 1;

/** A fake IPC event whose sender.id matches the registered ctx (requireCtx resolves it). */
export const fakeEvent = { sender: { id: TEST_WC_ID } } as const;

/**
 * Registers a SINGLE ctx under TEST_WC_ID and returns the recorded handlers + the
 * fake event. The ONE adapter that bridges the new registerIpc(ipcMain, contexts:
 * Map) signature to the existing handler-invoking tests: it builds the Map, records
 * every ipcMain.handle/on, and hands back a fakeEvent whose sender.id resolves to ctx
 * via requireCtx. Tests invoke `handlers.get(CH)!(fakeEvent, req)`.
 */
export function registerIpcForTest(ctx: IpcContext, id: number = TEST_WC_ID) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const onHandlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
    on: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void onHandlers.set(c, fn)),
  };
  const contexts = new Map<number, IpcContext>([[id, ctx]]);
  registerIpc(ipcMain as never, contexts);
  return { handlers, onHandlers, ipcMain, fakeEvent: { sender: { id } } };
}
