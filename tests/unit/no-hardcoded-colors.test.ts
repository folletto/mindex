/**
 * No colour literals in the renderer.
 *
 * Dark mode is one mechanism: the OS picks a scheme and the tokens in
 * src/renderer/styles.css change value. A component that names a colour, or
 * carries its own dark: variant, stops following the OS without anyone noticing,
 * so this test fails on the first one it finds, with file and line.
 *
 * Flagged, in code and CSS alike:
 *   - hex colours (#abc, #aabbcc, #aabbccdd) and colour functions (rgb, hsl,
 *     hwb, lab, lch, oklab, oklch, color())
 *   - CSS colour names where a colour is expected: a colour property, an inline
 *     style, a fill or stroke attribute
 *   - Tailwind palette, white and black utilities, and their arbitrary-value forms
 *     (bg-[#fff], text-[rgb(...)], [color:red])
 *   - dark: variants on colour utilities
 *
 * Not flagged: comments, prose that happens to contain a colour word, and tokens
 * (bg-bg, text-text-muted), which are the whole point.
 *
 * Allowed: the two token blocks in styles.css, and nothing else.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { STYLES_CSS, readStylesCss, themeColourTokens } from '../helpers/styles.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html']);

interface ScanOptions {
  /** Token names (see themeColourTokens). A class that paints with one is the sanctioned way. */
  tokens: ReadonlySet<string>;
  /** Only styles.css may define colours, and only inside its two token blocks. */
  allowTokenBlocks: boolean;
}

interface Finding {
  line: number;
  message: string;
}

// ---------------------------------------------------------------------------
// What counts as a colour
// ---------------------------------------------------------------------------

const HEX = /(?<![A-Za-z0-9&-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])/i;

const COLOUR_FUNCTION = /(?<![A-Za-z0-9-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** CSS named colours. transparent and currentColor are left out: they take their colour from context, not from a value. */
const NAMED_COLOURS: ReadonlySet<string> = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
   burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
   darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
   darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
   deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
   ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
   lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
   lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
   lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
   mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
   mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab
   orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
   pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
   seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle
   tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/),
);

/** Tailwind's default palette families. Their utilities are literal colours unless a token of the same name exists. */
const PALETTE_SHADE = new RegExp(
  `^(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|taupe|mauve|olive|mist)-\\d{2,3}$`,
);

const WHITE_OR_BLACK = /^(?:white|black)$/;

/** Properties whose value is a colour, so a bare colour name in them is a colour. */
const COLOUR_PROPERTY =
  /color|background|border|outline|fill|stroke|shadow|decoration|caret|accent|column-rule|scrollbar|emphasis|flood|lighting|filter|mask/;

/** SVG and HTML attributes that take a colour as their value. */
const COLOUR_ATTRIBUTES: ReadonlySet<string> = new Set([
  'fill',
  'stroke',
  'color',
  'stopColor',
  'floodColor',
  'lightingColor',
]);

/** Tailwind utilities that paint with a colour. Longest first, so border-x wins over border. */
const COLOUR_UTILITIES = [
  'bg',
  'text',
  'text-shadow',
  'border',
  'border-x',
  'border-y',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'border-s',
  'border-e',
  'outline',
  'ring',
  'ring-offset',
  'inset-ring',
  'shadow',
  'inset-shadow',
  'drop-shadow',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'decoration',
  'accent',
  'caret',
  'divide',
  'placeholder',
].sort((a, b) => b.length - a.length);

/**
 * A declaration value. `property` decides whether a bare colour name counts: in
 * `color: red` it does, in `font-family: Red Hat` it does not. Custom properties
 * always count: a colour stored in one is a literal outside the token blocks.
 */
function valueFindings(property: string, value: string): string[] {
  const name = property.trim().toLowerCase();
  const found: string[] = [];

  const hex = HEX.exec(value);
  if (hex) found.push(`hex colour ${hex[0]}`);

  const colourFunction = COLOUR_FUNCTION.exec(value);
  if (colourFunction) found.push(`colour function ${colourFunction[0]}`);

  if (name.startsWith('--') || COLOUR_PROPERTY.test(name)) {
    const words = value
      .replace(/url\([^)]*\)/gi, ' ')
      .replace(/"[^"]*"|'[^']*'/g, ' ')
      .split(/[^A-Za-z-]+/);
    const named = words.find((word) => NAMED_COLOURS.has(word.toLowerCase()));
    if (named) found.push(`colour name ${named}`);
  }
  return found;
}

/** Splits `dark:hover:bg-x` at its top-level colons. Colons inside [...] or (...) belong to a value. */
function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of token) {
    if (char === '[' || char === '(') depth++;
    if (char === ']' || char === ')') depth = Math.max(0, depth - 1);
    if (char === ':' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** One whitespace-separated class name, such as `dark:hover:bg-[#fff]`. */
function classFindings(token: string, tokens: ReadonlySet<string>): string[] {
  const segments = splitVariants(token);
  const utility = (segments.pop() ?? '').replace(/^!|!$/g, '').replace(/^-/, '');
  const dark = segments.includes('dark');
  const found: string[] = [];
  let colour = false;

  const property = /^\[([a-z-]+):(.+)\]$/i.exec(utility);
  const prefix = COLOUR_UTILITIES.find((candidate) => utility.startsWith(`${candidate}-`));

  if (property) {
    // Arbitrary property, e.g. [color:red].
    colour = COLOUR_PROPERTY.test(property[1].toLowerCase());
    found.push(...valueFindings(property[1], property[2]));
  } else if (prefix) {
    const rest = utility.slice(prefix.length + 1);
    if (rest.startsWith('[')) {
      // Arbitrary value, e.g. bg-[#fff]. Lengths and urls under the same prefix are not colours, so they pass.
      const inner = valueFindings('color', rest.slice(1).replace(/\]$/, ''));
      colour = inner.length > 0;
      found.push(...inner);
    } else {
      const bare = rest.replace(/\/.*$/, ''); // opacity modifier: red-500/50
      if (tokens.has(bare)) {
        colour = true; // a token: the sanctioned way to paint
      } else if (PALETTE_SHADE.test(bare) || WHITE_OR_BLACK.test(bare) || NAMED_COLOURS.has(bare)) {
        colour = true;
        found.push(`literal colour "${bare}", use a colour token instead`);
      }
    }
  }

  if (dark && colour) found.push('dark: variant on a colour utility, which already flips with the OS');
  return found;
}

/** Everything a string literal can say about colour: colour text, a CSS declaration, or class names. */
function stringFindings(text: string, tokens: ReadonlySet<string>): string[] {
  const found = valueFindings('', text);
  const declaration = /^\s*(-{0,2}[a-z][a-z-]*)\s*:\s*([^;{}]+?)\s*;?\s*$/.exec(text);
  if (declaration) found.push(...valueFindings(declaration[1], declaration[2]));
  for (const token of text.split(/\s+/)) found.push(...classFindings(token, tokens));
  return found;
}

// ---------------------------------------------------------------------------
// Scanners: one per file type. Each returns findings with 1-based lines.
// ---------------------------------------------------------------------------

function isStringNode(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** `element.style.color` and friends: the object a CSS property is assigned on. */
function isStyleAccess(node: ts.PropertyAccessExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'style';
}

/** camelCase to kebab-case, so `backgroundColor` matches the `background-color` rules. */
function cssName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function scanScript(file: string, source: string, tokens: ReadonlySet<string>): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Finding[] = [];
  const report = (node: ts.Node, messages: string[]): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    for (const message of messages) found.push({ line, message });
  };

  const visit = (node: ts.Node): void => {
    if (isStringNode(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      report(node, stringFindings(node.text, tokens));
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      isStringNode(node.initializer)
    ) {
      // style={{ color: 'red' }}, and any object that carries a colour property.
      report(node, valueFindings(cssName(node.name.text), node.initializer.text));
    } else if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      COLOUR_ATTRIBUTES.has(node.name.text) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      // <svg fill="white" />
      report(node, valueFindings(cssName(node.name.text), node.initializer.text));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isStyleAccess(node.left) &&
      isStringNode(node.right)
    ) {
      // el.style.color = 'red'
      report(node, valueFindings(cssName(node.left.name.text), node.right.text));
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setProperty'
    ) {
      // el.style.setProperty('color', 'red')
      const [property, value] = node.arguments;
      if (property && value && isStringNode(property) && isStringNode(value)) {
        report(node, valueFindings(property.text, value.text));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** Blanks a span out while keeping its line breaks, so line numbers stay true. */
function blankOut(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** 1-based line number of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Index of the quote that closes the string opened at `start`. */
function closingQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start]) return i;
  }
  return text.length - 1;
}

/** Opening text of a block that holds colour tokens, the only place a literal is allowed. */
const TOKEN_BLOCK_PRELUDES = [/^@theme\s+static$/, /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/];

/**
 * A small CSS tokenizer: enough to see declarations, their nesting, and whether a
 * declaration sits inside an allowed token block. Selectors and at-rule preludes are
 * not declarations, so `#notes { }` and `:root:not(...)` are never mistaken for colour.
 */
function scanCss(source: string, options: ScanOptions): Finding[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, blankOut);
  const found: Finding[] = [];

  // One entry per open block: true when everything inside it is an allowed token block.
  const inTokenBlock: boolean[] = [false];
  let buffer = '';
  let bufferStart = -1;

  const append = (chunk: string, index: number): void => {
    if (bufferStart < 0 && chunk.trim() !== '') bufferStart = index + chunk.length - chunk.trimStart().length;
    buffer += chunk;
  };

  const flush = (): void => {
    const statement = buffer.trim();
    const start = bufferStart;
    buffer = '';
    bufferStart = -1;
    if (statement === '' || inTokenBlock[inTokenBlock.length - 1]) return;

    if (statement.startsWith('@apply')) {
      for (const token of statement.slice('@apply'.length).trim().split(/\s+/)) {
        for (const message of classFindings(token, options.tokens)) found.push({ line: lineOf(css, start), message });
      }
      return;
    }
    if (statement.startsWith('@')) return;

    const colon = statement.indexOf(':');
    if (colon < 0) return;
    for (const message of valueFindings(statement.slice(0, colon), statement.slice(colon + 1))) {
      found.push({ line: lineOf(css, start), message });
    }
  };

  let index = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === '"' || char === "'") {
      const end = closingQuote(css, index);
      append(css.slice(index, end + 1), index);
      index = end + 1;
      continue;
    }
    if (char === '{') {
      const prelude = buffer.trim().replace(/\s+/g, ' ');
      const parent = inTokenBlock[inTokenBlock.length - 1];
      inTokenBlock.push(
        parent || (options.allowTokenBlocks && TOKEN_BLOCK_PRELUDES.some((pattern) => pattern.test(prelude))),
      );
      buffer = '';
      bufferStart = -1;
    } else if (char === '}') {
      flush();
      if (inTokenBlock.length > 1) inTokenBlock.pop();
    } else if (char === ';') {
      flush();
    } else {
      append(char, index);
    }
    index++;
  }
  flush();
  return found;
}

/**
 * HTML: the <style> blocks go through the CSS scanner, style="" attributes through
 * the declaration check, and everything else (a theme-color meta, say) through the
 * plain hex and colour-function check. Comments are ignored.
 */
function scanMarkup(source: string, options: ScanOptions): Finding[] {
  const found: Finding[] = [];
  const uncommented = source.replace(/<!--[\s\S]*?-->/g, blankOut);

  const withoutStyleBlocks = uncommented.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match: string, open: string, body: string, close: string, offset: number) => {
      const base = lineOf(uncommented, offset + open.length) - 1;
      for (const finding of scanCss(body, options))
        found.push({ line: base + finding.line, message: finding.message });
      return open + blankOut(body) + close;
    },
  );

  const withoutAttributes = withoutStyleBlocks.replace(
    /\sstyle\s*=\s*"([^"]*)"/gi,
    (match: string, value: string, offset: number) => {
      const line = lineOf(withoutStyleBlocks, offset);
      for (const declaration of value.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 1) continue;
        for (const message of valueFindings(declaration.slice(0, colon), declaration.slice(colon + 1))) {
          found.push({ line, message });
        }
      }
      return blankOut(match);
    },
  );

  for (const match of withoutAttributes.matchAll(new RegExp(HEX.source, 'gi'))) {
    found.push({ line: lineOf(withoutAttributes, match.index ?? 0), message: `hex colour ${match[0]}` });
  }
  for (const match of withoutAttributes.matchAll(new RegExp(COLOUR_FUNCTION.source, 'gi'))) {
    found.push({ line: lineOf(withoutAttributes, match.index ?? 0), message: `colour function ${match[0]}` });
  }
  return found;
}

/**
 * Every colour literal in one file, as "file:line  what". Empty when the file is
 * clean or is a type this guard does not read.
 */
function findColourViolations(file: string, source: string, options: ScanOptions): string[] {
  let found: Finding[];
  if (/\.(?:ts|tsx)$/.test(file)) found = scanScript(file, source, options.tokens);
  else if (file.endsWith('.css')) found = scanCss(source, options);
  else if (file.endsWith('.html')) found = scanMarkup(source, options);
  else return [];

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.line - b.line)
    .filter((finding) => {
      const key = `${finding.line}|${finding.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((finding) => `${file}:${finding.line}  ${finding.message}`);
}

/** Every renderer file this guard reads, as repo-relative paths with forward slashes. */
function rendererSources(): string[] {
  return readdirSync(join(REPO_ROOT, 'src', 'renderer'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => SCANNED_EXTENSIONS.has(extname(entry)))
    .map((entry) => `src/renderer/${entry.split(sep).join('/')}`)
    .sort();
}

const liveTokens: ReadonlySet<string> = new Set(themeColourTokens(readStylesCss()).light);

describe('the renderer paints with colour tokens only', () => {
  it('reads the renderer it is meant to read', () => {
    const sources = rendererSources();
    expect(sources).toContain('src/renderer/App.tsx');
    expect(sources).toContain(STYLES_CSS);
  });

  it('has no colour literal outside the two token blocks of styles.css', () => {
    const violations = rendererSources().flatMap((file) =>
      findColourViolations(file, readFileSync(join(REPO_ROOT, file), 'utf8'), {
        tokens: liveTokens,
        allowTokenBlocks: file === STYLES_CSS,
      }),
    );
    expect(violations).toEqual([]);
  });
});

describe('the detector', () => {
  const tokens: ReadonlySet<string> = new Set(['bg', 'bg-raised', 'text', 'text-muted', 'border', 'accent']);
  const flagged = (file: string, source: string, allowTokenBlocks = false): string[] =>
    findColourViolations(file, source, { tokens, allowTokenBlocks });

  it.each([
    { what: 'an arbitrary hex class', file: 'Card.tsx', source: '<div className="bg-[#fff]" />' },
    { what: 'an arbitrary rgb class', file: 'Card.tsx', source: '<p className="text-[rgb(0,0,0)]" />' },
    { what: 'an arbitrary colour name', file: 'Card.tsx', source: '<p className="text-[red]" />' },
    { what: 'a hex inside an arbitrary shadow', file: 'Card.tsx', source: '<p className="shadow-[0_1px_#0003]" />' },
    { what: 'an arbitrary colour property', file: 'Card.tsx', source: '<p className="[color:red]" />' },
    { what: 'the white utility', file: 'Card.tsx', source: '<p className="text-white">x</p>' },
    { what: 'the black utility with opacity', file: 'Card.tsx', source: '<p className="bg-black/50" />' },
    { what: 'a palette utility', file: 'Card.tsx', source: '<p className="text-red-500" />' },
    {
      what: 'a palette utility in a class helper',
      file: 'Card.tsx',
      source: "<p className={cn('px-2', 'bg-white')} />",
    },
    { what: 'a hover palette utility', file: 'Card.tsx', source: '<p className="hover:bg-slate-200" />' },
    { what: 'a dark: variant on a token', file: 'Card.tsx', source: '<p className="dark:text-text" />' },
    { what: 'a dark: variant on a token with opacity', file: 'Card.tsx', source: '<p className="dark:bg-bg/50" />' },
    { what: 'a dark: variant on a palette utility', file: 'Card.tsx', source: '<p className="dark:bg-gray-900" />' },
    { what: 'a colour name in an inline style', file: 'Card.tsx', source: "<p style={{ color: 'red' }} />" },
    { what: 'a hex in an inline style', file: 'Card.tsx', source: "<p style={{ backgroundColor: '#fff' }} />" },
    { what: 'an assignment to element.style', file: 'Card.tsx', source: "el.style.color = 'red';" },
    { what: 'a setProperty colour', file: 'Card.tsx', source: "el.style.setProperty('color', 'red');" },
    { what: 'a fill attribute colour name', file: 'Card.tsx', source: '<svg><rect fill="white" /></svg>' },
    { what: 'a stroke attribute hex', file: 'Card.tsx', source: '<svg><path stroke="#000" /></svg>' },
    { what: 'a bare hex string', file: 'Card.tsx', source: "const accent = '#2f6df6';" },
    { what: 'a colour function string', file: 'Card.tsx', source: "const shade = 'rgba(0, 0, 0, 0.5)';" },
    { what: 'a hex in a CSS declaration string', file: 'Card.tsx', source: "const css = 'border: 1px solid #fff';" },
    { what: 'a hex in a template literal', file: 'Card.tsx', source: 'const c = `#fff`;' },
    { what: 'a hex in a stylesheet', file: 'Card.css', source: '.card { color: #fff; }' },
    { what: 'a 4-digit hex with alpha', file: 'Card.css', source: '.card { color: #fff8; }' },
    { what: 'a named colour on a border', file: 'Card.css', source: '.card { border-color: white; }' },
    { what: 'an rgb function', file: 'Card.css', source: '.card { background: rgb(0 0 0 / 50%); }' },
    { what: 'a named colour in a shadow', file: 'Card.css', source: '.card { box-shadow: 0 1px 2px red; }' },
    { what: 'a hex in a custom property', file: 'Card.css', source: '.card { --surface: #fff; }' },
    { what: 'a palette class in @apply', file: 'Card.css', source: '.card { @apply bg-white; }' },
    { what: 'a token block outside styles.css', file: 'Card.css', source: '@theme static { --color-bg: #fff; }' },
    {
      what: 'a dark media block outside styles.css',
      file: 'Card.css',
      source: '@media (prefers-color-scheme: dark) { .card { color: #fff } }',
    },
    {
      what: 'a theme-color meta',
      file: 'index.html',
      source: '<meta name="theme-color" content="#101010" />',
    },
    { what: 'a colour in a style attribute', file: 'index.html', source: '<div style="color: red"></div>' },
  ])('flags $what', ({ file, source }) => {
    expect(flagged(file, source).length).toBeGreaterThan(0);
  });

  it.each([
    { what: 'token classes', file: 'Card.tsx', source: '<div className="bg-bg text-text-muted border-border" />' },
    {
      what: 'token classes with opacity and state',
      file: 'Card.tsx',
      source: '<p className="bg-bg/50 hover:text-text" />',
    },
    {
      what: 'layout and type utilities',
      file: 'Card.tsx',
      source: '<p className="text-sm text-center font-medium" />',
    },
    { what: 'a dark: variant on a non-colour utility', file: 'Card.tsx', source: '<p className="dark:invert" />' },
    { what: 'a var() colour in a style', file: 'Card.tsx', source: "<p style={{ color: 'var(--color-text)' }} />" },
    { what: 'a currentColor fill', file: 'Card.tsx', source: '<svg fill="currentColor" />' },
    {
      what: 'a colour in a comment',
      file: 'Card.tsx',
      source: '// color: #fff and text-white are not code\nconst a = 1;',
    },
    {
      what: 'prose with colour words',
      file: 'Card.tsx',
      source: "const label = 'Black Friday, white space and red tape';",
    },
    { what: 'white-space', file: 'Card.tsx', source: "const wrap = 'white-space nowrap';" },
    {
      what: 'a length arbitrary value',
      file: 'Card.tsx',
      source: '<p className="text-[13px] bg-[url(/hero.png)]" />',
    },
    { what: 'a non-colour arbitrary property', file: 'Card.tsx', source: '<p className="[mask-type:luminance]" />' },
    {
      what: 'a dynamic class',
      file: 'Card.tsx',
      source: '<p className={`dark:${mode} text-${tone}`} />',
    },
    {
      what: 'token declarations inside styles.css',
      file: STYLES_CSS,
      source: '@theme static { --color-bg: #fff; --font-sans: system-ui; }',
      allowTokenBlocks: true,
    },
    {
      what: 'the dark token block inside styles.css',
      file: STYLES_CSS,
      source: '@media (prefers-color-scheme: dark) { :root { --color-bg: #000; } }',
      allowTokenBlocks: true,
    },
    { what: 'a selector that looks like a hex id', file: 'Card.css', source: '#fff { margin: 0; }' },
    {
      what: 'a non-colour declaration',
      file: 'Card.css',
      source: '.card { white-space: nowrap; color: var(--color-text); }',
    },
    { what: 'a colour in a CSS comment', file: 'Card.css', source: '/* color: #fff; */ .card { margin: 0; }' },
    {
      what: 'a @layer and nested rules',
      file: 'Card.css',
      source: '@layer base { body { color: var(--color-text); } }',
    },
    {
      what: 'a markup with a CSP and an entity',
      file: 'index.html',
      source: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'" /><p>&#8230;</p>`,
    },
  ])('passes $what', ({ file, source, allowTokenBlocks }) => {
    expect(flagged(file, source, allowTokenBlocks === true)).toEqual([]);
  });

  it('reports the file and line of each finding', () => {
    expect(flagged('Card.tsx', '\n\n<p className="text-white" />')).toEqual([
      'Card.tsx:3  literal colour "white", use a colour token instead',
    ]);
  });
});
