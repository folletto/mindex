/**
 * The colour tokens in src/renderer/styles.css, read the same way by every test
 * that cares about them, so no two tests can disagree about what a token is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Repo-relative path of the stylesheet that defines the tokens. */
export const STYLES_CSS = 'src/renderer/styles.css';

export function readStylesCss(): string {
  return readFileSync(join(REPO_ROOT, STYLES_CSS), 'utf8');
}

/**
 * Token names from the light `@theme static` block and from the dark
 * `prefers-color-scheme` block, without the `--color-` prefix: "bg", "text-muted".
 */
export function themeColourTokens(css: string): { light: string[]; dark: string[] } {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return {
    light: colourNames(cssBlock(bare, /@theme\s+static\s*\{/)),
    dark: colourNames(cssBlock(bare, /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/)),
  };
}

function colourNames(block: string): string[] {
  return [...block.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((match) => match[1]);
}

/** The text inside the first block whose opening text matches `opener` (a pattern ending in `{`). */
function cssBlock(css: string, opener: RegExp): string {
  const match = opener.exec(css);
  if (!match) throw new Error(`styles.css has no block matching ${opener}`);
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`The styles.css block matching ${opener} is never closed`);
}
