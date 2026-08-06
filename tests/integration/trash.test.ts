/**
 * Trash and restore.
 *
 * The contract is that nothing is ever destroyed, so every test here checks the
 * bytes as well as the row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, makeFile, makeLibrary, makeTempDir, type TestLibrary } from '../helpers/temp.js';

let lib: TestLibrary;
let source: string;

beforeEach(() => {
  lib = makeLibrary();
  source = makeTempDir('mindex-source-');
});

afterEach(() => {
  vi.restoreAllMocks();
  lib.close();
  cleanupTempDirs();
});

function withAttachment(name: string, filename = 'manual.pdf', contents = 'the manual') {
  const item = lib.service.createItem({ name });
  lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, filename, contents)] });
  return lib.service.getItem(item.id)!;
}

describe('trashItem', () => {
  it('moves the folder into deleted/ and hides the row', () => {
    const item = withAttachment('Old Thing');

    const result = lib.service.trashItem({ id: item.id, rev: item.rev });

    expect(result.ok).toBe(true);
    expect(result.deletedPath).toMatch(/^old-thing--\d{8}-\d{6}$/);
    expect(existsSync(join(lib.root, 'data', 'old-thing'))).toBe(false);
    expect(readFileSync(join(lib.root, 'deleted', result.deletedPath!, 'manual.pdf'), 'utf8')).toBe('the manual');
    expect(lib.service.listItems()).toHaveLength(0);
  });

  it('keeps the item and its attachments visible in the trash', () => {
    const item = withAttachment('Old Thing');
    lib.service.trashItem({ id: item.id, rev: item.rev });

    const trash = lib.service.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0].name).toBe('Old Thing');
    expect(trash[0].attachmentCount).toBe(1);
    expect(lib.service.getItem(item.id)!.attachments).toHaveLength(1);
  });

  it('works for an item that never got a folder', () => {
    const item = lib.service.createItem({ name: 'Never Attached' });
    const result = lib.service.trashItem({ id: item.id, rev: item.rev });
    expect(result.ok).toBe(true);
    expect(result.deletedPath).toBeUndefined();
  });

  it('frees the slug for reuse', () => {
    const first = lib.service.createItem({ name: 'Widget' });
    lib.service.trashItem({ id: first.id, rev: first.rev });

    const second = lib.service.createItem({ name: 'Widget' });
    expect(second.slug).toBe('widget');
  });

  it('never collides when the same name is cycled', () => {
    const stamps = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const item = withAttachment('Widget');
      const result = lib.service.trashItem({ id: item.id, rev: item.rev });
      stamps.add(result.deletedPath!);
    }
    expect(stamps.size).toBe(3);
    expect(readdirSync(join(lib.root, 'deleted'))).toHaveLength(3);
  });

  it('refuses a stale rev and puts the folder back', () => {
    const item = withAttachment('Widget');
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { notes: 'someone else was here' } });

    const result = lib.service.trashItem({ id: item.id, rev: item.rev });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Another copy/);
    // The folder is exactly where it was.
    expect(existsSync(join(lib.root, 'data', 'widget', 'manual.pdf'))).toBe(true);
    expect(existsSync(join(lib.root, 'deleted'))).toBe(false);
    expect(lib.service.listItems()).toHaveLength(1);
  });

  it('is idempotent for an item already in the trash', () => {
    const item = withAttachment('Widget');
    const first = lib.service.trashItem({ id: item.id, rev: item.rev });
    const second = lib.service.trashItem({ id: item.id, rev: item.rev + 1 });
    expect(second.ok).toBe(true);
    expect(second.deletedPath).toBe(first.deletedPath);
  });

  it('tolerates the folder already being gone', () => {
    const item = withAttachment('Widget');
    rmSync(join(lib.root, 'data', 'widget'), { recursive: true, force: true });

    const result = lib.service.trashItem({ id: item.id, rev: item.rev });
    expect(result.ok).toBe(true);
    expect(lib.service.listItems()).toHaveLength(0);
  });
});

describe('restoreItem', () => {
  it('brings the item and its files back', () => {
    const item = withAttachment('Old Thing');
    lib.service.trashItem({ id: item.id, rev: item.rev });

    const restored = lib.service.restoreItem({ id: item.id });

    expect(restored.slug).toBe('old-thing');
    expect(restored.attachments).toHaveLength(1);
    expect(readFileSync(join(lib.root, 'data', 'old-thing', 'manual.pdf'), 'utf8')).toBe('the manual');
    expect(lib.service.listItems()).toHaveLength(1);
    expect(lib.service.listTrash()).toHaveLength(0);
  });

  it('is lossless — the item comes back exactly as it went in', () => {
    const field = lib.service.createField({ label: 'Voltage', type: 'number' });
    const item = lib.service.createItem({
      name: 'Widget',
      manufacturer: 'Acme',
      notes: 'notes',
      fields: { [field.key]: 12 },
    });
    const before = lib.service.getItem(item.id)!;

    lib.service.trashItem({ id: item.id, rev: before.rev });
    const restored = lib.service.restoreItem({ id: item.id });

    expect(restored.name).toBe(before.name);
    expect(restored.manufacturer).toBe(before.manufacturer);
    expect(restored.notes).toBe(before.notes);
    expect(restored.fields).toEqual(before.fields);
  });

  it('re-slugs when the name was taken while it was away', () => {
    const item = withAttachment('Widget');
    lib.service.trashItem({ id: item.id, rev: item.rev });
    lib.service.createItem({ name: 'Widget' });

    const restored = lib.service.restoreItem({ id: item.id });

    expect(restored.slug).toBe('widget-2');
    expect(readFileSync(join(lib.root, 'data', 'widget-2', 'manual.pdf'), 'utf8')).toBe('the manual');
    expect(lib.service.listItems()).toHaveLength(2);
  });

  it('restores an item whose trash folder was deleted by hand', () => {
    const item = withAttachment('Widget');
    const result = lib.service.trashItem({ id: item.id, rev: item.rev });
    rmSync(join(lib.root, 'deleted', result.deletedPath!), { recursive: true, force: true });

    const restored = lib.service.restoreItem({ id: item.id });

    // The row comes back; verify() is what tells the user the bytes did not.
    expect(restored.slug).toBe('widget');
    expect(lib.service.verify().missingFiles).toEqual([{ itemId: item.id, filename: 'manual.pdf' }]);
  });

  it('is a no-op for an item that is not in the trash', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    expect(lib.service.restoreItem({ id: item.id }).rev).toBe(item.rev);
  });

  it('survives a full trash and restore cycle repeated', () => {
    let item = withAttachment('Widget');
    for (let i = 0; i < 3; i++) {
      lib.service.trashItem({ id: item.id, rev: item.rev });
      item = lib.service.restoreItem({ id: item.id });
      expect(item.attachments).toHaveLength(1);
    }
    expect(readFileSync(join(lib.root, 'data', item.slug, 'manual.pdf'), 'utf8')).toBe('the manual');
  });
});

describe('the trash is never emptied automatically', () => {
  it('leaves every generation in place', () => {
    for (let i = 0; i < 4; i++) {
      const item = withAttachment(`Thing ${i}`, `file-${i}.pdf`);
      lib.service.trashItem({ id: item.id, rev: item.rev });
    }
    expect(readdirSync(join(lib.root, 'deleted'))).toHaveLength(4);
  });
});
