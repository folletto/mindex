/**
 * Field-definition SQL.
 *
 * Definitions are per-library and few, so everything here reads the whole table
 * and lets the caller filter.
 */

import type { Database } from 'better-sqlite3';
import type { FieldDef, FieldType } from '../../shared/types.js';

interface FieldRecord {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string | null;
  position: number;
  searchable: number;
  archived_at: string | null;
}

function parseOptions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    // A hand-edited library, or one written by a newer version. Ignore the
    // choices rather than refusing to open the field at all.
    return null;
  }
}

function toFieldDef(record: FieldRecord): FieldDef {
  return {
    id: record.id,
    key: record.key,
    label: record.label,
    type: record.type as FieldType,
    options: parseOptions(record.options),
    position: record.position,
    searchable: record.searchable === 1,
    archivedAt: record.archived_at,
  };
}

export function listFieldDefs(db: Database, options: { includeArchived?: boolean } = {}): FieldDef[] {
  const sql = options.includeArchived
    ? 'SELECT * FROM field_defs ORDER BY position ASC, label ASC'
    : 'SELECT * FROM field_defs WHERE archived_at IS NULL ORDER BY position ASC, label ASC';
  return (db.prepare(sql).all() as FieldRecord[]).map(toFieldDef);
}

export function getFieldDef(db: Database, id: string): FieldDef | null {
  const record = db.prepare('SELECT * FROM field_defs WHERE id = ?').get(id) as FieldRecord | undefined;
  return record ? toFieldDef(record) : null;
}

export function isFieldKeyTaken(db: Database, key: string, exceptId?: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM field_defs WHERE key = ? AND id IS NOT ? LIMIT 1')
    .get(key, exceptId ?? null) as { hit: number } | undefined;
  return row !== undefined;
}

export function nextFieldPosition(db: Database): number {
  const row = db.prepare('SELECT IFNULL(MAX(position), -1) + 1 AS next FROM field_defs').get() as { next: number };
  return row.next;
}

export function insertFieldDef(
  db: Database,
  input: {
    id: string;
    key: string;
    label: string;
    type: FieldType;
    options: string[] | null;
    position: number;
    searchable: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO field_defs (id, key, label, type, options, position, searchable)
     VALUES (@id, @key, @label, @type, @options, @position, @searchable)`,
  ).run({
    ...input,
    options: input.options ? JSON.stringify(input.options) : null,
    searchable: input.searchable ? 1 : 0,
  });
}

export function updateFieldDef(
  db: Database,
  input: {
    id: string;
    label: string;
    type: FieldType;
    options: string[] | null;
    position: number;
    searchable: boolean;
  },
): number {
  return db
    .prepare(
      `UPDATE field_defs
       SET label = @label, type = @type, options = @options, position = @position, searchable = @searchable
       WHERE id = @id`,
    )
    .run({
      ...input,
      options: input.options ? JSON.stringify(input.options) : null,
      searchable: input.searchable ? 1 : 0,
    }).changes;
}

export function setFieldArchived(db: Database, id: string, archivedAt: string | null): number {
  return db.prepare('UPDATE field_defs SET archived_at = ? WHERE id = ?').run(archivedAt, id).changes;
}

export function setFieldPosition(db: Database, id: string, position: number): number {
  return db.prepare('UPDATE field_defs SET position = ? WHERE id = ?').run(position, id).changes;
}

/** Deleting a definition cascades its values away — the UI offers archiving first. */
export function deleteFieldDef(db: Database, id: string): number {
  return db.prepare('DELETE FROM field_defs WHERE id = ?').run(id).changes;
}
