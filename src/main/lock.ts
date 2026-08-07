/**
 * Advisory heartbeat lock for libraries on file-sync folders.
 *
 * This is explicitly *not* a mutex — sync latency means it cannot be. It exists
 * to catch the common "I left it open on the laptop" case, which otherwise ends
 * in the sync client producing a conflicted copy of the database. Everything
 * about it is best-effort, and the user can always take over.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Sync round-trips are slow; three minutes is several missed heartbeats. */
export const LOCK_STALE_AFTER_MS = 3 * 60_000;

export interface LockFile {
  host: string;
  user: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export type LockCheck =
  | { state: 'free' }
  | { state: 'held-by-us'; lock: LockFile }
  | { state: 'held-by-other'; lock: LockFile }
  | { state: 'stale'; lock: LockFile };

export function currentHost(): string {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown-user';
  }
}

export function readLock(lockPath: string): LockFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const lock = parsed as Partial<LockFile>;
    if (typeof lock.host !== 'string' || typeof lock.heartbeatAt !== 'string') return null;
    return {
      host: lock.host,
      user: typeof lock.user === 'string' ? lock.user : 'unknown',
      pid: typeof lock.pid === 'number' ? lock.pid : 0,
      startedAt: typeof lock.startedAt === 'string' ? lock.startedAt : lock.heartbeatAt,
      heartbeatAt: lock.heartbeatAt,
    };
  } catch {
    // Missing, truncated mid-sync, or someone else's JSON. Treat as free —
    // refusing to open a library because of an unreadable hint file would be
    // worse than the race it protects against.
    return null;
  }
}

export function inspectLock(lockPath: string, now: Date = new Date(), host: string = currentHost()): LockCheck {
  const lock = readLock(lockPath);
  if (!lock) return { state: 'free' };

  const age = now.getTime() - new Date(lock.heartbeatAt).getTime();
  if (Number.isNaN(age) || age > LOCK_STALE_AFTER_MS) return { state: 'stale', lock };
  // Same machine is not a conflict worth blocking on: the single-instance lock
  // already stops a second window here, and a script sharing the disk is fine.
  if (lock.host === host) return { state: 'held-by-us', lock };
  return { state: 'held-by-other', lock };
}

export function writeLock(lockPath: string, now: Date = new Date(), startedAt?: string): LockFile {
  const lock: LockFile = {
    host: currentHost(),
    user: currentUser(),
    pid: process.pid,
    startedAt: startedAt ?? now.toISOString(),
    heartbeatAt: now.toISOString(),
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

export function releaseLock(lockPath: string): void {
  try {
    const lock = readLock(lockPath);
    // Only clear our own; another machine's lock is not ours to delete.
    if (lock && lock.host === currentHost() && lock.pid === process.pid) rmSync(lockPath, { force: true });
  } catch {
    // Best-effort by design.
  }
}

/**
 * Holds the lock for as long as the library is open, refreshing the heartbeat
 * so other machines can tell the difference between "in use" and "crashed".
 */
export class LockHolder {
  private timer: NodeJS.Timeout | null = null;
  private startedAt: string | null = null;

  constructor(private readonly lockPath: string) {}

  acquire(): void {
    const lock = writeLock(this.lockPath);
    this.startedAt = lock.startedAt;
    this.timer = setInterval(() => {
      try {
        writeLock(this.lockPath, new Date(), this.startedAt ?? undefined);
      } catch {
        // The folder may have vanished or gone read-only; the library-missing
        // check will notice, and a failed heartbeat is not worth interrupting for.
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.timer.unref?.();
  }

  release(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    releaseLock(this.lockPath);
  }
}

export function describeLock(lock: LockFile): string {
  return `"${lock.host}" (${lock.user}) has had this library open since ${lock.startedAt}`;
}
