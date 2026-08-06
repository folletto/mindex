/**
 * Filesystem failure modes.
 *
 * These need `node:fs` itself to misbehave, which in ESM means mocking the
 * module rather than spying on it — hence a file of their own, so the mock does
 * not leak into the suites that want a real filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failures = {
  /** Number of upcoming renameSync calls that should fail with EXDEV. */
  exdevRenames: 0,
  /** Number of upcoming renameSync calls that should fail unrecoverably. */
  permRenames: 0,
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync(from: string, to: string) {
      if (failures.permRenames > 0) {
        failures.permRenames--;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      if (failures.exdevRenames > 0) {
        failures.exdevRenames--;
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      }
      return actual.renameSync(from, to);
    },
  };
});

const { existsSync, readFileSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { cleanupTempDirs, makeFile, makeLibrary, makeTempDir } = await import('../helpers/temp.js');

type TestLibrary = ReturnType<typeof makeLibrary>;

let lib: TestLibrary;
let source: string;

beforeEach(() => {
  failures.exdevRenames = 0;
  lib = makeLibrary();
  source = makeTempDir('mindex-source-');
});

afterEach(() => {
  lib.close();
  cleanupTempDirs();
});

function withAttachment(name: string, filename = 'manual.pdf', contents = 'the manual') {
  const item = lib.service.createItem({ name });
  lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, filename, contents)] });
  return lib.service.getItem(item.id)!;
}

describe('EXDEV — the library straddles a mount point', () => {
  it('falls back to copy-and-delete when trashing', () => {
    const item = withAttachment('Widget');
    failures.exdevRenames = 1;

    const result = lib.service.trashItem({ id: item.id, rev: item.rev });

    expect(failures.exdevRenames).toBe(0);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(lib.root, 'deleted', result.deletedPath!, 'manual.pdf'), 'utf8')).toBe('the manual');
    expect(existsSync(join(lib.root, 'data', 'widget'))).toBe(false);
  });

  it('falls back to copy-and-delete when restoring', () => {
    const item = withAttachment('Widget');
    lib.service.trashItem({ id: item.id, rev: item.rev });
    failures.exdevRenames = 1;

    const restored = lib.service.restoreItem({ id: item.id });

    expect(restored.slug).toBe('widget');
    expect(readFileSync(join(lib.root, 'data', 'widget', 'manual.pdf'), 'utf8')).toBe('the manual');
  });

  it('falls back when renaming an item folder, keeping nested files', () => {
    const item = withAttachment('Widget');
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'photo.jpg', 'jpeg')] });
    const fresh = lib.service.getItem(item.id)!;
    lib.service.updateItem({ id: fresh.id, rev: fresh.rev, patch: { name: 'Renamed' } });

    failures.exdevRenames = 1;
    const renamed = lib.service.renameFolder({ id: item.id });

    expect(renamed.slug).toBe('renamed');
    expect(readdirSync(join(lib.root, 'data', 'renamed')).sort()).toEqual(['manual.pdf', 'photo.jpg']);
    expect(existsSync(join(lib.root, 'data', 'widget'))).toBe(false);
  });

  it('falls back when removing an attachment', () => {
    const item = withAttachment('Widget');
    failures.exdevRenames = 1;

    lib.service.removeAttachment({ attachmentId: item.attachments[0].id });

    expect(lib.service.getItem(item.id)!.attachments).toHaveLength(0);
    expect(existsSync(join(lib.root, 'data', 'widget', 'manual.pdf'))).toBe(false);
  });
});

describe('a filesystem move that fails outright', () => {
  beforeEach(() => {
    failures.exdevRenames = 0;
  });

  it('rolls the slug back so the row still matches the disk', () => {
    const item = withAttachment('Widget');
    const fresh = lib.service.getItem(item.id)!;
    lib.service.updateItem({ id: fresh.id, rev: fresh.rev, patch: { name: 'Renamed' } });

    failures.permRenames = 1;
    expect(() => lib.service.renameFolder({ id: item.id })).toThrow(/not permitted/);

    // The database claimed the new slug, then gave it back: row and disk agree.
    const after = lib.service.getItem(item.id)!;
    expect(after.slug).toBe('widget');
    expect(existsSync(join(lib.root, 'data', 'widget', 'manual.pdf'))).toBe(true);
    expect(existsSync(join(lib.root, 'data', 'renamed'))).toBe(false);
    expect(lib.service.verify().missingFiles).toEqual([]);
    expect(lib.service.verify().orphanFolders).toEqual([]);
  });

  it('puts a restored item back in the trash rather than half-restoring it', () => {
    const item = withAttachment('Widget');
    const result = lib.service.trashItem({ id: item.id, rev: item.rev });

    failures.permRenames = 1;
    expect(() => lib.service.restoreItem({ id: item.id })).toThrow(/not permitted/);

    const trash = lib.service.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0].id).toBe(item.id);
    expect(lib.service.listItems()).toHaveLength(0);
    // The bytes never moved.
    expect(readFileSync(join(lib.root, 'deleted', result.deletedPath!, 'manual.pdf'), 'utf8')).toBe('the manual');
  });
});
