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
