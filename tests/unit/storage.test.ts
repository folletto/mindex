/**
 * Storage detection decides the journal mode, and getting that wrong in the
 * permissive direction corrupts data on a synced folder. The tests lean on the
 * pessimistic side deliberately.
 */

import { describe, expect, it } from 'vitest';
import {
  detectStorageKind,
  journalModeFor,
  looksLikeNetworkPath,
  looksLikeSyncFolder,
  shortenPath,
  storageExplanation,
} from '../../src/main/storage.js';

describe('looksLikeSyncFolder', () => {
  const syncPaths = [
    '/Users/sam/Dropbox/tools',
    '/Users/sam/Dropbox (Personal)/tools',
    '/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/tools',
    '/Users/sam/Library/CloudStorage/GoogleDrive-sam@example.com/My Drive/tools',
    '/Users/sam/OneDrive - Contoso/tools',
    'C:\\Users\\sam\\OneDrive\\tools',
    '/home/sam/Nextcloud/tools',
    '/home/sam/Syncthing/tools',
    '/home/sam/Sync/tools',
    '/home/sam/pCloud/tools',
    '/home/sam/Proton Drive/tools',
  ];

  it.each(syncPaths)('spots %s', (path) => {
    expect(looksLikeSyncFolder(path)).toBe(true);
  });

  const normalPaths = [
    '/Users/sam/Documents/tools',
    '/home/sam/projects/dropbox-clone',
    '/home/sam/notes/dropbox-alternatives.md',
    'C:\\Users\\sam\\Desktop\\catalogue',
    '/Volumes/Backup/tools',
  ];

  it.each(normalPaths)('leaves %s alone', (path) => {
    expect(looksLikeSyncFolder(path)).toBe(false);
  });

  it('matches whole path segments, not substrings', () => {
    // The trap: a folder legitimately named "megaproject" is not MEGA.
    expect(looksLikeSyncFolder('/home/sam/megaproject/tools')).toBe(false);
    expect(looksLikeSyncFolder('/home/sam/MEGA/tools')).toBe(true);
  });
});

describe('looksLikeNetworkPath', () => {
  it('spots a Windows UNC path', () => {
    expect(looksLikeNetworkPath('\\\\nas\\share\\tools', 'win32')).toBe(true);
    expect(looksLikeNetworkPath('\\\\?\\UNC\\nas\\share', 'win32')).toBe(true);
  });

  it('leaves a normal Windows path alone', () => {
    expect(looksLikeNetworkPath('C:\\Users\\sam\\tools', 'win32')).toBe(false);
  });

  it('does not treat a POSIX path as UNC', () => {
    expect(looksLikeNetworkPath('/home/sam/tools', 'linux')).toBe(false);
  });
});

describe('detectStorageKind', () => {
  it('calls an ordinary folder local', () => {
    expect(detectStorageKind('/home/sam/tools', { platform: 'linux', statfs: () => 'local' })).toBe('local');
  });

  it('calls a sync folder sync', () => {
    expect(detectStorageKind('/home/sam/Dropbox/tools', { platform: 'linux', statfs: () => 'local' })).toBe('sync');
  });

  it('prefers sync over network when a folder is both', () => {
    // Whole-file replacement is the more dangerous of the two failure modes.
    expect(detectStorageKind('\\\\nas\\share\\Dropbox\\tools', { platform: 'win32', statfs: () => 'network' })).toBe(
      'sync',
    );
  });

  it('calls a UNC path network', () => {
    expect(detectStorageKind('\\\\nas\\share\\tools', { platform: 'win32', statfs: () => null })).toBe('network');
  });

  it('believes the kernel when it says network', () => {
    expect(detectStorageKind('/mnt/nfs/tools', { platform: 'linux', statfs: () => 'network' })).toBe('network');
  });

  it('falls back to local when the kernel will not say', () => {
    expect(detectStorageKind('/mnt/unknown/tools', { platform: 'linux', statfs: () => null })).toBe('local');
  });

  it('works against the real filesystem without throwing', () => {
    expect(['local', 'network', 'sync']).toContain(detectStorageKind(process.cwd()));
  });
});

describe('journalModeFor', () => {
  it('gives WAL only to local disks', () => {
    expect(journalModeFor('local')).toBe('wal');
    expect(journalModeFor('network')).toBe('truncate');
    expect(journalModeFor('sync')).toBe('truncate');
  });
});

describe('storageExplanation', () => {
  it('explains the trade-off rather than just warning', () => {
    // The sync case is the one where the user has a decision to make, so it has
    // to say what will and will not work, not just "careful".
    const sync = storageExplanation('sync');
    expect(sync).toMatch(/several machines/i);
    expect(sync).toMatch(/never two writing/i);

    expect(storageExplanation('network')).toMatch(/network share/i);
    expect(storageExplanation('local')).toMatch(/WAL/);
  });
});

describe('shortenPath', () => {
  it('keeps the last two segments', () => {
    expect(shortenPath('/Users/sam/Documents/My Catalogue')).toContain('Documents');
    expect(shortenPath('/Users/sam/Documents/My Catalogue')).toContain('My Catalogue');
  });

  it('leaves an already-short path alone', () => {
    expect(shortenPath('/tmp')).toBe('/tmp');
  });
});
