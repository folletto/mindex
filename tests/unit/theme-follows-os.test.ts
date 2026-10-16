/**
 * The app follows the OS colour scheme, and the two schemes define the same tokens.
 *
 * Electron's nativeTheme.themeSource defaults to "system", and that default is what
 * makes prefers-color-scheme (and so the dark token block) track the OS. Touching
 * nativeTheme anywhere in the main process would pin the app to one scheme without
 * any visible error, so the test reads the source instead of trusting a review.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readStylesCss, themeColourTokens } from '../helpers/styles.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAIN_DIR = join(REPO_ROOT, 'src', 'main');

/** Every TypeScript file in the main process, as absolute paths. */
function mainSources(): string[] {
  return readdirSync(MAIN_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => extname(entry) === '.ts')
    .map((entry) => join(MAIN_DIR, entry));
}

/**
 * Where a file touches the theme: any reference to nativeTheme, and any assignment to
 * or definition of themeSource. Read from the syntax tree, so comments and strings
 * that merely mention them do not count.
 */
function themeTouches(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const touches: string[] = [];
  const at = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'nativeTheme') {
      touches.push(`${file}:${at(node)} references nativeTheme`);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'themeSource'
    ) {
      touches.push(`${file}:${at(node)} assigns themeSource`);
    }
    const name = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) ? node.name : undefined;
    if (name && ts.isIdentifier(name) && name.text === 'themeSource') {
      touches.push(`${file}:${at(node)} sets themeSource`);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return touches;
}

describe('theme follows the OS', () => {
  it('never references nativeTheme or sets themeSource in the main process', () => {
    const sources = mainSources();
    expect(sources.length).toBeGreaterThan(0);

    const touches = sources.flatMap((file) =>
      themeTouches(relative(REPO_ROOT, file).split(sep).join('/'), readFileSync(file, 'utf8')),
    );
    expect(touches).toEqual([]);
  });

  it('recognises the forms it guards against, and nothing else', () => {
    expect(themeTouches('a.ts', "import { nativeTheme } from 'electron';")).toHaveLength(1);
    expect(themeTouches('a.ts', "nativeTheme.themeSource = 'dark';")).toHaveLength(2);
    expect(themeTouches('a.ts', "const theme = { themeSource: 'light' };")).toHaveLength(1);
    expect(themeTouches('a.ts', "// nativeTheme follows the OS\nconst note = 'nativeTheme';")).toEqual([]);
  });

  it('defines the same colour tokens in the light and dark blocks of styles.css', () => {
    const { light, dark } = themeColourTokens(readStylesCss());
    expect(light.length).toBeGreaterThan(0);

    expect({
      onlyInLight: light.filter((token) => !dark.includes(token)),
      onlyInDark: dark.filter((token) => !light.includes(token)),
    }).toEqual({ onlyInLight: [], onlyInDark: [] });
  });
});
