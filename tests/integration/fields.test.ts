import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coerceFieldValue, parseFieldValue, planTypeChange } from '../../src/shared/fields.js';
import { ValidationError } from '../../src/main/service.js';
import { cleanupTempDirs, makeLibrary, type TestLibrary } from '../helpers/temp.js';

let lib: TestLibrary;

beforeEach(() => {
  lib = makeLibrary();
});

afterEach(() => {
  lib.close();
  cleanupTempDirs();
});

describe('coerceFieldValue', () => {
  it('stores text as-is', () => {
    expect(coerceFieldValue({ type: 'text', options: null }, 'hello')).toEqual({
      ok: true,
      stored: { value: 'hello', numValue: null },
    });
  });

  it('mirrors numbers into num_value for sorting', () => {
    expect(coerceFieldValue({ type: 'number', options: null }, '12.5')).toEqual({
      ok: true,
      stored: { value: '12.5', numValue: 12.5 },
    });
  });

  it('accepts a comma decimal separator', () => {
    expect(coerceFieldValue({ type: 'number', options: null }, '12,5')).toMatchObject({
      stored: { numValue: 12.5 },
    });
  });

  it('rejects a number that is not one', () => {
    expect(coerceFieldValue({ type: 'number', options: null }, 'twelve')).toEqual({
      ok: false,
      reason: '"twelve" is not a number',
    });
  });

  it('rejects infinity', () => {
    expect(coerceFieldValue({ type: 'number', options: null }, 'Infinity').ok).toBe(false);
  });

  it('canonicalizes dates to ISO days with an epoch mirror', () => {
    expect(coerceFieldValue({ type: 'date', options: null }, '2026-08-06')).toEqual({
      ok: true,
      stored: { value: '2026-08-06', numValue: Date.UTC(2026, 7, 6) },
    });
  });

  it('rejects a date that is not one', () => {
    expect(coerceFieldValue({ type: 'date', options: null }, 'someday').ok).toBe(false);
  });

  it('accepts the many spellings of yes and no', () => {
    for (const yes of [true, 1, 'true', 'YES', 'on', '1']) {
      expect(coerceFieldValue({ type: 'boolean', options: null }, yes)).toMatchObject({
        stored: { value: '1', numValue: 1 },
      });
    }
    for (const no of [false, 0, 'false', 'NO', 'off', '0']) {
      expect(coerceFieldValue({ type: 'boolean', options: null }, no)).toMatchObject({
        stored: { value: '0', numValue: 0 },
      });
    }
  });

  it('rejects a boolean that is neither', () => {
    expect(coerceFieldValue({ type: 'boolean', options: null }, 'maybe').ok).toBe(false);
  });

  it('adds a scheme to a bare host', () => {
    expect(coerceFieldValue({ type: 'url', options: null }, 'example.com/thing')).toMatchObject({
      stored: { value: 'https://example.com/thing' },
    });
  });

  it('refuses a non-web scheme', () => {
    expect(coerceFieldValue({ type: 'url', options: null }, 'file:///etc/passwd').ok).toBe(false);
    expect(coerceFieldValue({ type: 'url', options: null }, 'javascript:alert(1)').ok).toBe(false);
  });

  it('holds a select to its options', () => {
    const field = { type: 'select' as const, options: ['metric', 'imperial'] };
    expect(coerceFieldValue(field, 'metric')).toMatchObject({ stored: { value: 'metric', numValue: 0 } });
    expect(coerceFieldValue(field, 'imperial')).toMatchObject({ stored: { value: 'imperial', numValue: 1 } });
    expect(coerceFieldValue(field, 'cubits').ok).toBe(false);
  });

  it('treats blank as cleared, for every type', () => {
    for (const type of ['text', 'number', 'date', 'boolean', 'url', 'select'] as const) {
      expect(coerceFieldValue({ type, options: [] }, '')).toEqual({ ok: true, stored: { value: null, numValue: null } });
      expect(coerceFieldValue({ type, options: [] }, null)).toEqual({ ok: true, stored: { value: null, numValue: null } });
    }
  });
});

describe('parseFieldValue', () => {
  it('round-trips every type', () => {
    expect(parseFieldValue('number', '12.5')).toBe(12.5);
    expect(parseFieldValue('boolean', '1')).toBe(true);
    expect(parseFieldValue('boolean', '0')).toBe(false);
    expect(parseFieldValue('date', '2026-08-06')).toBe('2026-08-06');
    expect(parseFieldValue('text', 'hello')).toBe('hello');
    expect(parseFieldValue('text', null)).toBeNull();
  });
});

describe('field definitions', () => {
  it('derives a stable key from the label', () => {
    const field = lib.service.createField({ label: 'Voltage (V)', type: 'number' });
    expect(field.key).toBe('voltage-v');
    expect(field.position).toBe(0);
    expect(field.searchable).toBe(true);
  });

  it('disambiguates two labels that normalize to the same key', () => {
    expect(lib.service.createField({ label: 'Voltage', type: 'number' }).key).toBe('voltage');
    expect(lib.service.createField({ label: 'voltage!', type: 'text' }).key).toBe('voltage-2');
  });

  it('renaming a label leaves the key alone', () => {
    const field = lib.service.createField({ label: 'Voltage', type: 'number' });
    const renamed = lib.service.updateField({ id: field.id, patch: { label: 'Working voltage' } });
    expect(renamed.label).toBe('Working voltage');
    expect(renamed.key).toBe('voltage');
  });

  it('requires options for a choice field', () => {
    expect(() => lib.service.createField({ label: 'Units', type: 'select' })).toThrow(ValidationError);
    expect(() => lib.service.createField({ label: 'Units', type: 'select', options: [] })).toThrow(ValidationError);
  });

  it('requires a name', () => {
    expect(() => lib.service.createField({ label: '  ', type: 'text' })).toThrow(ValidationError);
  });

  it('reorders', () => {
    const a = lib.service.createField({ label: 'A', type: 'text' });
    const b = lib.service.createField({ label: 'B', type: 'text' });
    const c = lib.service.createField({ label: 'C', type: 'text' });

    const reordered = lib.service.reorderFields({ ids: [c.id, a.id, b.id] });
    expect(reordered.map((field) => field.label)).toEqual(['C', 'A', 'B']);
  });
});

describe('field values on items', () => {
  it('are handed to the renderer as a plain key/value map', () => {
    const voltage = lib.service.createField({ label: 'Voltage', type: 'number' });
    const kind = lib.service.createField({ label: 'Units', type: 'select', options: ['metric', 'imperial'] });

    const item = lib.service.createItem({
      name: 'Widget',
      fields: { [voltage.key]: 12, [kind.key]: 'metric' },
    });

    expect(item.fields).toEqual({ voltage: 12, units: 'metric' });
  });

  it('reject a value that does not fit its type, naming the field', () => {
    const field = lib.service.createField({ label: 'Voltage', type: 'number' });
    expect(() => lib.service.createItem({ name: 'Widget', fields: { [field.key]: 'twelve' } })).toThrow(
      /Voltage: "twelve" is not a number/,
    );
  });

  it('reject a key that is not a field in this library', () => {
    expect(() => lib.service.createItem({ name: 'Widget', fields: { nonesuch: 1 } })).toThrow(
      /no field called "nonesuch"/,
    );
  });

  it('clear a value when it is set to blank', () => {
    const field = lib.service.createField({ label: 'Voltage', type: 'number' });
    const item = lib.service.createItem({ name: 'Widget', fields: { [field.key]: 12 } });

    lib.service.updateItem({ id: item.id, rev: item.rev, patch: {}, fields: { [field.key]: null } });
    expect(lib.service.getItem(item.id)!.fields).toEqual({});
  });

  it('are fetched for a whole page in one query, not N+1', () => {
    const field = lib.service.createField({ label: 'Voltage', type: 'number' });
    const ids = [1, 2, 3].map((n) => lib.service.createItem({ name: `Widget ${n}`, fields: { [field.key]: n } }).id);

    const values = lib.service.fieldValuesFor(ids);
    expect(values.size).toBe(3);
    expect(values.get(ids[1])).toEqual({ voltage: 2 });
  });
});

describe('changing a field type', () => {
  it('is allowed when every existing value converts', () => {
    const field = lib.service.createField({ label: 'Code', type: 'text' });
    lib.service.createItem({ name: 'A', fields: { [field.key]: '12' } });
    lib.service.createItem({ name: 'B', fields: { [field.key]: '34' } });

    const retyped = lib.service.updateField({ id: field.id, patch: { type: 'number' } });
    expect(retyped.type).toBe('number');
    expect(lib.service.listItems({ sort: 'name', direction: 'asc' }).length).toBe(2);
  });

  it('refuses rather than silently dropping values, and says how many', () => {
    const field = lib.service.createField({ label: 'Code', type: 'text' });
    lib.service.createItem({ name: 'A', fields: { [field.key]: '12' } });
    lib.service.createItem({ name: 'B', fields: { [field.key]: 'not a number' } });

    expect(() => lib.service.updateField({ id: field.id, patch: { type: 'number' } })).toThrow(
      /1 existing value could not be converted to number/,
    );
    expect(lib.service.listFields()[0].type).toBe('text');
  });

  it('re-derives num_value so sorting still works after a retype', () => {
    const field = lib.service.createField({ label: 'Code', type: 'text' });
    lib.service.createItem({ name: 'A', fields: { [field.key]: '100' } });
    lib.service.createItem({ name: 'B', fields: { [field.key]: '20' } });

    lib.service.updateField({ id: field.id, patch: { type: 'number' } });

    const rows = lib.library.db
      .prepare('SELECT value, num_value FROM field_values ORDER BY num_value')
      .all() as { value: string; num_value: number }[];
    expect(rows.map((row) => row.num_value)).toEqual([20, 100]);
  });

  it('refuses a select that would orphan a value', () => {
    const field = lib.service.createField({ label: 'Units', type: 'select', options: ['metric', 'imperial'] });
    lib.service.createItem({ name: 'A', fields: { [field.key]: 'imperial' } });

    expect(() => lib.service.updateField({ id: field.id, patch: { options: ['metric'] } })).toThrow(
      /could not be converted/,
    );
  });
});

describe('archiving a field', () => {
  it('hides it from forms while keeping the values', () => {
    const field = lib.service.createField({ label: 'Legacy', type: 'text' });
    const item = lib.service.createItem({ name: 'Widget', fields: { [field.key]: 'kept' } });

    lib.service.archiveField({ id: field.id, archived: true });

    expect(lib.service.listFields().map((f) => f.id)).not.toContain(field.id);
    expect(lib.service.listFields({ includeArchived: true }).map((f) => f.id)).toContain(field.id);
    // The value is still readable, which is what makes archiving the safe default.
    expect(lib.service.getItem(item.id)!.fields).toEqual({ legacy: 'kept' });
  });

  it('can be undone', () => {
    const field = lib.service.createField({ label: 'Legacy', type: 'text' });
    lib.service.archiveField({ id: field.id, archived: true });
    const restored = lib.service.archiveField({ id: field.id, archived: false });
    expect(restored.archivedAt).toBeNull();
    expect(lib.service.listFields()).toHaveLength(1);
  });
});

describe('deleting a field', () => {
  it('takes its values with it, which is why the UI offers archiving first', () => {
    const field = lib.service.createField({ label: 'Doomed', type: 'text' });
    const item = lib.service.createItem({ name: 'Widget', fields: { [field.key]: 'gone soon' } });

    expect(lib.service.removeField({ id: field.id })).toEqual({ ok: true });
    expect(lib.service.listFields({ includeArchived: true })).toHaveLength(0);
    expect(lib.service.getItem(item.id)!.fields).toEqual({});
  });

  it('reports when there was nothing to delete', () => {
    expect(lib.service.removeField({ id: 'ghost' })).toEqual({ ok: false });
  });
});

describe('planTypeChange', () => {
  it('counts convertible values and names the failures', () => {
    const report = planTypeChange({ type: 'number', options: null }, [
      { itemId: 'a', value: '12' },
      { itemId: 'b', value: 'twelve' },
      { itemId: 'c', value: null },
    ]);
    expect(report.convertible).toBe(1);
    expect(report.failures).toEqual([{ itemId: 'b', value: 'twelve', reason: '"twelve" is not a number' }]);
  });
});
