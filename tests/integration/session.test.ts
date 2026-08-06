/**
 * The session: the one open library, and the polling that notices when another
 * machine commits.
 *
 * This module has no Electron in it precisely so it can be tested like this.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session } from '../../src/main/session.js';
import { LibraryService } from '../../src/main/service.js';
import { openLibrary } from '../../src/main/library.js';
import { appSchemaVersion } from '../../src/main/db/migrations.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp.js';

let session: Session;

afterEach(() => {
  session?.close();
  cleanupTempDirs();
});

describe('Session', () => {
  it('reports unset before a library is chosen', () => {
    session = new Session();
    expect(session.isOpen).toBe(false);
    expect(session.state([], null)).toMatchObject({ status: 'unset', path: null });
  });

  it('reports missing when the remembered folder has gone', () => {
    session = new Session();
    const gone = join(makeTempDir(), 'not-here');
    expect(session.state([], gone)).toMatchObject({ status: 'missing', path: gone });
  });

  it('opens a library and describes it', () => {
    session = new Session();
    const root = makeTempDir();
    session.open(root, { initialize: true });

    const state = session.state([root], root);
    expect(state).toMatchObject({
      status: 'ready',
      path: root,
      schema: appSchemaVersion(),
      appSchema: appSchemaVersion(),
      journalMode: 'wal',
      storageKind: 'local',
      readOnly: false,
    });
  });

  it('throws rather than guessing when asked for a service with nothing open', () => {
    session = new Session();
    expect(() => session.service).toThrow(/No library is open/);
  });

  it('closes the previous library when switching', () => {
    session = new Session();
    const first = makeTempDir();
    const second = makeTempDir();

    session.open(first, { initialize: true });
    session.service.createItem({ name: 'In the first library' });

    session.open(second, { initialize: true });
    expect(session.state([], second).path).toBe(second);
    // The second library is genuinely a different one, not a stale handle.
    expect(session.service.listItems()).toHaveLength(0);

    session.open(first);
    expect(session.service.listItems().map((row) => row.name)).toEqual(['In the first library']);
  });

  it('reports missing if the folder disappears while open', () => {
    session = new Session();
    const root = makeTempDir();
    session.open(root, { initialize: true });
    expect(session.state([], root).status).toBe('ready');

    rmSync(root, { recursive: true, force: true });
    expect(session.state([], root).status).toBe('missing');
  });

  it('reports read-only for a library written by a newer app', () => {
    session = new Session();
    const root = makeTempDir();
    const seed = openLibrary(root, { initialize: true });
    seed.db.pragma(`user_version = ${appSchemaVersion() + 3}`);
    seed.close();

    session.open(root);
    const state = session.state([], root);
    expect(state.readOnly).toBe(true);
    expect(state.readOnlyReason).toMatch(/only understands/);
  });

  it('is safe to close twice', () => {
    session = new Session();
    session.open(makeTempDir(), { initialize: true });
    session.close();
    expect(() => session.close()).not.toThrow();
    expect(session.isOpen).toBe(false);
  });
});

describe('external change detection', () => {
  it('notifies listeners when another connection commits', async () => {
    session = new Session();
    const root = makeTempDir();
    session.open(root, { initialize: true });

    let notifications = 0;
    session.onExternalChange(() => notifications++);

    // Our own writes must not fire it — that would mean re-reading the list
    // on every keystroke's worth of autosave.
    session.service.createItem({ name: 'Mine' });
    await wait(2500);
    expect(notifications).toBe(0);

    // Another connection standing in for another machine.
    const other = openLibrary(root);
    try {
      new LibraryService(other, { host: 'other-machine' }).createItem({ name: 'Theirs' });
    } finally {
      other.close();
    }

    await waitFor(() => notifications > 0, 8000);
    expect(notifications).toBeGreaterThan(0);
    expect(
      session.service
        .listItems()
        .map((row) => row.name)
        .sort(),
    ).toEqual(['Mine', 'Theirs']);
  }, 30_000);

  it('stops polling once the library is closed', async () => {
    session = new Session();
    const root = makeTempDir();
    session.open(root, { initialize: true });

    let notifications = 0;
    const unsubscribe = session.onExternalChange(() => notifications++);
    session.close();

    const other = openLibrary(root);
    try {
      new LibraryService(other, { host: 'other' }).createItem({ name: 'After close' });
    } finally {
      other.close();
    }

    await wait(2500);
    expect(notifications).toBe(0);
    unsubscribe();
  }, 30_000);

  it('lets a listener unsubscribe', async () => {
    session = new Session();
    const root = makeTempDir();
    session.open(root, { initialize: true });

    let notifications = 0;
    const unsubscribe = session.onExternalChange(() => notifications++);
    unsubscribe();

    const other = openLibrary(root);
    try {
      new LibraryService(other, { host: 'other' }).createItem({ name: 'Unheard' });
    } finally {
      other.close();
    }

    await wait(2500);
    expect(notifications).toBe(0);
  }, 30_000);
});

describe('a library folder with something already in it', () => {
  it('is refused rather than adopted', () => {
    session = new Session();
    const root = makeTempDir();
    writeFileSync(join(root, 'taxes.pdf'), 'not yours');

    expect(() => session.open(root, { initialize: true })).toThrow(/already contains other files/);
    expect(session.isOpen).toBe(false);
  });

  it('accepts a subfolder created for the purpose', () => {
    session = new Session();
    const parent = makeTempDir();
    writeFileSync(join(parent, 'taxes.pdf'), 'not yours');

    const root = join(parent, 'Mindex Catalogue');
    mkdirSync(root);
    session.open(root, { initialize: true });

    expect(session.state([], root).status).toBe('ready');
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(100);
  }
  throw new Error(`Condition was still false after ${timeoutMs} ms`);
}
