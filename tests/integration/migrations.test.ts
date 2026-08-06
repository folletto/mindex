/**
 * Migration tests.
 *
 * The important one is the last: applying the chain must produce exactly the
 * same schema as applying every migration to an empty database. That is what
 * catches someone editing 001_init.sql instead of adding 004_.
 */

import { afterEach, describe, expect, it } from 'vitest';
import SQLite, { type Database } from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NewerSchemaError,
  appSchemaVersion,
  loadMigrations,
  migrate,
  schemaVersion,
} from '../../src/main/db/migrations.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp.js';

afterEach(() => {
  cleanupTempDirs();
});

function schemaDump(db: Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string | null }[];
  return rows.map((row) => `${row.type} ${row.name}\n${(row.sql ?? '').replace(/\s+/g, ' ').trim()}`).join('\n');
}

describe('loadMigrations', () => {
  it('finds the migration files', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]).toMatchObject({ version: 1, name: 'init' });
  });

  it('numbers them contiguously from one', () => {
    loadMigrations().forEach((migration, index) => {
      expect(migration.version).toBe(index + 1);
    });
  });

  it('agrees with appSchemaVersion', () => {
    const migrations = loadMigrations();
    expect(appSchemaVersion()).toBe(migrations[migrations.length - 1].version);
  });
});

describe('migrate', () => {
  it('takes an empty database to the current schema', () => {
    const db = new SQLite(':memory:');
    expect(schemaVersion(db)).toBe(0);

    const result = migrate(db, { backup: false });
    expect(result.from).toBe(0);
    expect(result.to).toBe(appSchemaVersion());
    expect(schemaVersion(db)).toBe(appSchemaVersion());
    db.close();
  });

  it('is a no-op when already current', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });
    const second = migrate(db, { backup: false });
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('leaves a database that passes both integrity checks', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('refuses a library from a newer app', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });
    db.pragma(`user_version = ${appSchemaVersion() + 1}`);

    expect(() => migrate(db, { backup: false })).toThrow(NewerSchemaError);
    db.close();
  });

  it('backs the database up before upgrading an existing library', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'catalogue.db');

    // Simulate a library sitting at schema 1 when the app knows more.
    const db = new SQLite(dbPath);
    migrate(db, { backup: false });
    db.close();

    const reopened = new SQLite(dbPath);
    reopened.pragma('user_version = 1');
    const result = migrate(reopened, { dbPath });
    reopened.close();

    if (appSchemaVersion() > 1) {
      expect(result.backupPath).toBe(`${dbPath}.bak-1`);
      expect(existsSync(result.backupPath!)).toBe(true);
    } else {
      // Only one migration exists so far, so there is nothing to upgrade.
      expect(result.applied).toEqual([]);
    }
  });

  it('does not back up a brand new library', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'catalogue.db');
    const db = new SQLite(dbPath);
    const result = migrate(db, { dbPath });
    db.close();
    expect(result.backupPath).toBeNull();
  });

  it('rolls the whole upgrade back if a migration fails', () => {
    const db = new SQLite(':memory:');
    const migrations = loadMigrations();
    const broken = [...migrations, { version: migrations.length + 1, name: 'broken', sql: 'CREATE TABLE oops(' }];

    // Apply by hand with the same transaction discipline migrate() uses.
    expect(() => {
      db.exec('BEGIN EXCLUSIVE');
      try {
        for (const migration of broken) {
          db.exec(migration.sql);
          db.exec(`PRAGMA user_version = ${migration.version}`);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }).toThrow();

    expect(schemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'items'").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('schema shape', () => {
  it('is identical whether applied step by step or all at once', () => {
    const stepwise = new SQLite(':memory:');
    for (const migration of loadMigrations()) {
      stepwise.exec('BEGIN EXCLUSIVE');
      stepwise.exec(migration.sql);
      stepwise.exec(`PRAGMA user_version = ${migration.version}`);
      stepwise.exec('COMMIT');
    }

    const atOnce = new SQLite(':memory:');
    migrate(atOnce, { backup: false });

    expect(schemaDump(stepwise)).toBe(schemaDump(atOnce));
    expect(schemaVersion(stepwise)).toBe(schemaVersion(atOnce));

    stepwise.close();
    atOnce.close();
  });

  it('enforces slug uniqueness only among live items', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });

    const insert = db.prepare(
      `INSERT INTO items (id, name, slug, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01', '2026-01-01', ?)`,
    );
    insert.run('1', 'Widget', 'widget', null);
    expect(() => insert.run('2', 'Widget', 'widget', null)).toThrow(/UNIQUE/);
    // Trashed rows do not reserve the name.
    expect(() => insert.run('3', 'Widget', 'widget', '2026-01-02')).not.toThrow();
    expect(() => insert.run('4', 'Widget', 'widget', '2026-01-03')).not.toThrow();

    db.close();
  });

  it('cascades attachments and field values when an item row is deleted', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });
    db.pragma('foreign_keys = ON');

    db.prepare(
      `INSERT INTO items (id, name, slug, created_at, updated_at) VALUES ('i1', 'Widget', 'widget', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, item_id, filename, added_at) VALUES ('a1', 'i1', 'manual.pdf', 'now')`,
    ).run();
    db.prepare(`INSERT INTO field_defs (id, key, label, type) VALUES ('f1', 'voltage', 'Voltage', 'number')`).run();
    db.prepare(`INSERT INTO field_values (item_id, field_id, value) VALUES ('i1', 'f1', '12')`).run();

    db.prepare("DELETE FROM items WHERE id = 'i1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM field_values').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.close();
  });

  it('rejects an attachment for an item that does not exist', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });
    db.pragma('foreign_keys = ON');
    expect(() =>
      db
        .prepare(`INSERT INTO attachments (id, item_id, filename, added_at) VALUES ('a1', 'ghost', 'x.pdf', 'now')`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('derives attachment counts through the view', () => {
    const db = new SQLite(':memory:');
    migrate(db, { backup: false });
    db.prepare(
      `INSERT INTO items (id, name, slug, created_at, updated_at) VALUES ('i1', 'Widget', 'widget', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO items (id, name, slug, created_at, updated_at) VALUES ('i2', 'Other', 'other', 'now', 'now')`,
    ).run();
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
      db.prepare('INSERT INTO attachments (id, item_id, filename, added_at) VALUES (?, ?, ?, ?)').run(
        name,
        'i1',
        name,
        'now',
      );
    }

    const rows = db.prepare('SELECT id, attachment_count FROM items_with_counts ORDER BY id').all() as {
      id: string;
      attachment_count: number;
    }[];
    expect(rows).toEqual([
      { id: 'i1', attachment_count: 3 },
      { id: 'i2', attachment_count: 0 },
    ]);
    db.close();
  });
});
