/**
 * Vitest/Jest manual mock for `electron`.
 * Provides the minimal surface used by src/main/ipc/register-ipc.ts in tests
 * so handlers can be tested without booting Electron.
 */
import { vi } from 'vitest';

export const app = {
  getVersion: vi.fn(() => '0.1.0'),
};

export const ipcMain = {
  handle: vi.fn(),
};

export const contextBridge = {
  exposeInMainWorld: vi.fn(),
};

export const ipcRenderer = {
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

export const BrowserWindow = vi.fn();
