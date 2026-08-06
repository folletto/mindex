import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'node_modules/**', 'site/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty catch blocks are a deliberate idiom here: several filesystem
      // operations are best-effort and each one carries a comment saying why.
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // --- the renderer is not allowed to touch the machine ---
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      /**
       * The renderer talks to the main process and to nothing else. This is the
       * lint expression of the security model in src/preload/index.ts: if a
       * capability is needed here, it gets added to the IPC surface on purpose.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process', 'electron'],
              message:
                'The renderer has no filesystem, no path handling and no Electron. Add an IPC channel in src/main/ipc.ts instead.',
            },
            {
              group: ['**/main/**'],
              message: 'The renderer must not import main-process code. Share types through src/shared instead.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'The renderer is sandboxed; there is no require.' },
      ],
    },
  },

  // --- the main process must not import the renderer ---
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/renderer/**'],
              message: 'The main process must not import renderer code.',
            },
          ],
        },
      ],
    },
  },

  // --- shared code runs in both, so it may assume neither ---
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fs', 'node:fs', 'path', 'node:path', 'electron', '**/main/**', '**/renderer/**'],
              message:
                'src/shared is imported by the sandboxed renderer, so it must stay free of Node and Electron.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['*.config.ts', '*.config.js', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
