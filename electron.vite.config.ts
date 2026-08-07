import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Migrations are plain `.sql` files read at runtime, so they have to travel
 * next to the main bundle. Copying beats inlining: the files stay readable in
 * the repo, and the runner works identically from `src/` in tests and from
 * `out/` in a packaged app.
 */
function copyMigrations(): Plugin {
  return {
    name: 'mindex:copy-migrations',
    apply: 'build',
    closeBundle() {
      const source = resolve(__dirname, 'src/main/db/migrations');
      const target = resolve(__dirname, 'out/main/migrations');
      mkdirSync(target, { recursive: true });
      for (const file of readdirSync(source)) {
        if (file.endsWith('.sql')) copyFileSync(resolve(source, file), resolve(target, file));
      }
    },
  };
}

/**
 * The shipped CSP forbids inline scripts, which is also what Vite's HMR client
 * and the React refresh preamble need. Relax it for the dev server only, so the
 * production build keeps the strict policy that matters.
 */
function relaxCspForDevServer(): Plugin {
  return {
    name: 'mindex:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        '<!-- CSP relaxed for the dev server; the packaged app keeps the strict policy -->',
      );
    },
  };
}

export default defineConfig({
  main: {
    // better-sqlite3 is native and must never be bundled; electron-builder
    // ships it from node_modules and asarUnpack keeps the .node loadable.
    plugins: [externalizeDepsPlugin(), copyMigrations()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // A sandboxed preload script must be CommonJS — Electron has no module
        // loader in that context. This package is "type": "module", so the file
        // also has to be named .cjs or Node treats it as ESM regardless.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), relaxCspForDevServer()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
