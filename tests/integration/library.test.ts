/**
 * Library initialization matrix.
 *
 * The rule under test throughout: Mindex never writes into a folder the user
 * did not sanction. Every case snapshots the folder before and after.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFolder, createLibraryIn, isLibrary, openLibrary, readMarker, probeWritable } from '../../src/main/library.js';
import { appSchemaVersion } from '../../src/main/db/migrations.js';
import { cleanupTempDirs, makeTempDir, snapshotTree } from '../helpers/temp.js';

afterEach(() => {
  cleanupTempDirs();
});

describe('classifyFolder', () => {
  it('calls a missing folder missing', () => {
    expect(classifyFolder(join(makeTempDir(), 'nope')).kind).toBe('missing');
  });

  it('calls an empty folder empty', () => {
    expect(classifyFolder(makeTempDir()).kind).toBe('empty');
  });

  it('ignores the noise files an OS leaves behind', () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.DS_Store'), 'junk');
    writeFileSync(join(root, 'Thumbs.db'), 'junk');
    writeFileSync(join(root, '.localized'), '');
    expect(classifyFolder(root).kind).toBe('empty');
  });

  it('calls a folder with a real file foreign', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'taxes.pdf'), 'not yours');
    const result = classifyFolder(root);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.entries).toContain('taxes.pdf');
  });

  it('calls a real library a library', () => {
    const root = makeTempDir();
    openLibrary(root, { initialize: true }).close();
    const result = classifyFolder(root);
    expect(result.kind).toBe('library');
    if (result.kind === 'library') expect(result.schema).toBe(appSchemaVersion());
  });

  it('treats a database without a marker as foreign, not as a library', () => {
    // Half-written or hand-damaged. Guessing here would mean overwriting.
    const root = makeTempDir();
    writeFileSync(join(root, 'catalogue.db'), 'not really a database');
    expect(classifyFolder(root).kind).toBe('foreign');
  });

  it('treats a marker without a database as foreign', () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.catalogue-library'), '{"app":"mindex","schema":1}');
    expect(classifyFolder(root).kind).toBe('foreign');
  });

  it('reports a file where a folder was expected', () => {
    const root = makeTempDir();
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    const result = classifyFolder(file);
    expect(result.kind).toBe('unwritable');
  });
});

describe('openLibrary — initialization', () => {
  it('creates the whole contract in an empty folder', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true });

    expect(existsSync(library.paths.dbPath)).toBe(true);
    expect(existsSync(library.paths.dataDir)).toBe(true);
    expect(existsSync(library.paths.markerPath)).toBe(true);
    expect(library.schema).toBe(appSchemaVersion());
    expect(library.readOnly).toBe(false);

    const marker = readMarker(library.paths.markerPath);
    expect(marker).toMatchObject({ app: 'mindex', schema: appSchemaVersion() });

    library.close();
  });

  it('does not create a deleted/ folder until something is deleted', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true });
    expect(existsSync(library.paths.deletedDir)).toBe(false);
    library.close();
  });

  it('refuses an empty folder when not asked to initialize', () => {
    const root = makeTempDir();
    const before = snapshotTree(root);
    expect(() => openLibrary(root, { initialize: false })).toThrow(/not a Mindex library/);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('refuses a foreign folder and writes nothing into it', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'taxes.pdf'), 'not yours');
    const before = snapshotTree(root);

    expect(() => openLibrary(root, { initialize: true })).toThrow(/already contains other files/);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('refuses a folder that does not exist', () => {
    expect(() => openLibrary(join(makeTempDir(), 'gone'), { initialize: true })).toThrow(/no longer exists/);
  });

  it('reopens an existing library without re-running migrations', () => {
    const root = makeTempDir();
    const first = openLibrary(root, { initialize: true });
    const created = readMarker(first.paths.markerPath)?.createdAt;
    first.close();

    const second = openLibrary(root);
    expect(second.schema).toBe(appSchemaVersion());
    // createdAt is the library's birthday, not this session's.
    expect(readMarker(second.paths.markerPath)?.createdAt).toBe(created);
    second.close();
  });

  it('creates a subfolder library when asked', () => {
    const parent = makeTempDir();
    writeFileSync(join(parent, 'taxes.pdf'), 'not yours');

    const library = createLibraryIn(parent, 'Catalogue');
    expect(library.paths.root).toBe(join(parent, 'Catalogue'));
    expect(existsSync(library.paths.dbPath)).toBe(true);
    // The parent is untouched apart from the new folder.
    expect(existsSync(join(parent, 'taxes.pdf'))).toBe(true);
    library.close();
  });

  it('honours an explicit journal mode', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true, journalMode: 'truncate' });
    expect(library.journalMode).toBe('truncate');
    expect(readMarker(library.paths.markerPath)?.journalMode).toBe('truncate');
    library.close();
  });

  it('uses WAL on a local disk by default', () => {
    const library = openLibrary(makeTempDir(), { initialize: true });
    expect(library.journalMode).toBe('wal');
    library.close();
  });

  it('remembers the journal mode across sessions', () => {
    const root = makeTempDir();
    openLibrary(root, { initialize: true, journalMode: 'truncate' }).close();
    const reopened = openLibrary(root);
    expect(reopened.journalMode).toBe('truncate');
    reopened.close();
  });
});

describe('openLibrary — a library from a newer app', () => {
  it('opens read-only rather than writing a shape it does not understand', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true });
    library.db.pragma(`user_version = ${appSchemaVersion() + 5}`);
    library.close();

    const reopened = openLibrary(root);
    expect(reopened.readOnly).toBe(true);
    expect(reopened.readOnlyReason).toMatch(/newer|only understands/i);
    expect(reopened.schema).toBe(appSchemaVersion() + 5);
    reopened.close();
  });

  it('leaves the marker file alone while read-only', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true });
    library.db.pragma(`user_version = ${appSchemaVersion() + 5}`);
    library.close();

    const markerBefore = readFileSync(join(root, '.catalogue-library'), 'utf8');
    const reopened = openLibrary(root);
    reopened.close();
    expect(readFileSync(join(root, '.catalogue-library'), 'utf8')).toBe(markerBefore);
  });
});

describe('probeWritable', () => {
  it('confirms a normal folder and leaves no probe behind', () => {
    const root = makeTempDir();
    expect(probeWritable(root).ok).toBe(true);
    expect(snapshotTree(root)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reports a read-only folder rather than crashing later',
    () => {
      const root = makeTempDir();
      const locked = join(root, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        expect(probeWritable(locked).ok).toBe(false);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});

describe('a library folder that disappears mid-session', () => {
  it('is reported as missing on the next classification', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true });
    expect(isLibrary(root)).toBe(true);
    library.close();

    rmSync(root, { recursive: true, force: true });
    expect(classifyFolder(root).kind).toBe('missing');
    expect(isLibrary(root)).toBe(false);
  });
});

describe('readMarker', () => {
  it('returns null for a marker that belongs to another app', () => {
    const root = makeTempDir();
    const marker = join(root, '.catalogue-library');
    writeFileSync(marker, '{"app":"something-else"}');
    expect(readMarker(marker)).toBeNull();
  });

  it('returns null for unparseable json rather than throwing', () => {
    const root = makeTempDir();
    const marker = join(root, '.catalogue-library');
    writeFileSync(marker, '{ this is not json');
    expect(readMarker(marker)).toBeNull();
  });

  it('fills in defaults for a marker missing fields', () => {
    const root = makeTempDir();
    const marker = join(root, '.catalogue-library');
    writeFileSync(marker, '{"app":"mindex"}');
    expect(readMarker(marker)).toMatchObject({ app: 'mindex', schema: 0, journalMode: 'wal' });
  });
});
