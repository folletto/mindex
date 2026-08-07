/**
 * The load-bearing suite: several real processes writing to one library.
 *
 * Everything here runs against both journal modes, because WAL and the rollback
 * journal have genuinely different locking, and on all three CI platforms,
 * because file locking differs between them too.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openLibrary } from '../../src/main/library.js';
import { LibraryService } from '../../src/main/service.js';
import { appSchemaVersion } from '../../src/main/db/migrations.js';
import { itemFolder, libraryPaths, trashFolder } from '../../src/main/paths.js';
import type { JournalMode } from '../../src/shared/types.js';
import { expectAllSucceeded, runWorkers } from '../helpers/spawn.js';
import type { WorkerConfig } from '../helpers/worker.js';
import { cleanupTempDirs, makeLibrary, makeTempDir } from '../helpers/temp.js';

afterEach(() => {
  cleanupTempDirs();
});

const JOURNAL_MODES: JournalMode[] = ['wal', 'truncate'];

function setupLibrary(journalMode: JournalMode) {
  const parent = makeTempDir('mindex-shared-');
  const root = join(parent, 'library');
  mkdirSync(root, { recursive: true });
  const configDir = join(parent, 'configs');
  mkdirSync(configDir, { recursive: true });

  const library = openLibrary(root, { initialize: true, journalMode });
  const service = new LibraryService(library, { host: 'setup' });
  return { root, configDir, library, service };
}

/**
 * Every attachment the database knows about must still have its bytes, either
 * in the item's folder or in the trash folder it was moved to. This is the
 * "no data was lost" assertion, and it tolerates the legitimate race where one
 * process attaches a file while another trashes the item.
 */
function expectNoDataLost(root: string, db: Database): void {
  const paths = libraryPaths(root);
  const rows = db
    .prepare(
      `SELECT a.filename AS filename, i.slug AS slug, i.deleted_path AS deletedPath
       FROM attachments a JOIN items i ON i.id = a.item_id`,
    )
    .all() as { filename: string; slug: string; deletedPath: string | null }[];

  const missing = rows.filter((row) => {
    const live = join(itemFolder(paths, row.slug), row.filename);
    if (existsSync(live)) return false;
    if (row.deletedPath && existsSync(join(trashFolder(paths, row.deletedPath), row.filename))) return false;
    return true;
  });

  expect(missing).toEqual([]);
}

describe.each(JOURNAL_MODES)('multi-process writes (journal_mode = %s)', (journalMode) => {
  it('survives eight processes hammering the same library', async () => {
    const { root, configDir, library } = setupLibrary(journalMode);
    library.close();

    const workers: WorkerConfig[] = Array.from({ length: 8 }, (_, index) => ({
      scenario: 'hammer' as const,
      root,
      journalMode,
      host: `worker-${index}`,
      seed: 1000 + index,
      operations: 150,
    }));

    const results = expectAllSucceeded(await runWorkers(workers, configDir));

    for (const result of results) {
      expect(result.errors).toEqual([]);
    }

    const reopened = openLibrary(root, { journalMode });
    try {
      // The database is structurally sound.
      expect(reopened.db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(reopened.db.pragma('foreign_key_check')).toEqual([]);

      // Every create landed, and nothing was created twice.
      const totalCreated = results.reduce((sum, result) => sum + result.created, 0);
      const rows = reopened.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
      expect(totalCreated).toBeGreaterThan(100);
      expect(rows.n).toBe(totalCreated);

      // The partial unique index held: no two live items share a folder.
      const duplicates = reopened.db
        .prepare(`SELECT slug, COUNT(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY slug HAVING n > 1`)
        .all();
      expect(duplicates).toEqual([]);

      // No attachment was recorded twice for the same item.
      const duplicateFiles = reopened.db
        .prepare('SELECT item_id, filename, COUNT(*) AS n FROM attachments GROUP BY item_id, filename HAVING n > 1')
        .all();
      expect(duplicateFiles).toEqual([]);

      expectNoDataLost(root, reopened.db);
    } finally {
      reopened.close();
    }
  }, 180_000);

  it('lets exactly one of two simultaneous edits win', async () => {
    const { root, configDir, library, service } = setupLibrary(journalMode);
    const item = service.createItem({ name: 'Contested' });
    library.close();

    const barrierDir = join(configDir, 'barrier-lost-update');
    const workers: WorkerConfig[] = [0, 1].map((index) => ({
      scenario: 'lost-update' as const,
      root,
      journalMode,
      host: `worker-${index}`,
      seed: index,
      itemId: item.id,
      value: `name from worker-${index}`,
      barrierDir,
      barrierSize: 2,
    }));

    const results = expectAllSucceeded(await runWorkers(workers, configDir));

    // Not "probably one" — exactly one. The loser must have taken the merge
    // path rather than silently overwriting.
    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(results.filter((result) => result.conflicts === 1)).toHaveLength(1);

    const reopened = openLibrary(root, { journalMode });
    try {
      const stored = reopened.db.prepare('SELECT name, rev FROM items WHERE id = ?').get(item.id) as {
        name: string;
        rev: number;
      };
      const winner = results.find((result) => result.won)!;
      expect(stored.name).toBe(`name from ${winner.host}`);
      // One write, one rev bump. The loser wrote nothing.
      expect(stored.rev).toBe(item.rev + 1);
    } finally {
      reopened.close();
    }
  }, 120_000);

  it('waits out a writer that holds the lock, instead of failing', async () => {
    const { root, configDir, library } = setupLibrary(journalMode);
    library.close();

    const holdMs = 3000;
    const workers: WorkerConfig[] = [
      { scenario: 'hold-write', root, journalMode, host: 'worker-0', seed: 0, holdMs },
      ...Array.from({ length: 4 }, (_, index) => ({
        scenario: 'write-once' as const,
        root,
        journalMode,
        host: `worker-${index + 1}`,
        seed: index + 1,
        value: `written by worker-${index + 1}`,
      })),
    ];

    const started = Date.now();
    const results = expectAllSucceeded(await runWorkers(workers, configDir));
    const elapsed = Date.now() - started;

    // Every writer eventually got in — busy_timeout plus backoff, not errors.
    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(result.created).toBe(1);
    }
    // And they really did have to wait for the holder.
    expect(elapsed).toBeGreaterThanOrEqual(holdMs - 500);

    const reopened = openLibrary(root, { journalMode });
    try {
      expect(reopened.db.pragma('integrity_check', { simple: true })).toBe('ok');
      const rows = reopened.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
      expect(rows.n).toBe(5);
    } finally {
      reopened.close();
    }
  }, 120_000);

  it('never lets two processes claim the same folder name', async () => {
    const { root, configDir, library } = setupLibrary(journalMode);
    library.close();

    const barrierDir = join(configDir, 'barrier-same-name');
    const workers: WorkerConfig[] = Array.from({ length: 6 }, (_, index) => ({
      scenario: 'write-once' as const,
      root,
      journalMode,
      host: `worker-${index}`,
      seed: index,
      // Same name from every process, at the same moment.
      value: 'Acme Widget',
      barrierDir,
      barrierSize: 6,
    }));

    expectAllSucceeded(await runWorkers(workers, configDir));

    const reopened = openLibrary(root, { journalMode });
    try {
      const slugs = (reopened.db.prepare('SELECT slug FROM items ORDER BY slug').all() as { slug: string }[]).map(
        (row) => row.slug,
      );
      expect(slugs).toHaveLength(6);
      expect(new Set(slugs).size).toBe(6);
      expect(slugs).toContain('acme-widget');
    } finally {
      reopened.close();
    }
  }, 120_000);
});

describe('migration skew', () => {
  it('makes an older app open a newer library read-only rather than write to it', async () => {
    const parent = makeTempDir('mindex-skew-');
    const root = join(parent, 'library');
    mkdirSync(root, { recursive: true });
    const configDir = join(parent, 'configs');
    mkdirSync(configDir, { recursive: true });

    const library = openLibrary(root, { initialize: true });
    new LibraryService(library, { host: 'setup' }).createItem({ name: 'Existing' });
    // Stand in for "the other machine updated Mindex first".
    library.db.pragma(`user_version = ${appSchemaVersion() + 1}`);
    library.close();

    const results = expectAllSucceeded(
      await runWorkers(
        [{ scenario: 'read-only-check', root, journalMode: 'wal', host: 'worker-0', seed: 0 }],
        configDir,
      ),
    );

    expect(results[0].readOnly).toBe(true);
    expect(results[0].readOnlyReason).toMatch(/only understands/);
    expect(results[0].created).toBe(0);
    expect(results[0].errors).toEqual(['ReadOnlyError']);

    const reopened = openLibrary(root);
    try {
      const rows = reopened.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      reopened.close();
    }
  }, 120_000);
});

describe('data_version change detection', () => {
  it('notices when another connection commits, and not when this one does', () => {
    const first = makeLibrary();
    const second = openLibrary(first.root);
    const secondService = new LibraryService(second, { host: 'other-machine' });

    try {
      const before = second.db.pragma('data_version', { simple: true });

      // Our own writes do not move our own data_version …
      secondService.createItem({ name: 'Mine' });
      expect(second.db.pragma('data_version', { simple: true })).toBe(before);

      // … but another connection's commit does.
      first.service.createItem({ name: 'Theirs' });
      expect(second.db.pragma('data_version', { simple: true })).not.toBe(before);

      // And the change is visible, not just signalled.
      expect(
        secondService
          .listItems()
          .map((row) => row.name)
          .sort(),
      ).toEqual(['Mine', 'Theirs']);
    } finally {
      second.close();
      first.close();
    }
  });
});

describe('two connections in one process', () => {
  it('keeps the trash consistent when one closes mid-flight', () => {
    const first = makeLibrary();
    const item = first.service.createItem({ name: 'Shared' });

    const second = openLibrary(first.root);
    const secondService = new LibraryService(second, { host: 'other' });
    try {
      const result = secondService.trashItem({ id: item.id, rev: item.rev });
      expect(result.ok).toBe(true);

      // The first connection sees it immediately — no cache to invalidate.
      expect(first.service.listItems()).toHaveLength(0);
      expect(first.service.listTrash()).toHaveLength(1);
    } finally {
      second.close();
      first.close();
    }
  });

  it('leaves no stray folders behind after a restore race', () => {
    const first = makeLibrary();
    const item = first.service.createItem({ name: 'Shared' });
    first.service.trashItem({ id: item.id, rev: item.rev });

    const second = openLibrary(first.root);
    const secondService = new LibraryService(second, { host: 'other' });
    try {
      first.service.restoreItem({ id: item.id });
      // The second process restores something already restored: a no-op.
      const restored = secondService.restoreItem({ id: item.id });
      expect(restored.slug).toBe('shared');
      const trashDir = join(first.root, 'deleted');
      expect(existsSync(trashDir) ? readdirSync(trashDir) : []).toEqual([]);
    } finally {
      second.close();
      first.close();
    }
  });
});
