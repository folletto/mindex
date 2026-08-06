/**
 * Forward-only migration runner.
 *
 * Migrations are numbered `.sql` files applied in order inside a single
 * `BEGIN EXCLUSIVE` transaction, with `PRAGMA user_version` as the ledger.
 * SQLite makes DDL transactional, so a failed migration leaves the database
 * exactly as it was.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Find the migrations folder in both layouts we run under: straight from
 * `src/` in dev and tests, and next to the bundle in a packaged app (where a
 * Vite plugin copies the `.sql` files alongside the output).
 */
function migrationsDir(): string {
  const here = moduleDir();
  const candidates = [join(here, 'migrations'), join(here, 'db', 'migrations'), join(here, '..', 'migrations')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate the migrations folder (looked in: ${candidates.join(', ')})`);
}

let cached: Migration[] | null = null;

export function loadMigrations(): Migration[] {
  if (cached) return cached;

  const dir = migrationsDir();
  const migrations: Migration[] = [];

  for (const file of readdirSync(dir).sort()) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) continue;
    migrations.push({
      version: Number(match[1]),
      name: match[2],
      sql: readFileSync(join(dir, file), 'utf8'),
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration numbering has a gap or duplicate at ${migration.version} (${migration.name})`);
    }
  });

  cached = migrations;
  return migrations;
}

/** The newest schema this build of the app knows how to run. */
export function appSchemaVersion(): number {
  const migrations = loadMigrations();
  return migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
}

export function schemaVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Thrown when a library was upgraded by a newer build of the app. Two machines
 * will not update on the same day, so this is a correctness requirement, not a
 * nicety: the older app must degrade to read-only rather than write a shape the
 * newer schema does not expect.
 */
export class NewerSchemaError extends Error {
  readonly libraryVersion: number;
  readonly appVersion: number;

  constructor(libraryVersion: number, appVersion: number) {
    super(
      `This library uses schema ${libraryVersion}, but this version of Mindex only understands ${appVersion}. ` +
        'Update Mindex on this machine to make changes.',
    );
    this.name = 'NewerSchemaError';
    this.libraryVersion = libraryVersion;
    this.appVersion = appVersion;
  }
}

export interface MigrateOptions {
  /** Path to the database file, used to write a backup before a real upgrade. */
  dbPath?: string;
  /** Set false in tests that do not care about the .bak files. */
  backup?: boolean;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
  backupPath: string | null;
}

/**
 * Bring `db` up to the newest schema this app knows.
 *
 * Throws {@link NewerSchemaError} if the library is ahead of us; callers turn
 * that into read-only mode rather than a crash.
 */
export function migrate(db: Database, options: MigrateOptions = {}): MigrateResult {
  const migrations = loadMigrations();
  const target = appSchemaVersion();
  const current = schemaVersion(db);

  if (current > target) throw new NewerSchemaError(current, target);
  if (current === target) return { from: current, to: current, applied: [], backupPath: null };

  const pending = migrations.filter((migration) => migration.version > current);

  // Back up before touching an existing library. A fresh one has nothing worth
  // keeping, and skipping the copy keeps first-launch quiet.
  let backupPath: string | null = null;
  if (options.backup !== false && current > 0 && options.dbPath && existsSync(options.dbPath)) {
    backupPath = `${options.dbPath}.bak-${current}`;
    copyFileSync(options.dbPath, backupPath);
  }

  db.exec('BEGIN EXCLUSIVE');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      // user_version takes a literal, not a binding. `version` comes from a
      // filename matched against \d{3}, so it cannot carry anything else.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback of an already-rolled-back transaction; the original error wins.
    }
    throw error;
  }

  return {
    from: current,
    to: target,
    applied: pending.map((migration) => migration.version),
    backupPath,
  };
}
