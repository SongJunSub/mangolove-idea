import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
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
