/**
 * The IPC surface, registered in one place so the whole attack surface is
 * readable at a glance.
 *
 * Two rules hold throughout:
 * - only IDs cross the boundary. The main process resolves them to paths from
 *   the database, so a renderer-supplied string is never joined onto a path.
 * - every handler is wrapped, so a thrown error becomes a message the UI can
 *   show instead of an unhandled rejection with a stack trace in it.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename } from 'node:path';
import { classifyFolder, createLibraryIn, probeWritable } from './library.js';
import { NotFoundError, ReadOnlyError, ValidationError } from './service.js';
import { LibraryOpenError } from './library.js';
import { WriteContentionError } from './db/connection.js';
import { inspectLock } from './lock.js';
import { libraryPaths } from './paths.js';
import { detectStorageKind, storageExplanation } from './storage.js';
import { appSchemaVersion } from './db/migrations.js';
import {
  forgetLibrary,
  journalModeOverrideFor,
  readSettings,
  rememberLibrary,
  setJournalModeOverride,
} from './settings.js';
import type { Session } from './session.js';
import { slugify } from '../shared/slug.js';
import type {
  FieldType,
  FieldValue,
  ItemPatch,
  JournalMode,
  LibraryChooseResult,
  ListQuery,
} from '../shared/types.js';

/**
 * Errors the user caused, or that describe a state they can act on. Anything
 * not in this list is a bug and gets a generic message plus a log line.
 */
const EXPECTED_ERRORS = [ValidationError, NotFoundError, ReadOnlyError, WriteContentionError, LibraryOpenError];

function toMessage(error: unknown): string {
  if (EXPECTED_ERRORS.some((type) => error instanceof type)) return (error as Error).message;
  console.error('[mindex] unexpected error in an IPC handler:', error);
  return 'Something went wrong. The details are in the log.';
}

function handle<T>(channel: string, handler: (...args: never[]) => T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...(args as never[]));
    } catch (error) {
      throw new Error(toMessage(error));
    }
  });
}

export interface IpcContext {
  session: Session;
  getWindow: () => BrowserWindow | null;
  broadcast: (channel: string, payload?: unknown) => void;
}

export function registerIpc(context: IpcContext): void {
  const { session, getWindow, broadcast } = context;

  const state = () => {
    const settings = readSettings();
    return session.state(settings.recentLibraries, settings.libraryPath);
  };

  const announce = () => broadcast('library:changed', state());

  /** Open a folder as the current library and remember it. */
  const adopt = (path: string): LibraryChooseResult => {
    try {
      session.open(path, { journalMode: journalModeOverrideFor(path) });
      rememberLibrary(path);
      announce();
      return { ok: true, path };
    } catch (error) {
      return { ok: false, error: toMessage(error) };
    }
  };

  // --- library -------------------------------------------------------------

  handle('library:getState', () => state());

  handle('library:choose', async (): Promise<LibraryChooseResult> => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Choose a folder for your catalogue',
          properties: ['openDirectory', 'createDirectory'],
          message: 'Mindex keeps everything — database and files — inside this one folder.',
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });

    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    const path = result.filePaths[0];

    const classification = classifyFolder(path);
    if (classification.kind === 'foreign') {
      // Never scribble into a folder the user did not intend as a library.
      return { ok: false, needsConfirmation: 'foreign', path, entries: classification.entries };
    }
    if (classification.kind === 'unwritable') {
      return { ok: false, error: `Mindex cannot use that folder: ${classification.reason}` };
    }

    const writable = probeWritable(path);
    if (!writable.ok) return { ok: false, error: `Mindex cannot write to that folder: ${writable.reason}` };

    return adopt(path);
  });

  handle('library:create', (parentPath: string, name: string): LibraryChooseResult => {
    try {
      const library = createLibraryIn(parentPath, slugify(name) === 'item' ? 'Mindex Catalogue' : name);
      const path = library.paths.root;
      library.close();
      return adopt(path);
    } catch (error) {
      return { ok: false, error: toMessage(error) };
    }
  });

  handle('library:switch', (path: string): LibraryChooseResult => {
    const classification = classifyFolder(path);
    if (classification.kind !== 'library') {
      forgetLibrary(path);
      announce();
      return { ok: false, error: `${basename(path)} is no longer a Mindex library.` };
    }
    return adopt(path);
  });

  handle('library:reveal', () => {
    const library = session.current;
    if (!library) return { ok: false, error: 'No library is open.' };
    void shell.openPath(library.paths.root);
    return { ok: true };
  });

  handle('library:verify', () => session.service.verify());

  handle('library:setJournalMode', (mode: JournalMode) => {
    const library = session.current;
    if (!library) return { ok: false, error: 'No library is open.' };
    const path = library.paths.root;
    setJournalModeOverride(path, mode);
    session.open(path, { journalMode: mode });
    announce();
    return { ok: true };
  });

  handle('library:takeOverLock', () => {
    const library = session.current;
    if (!library) return { ok: false, error: 'No library is open.' };
    const path = library.paths.root;
    session.open(path, { journalMode: journalModeOverrideFor(path), takeOverLock: true });
    announce();
    return { ok: true };
  });

  handle('library:describeFolder', (path: string) => {
    const kind = detectStorageKind(path);
    return { kind, explanation: storageExplanation(kind), lock: inspectLock(libraryPaths(path).lockPath) };
  });

  // --- items ---------------------------------------------------------------

  handle('items:list', (query: ListQuery) => session.service.listItems(query));
  handle('items:get', (id: string) => session.service.getItem(id));

  handle(
    'items:create',
    (input: { name: string; manufacturer?: string; notes?: string; fields?: Record<string, FieldValue> }) => {
      const item = session.service.createItem(input);
      broadcast('library:dataChanged');
      return item;
    },
  );

  handle(
    'items:update',
    (input: {
      id: string;
      rev: number;
      patch: ItemPatch;
      fields?: Record<string, FieldValue>;
      base?: ItemPatch & { fields?: Record<string, FieldValue> };
    }) => {
      const result = session.service.updateItem(input);
      broadcast('library:dataChanged');
      return result;
    },
  );

  handle('items:trash', (input: { id: string; rev: number }) => {
    const result = session.service.trashItem(input);
    broadcast('library:dataChanged');
    return result;
  });

  handle('items:restore', (input: { id: string }) => {
    const item = session.service.restoreItem(input);
    broadcast('library:dataChanged');
    return item;
  });

  handle('items:listTrash', (query: { query?: string } = {}) => session.service.listTrash(query));

  handle('items:renameFolder', (input: { id: string }) => {
    const item = session.service.renameFolder(input);
    broadcast('library:dataChanged');
    return item;
  });

  handle('items:revealFolder', (input: { id: string }) => {
    const folder = session.service.itemFolderPath(input.id, { create: true });
    void shell.openPath(folder);
    return { ok: true };
  });

  // --- fields --------------------------------------------------------------

  handle('fields:list', () => session.service.listFields({ includeArchived: true }));

  handle('fields:create', (input: { label: string; type: FieldType; options?: string[] }) => {
    const field = session.service.createField(input);
    broadcast('library:dataChanged');
    return field;
  });

  handle('fields:update', (input: { id: string; patch: Record<string, unknown> }) => {
    const field = session.service.updateField(input as Parameters<typeof session.service.updateField>[0]);
    broadcast('library:dataChanged');
    return field;
  });

  handle('fields:archive', (input: { id: string; archived: boolean }) => {
    const field = session.service.archiveField(input);
    broadcast('library:dataChanged');
    return field;
  });

  handle('fields:remove', (input: { id: string }) => {
    const result = session.service.removeField(input);
    broadcast('library:dataChanged');
    return result;
  });

  handle('fields:reorder', (input: { ids: string[] }) => {
    const fields = session.service.reorderFields(input);
    broadcast('library:dataChanged');
    return fields;
  });

  // --- attachments ---------------------------------------------------------

  handle('attachments:add', async (input: { itemId: string; paths?: string[] }) => {
    let paths = input.paths;

    // No paths means "open the picker"; drag-and-drop supplies them directly.
    if (!paths || paths.length === 0) {
      const window = getWindow();
      const result = window
        ? await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return [];
      paths = result.filePaths;
    }

    const added = session.service.addAttachments({ itemId: input.itemId, paths });
    broadcast('library:dataChanged');
    return added;
  });

  handle('attachments:open', async (input: { attachmentId: string }) => {
    const { path } = session.service.attachmentPath(input.attachmentId);
    const error = await shell.openPath(path);
    return error ? { ok: false, error } : { ok: true };
  });

  handle('attachments:reveal', (input: { attachmentId: string }) => {
    const { path } = session.service.attachmentPath(input.attachmentId);
    shell.showItemInFolder(path);
    return { ok: true };
  });

  handle('attachments:remove', (input: { attachmentId: string }) => {
    const result = session.service.removeAttachment(input);
    broadcast('library:dataChanged');
    return result;
  });

  // --- app -----------------------------------------------------------------

  handle('app:getVersion', () => ({
    version: process.env.npm_package_version ?? app.getVersion(),
    electron: process.versions.electron,
    schema: appSchemaVersion(),
  }));

  handle('app:openExternal', async (url: string) => {
    // Only ever hand the OS a web link, whatever the renderer asked for.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: 'That is not a link.' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Mindex only opens http and https links.' };
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });
}
