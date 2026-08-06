/**
 * Path containment is the security boundary between renderer input and the
 * filesystem, so it gets adversarial cases rather than happy ones.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolve, sep } from 'node:path';
import {
  PathEscapeError,
  assertContained,
  isContained,
  itemFolder,
  libraryPaths,
  resolveInside,
  trashFolderName,
} from '../../src/main/paths.js';
import { sanitizeFilename } from '../../src/shared/filenames.js';

const ROOT = resolve('/tmp/mindex-library');

describe('libraryPaths', () => {
  it('derives every path from the root', () => {
    const paths = libraryPaths(ROOT);
    expect(paths.root).toBe(ROOT);
    expect(paths.dbPath).toBe(resolve(ROOT, 'catalogue.db'));
    expect(paths.dataDir).toBe(resolve(ROOT, 'data'));
    expect(paths.deletedDir).toBe(resolve(ROOT, 'deleted'));
    expect(paths.markerPath).toBe(resolve(ROOT, '.catalogue-library'));
    expect(paths.lockPath).toBe(resolve(ROOT, '.catalogue-lock'));
  });

  it('normalizes a relative root to an absolute one', () => {
    expect(libraryPaths('.').root).toBe(resolve('.'));
  });
});

describe('isContained', () => {
  it('accepts the root itself and things inside it', () => {
    expect(isContained(ROOT, ROOT)).toBe(true);
    expect(isContained(ROOT, resolve(ROOT, 'data'))).toBe(true);
    expect(isContained(ROOT, resolve(ROOT, 'data/widget/manual.pdf'))).toBe(true);
  });

  it('rejects anything above the root', () => {
    expect(isContained(ROOT, resolve(ROOT, '..'))).toBe(false);
    expect(isContained(ROOT, resolve(ROOT, '../elsewhere'))).toBe(false);
    expect(isContained(ROOT, resolve('/etc/passwd'))).toBe(false);
  });

  it('rejects a sibling whose name starts with the root name', () => {
    // The classic prefix bug: "/tmp/mindex-library-2" starts with the root
    // string but is not inside it.
    expect(isContained(ROOT, `${ROOT}-2`)).toBe(false);
    expect(isContained(ROOT, `${ROOT}-evil/file.txt`)).toBe(false);
  });

  it('collapses traversal segments before deciding', () => {
    expect(isContained(ROOT, resolve(ROOT, 'data/../../outside'))).toBe(false);
    expect(isContained(ROOT, resolve(ROOT, 'data/../data/widget'))).toBe(true);
  });
});

describe('assertContained', () => {
  it('returns the resolved path when it is inside', () => {
    expect(assertContained(ROOT, resolve(ROOT, 'data'))).toBe(resolve(ROOT, 'data'));
  });

  it('throws for an escape', () => {
    expect(() => assertContained(ROOT, '/etc/passwd')).toThrow(PathEscapeError);
  });
});

describe('resolveInside', () => {
  it('joins a single safe segment', () => {
    expect(resolveInside(ROOT, 'data', 'widget')).toBe(resolve(ROOT, 'data', 'widget'));
  });

  it('refuses a segment that contains a separator', () => {
    expect(() => resolveInside(ROOT, 'a/b')).toThrow(PathEscapeError);
    expect(() => resolveInside(ROOT, 'a\\b')).toThrow(PathEscapeError);
  });

  it('refuses a traversal segment', () => {
    expect(() => resolveInside(ROOT, '..')).toThrow(PathEscapeError);
    expect(() => resolveInside(ROOT, '..', '..', 'etc')).toThrow(PathEscapeError);
  });

  it('cannot be escaped by any sanitized filename', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 100 }), (input) => {
        const folder = resolve(ROOT, 'data', 'widget');
        const resolved = resolveInside(folder, sanitizeFilename(input));
        expect(resolved.startsWith(folder + sep)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('itemFolder', () => {
  it('places an item under data/', () => {
    expect(itemFolder(libraryPaths(ROOT), 'acme-widget')).toBe(resolve(ROOT, 'data', 'acme-widget'));
  });

  it('refuses a slug that somehow contains a separator', () => {
    expect(() => itemFolder(libraryPaths(ROOT), '../../etc')).toThrow(PathEscapeError);
  });
});

describe('trashFolderName', () => {
  it('appends a sortable UTC timestamp', () => {
    expect(trashFolderName('old-thing', new Date('2026-08-06T14:15:30Z'))).toBe('old-thing--20260806-141530');
  });

  it('produces a different name for each second, so cycles never collide', () => {
    const first = trashFolderName('thing', new Date('2026-08-06T14:15:30Z'));
    const second = trashFolderName('thing', new Date('2026-08-06T14:15:31Z'));
    expect(first).not.toBe(second);
  });

  it('produces a name that is still a single safe path segment', () => {
    const name = trashFolderName('acme-widget', new Date('2026-01-02T03:04:05Z'));
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(() => resolveInside(ROOT, name)).not.toThrow();
  });
});
