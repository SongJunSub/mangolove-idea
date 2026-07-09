import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The electron alias every node-env project needs: dynamic import('electron') in register-ipc
// handlers must resolve to our manual mock under plain Node tests.
const electronAlias = { electron: path.resolve(__dirname, '__mocks__/electron.ts') };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: electronAlias },
        test: {
          name: 'node',
          environment: 'node',
          // tests/main = main-process units; tests/shared = pure cross-process modules
          // (e.g. pane-layout clamp) — both run in the node env with no DOM. The heavy real-git
          // integration tests (*.integration.test.ts) are EXCLUDED here and run in the serialized
          // `integration` project below, so this fast pool stays hermetic + parallel-safe and its
          // pass/fail never depends on ambient CPU load (see that project for the why).
          include: ['tests/main/**/*.test.ts', 'tests/shared/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/main/**/*.integration.test.ts'],
          pool: 'forks',
          testTimeout: 15000,
          hookTimeout: 15000,
        },
      },
      {
        // Heavy real-git integration tests: they spin up real temp repos and run worktree/merge/
        // commit/clone SUBPROCESSES. Run them in a SEPARATE, SERIALIZED pool (fileParallelism:
        // false) so N of them can't starve each other — and so they never compete with the fast
        // `node`/`jsdom` pools. This removes the timing non-determinism that made a full run flake
        // when it raced a parallel `npm run build` (a starved git test would exceed its timeout and
        // false-fail). Generous timeout + one retry are backstops for a transient stall, not the
        // fix — the isolation is. Name a test `*.integration.test.ts` iff it drives real git.
        resolve: { alias: electronAlias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/main/**/*.integration.test.ts'],
          pool: 'forks',
          fileParallelism: false, // one integration file at a time — no self-inflicted git contention
          testTimeout: 60000,
          hookTimeout: 60000,
          retry: 1,
        },
      },
      {
        // React plugin gives the jsdom project the automatic-JSX transform so RTL
        // component tests (.test.tsx) compile; pure-logic .test.ts tests are unaffected.
        plugins: [react()],
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/renderer/setup-rtl.ts'],
        },
      },
    ],
  },
});
