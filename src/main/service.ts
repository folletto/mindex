/**
 * The service layer: everything that needs both the database and the disk.
 *
 * The ordering rules here are the whole point of the file:
 * - a write transaction contains no filesystem work, because it may be retried;
 * - a filesystem change that the database then refuses is undone by hand;
 * - a database change that the filesystem then refuses is undone by hand.
 *
 * Both compensations are exercised in tests/integration.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { coerceFieldValue, parseFieldValue, planTypeChange, type ConversionReport } from '../shared/fields.js';
import { fieldKey, slugify, uniqueSlug } from '../shared/slug.js';
import { nextAvailableFilename, sanitizeFilename } from '../shared/filenames.js';
import type {
  Attachment,
  FieldDef,
  FieldType,
  FieldValue,
  Item,
  ItemPatch,
  ItemRow,
  ListQuery,
  TrashRow,
  UpdateResult,
  VerifyReport,
} from '../shared/types.js';
import { withWrite } from './db/connection.js';
import * as fields from './db/fields.repo.js';
import * as repo from './db/items.repo.js';
import type { Library } from './library.js';
import { currentHost } from './lock.js';
import { itemFolder, resolveInside, trashFolder, trashFolderName } from './paths.js';

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no longer exists in this library.`);
    this.name = 'NotFoundError';
  }
}

export class ReadOnlyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReadOnlyError';
  }
}

export class ValidationError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export interface ServiceOptions {
  host?: string;
  now?: () => Date;
  uuid?: () => string;
}

export interface UpdateItemInput {
  id: string;
  rev: number;
  patch: ItemPatch;
  fields?: Record<string, FieldValue>;
  /**
   * What the caller believed the values were when it started editing. Supplied,
   * a rev clash can be resolved as a three-way merge: fields the other writer
   * left alone are safe to overwrite. Omitted, every difference is a conflict.
   */
  base?: ItemPatch & { fields?: Record<string, FieldValue> };
}

const ITEM_FIELDS = ['name', 'manufacturer', 'notes'] as const;
type ItemField = (typeof ITEM_FIELDS)[number];

export class LibraryService {
  private readonly host: string;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    readonly library: Library,
    options: ServiceOptions = {},
  ) {
    this.host = options.host ?? currentHost();
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => randomUUID());
  }

  private get db() {
    return this.library.db;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private assertWritable(): void {
    if (this.library.readOnly) {
      throw new ReadOnlyError(this.library.readOnlyReason ?? 'This library is open read-only.');
    }
  }

  // --- reads ---------------------------------------------------------------

  listItems(query: ListQuery = {}): ItemRow[] {
    return repo.listItems(this.db, query);
  }

  listTrash(query: { query?: string } = {}): TrashRow[] {
    return repo.listTrash(this.db, query);
  }

  listFields(options: { includeArchived?: boolean } = {}): FieldDef[] {
    return fields.listFieldDefs(this.db, options);
  }

  getItem(id: string): Item | null {
    const row = repo.getItemRow(this.db, id);
    if (!row) return null;
    return this.hydrate(row);
  }

  private hydrate(row: ItemRow): Item {
    const defs = fields.listFieldDefs(this.db, { includeArchived: true });
    const byId = repo.fieldDefsById(defs);
    const values: Record<string, FieldValue> = {};
    for (const record of repo.getFieldValues(this.db, [row.id])) {
      const def = byId.get(record.fieldId);
      if (def) values[def.key] = parseFieldValue(def.type, record.value);
    }
    return {
      ...row,
      fields: values,
      attachments: repo.listAttachments(this.db, row.id),
      folderPath: itemFolder(this.library.paths, row.slug),
    };
  }

  /** Field values for a whole page of rows, in one query. */
  fieldValuesFor(itemIds: string[]): Map<string, Record<string, FieldValue>> {
    const defs = repo.fieldDefsById(fields.listFieldDefs(this.db, { includeArchived: true }));
    const result = new Map<string, Record<string, FieldValue>>();
    for (const record of repo.getFieldValues(this.db, itemIds)) {
      const def = defs.get(record.fieldId);
      if (!def) continue;
      const bucket = result.get(record.itemId) ?? {};
      bucket[def.key] = parseFieldValue(def.type, record.value);
      result.set(record.itemId, bucket);
    }
    return result;
  }

  // --- item writes ---------------------------------------------------------

  /**
   * Translate `{ key: value }` from the UI into rows, failing loudly on values
   * that do not fit their field's type. Runs before any transaction opens.
   */
  private prepareFieldValues(
    input: Record<string, FieldValue> | undefined,
  ): { fieldId: string; value: string | null; numValue: number | null }[] {
    if (!input) return [];
    const defs = fields.listFieldDefs(this.db, { includeArchived: true });
    const byKey = new Map(defs.map((def) => [def.key, def]));
    const prepared: { fieldId: string; value: string | null; numValue: number | null }[] = [];
    const problems: string[] = [];

    for (const [key, raw] of Object.entries(input)) {
      const def = byKey.get(key);
      if (!def) {
        problems.push(`there is no field called "${key}" in this library`);
        continue;
      }
      const result = coerceFieldValue(def, raw);
      if (!result.ok) problems.push(`${def.label}: ${result.reason}`);
      else prepared.push({ fieldId: def.id, ...result.stored });
    }

    if (problems.length > 0) throw new ValidationError(problems.join('; '), problems);
    return prepared;
  }

  createItem(input: {
    name: string;
    manufacturer?: string | null;
    notes?: string | null;
    fields?: Record<string, FieldValue>;
  }): Item {
    this.assertWritable();
    const name = input.name.trim();
    if (name === '') throw new ValidationError('An item needs a name.');

    const values = this.prepareFieldValues(input.fields);
    const id = this.uuid();
    const now = this.timestamp();

    withWrite(this.db, (db) => {
      // Inside the transaction, so the uniqueness check and the insert cannot be
      // separated by another writer. The partial unique index is the backstop.
      const slug = uniqueSlug(name, (candidate) => repo.isSlugTaken(db, candidate));
      repo.insertItem(db, {
        id,
        name,
        slug,
        manufacturer: input.manufacturer?.trim() || null,
        notes: input.notes ?? null,
        now,
        updatedBy: this.host,
      });
      for (const value of values) repo.setFieldValue(db, { itemId: id, ...value });
    });

    const created = this.getItem(id);
    if (!created) throw new NotFoundError('The item');
    return created;
  }

  updateItem(input: UpdateItemInput): UpdateResult {
    this.assertWritable();
    const values = this.prepareFieldValues(input.fields);
    const now = this.timestamp();

    const outcome = withWrite(this.db, (db): { ok: true } | { ok: false; overlapping: string[] } => {
      const current = repo.getItemRow(db, input.id);
      if (!current || current.deletedAt) throw new NotFoundError('The item');

      let overlapping: string[] = [];
      if (current.rev !== input.rev) {
        overlapping = this.findOverlaps(db, current, input);
        if (overlapping.length > 0) return { ok: false, overlapping };
      }

      const merged = {
        name: input.patch.name?.trim() ?? current.name,
        manufacturer:
          input.patch.manufacturer === undefined ? current.manufacturer : input.patch.manufacturer?.trim() || null,
        notes: input.patch.notes === undefined ? current.notes : input.patch.notes,
      };
      if (merged.name.trim() === '') throw new ValidationError('An item needs a name.');

      const changed = repo.updateItemConditional(db, {
        id: input.id,
        rev: current.rev,
        name: merged.name,
        manufacturer: merged.manufacturer,
        notes: merged.notes,
        now,
        updatedBy: this.host,
      });
      // We hold the write lock, so a zero here means the row was trashed
      // between the read and the update by this very transaction — impossible —
      // or the id vanished. Either way it is not a merge case.
      if (changed === 0) throw new NotFoundError('The item');

      for (const value of values) repo.setFieldValue(db, { itemId: input.id, ...value });
      return { ok: true };
    });

    const item = this.getItem(input.id);
    if (!item) throw new NotFoundError('The item');
    if (!outcome.ok) return { conflict: true, current: item, overlapping: outcome.overlapping };
    return { item };
  }

  /**
   * Three-way merge test. A field the other writer left untouched is safe to
   * overwrite even though the rev moved on; anything else needs the user.
   */
  private findOverlaps(db: Library['db'], current: ItemRow, input: UpdateItemInput): string[] {
    const overlapping: string[] = [];

    for (const key of ITEM_FIELDS) {
      const mine = input.patch[key];
      if (mine === undefined) continue;
      const theirs = current[key as ItemField];
      if (normalize(mine) === normalize(theirs)) continue;
      const base = input.base?.[key];
      if (base !== undefined && normalize(base) === normalize(theirs)) continue;
      overlapping.push(key);
    }

    if (input.fields) {
      const defs = fields.listFieldDefs(db, { includeArchived: true });
      const byKey = new Map(defs.map((def) => [def.key, def]));
      const stored = new Map(repo.getFieldValues(db, [current.id]).map((row) => [row.fieldId, row.value]));

      for (const [key, mine] of Object.entries(input.fields)) {
        const def = byKey.get(key);
        if (!def) continue;
        const theirs = parseFieldValue(def.type, stored.get(def.id) ?? null);
        if (normalize(mine) === normalize(theirs)) continue;
        const base = input.base?.fields?.[key];
        if (base !== undefined && normalize(base) === normalize(theirs)) continue;
        overlapping.push(key);
      }
    }

    return overlapping;
  }

  /**
   * Move the item's folder to `deleted/` and flag the row. Nothing is destroyed.
   */
  trashItem(input: { id: string; rev: number }): { ok: boolean; deletedPath?: string; error?: string } {
    this.assertWritable();
    const row = repo.getItemRow(this.db, input.id);
    if (!row) throw new NotFoundError('The item');
    if (row.deletedAt) return { ok: true, deletedPath: row.deletedPath ?? undefined };

    const source = itemFolder(this.library.paths, row.slug);
    const deletedPath = trashFolderName(row.slug, this.now());
    const target = trashFolder(this.library.paths, deletedPath);

    const moved = this.moveFolder(source, target);

    let changes = 0;
    try {
      changes = withWrite(this.db, (db) =>
        repo.trashItem(db, {
          id: input.id,
          rev: input.rev,
          deletedPath: moved ? deletedPath : null,
          now: this.timestamp(),
          updatedBy: this.host,
        }),
      );
    } catch (error) {
      if (moved) this.undoTrashMove(target, source);
      throw error;
    }

    if (changes === 0) {
      // Someone edited or trashed the item first. Put the folder back and let
      // the caller re-read rather than leaving the disk out of step with the DB.
      if (moved) this.undoTrashMove(target, source);
      return { ok: false, error: 'Another copy of Mindex changed this item first. Reload and try again.' };
    }

    return { ok: true, deletedPath: moved ? deletedPath : undefined };
  }

  restoreItem(input: { id: string }): Item {
    this.assertWritable();
    const row = repo.getItemRow(this.db, input.id);
    if (!row) throw new NotFoundError('The item');
    if (!row.deletedAt) return this.hydrate(row);

    // Claim the slug in the database first: two machines restoring at once must
    // not both decide they can have the original name back.
    const restoredSlug = withWrite(this.db, (db) => {
      const current = repo.getItemRow(db, input.id);
      if (!current || !current.deletedAt) throw new NotFoundError('The item');
      const slug = repo.isSlugTaken(db, current.slug)
        ? uniqueSlug(current.name, (candidate) => repo.isSlugTaken(db, candidate))
        : current.slug;
      const changed = repo.restoreItem(db, { id: input.id, slug, now: this.timestamp(), updatedBy: this.host });
      if (changed === 0) throw new NotFoundError('The item');
      return slug;
    });

    if (row.deletedPath) {
      const source = trashFolder(this.library.paths, row.deletedPath);
      const target = itemFolder(this.library.paths, restoredSlug);
      try {
        this.moveFolder(source, target);
      } catch (error) {
        // Put the row back in the trash so the two halves stay consistent.
        withWrite(this.db, (db) =>
          repo.trashItem(db, {
            id: input.id,
            rev: repo.getItemRow(db, input.id)?.rev ?? 0,
            deletedPath: row.deletedPath,
            now: this.timestamp(),
            updatedBy: this.host,
          }),
        );
        throw error;
      }
    }

    const restored = this.getItem(input.id);
    if (!restored) throw new NotFoundError('The item');
    return restored;
  }

  /**
   * Bring the folder name back in line with the item name. Explicit, because
   * renaming an item does not move anything by default — `id` is the real key
   * and a stable folder is worth more than a tidy one.
   */
  renameFolder(input: { id: string }): Item {
    this.assertWritable();
    const row = repo.getItemRow(this.db, input.id);
    if (!row) throw new NotFoundError('The item');
    if (row.deletedAt) throw new ValidationError('That item is in the trash.');
    if (slugify(row.name) === row.slug) return this.hydrate(row);

    const newSlug = withWrite(this.db, (db) => {
      const current = repo.getItemRow(db, input.id);
      if (!current) throw new NotFoundError('The item');
      const slug = uniqueSlug(current.name, (candidate) => repo.isSlugTaken(db, candidate, input.id));
      repo.setItemSlug(db, input.id, slug, this.timestamp(), this.host);
      return slug;
    });

    const source = itemFolder(this.library.paths, row.slug);
    const target = itemFolder(this.library.paths, newSlug);
    try {
      this.moveFolder(source, target);
    } catch (error) {
      withWrite(this.db, (db) => repo.setItemSlug(db, input.id, row.slug, this.timestamp(), this.host));
      throw error;
    }

    const renamed = this.getItem(input.id);
    if (!renamed) throw new NotFoundError('The item');
    return renamed;
  }

  /**
   * Put a folder back after the database refused the deletion, and take the
   * `deleted/` directory with it if we were the ones who created it. A library
   * that has never had anything deleted should not grow an empty trash.
   */
  private undoTrashMove(target: string, source: string): void {
    this.moveFolder(target, source);
    try {
      rmdirSync(this.library.paths.deletedDir);
    } catch {
      // Not empty, or not there. Either way there is nothing to tidy.
    }
  }

  /**
   * Rename within the library folder, tolerating the two things that go wrong
   * when several machines share it: the folder is already gone (ENOENT), or the
   * library straddles a mount point (EXDEV).
   */
  private moveFolder(source: string, target: string): boolean {
    if (!existsSync(source)) return false;
    mkdirSync(join(target, '..'), { recursive: true });
    try {
      renameSync(source, target);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      if (code !== 'EXDEV') throw error;

      // Different volume: copy the tree, then remove the original.
      copyTree(source, target);
      rmSync(source, { recursive: true, force: true });
      return true;
    }
  }

  itemFolderPath(id: string, options: { create?: boolean } = {}): string {
    const row = repo.getItemRow(this.db, id);
    if (!row) throw new NotFoundError('The item');
    const folder =
      row.deletedAt && row.deletedPath
        ? trashFolder(this.library.paths, row.deletedPath)
        : itemFolder(this.library.paths, row.slug);
    if (options.create && !row.deletedAt) mkdirSync(folder, { recursive: true });
    return folder;
  }

  // --- attachments ---------------------------------------------------------

  /**
   * Copy files into the item's folder. Never moves: the original stays where
   * the user left it.
   */
  addAttachments(input: { itemId: string; paths: string[] }): Attachment[] {
    this.assertWritable();
    const row = repo.getItemRow(this.db, input.itemId);
    if (!row) throw new NotFoundError('The item');
    if (row.deletedAt) throw new ValidationError('That item is in the trash — restore it first.');

    const folder = itemFolder(this.library.paths, row.slug);
    mkdirSync(folder, { recursive: true });

    const added: Attachment[] = [];
    for (const source of input.paths) {
      const attachment = this.addOneAttachment(input.itemId, folder, source);
      if (attachment) added.push(attachment);
    }
    return added;
  }

  private addOneAttachment(itemId: string, folder: string, source: string): Attachment | null {
    let sizeBytes: number | null = null;
    try {
      sizeBytes = statSync(source).size;
    } catch {
      // Picked in a dialog and then moved before we got to it. Skipping beats
      // aborting the whole batch.
      return null;
    }

    const desired = sanitizeFilename(basename(source));

    // Bounded retry: the filename is chosen outside the transaction, so another
    // writer can claim it in between. Both the filesystem and the UNIQUE
    // constraint can reject us, and both mean "pick the next name".
    for (let attempt = 0; attempt < 20; attempt++) {
      const filename = nextAvailableFilename(
        desired,
        (candidate) =>
          repo.isFilenameTaken(this.db, itemId, candidate) || existsSync(resolveInside(folder, candidate)),
      );
      const target = resolveInside(folder, filename);

      try {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }

      const id = this.uuid();
      try {
        withWrite(this.db, (db) => {
          repo.insertAttachment(db, { id, itemId, filename, sizeBytes, now: this.timestamp() });
          repo.touchItem(db, itemId, this.timestamp(), this.host);
        });
      } catch (error) {
        // Compensate: the copy is ours and nothing references it.
        try {
          unlinkSync(target);
        } catch {
          // The file may already be gone; the database is the thing that matters.
        }
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
        throw error;
      }

      return { id, itemId, filename, sizeBytes, addedAt: this.timestamp() };
    }

    throw new Error(`Could not find a free name for "${basename(source)}" — is another copy of Mindex adding files?`);
  }

  attachmentPath(attachmentId: string): { attachment: Attachment; path: string } {
    const attachment = repo.getAttachment(this.db, attachmentId);
    if (!attachment) throw new NotFoundError('That attachment');
    const folder = this.itemFolderPath(attachment.itemId);
    return { attachment, path: resolveInside(folder, attachment.filename) };
  }

  /**
   * Remove an attachment. The row goes; the bytes move to `deleted/`, because
   * nothing in this app destroys a file the user gave it.
   */
  removeAttachment(input: { attachmentId: string }): { ok: boolean } {
    this.assertWritable();
    const { attachment, path } = this.attachmentPath(input.attachmentId);
    const row = repo.getItemRow(this.db, attachment.itemId);

    if (existsSync(path)) {
      const bin = trashFolder(this.library.paths, trashFolderName(`${row?.slug ?? 'item'}-attachment`, this.now()));
      mkdirSync(bin, { recursive: true });
      const target = resolveInside(bin, attachment.filename);
      try {
        renameSync(path, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          copyFileSync(path, target);
          unlinkSync(path);
        } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    withWrite(this.db, (db) => {
      repo.deleteAttachment(db, input.attachmentId);
      repo.touchItem(db, attachment.itemId, this.timestamp(), this.host);
    });

    return { ok: true };
  }

  // --- custom fields -------------------------------------------------------

  createField(input: { label: string; type: FieldType; options?: string[]; searchable?: boolean }): FieldDef {
    this.assertWritable();
    const label = input.label.trim();
    if (label === '') throw new ValidationError('A field needs a name.');
    if (input.type === 'select' && (!input.options || input.options.length === 0)) {
      throw new ValidationError('A choice field needs at least one option.');
    }

    const id = this.uuid();
    withWrite(this.db, (db) => {
      const key = uniqueSlug(fieldKey(label), (candidate) => fields.isFieldKeyTaken(db, candidate));
      fields.insertFieldDef(db, {
        id,
        key,
        label,
        type: input.type,
        options: input.options ?? null,
        position: fields.nextFieldPosition(db),
        searchable: input.searchable ?? true,
      });
    });

    const created = fields.getFieldDef(this.db, id);
    if (!created) throw new NotFoundError('The field');
    return created;
  }

  /**
   * Rename, reorder or retype a field. A type change that would drop values is
   * refused with a count, not applied with a shrug.
   */
  updateField(input: {
    id: string;
    patch: Partial<Pick<FieldDef, 'label' | 'type' | 'options' | 'position' | 'searchable'>>;
  }): FieldDef {
    this.assertWritable();
    const current = fields.getFieldDef(this.db, input.id);
    if (!current) throw new NotFoundError('The field');

    const next = {
      label: input.patch.label?.trim() ?? current.label,
      type: input.patch.type ?? current.type,
      options: input.patch.options ?? current.options,
      position: input.patch.position ?? current.position,
      searchable: input.patch.searchable ?? current.searchable,
    };
    if (next.label === '') throw new ValidationError('A field needs a name.');
    if (next.type === 'select' && (!next.options || next.options.length === 0)) {
      throw new ValidationError('A choice field needs at least one option.');
    }

    const retyped = next.type !== current.type || next.options !== current.options;
    let report: ConversionReport | null = null;
    if (retyped) {
      report = planTypeChange(next, repo.valuesForField(this.db, input.id));
      if (report.failures.length > 0) {
        throw new ValidationError(
          `${report.failures.length} existing value${report.failures.length === 1 ? '' : 's'} could not be converted ` +
            `to ${next.type}. Archive this field instead if you want to keep them.`,
          report,
        );
      }
    }

    withWrite(this.db, (db) => {
      fields.updateFieldDef(db, { id: input.id, ...next });
      if (retyped) {
        // The canonical string form and its numeric mirror both change with the
        // type; recompute rather than leaving a stale num_value behind.
        repo.refreshNumValue(db, input.id, (value) => {
          const coerced = coerceFieldValue(next, value);
          return coerced.ok ? coerced.stored.numValue : null;
        });
      }
    });

    const updated = fields.getFieldDef(this.db, input.id);
    if (!updated) throw new NotFoundError('The field');
    return updated;
  }

  archiveField(input: { id: string; archived: boolean }): FieldDef {
    this.assertWritable();
    withWrite(this.db, (db) => fields.setFieldArchived(db, input.id, input.archived ? this.timestamp() : null));
    const updated = fields.getFieldDef(this.db, input.id);
    if (!updated) throw new NotFoundError('The field');
    return updated;
  }

  /** Really deletes, values and all. The UI offers archiving first. */
  removeField(input: { id: string }): { ok: boolean } {
    this.assertWritable();
    const changed = withWrite(this.db, (db) => fields.deleteFieldDef(db, input.id));
    return { ok: changed > 0 };
  }

  reorderFields(input: { ids: string[] }): FieldDef[] {
    this.assertWritable();
    withWrite(this.db, (db) => {
      input.ids.forEach((id, index) => fields.setFieldPosition(db, id, index));
    });
    return this.listFields({ includeArchived: true });
  }

  // --- housekeeping --------------------------------------------------------

  /**
   * Compare the database against the folder and report the differences without
   * changing anything. Sharing a folder between machines eventually produces
   * drift, and a user who can see it can fix it in Finder.
   */
  verify(): VerifyReport {
    const report: VerifyReport = {
      orphanFolders: [],
      missingFolders: [],
      missingFiles: [],
      untrackedFiles: [],
      conflictedCopies: [],
      trashSizeBytes: 0,
    };
    const { dataDir, deletedDir, root } = this.library.paths;

    const liveSlugs = new Set(
      (this.db.prepare('SELECT slug FROM items WHERE deleted_at IS NULL').all() as { slug: string }[]).map(
        (row) => row.slug,
      ),
    );

    if (existsSync(dataDir)) {
      for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!liveSlugs.has(entry.name)) report.orphanFolders.push(entry.name);
      }
    }

    const byItem = new Map<string, { slug: string; files: Set<string> }>();
    for (const attachment of repo.allAttachments(this.db)) {
      if (attachment.deletedAt) continue;
      const bucket = byItem.get(attachment.itemId) ?? { slug: attachment.slug, files: new Set<string>() };
      bucket.files.add(attachment.filename);
      byItem.set(attachment.itemId, bucket);
    }

    for (const [itemId, { slug, files }] of byItem) {
      const folder = itemFolder(this.library.paths, slug);
      if (!existsSync(folder)) {
        report.missingFolders.push(slug);
        for (const filename of files) report.missingFiles.push({ itemId, filename });
        continue;
      }
      const onDisk = new Set(readdirSync(folder));
      for (const filename of files) {
        if (!onDisk.has(filename)) report.missingFiles.push({ itemId, filename });
      }
      for (const filename of onDisk) {
        if (!files.has(filename) && !filename.startsWith('.')) {
          report.untrackedFiles.push({ itemId, filename });
        }
      }
    }

    // Sync clients name their conflicts predictably enough to spot.
    if (existsSync(root)) {
      for (const entry of readdirSync(root)) {
        if (/conflicted copy|conflict\b|\(\d+\)\.db$|\.sync-conflict/i.test(entry))
          report.conflictedCopies.push(entry);
      }
    }

    if (existsSync(deletedDir)) report.trashSizeBytes = directorySize(deletedDir);

    return report;
  }
}

function normalize(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(full);
      else total += statSync(full).size;
    } catch {
      // Files can vanish mid-walk when a sync client is working; a size report
      // is not worth failing over.
    }
  }
  return total;
}
