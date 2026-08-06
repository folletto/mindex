/**
 * Fixture factories.
 *
 * Every test gets its own folder under the OS temp directory and a real SQLite
 * database on it. Nothing here mocks the database: the locking behaviour is
 * precisely what the concurrency suite exists to verify, and a mock would hide it.
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLibrary, type Library } from '../../src/main/library.js';
import { LibraryService } from '../../src/main/service.js';
import type { JournalMode } from '../../src/shared/types.js';

const created: string[] = [];

export function makeTempDir(prefix = 'mindex-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows occasionally holds a handle a moment longer than we do; the OS
      // will clean the temp directory eventually.
    }
  }
}

export interface TestLibrary {
  root: string;
  library: Library;
  service: LibraryService;
  close(): void;
}

let clockCounter = 0;

/**
 * A library on a fresh temp folder, with a monotonic clock so that ordering
 * assertions do not depend on how fast the machine is.
 */
export function makeLibrary(
  options: { journalMode?: JournalMode; host?: string; root?: string } = {},
): TestLibrary {
  const root = options.root ?? makeTempDir();
  const library = openLibrary(root, { initialize: true, journalMode: options.journalMode });
  const service = new LibraryService(library, {
    host: options.host ?? 'test-host',
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + clockCounter++ * 1000),
  });
  return {
    root,
    library,
    service,
    close() {
      library.close();
    },
  };
}

export function makeItem(
  service: LibraryService,
  overrides: { name?: string; manufacturer?: string; notes?: string } = {},
) {
  return service.createItem({
    name: overrides.name ?? `Widget ${Math.random().toString(36).slice(2, 8)}`,
    manufacturer: overrides.manufacturer ?? 'Acme',
    notes: overrides.notes ?? null,
  });
}

/** A real file on disk, for attachment tests. */
export function makeFile(dir: string, name: string, contents = 'hello'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

/**
 * A sorted snapshot of everything under `dir`, used to assert that a code path
 * wrote nothing it was not supposed to.
 */
export function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(join(current, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  try {
    if (statSync(dir).isDirectory()) walk(dir, '');
  } catch {
    return [];
  }
  return out.sort();
}
