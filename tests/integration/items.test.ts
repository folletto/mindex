import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundError, ValidationError } from '../../src/main/service.js';
import { cleanupTempDirs, makeFile, makeLibrary, makeTempDir, type TestLibrary } from '../helpers/temp.js';

let lib: TestLibrary;

beforeEach(() => {
  lib = makeLibrary();
});

afterEach(() => {
  lib.close();
  cleanupTempDirs();
});

describe('createItem', () => {
  it('stores the item and gives it a slug', () => {
    const item = lib.service.createItem({ name: 'Acme Widget Mk2', manufacturer: 'Acme' });
    expect(item.name).toBe('Acme Widget Mk2');
    expect(item.slug).toBe('acme-widget-mk2');
    expect(item.rev).toBe(1);
    expect(item.attachmentCount).toBe(0);
    expect(item.updatedBy).toBe('test-host');
  });

  it('does not create the folder until there is something to put in it', () => {
    const item = lib.service.createItem({ name: 'Acme Widget' });
    expect(existsSync(join(lib.root, 'data', item.slug))).toBe(false);
  });

  it('disambiguates a duplicate name', () => {
    const first = lib.service.createItem({ name: 'Widget' });
    const second = lib.service.createItem({ name: 'Widget' });
    const third = lib.service.createItem({ name: 'widget' });
    expect(first.slug).toBe('widget');
    expect(second.slug).toBe('widget-2');
    expect(third.slug).toBe('widget-3');
    // Same name is allowed; only the folder has to differ.
    expect(third.name).toBe('widget');
  });

  it('trims whitespace and refuses an empty name', () => {
    expect(lib.service.createItem({ name: '  Padded  ' }).name).toBe('Padded');
    expect(() => lib.service.createItem({ name: '   ' })).toThrow(ValidationError);
  });

  it('normalizes an empty manufacturer to null', () => {
    expect(lib.service.createItem({ name: 'A', manufacturer: '  ' }).manufacturer).toBeNull();
  });
});

describe('listItems', () => {
  beforeEach(() => {
    lib.service.createItem({ name: 'Bosch GSB 13 RE', manufacturer: 'Bosch', notes: 'hammer drill' });
    lib.service.createItem({ name: 'Acme Widget', manufacturer: 'Acme', notes: 'the good one' });
    lib.service.createItem({ name: 'Makita Grinder', manufacturer: 'Makita' });
  });

  it('returns everything, newest first by default', () => {
    const rows = lib.service.listItems();
    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe('Makita Grinder');
  });

  it('sorts by name', () => {
    const rows = lib.service.listItems({ sort: 'name', direction: 'asc' });
    expect(rows.map((row) => row.name)).toEqual(['Acme Widget', 'Bosch GSB 13 RE', 'Makita Grinder']);
  });

  it('searches name, manufacturer and notes', () => {
    expect(lib.service.listItems({ query: 'bosch' }).map((row) => row.name)).toEqual(['Bosch GSB 13 RE']);
    expect(lib.service.listItems({ query: 'makita' }).map((row) => row.name)).toEqual(['Makita Grinder']);
    expect(lib.service.listItems({ query: 'good one' }).map((row) => row.name)).toEqual(['Acme Widget']);
  });

  it('searches case-insensitively', () => {
    expect(lib.service.listItems({ query: 'ACME' })).toHaveLength(1);
  });

  it('treats LIKE wildcards in the query as literal characters', () => {
    lib.service.createItem({ name: '50% cotton' });
    expect(lib.service.listItems({ query: '%' }).map((row) => row.name)).toEqual(['50% cotton']);
    expect(lib.service.listItems({ query: '_' })).toHaveLength(0);
  });

  it('pages', () => {
    expect(lib.service.listItems({ limit: 2 })).toHaveLength(2);
    expect(lib.service.listItems({ limit: 2, offset: 2 })).toHaveLength(1);
  });

  it('finds items by a searchable custom field', () => {
    const field = lib.service.createField({ label: 'Serial', type: 'text' });
    const item = lib.service.createItem({ name: 'Tagged thing' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: {}, fields: { [field.key]: 'XJ-9000' } });

    expect(lib.service.listItems({ query: 'xj-9000' }).map((row) => row.name)).toEqual(['Tagged thing']);
  });

  it('ignores custom fields that are marked unsearchable', () => {
    const field = lib.service.createField({ label: 'Internal', type: 'text', searchable: false });
    const item = lib.service.createItem({ name: 'Quiet thing' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: {}, fields: { [field.key]: 'ZZ-TOP' } });

    expect(lib.service.listItems({ query: 'zz-top' })).toHaveLength(0);
  });
});

describe('updateItem', () => {
  it('applies a patch and bumps the rev', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const result = lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Better Widget' } });

    expect(result).not.toHaveProperty('conflict', true);
    if ('item' in result) {
      expect(result.item.name).toBe('Better Widget');
      expect(result.item.rev).toBe(item.rev + 1);
    }
  });

  it('leaves the folder name alone when the item is renamed', () => {
    // The id is the real key; a stable folder is worth more than a tidy one.
    const item = lib.service.createItem({ name: 'Widget' });
    const result = lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Completely Different' } });
    if ('item' in result) expect(result.item.slug).toBe('widget');
  });

  it('only touches the keys present in the patch', () => {
    const item = lib.service.createItem({ name: 'Widget', manufacturer: 'Acme', notes: 'keep me' });
    const result = lib.service.updateItem({ id: item.id, rev: item.rev, patch: { manufacturer: 'Bosch' } });
    if ('item' in result) {
      expect(result.item.manufacturer).toBe('Bosch');
      expect(result.item.notes).toBe('keep me');
      expect(result.item.name).toBe('Widget');
    }
  });

  it('refuses to blank the name', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    expect(() => lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: '  ' } })).toThrow(ValidationError);
  });

  it('throws for an item that is gone', () => {
    expect(() => lib.service.updateItem({ id: 'nope', rev: 1, patch: { name: 'x' } })).toThrow(NotFoundError);
  });
});

describe('updateItem — concurrent edits', () => {
  it('reports a conflict when two writers change the same field', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Their name' } });

    const result = lib.service.updateItem({
      id: item.id,
      rev: item.rev, // stale
      patch: { name: 'My name' },
      base: { name: 'Widget' },
    });

    expect(result).toMatchObject({ conflict: true, overlapping: ['name'] });
    if ('current' in result) expect(result.current.name).toBe('Their name');
  });

  it('merges automatically when the two writers changed different fields', () => {
    const item = lib.service.createItem({ name: 'Widget', manufacturer: 'Acme', notes: 'original' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { manufacturer: 'Bosch' } });

    const result = lib.service.updateItem({
      id: item.id,
      rev: item.rev, // stale, but we only touched notes
      patch: { notes: 'mine' },
      base: { notes: 'original' },
    });

    expect(result).not.toHaveProperty('conflict', true);
    if ('item' in result) {
      expect(result.item.notes).toBe('mine');
      expect(result.item.manufacturer).toBe('Bosch');
    }
  });

  it('accepts a stale write that agrees with what is already stored', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Agreed' } });

    const result = lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Agreed' } });
    expect(result).not.toHaveProperty('conflict', true);
  });

  it('treats every difference as a conflict when no base is supplied', () => {
    const item = lib.service.createItem({ name: 'Widget', notes: 'original' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { manufacturer: 'Bosch' } });

    const result = lib.service.updateItem({ id: item.id, rev: item.rev, patch: { notes: 'mine' } });
    expect(result).toMatchObject({ conflict: true, overlapping: ['notes'] });
  });

  it('detects conflicts on custom fields too', () => {
    const field = lib.service.createField({ label: 'Voltage', type: 'number' });
    const item = lib.service.createItem({ name: 'Widget', fields: { [field.key]: 12 } });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: {}, fields: { [field.key]: 24 } });

    const result = lib.service.updateItem({
      id: item.id,
      rev: item.rev,
      patch: {},
      fields: { [field.key]: 48 },
      base: { fields: { [field.key]: 12 } },
    });

    expect(result).toMatchObject({ conflict: true, overlapping: [field.key] });
  });

  it('does not write anything when it reports a conflict', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Their name' } });
    const before = lib.service.getItem(item.id);

    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'My name' }, base: { name: 'Widget' } });

    expect(lib.service.getItem(item.id)).toEqual(before);
  });
});

describe('renameFolder', () => {
  it('moves the folder to match the name', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const source = makeTempDir();
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'manual.pdf')] });

    // Adding an attachment bumps the rev, so re-read before editing.
    const attached = lib.service.getItem(item.id)!;
    lib.service.updateItem({ id: attached.id, rev: attached.rev, patch: { name: 'Renamed Thing' } });
    const renamed = lib.service.renameFolder({ id: item.id });

    expect(renamed.slug).toBe('renamed-thing');
    expect(existsSync(join(lib.root, 'data', 'renamed-thing', 'manual.pdf'))).toBe(true);
    expect(existsSync(join(lib.root, 'data', 'widget'))).toBe(false);
  });

  it('is a no-op when the folder already matches', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    expect(lib.service.renameFolder({ id: item.id }).slug).toBe('widget');
  });

  it('disambiguates when the target name is taken', () => {
    lib.service.createItem({ name: 'Taken' });
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.updateItem({ id: item.id, rev: item.rev, patch: { name: 'Taken' } });

    expect(lib.service.renameFolder({ id: item.id }).slug).toBe('taken-2');
  });

  it('refuses for an item in the trash', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.trashItem({ id: item.id, rev: item.rev });
    expect(() => lib.service.renameFolder({ id: item.id })).toThrow(ValidationError);
  });
});
