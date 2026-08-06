/**
 * A real, separate process that opens a shared library and writes to it.
 *
 * This is the whole point of the concurrency suite: SQLite's locking is a
 * property of processes and files, and no amount of in-process simulation would
 * exercise it. Run with `node --import tsx tests/helpers/worker.ts <json>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLibrary } from '../../src/main/library.js';
import { LibraryService } from '../../src/main/service.js';
import { WriteContentionError } from '../../src/main/db/connection.js';
import { sleepSync } from '../../src/shared/backoff.js';
import type { JournalMode } from '../../src/shared/types.js';

export interface WorkerConfig {
  scenario: 'hammer' | 'lost-update' | 'hold-write' | 'write-once' | 'read-only-check';
  root: string;
  journalMode: JournalMode;
  host: string;
  seed: number;
  /** hammer: how many operations to attempt. */
  operations?: number;
  /** hold-write: how long to sit inside an open write transaction. */
  holdMs?: number;
  /** lost-update / write-once: which item to fight over, and what to write. */
  itemId?: string;
  value?: string;
  /** A folder both sides touch to synchronise without a shared event loop. */
  barrierDir?: string;
  barrierSize?: number;
}

export interface WorkerResult {
  host: string;
  created: number;
  updated: number;
  conflicts: number;
  trashed: number;
  restored: number;
  attachments: number;
  contention: number;
  errors: string[];
  /** lost-update: did this process's write land? */
  won?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
}

/** Deterministic per-worker RNG, so a failure can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wait until every participant has checked in. Cheap and filesystem-based,
 * because the participants are separate processes with no channel between them.
 */
function barrier(dir: string, size: number, host: string, timeoutMs = 30_000): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, host), 'ready');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let present = 0;
    for (let i = 0; i < size; i++) {
      // Participants are named worker-0 … worker-N by the harness.
      if (existsSync(join(dir, `worker-${i}`))) present++;
    }
    if (present >= size) return;
    sleepSync(5);
  }
  throw new Error(`Barrier timed out waiting for ${size} participants in ${dir}`);
}

export function runWorker(config: WorkerConfig): WorkerResult {
  const result: WorkerResult = {
    host: config.host,
    created: 0,
    updated: 0,
    conflicts: 0,
    trashed: 0,
    restored: 0,
    attachments: 0,
    contention: 0,
    errors: [],
  };

  const library = openLibrary(config.root, { journalMode: config.journalMode });
  result.readOnly = library.readOnly;
  result.readOnlyReason = library.readOnlyReason;
  const service = new LibraryService(library, { host: config.host });
  const random = mulberry32(config.seed);

  const scratch = join(config.root, '..', `scratch-${config.host}`);
  mkdirSync(scratch, { recursive: true });

  try {
    switch (config.scenario) {
      case 'hammer':
        hammer(service, random, config, result, scratch);
        break;

      case 'hold-write': {
        // Sit inside an open write transaction so everyone else has to wait.
        library.db.exec('BEGIN IMMEDIATE');
        library.db
          .prepare(
            `INSERT INTO items (id, name, slug, created_at, updated_at, rev)
             VALUES (?, ?, ?, ?, ?, 1)`,
          )
          .run(`hold-${config.host}`, 'Holder', `holder-${config.host}`, 'now', 'now');
        sleepSync(config.holdMs ?? 3000);
        library.db.exec('COMMIT');
        result.created++;
        break;
      }

      case 'write-once': {
        if (config.barrierDir) barrier(config.barrierDir, config.barrierSize ?? 1, config.host);
        const item = service.createItem({ name: config.value ?? `Item from ${config.host}` });
        result.created++;
        result.won = Boolean(item.id);
        break;
      }

      case 'lost-update': {
        // Read first, then wait for everyone else to have read too, so both
        // processes are working from the same rev before either writes.
        const before = service.getItem(config.itemId!);
        if (!before) throw new Error(`Item ${config.itemId} is missing`);
        if (config.barrierDir) barrier(config.barrierDir, config.barrierSize ?? 2, config.host);

        const outcome = service.updateItem({
          id: before.id,
          rev: before.rev,
          patch: { name: config.value ?? config.host },
          base: { name: before.name },
        });
        if ('conflict' in outcome && outcome.conflict) {
          result.conflicts++;
          result.won = false;
        } else {
          result.updated++;
          result.won = true;
        }
        break;
      }

      case 'read-only-check': {
        try {
          service.createItem({ name: `Should not exist (${config.host})` });
          result.created++;
        } catch (error) {
          result.errors.push((error as Error).name);
        }
        break;
      }
    }
  } finally {
    library.close();
  }

  return result;
}

function hammer(
  service: LibraryService,
  random: () => number,
  config: WorkerConfig,
  result: WorkerResult,
  scratch: string,
): void {
  const mine: string[] = [];
  const operations = config.operations ?? 200;

  for (let n = 0; n < operations; n++) {
    const roll = random();
    try {
      if (roll < 0.35 || mine.length === 0) {
        const item = service.createItem({
          name: `${config.host} item ${n}`,
          manufacturer: random() < 0.5 ? 'Acme' : 'Bosch',
        });
        mine.push(item.id);
        result.created++;
        continue;
      }

      const id = mine[Math.floor(random() * mine.length)];
      const current = service.getItem(id);
      if (!current) continue;

      if (roll < 0.6) {
        const outcome = service.updateItem({
          id,
          rev: current.rev,
          patch: { notes: `touched at ${n} by ${config.host}` },
          base: { notes: current.notes },
        });
        if ('conflict' in outcome && outcome.conflict) result.conflicts++;
        else result.updated++;
      } else if (roll < 0.8) {
        const file = join(scratch, `file-${n}.txt`);
        writeFileSync(file, `contents ${n}`);
        result.attachments += service.addAttachments({ itemId: id, paths: [file] }).length;
      } else if (roll < 0.92) {
        if (current.rev !== undefined && !isTrashed(service, id)) {
          const outcome = service.trashItem({ id, rev: current.rev });
          if (outcome.ok) result.trashed++;
        }
      } else if (isTrashed(service, id)) {
        service.restoreItem({ id });
        result.restored++;
      }
    } catch (error) {
      if (error instanceof WriteContentionError) {
        result.contention++;
        continue;
      }
      // Races between processes produce legitimate "gone already" outcomes;
      // anything else is a real failure and must reach the assertions.
      const name = (error as Error).name;
      if (name === 'NotFoundError' || name === 'ValidationError') continue;
      result.errors.push(`${name}: ${(error as Error).message}`);
    }
  }
}

function isTrashed(service: LibraryService, id: string): boolean {
  return service.listTrash().some((row) => row.id === id);
}

// --- entry point -----------------------------------------------------------

const argument = process.argv[2];
if (argument) {
  try {
    const config = JSON.parse(
      argument.startsWith('@') ? readFileSync(argument.slice(1), 'utf8') : argument,
    ) as WorkerConfig;
    const result = runWorker(config);
    process.stdout.write(`__RESULT__${JSON.stringify(result)}`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(
      `__ERROR__${JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack })}`,
    );
    process.exit(1);
  }
}
