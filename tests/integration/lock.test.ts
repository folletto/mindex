/**
 * The advisory lock for sync folders.
 *
 * It is explicitly not a mutex — sync latency means it cannot be. What it has
 * to do is catch "left it open on the laptop" without ever locking someone out
 * of their own catalogue, so the tests care as much about the ways it yields as
 * the ways it holds.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCK_STALE_AFTER_MS,
  LockHolder,
  currentHost,
  describeLock,
  inspectLock,
  readLock,
  releaseLock,
  writeLock,
} from '../../src/main/lock.js';
import { openLibrary } from '../../src/main/library.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp.js';

afterEach(() => {
  cleanupTempDirs();
});

function lockPathIn(dir: string): string {
  return join(dir, '.catalogue-lock');
}

describe('writeLock and readLock', () => {
  it('round-trip', () => {
    const path = lockPathIn(makeTempDir());
    const written = writeLock(path, new Date('2026-08-06T12:00:00Z'));

    expect(written.host).toBe(currentHost());
    expect(written.pid).toBe(process.pid);
    expect(readLock(path)).toEqual(written);
  });

  it('keeps the original start time across heartbeats', () => {
    const path = lockPathIn(makeTempDir());
    const first = writeLock(path, new Date('2026-08-06T12:00:00Z'));
    const second = writeLock(path, new Date('2026-08-06T12:00:30Z'), first.startedAt);

    expect(second.startedAt).toBe(first.startedAt);
    expect(second.heartbeatAt).not.toBe(first.heartbeatAt);
  });

  it('writes readable JSON, because a human may have to look at it', () => {
    const path = lockPathIn(makeTempDir());
    writeLock(path);
    expect(readFileSync(path, 'utf8')).toMatch(/^\{\n {2}"host"/);
  });
});

describe('readLock on a damaged file', () => {
  it('returns null rather than throwing for unparseable JSON', () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(path, '{ half a file, caught mid-sync');
    expect(readLock(path)).toBeNull();
  });

  it('returns null when the file is missing', () => {
    expect(readLock(lockPathIn(makeTempDir()))).toBeNull();
  });

  it('returns null for JSON that is not a lock', () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(path, '{"something":"else"}');
    expect(readLock(path)).toBeNull();
  });

  it('fills in what it can from a partial lock', () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(path, '{"host":"laptop","heartbeatAt":"2026-08-06T12:00:00.000Z"}');
    expect(readLock(path)).toMatchObject({ host: 'laptop', user: 'unknown', pid: 0 });
  });
});

describe('inspectLock', () => {
  const now = new Date('2026-08-06T12:00:00Z');

  it('reports free when there is no lock', () => {
    expect(inspectLock(lockPathIn(makeTempDir()), now)).toEqual({ state: 'free' });
  });

  it('reports held-by-other for a fresh lock from another machine', () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(
      path,
      JSON.stringify({
        host: 'laptop',
        user: 'sam',
        pid: 42,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      }),
    );

    const result = inspectLock(path, new Date(now.getTime() + 10_000), 'desktop');
    expect(result.state).toBe('held-by-other');
  });

  it('reports stale once the heartbeat stops', () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(
      path,
      JSON.stringify({
        host: 'laptop',
        user: 'sam',
        pid: 42,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      }),
    );

    const result = inspectLock(path, new Date(now.getTime() + LOCK_STALE_AFTER_MS + 1000), 'desktop');
    expect(result.state).toBe('stale');
  });

  it('does not lock a machine out of its own library', () => {
    // The single-instance lock already stops a second window here, and a script
    // sharing the disk with the app is a supported arrangement.
    const path = lockPathIn(makeTempDir());
    writeLock(path, now);
    expect(inspectLock(path, new Date(now.getTime() + 5000)).state).toBe('held-by-us');
  });

  it('treats an unparseable heartbeat as stale rather than blocking', () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(path, JSON.stringify({ host: 'laptop', heartbeatAt: 'not a date' }));
    expect(inspectLock(path, now, 'desktop').state).toBe('stale');
  });
});

describe('releaseLock', () => {
  it('removes our own lock', () => {
    const path = lockPathIn(makeTempDir());
    writeLock(path);
    releaseLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves another machine's lock alone", () => {
    const path = lockPathIn(makeTempDir());
    writeFileSync(path, JSON.stringify({ host: 'someone-else', pid: 1, heartbeatAt: new Date().toISOString() }));
    releaseLock(path);
    expect(existsSync(path)).toBe(true);
  });

  it('does nothing when there is no lock', () => {
    expect(() => releaseLock(lockPathIn(makeTempDir()))).not.toThrow();
  });
});

describe('LockHolder', () => {
  it('takes the lock and gives it back', () => {
    const path = lockPathIn(makeTempDir());
    const holder = new LockHolder(path);

    holder.acquire();
    expect(existsSync(path)).toBe(true);
    expect(readLock(path)?.pid).toBe(process.pid);

    holder.release();
    expect(existsSync(path)).toBe(false);
  });

  it('can be released twice without complaint', () => {
    const holder = new LockHolder(lockPathIn(makeTempDir()));
    holder.acquire();
    holder.release();
    expect(() => holder.release()).not.toThrow();
  });
});

describe('describeLock', () => {
  it('names the machine, so the message can be acted on', () => {
    const lock = { host: 'laptop', user: 'sam', pid: 1, startedAt: '2026-08-06T12:00:00.000Z', heartbeatAt: '' };
    expect(describeLock(lock)).toContain('laptop');
    expect(describeLock(lock)).toContain('sam');
  });
});

/**
 * A library folder whose path makes the sync heuristic fire, so the lock code
 * runs for real rather than through an injected flag.
 */
function makeSyncLibraryRoot(): string {
  const root = join(makeTempDir(), 'Dropbox', 'Catalogue');
  mkdirSync(root, { recursive: true });
  return root;
}

describe('openLibrary on a sync folder', () => {
  it('takes the lock and releases it on close', () => {
    const root = makeSyncLibraryRoot();
    const library = openLibrary(root, { initialize: true, useLock: true });

    expect(library.storageKind).toBe('sync');
    // WAL needs shared memory that a sync client does not provide.
    expect(library.journalMode).toBe('truncate');
    expect(existsSync(lockPathIn(root))).toBe(true);

    library.close();
    expect(existsSync(lockPathIn(root))).toBe(false);
  });

  it('opens read-only when another machine holds the lock', () => {
    const root = makeSyncLibraryRoot();
    openLibrary(root, { initialize: true }).close();

    writeFileSync(
      lockPathIn(root),
      JSON.stringify({
        host: 'the-laptop',
        user: 'sam',
        pid: 999,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );

    const library = openLibrary(root, { useLock: true });
    expect(library.readOnly).toBe(true);
    expect(library.readOnlyReason).toContain('the-laptop');
    expect(library.readOnlyReason).toMatch(/conflicted copy/);
    library.close();
  });

  it('offers a way through — the lock is advice, not a wall', () => {
    const root = makeSyncLibraryRoot();
    openLibrary(root, { initialize: true }).close();
    writeFileSync(
      lockPathIn(root),
      JSON.stringify({ host: 'the-laptop', user: 'sam', pid: 999, heartbeatAt: new Date().toISOString() }),
    );

    const library = openLibrary(root, { useLock: true, takeOverLock: true });
    expect(library.readOnly).toBe(false);
    expect(readLock(lockPathIn(root))?.host).toBe(currentHost());
    library.close();
  });

  it('ignores a lock whose heartbeat stopped', () => {
    const root = makeSyncLibraryRoot();
    openLibrary(root, { initialize: true }).close();
    writeFileSync(
      lockPathIn(root),
      JSON.stringify({
        host: 'the-laptop',
        pid: 999,
        heartbeatAt: new Date(Date.now() - LOCK_STALE_AFTER_MS - 60_000).toISOString(),
      }),
    );

    const library = openLibrary(root, { useLock: true });
    expect(library.readOnly).toBe(false);
    library.close();
  });

  it('does not lock a library on a local disk', () => {
    const root = makeTempDir();
    const library = openLibrary(root, { initialize: true, useLock: true });

    expect(library.storageKind).toBe('local');
    expect(library.journalMode).toBe('wal');
    expect(existsSync(lockPathIn(root))).toBe(false);
    library.close();
  });
});
