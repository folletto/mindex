/**
 * Database connection and the write discipline that makes concurrent instances
 * safe.
 *
 * The rules enforced here, all of which have tests in tests/concurrency:
 * - every write runs in `BEGIN IMMEDIATE`, never a deferred transaction that
 *   tries to upgrade mid-flight (the classic route to an unrecoverable BUSY);
 * - transactions are short and machine-driven — never spanning user input, a
 *   file copy or an IPC round-trip;
 * - contention is waited out (busy_timeout) and then retried with jittered
 *   backoff before the user ever hears about it;
 * - reads never hold a snapshot open.
 */

import SQLite, { type Database } from 'better-sqlite3';
import { retrySync, type BackoffOptions } from '../../shared/backoff.js';
import type { JournalMode } from '../../shared/types.js';

/**
 * SQLite result codes that mean "someone else is writing, try again", as
 * opposed to "this statement is wrong".
 */
const RETRYABLE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  // Raised under rollback-journal contention when several processes retry at
  // once; SQLite's own docs say to treat it as a busy condition.
  'SQLITE_PROTOCOL',
]);

export function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

export const BUSY_TIMEOUT_MS = 10_000;

export interface OpenOptions {
  journalMode: JournalMode;
  readOnly?: boolean;
  busyTimeoutMs?: number;
}

export function openDatabase(dbPath: string, options: OpenOptions): Database {
  const db = new SQLite(dbPath, { readonly: options.readOnly ?? false, fileMustExist: false });

  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? BUSY_TIMEOUT_MS}`);

  if (!options.readOnly) {
    // WAL needs shared memory, which network and file-sync filesystems do not
    // provide; library.ts picks the mode from where the folder actually lives.
    db.pragma(`journal_mode = ${options.journalMode}`);
  }

  // Durability over throughput. Writes here are tiny and rare, and the folder
  // may be under a sync client that copies whatever it finds on disk.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  return db;
}

/** Report the journal mode the file is actually in, which may differ from the request. */
export function effectiveJournalMode(db: Database): string {
  return String(db.pragma('journal_mode', { simple: true })).toLowerCase();
}

/**
 * Changes whenever *another* connection commits. Cheap enough to poll, and it
 * does no I/O, which is why it beats watching the file.
 */
export function dataVersion(db: Database): number {
  return db.pragma('data_version', { simple: true }) as number;
}

export class WriteContentionError extends Error {
  constructor(cause: unknown) {
    super('Could not save — another copy of Mindex is writing to this library.', { cause });
    this.name = 'WriteContentionError';
  }
}

/**
 * Run `work` inside an immediate write transaction, retrying on contention.
 *
 * `work` must contain no filesystem or network side effects: on a retry it runs
 * again from the top. The service layer sequences file operations around this
 * call, never inside it.
 */
export function withWrite<T>(db: Database, work: (db: Database) => T, backoff?: BackoffOptions): T {
  try {
    return retrySync(
      () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = work(db);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          if (db.inTransaction) {
            try {
              db.exec('ROLLBACK');
            } catch {
              // Already unwound by SQLite; the original error is the useful one.
            }
          }
          throw error;
        }
      },
      isBusyError,
      backoff,
    );
  } catch (error) {
    if (isBusyError(error) || (error as { name?: string })?.name === 'RetryExhaustedError') {
      throw new WriteContentionError(error);
    }
    throw error;
  }
}

/**
 * Read helper. Deliberately not a transaction: a list query that held a
 * snapshot open would block the WAL from checkpointing and starve other writers.
 */
export function read<T>(db: Database, work: (db: Database) => T): T {
  return work(db);
}

/** Flush the WAL back into the main file so the folder is safe to copy or sync. */
export function closeDatabase(db: Database): void {
  try {
    if (!db.readonly && effectiveJournalMode(db) === 'wal') {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } catch {
    // Checkpointing is best-effort; a locked database still closes cleanly.
  }
  db.close();
}
