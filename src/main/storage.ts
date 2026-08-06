/**
 * Where the library folder lives decides how SQLite may journal.
 *
 * WAL is faster and lets readers run alongside a writer, but it depends on a
 * shared-memory file that network filesystems and file-level sync clients do
 * not implement. Guessing wrong in that direction corrupts data, so the
 * detection is deliberately pessimistic and the answer is user-overridable.
 */

import { statfsSync } from 'node:fs';
import { sep } from 'node:path';
import type { JournalMode, StorageKind } from '../shared/types.js';

/**
 * Folder names the common sync clients use. Matched per path segment, so
 * `~/Dropbox/tools` matches but `~/notes/dropbox-alternatives.md` does not.
 */
const SYNC_SEGMENTS = [
  'dropbox',
  'onedrive',
  'google drive',
  'googledrive',
  'my drive',
  'cloudstorage',
  'mobile documents',
  'icloud drive',
  'icloud~',
  'nextcloud',
  'owncloud',
  'seafile',
  'syncthing',
  'sync',
  'pcloud',
  'mega',
  'megasync',
  'box sync',
  'tresorit',
  'yandex.disk',
  'proton drive',
  'protondrive',
];

/** Linux filesystem magic numbers that mean "not a local disk". */
const NETWORK_FS_MAGIC = new Set([
  0x6969, // NFS
  0xff534d42, // CIFS/SMB1
  0xfe534d42, // SMB2
  0x517b, // SMB (older)
  0x65735546, // FUSE — sshfs, rclone, most cloud mounts
  0x564c, // NCP
  0x73757245, // CODA
  0xbacbacbc, // VMware hgfs style shares
]);

export function looksLikeSyncFolder(path: string): boolean {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return SYNC_SEGMENTS.some(
      (needle) => normalized === needle || normalized.startsWith(`${needle} -`) || normalized.startsWith(`${needle}-`),
    );
  });
}

export function looksLikeNetworkPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    // UNC: \\server\share. Also covers the \\?\UNC\ long-path form.
    return path.startsWith('\\\\') || /^\\\\\?\\unc\\/i.test(path);
  }
  return false;
}

/**
 * Ask the kernel what kind of filesystem this is. Only Linux reports a magic
 * number we can interpret, so on other platforms this returns null and the path
 * heuristics decide.
 */
function statfsKind(path: string, platform: NodeJS.Platform): StorageKind | null {
  if (platform !== 'linux') return null;
  try {
    const stats = statfsSync(path);
    return NETWORK_FS_MAGIC.has(Number(stats.type)) ? 'network' : 'local';
  } catch {
    return null;
  }
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** Injected in tests. */
  statfs?: (path: string) => StorageKind | null;
}

/**
 * Classify the storage under `path`.
 *
 * Sync wins over network: a Dropbox folder on a network share is still subject
 * to whole-file replacement, which is the more dangerous of the two.
 */
export function detectStorageKind(path: string, options: DetectOptions = {}): StorageKind {
  const platform = options.platform ?? process.platform;

  if (looksLikeSyncFolder(path)) return 'sync';
  if (looksLikeNetworkPath(path, platform)) return 'network';

  const probe = options.statfs ?? ((candidate: string) => statfsKind(candidate, platform));
  const kind = probe(path);
  if (kind === 'network') return 'network';

  return 'local';
}

/** Only genuinely local disks get WAL. */
export function journalModeFor(kind: StorageKind): JournalMode {
  return kind === 'local' ? 'wal' : 'truncate';
}

export function storageExplanation(kind: StorageKind): string {
  switch (kind) {
    case 'sync':
      return (
        'This folder looks like it is inside a file-sync service. Mindex will use a slower, ' +
        'safer journal mode and take an advisory lock. Several machines can use this library, ' +
        'but never two writing in the same second — the sync client would make a conflicted copy.'
      );
    case 'network':
      return (
        'This folder is on a network share. Mindex will use a slower, safer journal mode so ' +
        'that locking works correctly across hosts.'
      );
    default:
      return 'This folder is on a local disk. Mindex will use WAL journalling for full read/write concurrency.';
  }
}

/** Cosmetic: the last two segments of a path, for showing in the UI. */
export function shortenPath(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  if (segments.length <= 2) return path;
  return `…${sep}${segments.slice(-2).join(sep)}`;
}
