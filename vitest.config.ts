import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Playwright drives the e2e suite; vitest must not try to load it.
    exclude: ['tests/e2e/**', 'node_modules/**', 'out/**'],
    environment: 'node',
    // Forks, not threads: better-sqlite3 is a native module and the concurrency
    // suite spawns real child processes that need their own SQLite handles.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Extension-scoped: the migrations folder holds .sql files, and the
      // coverage provider tries to parse anything it is handed as JavaScript.
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        // Electron entry points: covered by the Playwright suite, not by line
        // counting against a headless main process.
        'src/main/index.ts',
        'src/main/window.ts',
        'src/main/ipc.ts',
        'src/main/menu.ts',
        'src/main/settings.ts',
        'src/main/dialogs.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
});
