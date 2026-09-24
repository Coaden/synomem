import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/mcp-server.ts'],
    },
    // The Windows runner's filesystem makes SQLite-heavy tests several times slower.
    testTimeout: process.platform === 'win32' ? 60_000 : 15_000,
  },
});
