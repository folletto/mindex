import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundError, ValidationError } from '../../src/main/service.js';
import { PathEscapeError } from '../../src/main/paths.js';
import {
  cleanupTempDirs,
  makeFile,
  makeLibrary,
  makeTempDir,
  snapshotTree,
  type TestLibrary,
} from '../helpers/temp.js';

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

describe('addAttachments', () => {
  it('copies the file into the item folder and leaves the original alone', () => {
    const item = lib.service.createItem({ name: 'Acme Widget' });
    const file = makeFile(source, 'datasheet.pdf', 'PDF BYTES');

    const [attachment] = lib.service.addAttachments({ itemId: item.id, paths: [file] });

    expect(attachment.filename).toBe('datasheet.pdf');
    expect(attachment.sizeBytes).toBe('PDF BYTES'.length);
    expect(readFileSync(join(lib.root, 'data', 'acme-widget', 'datasheet.pdf'), 'utf8')).toBe('PDF BYTES');
    expect(existsSync(file)).toBe(true);
  });

  it('bumps the item so other machines notice', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });

    const after = lib.service.getItem(item.id)!;
    expect(after.rev).toBe(item.rev + 1);
    expect(after.attachmentCount).toBe(1);
  });

  it('suffixes a colliding filename instead of overwriting', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'photo.jpg', 'first')] });

    const second = makeTempDir('mindex-source2-');
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(second, 'photo.jpg', 'second')] });

    const folder = join(lib.root, 'data', 'widget');
    expect(readdirSync(folder).sort()).toEqual(['photo (2).jpg', 'photo.jpg']);
    expect(readFileSync(join(folder, 'photo.jpg'), 'utf8')).toBe('first');
    expect(readFileSync(join(folder, 'photo (2).jpg'), 'utf8')).toBe('second');
  });

  it('accepts several files at once', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const files = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => makeFile(source, name));

    expect(lib.service.addAttachments({ itemId: item.id, paths: files })).toHaveLength(3);
    expect(lib.service.getItem(item.id)!.attachments).toHaveLength(3);
  });

  it('handles a zero-byte file', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const [attachment] = lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'empty.txt', '')] });
    expect(attachment.sizeBytes).toBe(0);
  });

  it('handles unicode filenames', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const [attachment] = lib.service.addAttachments({
      itemId: item.id,
      paths: [makeFile(source, 'Größe — 说明书.pdf')],
    });
    expect(attachment.filename).toBe('Größe — 说明书.pdf');
    expect(existsSync(join(lib.root, 'data', 'widget', attachment.filename))).toBe(true);
  });

  it('skips a file that vanished between the dialog and the copy', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const present = makeFile(source, 'here.pdf');
    const missing = join(source, 'gone.pdf');

    const added = lib.service.addAttachments({ itemId: item.id, paths: [missing, present] });
    expect(added.map((a) => a.filename)).toEqual(['here.pdf']);
  });

  it('never writes outside the item folder, whatever the filename claims', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const evil = makeFile(source, 'passwd', 'root:x:0:0');

    // The dialog gives real paths, but a crafted basename must not escape.
    const [attachment] = lib.service.addAttachments({ itemId: item.id, paths: [evil] });
    expect(attachment.filename).toBe('passwd');
    expect(existsSync(join(lib.root, 'data', 'widget', 'passwd'))).toBe(true);

    // Nothing was written above the library root.
    expect(snapshotTree(lib.root).every((entry) => !entry.startsWith('..'))).toBe(true);
  });

  it('refuses to attach to an item in the trash', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.trashItem({ id: item.id, rev: item.rev });
    expect(() => lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] })).toThrow(
      ValidationError,
    );
  });

  it('throws for an item that does not exist', () => {
    expect(() => lib.service.addAttachments({ itemId: 'ghost', paths: [] })).toThrow(NotFoundError);
  });
});

describe('attachmentPath', () => {
  it('resolves inside the item folder', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const [attachment] = lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });

    const { path } = lib.service.attachmentPath(attachment.id);
    expect(path).toBe(join(lib.root, 'data', 'widget', 'a.pdf'));
  });

  it('throws for an unknown attachment id', () => {
    expect(() => lib.service.attachmentPath('ghost')).toThrow(NotFoundError);
  });

  it('refuses a filename that was tampered with in the database', () => {
    // Only IDs cross IPC, but the folder is user-editable, so the containment
    // check is the last line of defence.
    const item = lib.service.createItem({ name: 'Widget' });
    const [attachment] = lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });
    lib.library.db
      .prepare('UPDATE attachments SET filename = ? WHERE id = ?')
      .run('../../../etc/passwd', attachment.id);

    expect(() => lib.service.attachmentPath(attachment.id)).toThrow(PathEscapeError);
  });
});

describe('removeAttachment', () => {
  it('drops the row and moves the bytes to deleted/', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const [attachment] = lib.service.addAttachments({
      itemId: item.id,
      paths: [makeFile(source, 'a.pdf', 'keep me')],
    });

    lib.service.removeAttachment({ attachmentId: attachment.id });

    expect(lib.service.getItem(item.id)!.attachments).toHaveLength(0);
    expect(existsSync(join(lib.root, 'data', 'widget', 'a.pdf'))).toBe(false);

    // Nothing is destroyed: the file is still in the library somewhere.
    const rescued = snapshotTree(join(lib.root, 'deleted')).filter((entry) => entry.endsWith('a.pdf'));
    expect(rescued).toHaveLength(1);
  });

  it('still removes the row when the file was deleted by hand', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    const [attachment] = lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });
    rmSync(join(lib.root, 'data', 'widget', 'a.pdf'));

    expect(() => lib.service.removeAttachment({ attachmentId: attachment.id })).not.toThrow();
    expect(lib.service.getItem(item.id)!.attachments).toHaveLength(0);
  });
});

describe('verify', () => {
  it('is quiet for a healthy library', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });

    const report = lib.service.verify();
    expect(report.orphanFolders).toEqual([]);
    expect(report.missingFiles).toEqual([]);
    expect(report.untrackedFiles).toEqual([]);
    expect(report.conflictedCopies).toEqual([]);
  });

  it('reports a folder with no item', () => {
    mkdirSync(join(lib.root, 'data', 'left-behind'), { recursive: true });
    expect(lib.service.verify().orphanFolders).toEqual(['left-behind']);
  });

  it('reports a file the database expected but cannot find', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });
    rmSync(join(lib.root, 'data', 'widget', 'a.pdf'));

    expect(lib.service.verify().missingFiles).toEqual([{ itemId: item.id, filename: 'a.pdf' }]);
  });

  it('reports a file someone dropped in by hand', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf')] });
    writeFileSync(join(lib.root, 'data', 'widget', 'stray.txt'), 'dropped in by hand');

    expect(lib.service.verify().untrackedFiles).toEqual([{ itemId: item.id, filename: 'stray.txt' }]);
  });

  it('spots a sync client conflicted copy', () => {
    writeFileSync(join(lib.root, 'catalogue (conflicted copy 2026-08-06).db'), '');
    writeFileSync(join(lib.root, 'catalogue.db.sync-conflict-20260806'), '');

    expect(lib.service.verify().conflictedCopies.sort()).toEqual([
      'catalogue (conflicted copy 2026-08-06).db',
      'catalogue.db.sync-conflict-20260806',
    ]);
  });

  it('measures the trash so the user can decide to prune it', () => {
    const item = lib.service.createItem({ name: 'Widget' });
    lib.service.addAttachments({ itemId: item.id, paths: [makeFile(source, 'a.pdf', 'x'.repeat(1000))] });
    lib.service.trashItem({ id: item.id, rev: lib.service.getItem(item.id)!.rev });

    expect(lib.service.verify().trashSizeBytes).toBe(1000);
  });
});
