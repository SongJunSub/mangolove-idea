import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            // Redirect `electron` to our manual mock so dynamic import('electron')
            // in register-ipc handlers resolves cleanly under plain Node tests.
            electron: path.resolve(__dirname, '__mocks__/electron.ts'),
          },
        },
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/main/**/*.test.ts'],
          pool: 'forks',
          // Git-heavy manager tests spin up real temp repos and run
          // worktree/merge/commit subprocesses; under the parallel forks pool
          // these can exceed the 5s default on a loaded machine. Give them
          // headroom so the suite is deterministic (no logic change).
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.ts'],
        },
      },
    ],
  },
});
