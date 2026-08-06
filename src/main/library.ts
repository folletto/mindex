/**
 * Opening, classifying and initialising a library folder.
 *
 * The governing rule: never write into a folder the user did not intend as a
 * library. Classification happens first and separately, and a folder that is
 * non-empty but not a library is refused rather than adopted.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FolderClassification, JournalMode, LibraryMarker, StorageKind } from '../shared/types.js';
import { closeDatabase, effectiveJournalMode, openDatabase } from './db/connection.js';
import { NewerSchemaError, appSchemaVersion, migrate, schemaVersion } from './db/migrations.js';
import { LockHolder, describeLock, inspectLock } from './lock.js';
import { DB_FILENAME, libraryPaths, type LibraryPaths } from './paths.js';
import { detectStorageKind, journalModeFor } from './storage.js';

/**
 * Files that do not count as "this folder is in use". Everything else does,
 * including a single stray document.
 */
const IGNORABLE_ENTRIES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized', '.directory']);

function meaningfulEntries(dir: string): string[] {
  return readdirSync(dir).filter((entry) => !IGNORABLE_ENTRIES.has(entry.toLowerCase()));
}

export function readMarker(markerPath: string): LibraryMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const marker = parsed as Partial<LibraryMarker>;
    if (marker.app !== 'mindex') return null;
    return {
      app: 'mindex',
      schema: typeof marker.schema === 'number' ? marker.schema : 0,
      journalMode: marker.journalMode === 'truncate' ? 'truncate' : 'wal',
      storageKind: (['local', 'network', 'sync'] as StorageKind[]).includes(marker.storageKind as StorageKind)
        ? (marker.storageKind as StorageKind)
        : 'local',
      createdAt: typeof marker.createdAt === 'string' ? marker.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeMarker(markerPath: string, marker: LibraryMarker): void {
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/**
 * Can we actually write here? Checked with a real probe file rather than by
 * reading permission bits, which lie on network shares and on Windows.
 */
export function probeWritable(dir: string): { ok: true } | { ok: false; reason: string } {
  const probe = join(dir, `.mindex-write-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, 'probe', 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // If the probe cannot be removed the folder is unusable anyway, and the
      // write above will already have reported why.
    }
  }
}

/**
 * Decide what a folder is before touching it.
 */
export function classifyFolder(root: string): FolderClassification {
  if (!existsSync(root)) return { kind: 'missing' };

  let stats;
  try {
    stats = statSync(root);
  } catch (error) {
    return { kind: 'unwritable', reason: (error as Error).message };
  }
  if (!stats.isDirectory()) return { kind: 'unwritable', reason: 'That path is a file, not a folder.' };

  try {
    accessSync(root, constants.R_OK);
  } catch (error) {
    return { kind: 'unwritable', reason: (error as Error).message };
  }

  const paths = libraryPaths(root);
  const hasMarker = existsSync(paths.markerPath);
  const hasDb = existsSync(paths.dbPath);

  if (hasMarker && hasDb) {
    const marker = readMarker(paths.markerPath);
    return { kind: 'library', schema: marker?.schema ?? 0, marker };
  }

  let entries: string[];
  try {
    entries = meaningfulEntries(root);
  } catch (error) {
    return { kind: 'unwritable', reason: (error as Error).message };
  }

  if (entries.length === 0) return { kind: 'empty' };

  // A database without a marker, or a marker without a database, is a
  // half-written or hand-damaged library. Treat it as foreign so the user
  // decides, rather than guessing and overwriting.
  return { kind: 'foreign', entries: entries.slice(0, 20) };
}

export interface Library {
  paths: LibraryPaths;
  db: Database;
  marker: LibraryMarker;
  schema: number;
  appSchema: number;
  journalMode: JournalMode;
  storageKind: StorageKind;
  readOnly: boolean;
  readOnlyReason?: string;
  close(): void;
}

export class LibraryOpenError extends Error {
  readonly classification?: FolderClassification;

  constructor(message: string, classification?: FolderClassification) {
    super(message);
    this.name = 'LibraryOpenError';
    this.classification = classification;
  }
}

export interface OpenLibraryOptions {
  /** Create the library when the folder is empty. Off for plain "open". */
  initialize?: boolean;
  /** Override the auto-detected journal mode (Settings exposes this). */
  journalMode?: JournalMode;
  /** Sync-folder lock handling. Off for tests and for child processes. */
  useLock?: boolean;
  /** Open even though another host holds the lock. */
  takeOverLock?: boolean;
  now?: () => Date;
}

/**
 * Open (and optionally create) the library at `root`.
 *
 * Ordering matters here: classify, probe, then decide the journal mode from the
 * storage type, then take the advisory lock, and only then open the database.
 */
export function openLibrary(root: string, options: OpenLibraryOptions = {}): Library {
  const paths = libraryPaths(root);
  const classification = classifyFolder(paths.root);

  if (classification.kind === 'missing') {
    throw new LibraryOpenError(`The folder ${paths.root} no longer exists.`, classification);
  }
  if (classification.kind === 'unwritable') {
    throw new LibraryOpenError(`Cannot use ${paths.root}: ${classification.reason}`, classification);
  }
  if (classification.kind === 'foreign') {
    throw new LibraryOpenError(
      `${paths.root} already contains other files, so Mindex will not turn it into a library. ` +
        'Pick an empty folder, or let Mindex create a subfolder here.',
      classification,
    );
  }
  if (classification.kind === 'empty' && !options.initialize) {
    throw new LibraryOpenError(`${paths.root} is empty — it is not a Mindex library yet.`, classification);
  }

  const writable = probeWritable(paths.root);
  const storageKind = detectStorageKind(paths.root);

  const existingMarker = classification.kind === 'library' ? classification.marker : null;
  const journalMode: JournalMode = options.journalMode ?? existingMarker?.journalMode ?? journalModeFor(storageKind);

  // --- advisory lock, sync folders only ---
  let lockHolder: LockHolder | null = null;
  let readOnly = !writable.ok;
  let readOnlyReason = writable.ok ? undefined : `The folder is not writable: ${writable.reason}`;

  if (options.useLock && storageKind === 'sync' && writable.ok) {
    const check = inspectLock(paths.lockPath, options.now?.() ?? new Date());
    if (check.state === 'held-by-other' && !options.takeOverLock) {
      readOnly = true;
      readOnlyReason = `${describeLock(check.lock)}. Mindex opened it read-only to avoid a conflicted copy.`;
    } else {
      lockHolder = new LockHolder(paths.lockPath);
      lockHolder.acquire();
    }
  }

  const db = openDatabase(paths.dbPath, { journalMode, readOnly });

  let schema: number;
  try {
    if (readOnly) {
      schema = schemaVersion(db);
      if (schema > appSchemaVersion()) {
        readOnlyReason = new NewerSchemaError(schema, appSchemaVersion()).message;
      }
    } else {
      const result = migrate(db, { dbPath: paths.dbPath });
      schema = result.to;
    }
  } catch (error) {
    if (error instanceof NewerSchemaError) {
      // Degrade instead of failing: the user can still read their catalogue
      // while they update this machine.
      readOnly = true;
      readOnlyReason = error.message;
      schema = schemaVersion(db);
    } else {
      closeDatabase(db);
      lockHolder?.release();
      throw error;
    }
  }

  const marker: LibraryMarker = {
    app: 'mindex',
    schema,
    journalMode: (effectiveJournalMode(db) === 'wal' ? 'wal' : 'truncate') as JournalMode,
    storageKind,
    createdAt: existingMarker?.createdAt ?? new Date().toISOString(),
  };

  if (!readOnly) {
    mkdirSync(paths.dataDir, { recursive: true });
    writeMarker(paths.markerPath, marker);
  }

  return {
    paths,
    db,
    marker,
    schema,
    appSchema: appSchemaVersion(),
    journalMode: marker.journalMode,
    storageKind,
    readOnly,
    readOnlyReason,
    close() {
      closeDatabase(db);
      lockHolder?.release();
    },
  };
}

/**
 * Create a fresh library in a new subfolder of `parent`. This is the escape
 * hatch offered when the user picks a folder that already has files in it.
 */
export function createLibraryIn(parent: string, name: string, options: OpenLibraryOptions = {}): Library {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  return openLibrary(root, { ...options, initialize: true });
}

/** True when this folder is a library we could open right now. */
export function isLibrary(root: string): boolean {
  return classifyFolder(root).kind === 'library';
}

export { DB_FILENAME };
