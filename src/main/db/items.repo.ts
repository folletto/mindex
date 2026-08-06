/**
 * All item, attachment and field-value SQL.
 *
 * Nothing in here touches the filesystem and nothing opens a transaction: the
 * service layer sequences those, so that a retried transaction never replays a
 * file copy.
 */

import type { Database } from 'better-sqlite3';
import type {
  Attachment,
  FieldDef,
  ItemRow,
  ListQuery,
  SortDirection,
  SortKey,
  TrashRow,
} from '../../shared/types.js';

interface ItemRecord {
  id: string;
  name: string;
  slug: string;
  manufacturer: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  rev: number;
  deleted_at: string | null;
  deleted_path: string | null;
  attachment_count: number;
}

interface AttachmentRecord {
  id: string;
  item_id: string;
  filename: string;
  size_bytes: number | null;
  added_at: string;
}

function toItemRow(record: ItemRecord): ItemRow {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    manufacturer: record.manufacturer,
    notes: record.notes,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    updatedBy: record.updated_by,
    rev: record.rev,
    attachmentCount: record.attachment_count ?? 0,
  };
}

function toTrashRow(record: ItemRecord): TrashRow {
  return {
    ...toItemRow(record),
    deletedAt: record.deleted_at ?? '',
    deletedPath: record.deleted_path,
  };
}

function toAttachment(record: AttachmentRecord): Attachment {
  return {
    id: record.id,
    itemId: record.item_id,
    filename: record.filename,
    sizeBytes: record.size_bytes,
    addedAt: record.added_at,
  };
}

/** `%` and `_` are LIKE wildcards; a user searching for "50%" means the characters. */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

const SORT_COLUMNS: Record<SortKey, string> = {
  name: 'name COLLATE NOCASE',
  manufacturer: 'manufacturer COLLATE NOCASE',
  updatedAt: 'updated_at',
  createdAt: 'created_at',
};

function orderBy(sort: SortKey = 'updatedAt', direction: SortDirection = 'desc'): string {
  const column = SORT_COLUMNS[sort] ?? SORT_COLUMNS.updatedAt;
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  // Trailing id keeps paging stable when two rows share a sort value.
  return `ORDER BY ${column} ${dir}, id ASC`;
}

/**
 * Matches name, manufacturer, notes and any searchable custom field.
 *
 * v1 is a LIKE scan, which is honest to a few thousand rows. The FTS5 upgrade
 * slots in behind a migration without changing this function's signature.
 */
const SEARCH_PREDICATE = `(
  i.name LIKE @like ESCAPE '\\'
  OR IFNULL(i.manufacturer, '') LIKE @like ESCAPE '\\'
  OR IFNULL(i.notes, '') LIKE @like ESCAPE '\\'
  OR EXISTS (
    SELECT 1 FROM field_values fv
    JOIN field_defs fd ON fd.id = fv.field_id
    WHERE fv.item_id = i.id AND fd.searchable = 1 AND IFNULL(fv.value, '') LIKE @like ESCAPE '\\'
  )
)`;

export function listItems(db: Database, query: ListQuery = {}): ItemRow[] {
  const term = query.query?.trim();
  const sql = `
    SELECT i.* FROM items_with_counts i
    WHERE i.deleted_at IS NULL
    ${term ? `AND ${SEARCH_PREDICATE}` : ''}
    ${orderBy(query.sort, query.direction)}
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({
    like: term ? likePattern(term) : null,
    limit: query.limit ?? 500,
    offset: query.offset ?? 0,
  }) as ItemRecord[];
  return rows.map(toItemRow);
}

export function countItems(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL').get() as { n: number };
  return row.n;
}

export function listTrash(db: Database, query: { query?: string } = {}): TrashRow[] {
  const term = query.query?.trim();
  const sql = `
    SELECT i.* FROM items_with_counts i
    WHERE i.deleted_at IS NOT NULL
    ${term ? `AND ${SEARCH_PREDICATE}` : ''}
    ORDER BY i.deleted_at DESC, i.id ASC
  `;
  const rows = db.prepare(sql).all(term ? { like: likePattern(term) } : {}) as ItemRecord[];
  return rows.map(toTrashRow);
}

export function getItemRow(db: Database, id: string): (ItemRow & { deletedAt: string | null; deletedPath: string | null }) | null {
  const record = db.prepare('SELECT * FROM items_with_counts WHERE id = ?').get(id) as ItemRecord | undefined;
  if (!record) return null;
  return { ...toItemRow(record), deletedAt: record.deleted_at, deletedPath: record.deleted_path };
}

/** True if a *live* item already owns this slug. Trashed items free their name. */
export function isSlugTaken(db: Database, slug: string, exceptId?: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM items WHERE slug = ? AND deleted_at IS NULL AND id IS NOT ? LIMIT 1')
    .get(slug, exceptId ?? null) as { hit: number } | undefined;
  return row !== undefined;
}

export interface InsertItemInput {
  id: string;
  name: string;
  slug: string;
  manufacturer: string | null;
  notes: string | null;
  now: string;
  updatedBy: string | null;
}

export function insertItem(db: Database, input: InsertItemInput): void {
  db.prepare(
    `INSERT INTO items (id, name, slug, manufacturer, notes, created_at, updated_at, updated_by, rev)
     VALUES (@id, @name, @slug, @manufacturer, @notes, @now, @now, @updatedBy, 1)`,
  ).run(input);
}

export interface UpdateItemInput {
  id: string;
  rev: number;
  name: string;
  manufacturer: string | null;
  notes: string | null;
  now: string;
  updatedBy: string | null;
}

/**
 * Conditional on `rev`. A return of 0 means another writer got there first —
 * the caller reloads and merges rather than overwriting.
 */
export function updateItemConditional(db: Database, input: UpdateItemInput): number {
  const info = db
    .prepare(
      `UPDATE items
       SET name = @name, manufacturer = @manufacturer, notes = @notes,
           updated_at = @now, updated_by = @updatedBy, rev = rev + 1
       WHERE id = @id AND rev = @rev AND deleted_at IS NULL`,
    )
    .run(input);
  return info.changes;
}

/** Bump rev and updated_at without changing content — used by attachment writes. */
export function touchItem(db: Database, id: string, now: string, updatedBy: string | null): number {
  return db
    .prepare('UPDATE items SET updated_at = ?, updated_by = ?, rev = rev + 1 WHERE id = ?')
    .run(now, updatedBy, id).changes;
}

export function setItemSlug(db: Database, id: string, slug: string, now: string, updatedBy: string | null): number {
  return db
    .prepare('UPDATE items SET slug = ?, updated_at = ?, updated_by = ?, rev = rev + 1 WHERE id = ?')
    .run(slug, now, updatedBy, id).changes;
}

export function trashItem(
  db: Database,
  input: { id: string; rev: number; deletedPath: string | null; now: string; updatedBy: string | null },
): number {
  return db
    .prepare(
      `UPDATE items
       SET deleted_at = @now, deleted_path = @deletedPath, updated_at = @now,
           updated_by = @updatedBy, rev = rev + 1
       WHERE id = @id AND rev = @rev AND deleted_at IS NULL`,
    )
    .run(input).changes;
}

export function restoreItem(
  db: Database,
  input: { id: string; slug: string; now: string; updatedBy: string | null },
): number {
  return db
    .prepare(
      `UPDATE items
       SET deleted_at = NULL, deleted_path = NULL, slug = @slug, updated_at = @now,
           updated_by = @updatedBy, rev = rev + 1
       WHERE id = @id AND deleted_at IS NOT NULL`,
    )
    .run(input).changes;
}

// --- attachments -----------------------------------------------------------

export function listAttachments(db: Database, itemId: string): Attachment[] {
  const rows = db
    .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY added_at ASC, filename ASC')
    .all(itemId) as AttachmentRecord[];
  return rows.map(toAttachment);
}

export function getAttachment(db: Database, id: string): Attachment | null {
  const record = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRecord | undefined;
  return record ? toAttachment(record) : null;
}

export function isFilenameTaken(db: Database, itemId: string, filename: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM attachments WHERE item_id = ? AND filename = ? LIMIT 1')
    .get(itemId, filename) as { hit: number } | undefined;
  return row !== undefined;
}

export function insertAttachment(
  db: Database,
  input: { id: string; itemId: string; filename: string; sizeBytes: number | null; now: string },
): void {
  db.prepare(
    `INSERT INTO attachments (id, item_id, filename, size_bytes, added_at)
     VALUES (@id, @itemId, @filename, @sizeBytes, @now)`,
  ).run(input);
}

export function deleteAttachment(db: Database, id: string): number {
  return db.prepare('DELETE FROM attachments WHERE id = ?').run(id).changes;
}

/** Every attachment with its item's folder name, for the verify pass. */
export function allAttachments(db: Database): (Attachment & { slug: string; deletedAt: string | null })[] {
  return db
    .prepare(
      `SELECT a.id AS id, a.item_id AS itemId, a.filename AS filename,
              a.size_bytes AS sizeBytes, a.added_at AS addedAt,
              i.slug AS slug, i.deleted_at AS deletedAt
       FROM attachments a JOIN items i ON i.id = a.item_id`,
    )
    .all() as (Attachment & { slug: string; deletedAt: string | null })[];
}

// --- custom field values ---------------------------------------------------

export interface FieldValueRecord {
  itemId: string;
  fieldId: string;
  value: string | null;
}

/**
 * One grouped query for a whole page of results, never N+1.
 */
export function getFieldValues(db: Database, itemIds: string[]): FieldValueRecord[] {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT item_id, field_id, value FROM field_values WHERE item_id IN (${placeholders})`)
    .all(...itemIds) as { item_id: string; field_id: string; value: string | null }[];
  return rows.map((row) => ({ itemId: row.item_id, fieldId: row.field_id, value: row.value }));
}

export function setFieldValue(
  db: Database,
  input: { itemId: string; fieldId: string; value: string | null; numValue: number | null },
): void {
  if (input.value === null) {
    db.prepare('DELETE FROM field_values WHERE item_id = ? AND field_id = ?').run(input.itemId, input.fieldId);
    return;
  }
  db.prepare(
    `INSERT INTO field_values (item_id, field_id, value, num_value)
     VALUES (@itemId, @fieldId, @value, @numValue)
     ON CONFLICT (item_id, field_id) DO UPDATE SET value = excluded.value, num_value = excluded.num_value`,
  ).run(input);
}

export function valuesForField(db: Database, fieldId: string): { itemId: string; value: string | null }[] {
  const rows = db.prepare('SELECT item_id, value FROM field_values WHERE field_id = ?').all(fieldId) as {
    item_id: string;
    value: string | null;
  }[];
  return rows.map((row) => ({ itemId: row.item_id, value: row.value }));
}

/** Re-derive num_value for every stored value of a field, after a type change. */
export function refreshNumValue(
  db: Database,
  fieldId: string,
  compute: (value: string) => number | null,
): void {
  const statement = db.prepare('UPDATE field_values SET num_value = ? WHERE item_id = ? AND field_id = ?');
  for (const row of valuesForField(db, fieldId)) {
    if (row.value === null) continue;
    statement.run(compute(row.value), row.itemId, fieldId);
  }
}

/** Field definitions, ordered the way forms render them. */
export function fieldDefsById(defs: FieldDef[]): Map<string, FieldDef> {
  return new Map(defs.map((def) => [def.id, def]));
}
