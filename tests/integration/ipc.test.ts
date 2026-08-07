/**
 * IPC contract tests.
 *
 * Every handler, driven the way the preload drives it, against a real temp
 * library. Electron is the only thing mocked here — there is no display to put
 * a dialog on — and the mock is thin: it records what was registered and hands
 * back canned dialog answers. The database, the filesystem and the service
 * layer underneath are all real.
 *
 * These catch the class of bug that unit tests structurally cannot: a channel
 * name typo, an argument shape that does not match the preload, a handler that
 * forgets to broadcast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  userData: '',
  dialogResult: { canceled: true, filePaths: [] as string[] },
  opened: [] as string[],
  revealed: [] as string[],
  externals: [] as string[],
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    getPath: () => state.userData,
  },
  ipcMain: {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
      state.handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: async () => state.dialogResult,
  },
  shell: {
    openPath: async (path: string) => {
      state.opened.push(path);
      return '';
    },
    showItemInFolder: (path: string) => state.revealed.push(path),
    openExternal: async (url: string) => {
      state.externals.push(url);
    },
  },
  BrowserWindow: class {},
}));

const { registerIpc } = await import('../../src/main/ipc.js');
const { Session } = await import('../../src/main/session.js');
const { resetSettingsCache } = await import('../../src/main/settings.js');
const { appSchemaVersion } = await import('../../src/main/db/migrations.js');

type SessionInstance = InstanceType<typeof Session>;

let session: SessionInstance;
let scratch: string;
let libraryPath: string;
let broadcasts: { channel: string; payload: unknown }[];

/** Call a handler the way ipcRenderer.invoke would. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`No handler is registered for "${channel}"`);
  return (await handler({}, ...args)) as T;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mindex-ipc-'));
  state.userData = join(scratch, 'user-data');
  libraryPath = join(scratch, 'library');
  mkdirSync(state.userData, { recursive: true });
  mkdirSync(libraryPath, { recursive: true });

  state.dialogResult = { canceled: true, filePaths: [] };
  state.opened = [];
  state.revealed = [];
  state.externals = [];
  state.handlers.clear();
  resetSettingsCache();

  broadcasts = [];
  session = new Session();
  registerIpc({
    session,
    getWindow: () => null,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  });
});

afterEach(() => {
  session.close();
  resetSettingsCache();
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows can hold the database handle a moment longer than we do.
  }
});

/** Choose `libraryPath` through the real dialog handler. */
async function chooseLibrary(path = libraryPath) {
  state.dialogResult = { canceled: false, filePaths: [path] };
  return invoke<{ ok: boolean; error?: string }>('library:choose');
}

describe('the registered surface', () => {
  it('covers every channel the preload calls', () => {
    // Kept in step by hand on purpose: adding a capability should be a visible,
    // deliberate act in both files.
    const expected = [
      'app:getVersion',
      'app:openExternal',
      'attachments:add',
      'attachments:open',
      'attachments:remove',
      'attachments:reveal',
      'fields:archive',
      'fields:create',
      'fields:list',
      'fields:remove',
      'fields:reorder',
      'fields:update',
      'items:create',
      'items:get',
      'items:list',
      'items:listTrash',
      'items:renameFolder',
      'items:restore',
      'items:revealFolder',
      'items:trash',
      'items:update',
      'library:choose',
      'library:create',
      'library:describeFolder',
      'library:getState',
      'library:reveal',
      'library:setJournalMode',
      'library:switch',
      'library:takeOverLock',
      'library:verify',
    ];
    expect([...state.handlers.keys()].sort()).toEqual(expected);
  });
});

describe('library:getState', () => {
  it('reports unset before anything is chosen', async () => {
    expect(await invoke('library:getState')).toMatchObject({ status: 'unset', path: null, recent: [] });
  });

  it('reports ready once a library is open', async () => {
    await chooseLibrary();
    expect(await invoke('library:getState')).toMatchObject({
      status: 'ready',
      path: libraryPath,
      schema: appSchemaVersion(),
      readOnly: false,
    });
  });
});

describe('library:choose', () => {
  it('initialises the folder and announces the change', async () => {
    const result = await chooseLibrary();

    expect(result.ok).toBe(true);
    expect(existsSync(join(libraryPath, 'catalogue.db'))).toBe(true);
    expect(broadcasts.map((entry) => entry.channel)).toContain('library:changed');
  });

  it('remembers it for next time', async () => {
    await chooseLibrary();
    expect(await invoke('library:getState')).toMatchObject({ recent: [libraryPath] });
  });

  it('reports a cancelled dialog without an error', async () => {
    state.dialogResult = { canceled: true, filePaths: [] };
    expect(await invoke('library:choose')).toEqual({ ok: false });
  });

  it('refuses a folder that already has files in it', async () => {
    const foreign = join(scratch, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'taxes.pdf'), 'not yours');

    const result = await invoke<{ needsConfirmation?: string; entries?: string[] }>(
      'library:choose',
      ...(((state.dialogResult = { canceled: false, filePaths: [foreign] }), []) as unknown[]),
    );

    expect(result.needsConfirmation).toBe('foreign');
    expect(result.entries).toContain('taxes.pdf');
    // Nothing was written into it.
    expect(existsSync(join(foreign, 'catalogue.db'))).toBe(false);
  });
});

describe('library:create', () => {
  it('makes a subfolder and opens it', async () => {
    const parent = join(scratch, 'parent');
    mkdirSync(parent);
    writeFileSync(join(parent, 'taxes.pdf'), 'not yours');

    const result = await invoke<{ ok: boolean; path?: string }>('library:create', parent, 'My Catalogue');

    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(parent, 'My Catalogue'));
    expect(existsSync(join(parent, 'My Catalogue', 'catalogue.db'))).toBe(true);
    expect(existsSync(join(parent, 'taxes.pdf'))).toBe(true);
  });

  it('cannot be talked out of the parent folder', async () => {
    // The name is renderer input, so it must never reach path.join unfiltered.
    const parent = join(scratch, 'parent');
    mkdirSync(parent);

    const result = await invoke<{ ok: boolean; path?: string }>('library:create', parent, '../../escaped');

    expect(result.ok).toBe(true);
    expect(result.path?.startsWith(parent)).toBe(true);
    expect(existsSync(join(scratch, '..', 'escaped'))).toBe(false);
  });

  it('falls back to a sensible name when the given one reduces to nothing', async () => {
    const parent = join(scratch, 'parent');
    mkdirSync(parent);
    const result = await invoke<{ path?: string }>('library:create', parent, '///');
    expect(result.path).toBe(join(parent, 'Mindex Catalogue'));
  });
});

describe('library:switch', () => {
  it('forgets a path that is no longer a library', async () => {
    await chooseLibrary();
    const other = join(scratch, 'not-a-library');
    mkdirSync(other);

    const result = await invoke<{ ok: boolean; error?: string }>('library:switch', other);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer a Mindex library/);
  });

  it('reopens a library it knows', async () => {
    await chooseLibrary();
    await invoke('items:create', { name: 'Widget' });

    const second = join(scratch, 'second');
    mkdirSync(second);
    await invoke('library:switch', second).catch(() => undefined);

    const result = await invoke<{ ok: boolean }>('library:switch', libraryPath);
    expect(result.ok).toBe(true);
    expect(await invoke('items:list', {})).toHaveLength(1);
  });
});

describe('items', () => {
  beforeEach(async () => {
    await chooseLibrary();
  });

  it('creates, reads back and lists', async () => {
    const created = await invoke<{ id: string; rev: number; slug: string }>('items:create', {
      name: 'Acme Widget',
      manufacturer: 'Acme',
    });

    expect(created.slug).toBe('acme-widget');
    expect(await invoke('items:get', created.id)).toMatchObject({ name: 'Acme Widget' });
    expect(await invoke('items:list', { query: 'acme' })).toHaveLength(1);
  });

  it('broadcasts a data change on every write', async () => {
    broadcasts = [];
    await invoke('items:create', { name: 'Widget' });
    expect(broadcasts.filter((entry) => entry.channel === 'library:dataChanged')).toHaveLength(1);
  });

  it('does not broadcast on a read', async () => {
    await invoke('items:create', { name: 'Widget' });
    broadcasts = [];
    await invoke('items:list', {});
    await invoke('items:listTrash', {});
    expect(broadcasts).toEqual([]);
  });

  it('updates and returns a conflict rather than throwing', async () => {
    const item = await invoke<{ id: string; rev: number }>('items:create', { name: 'Widget' });
    await invoke('items:update', { id: item.id, rev: item.rev, patch: { name: 'Theirs' } });

    const result = await invoke<{ conflict?: boolean; overlapping?: string[] }>('items:update', {
      id: item.id,
      rev: item.rev,
      patch: { name: 'Mine' },
      base: { name: 'Widget' },
    });

    expect(result.conflict).toBe(true);
    expect(result.overlapping).toEqual(['name']);
  });

  it('turns a validation failure into a readable message', async () => {
    await expect(invoke('items:create', { name: '   ' })).rejects.toThrow(/needs a name/);
  });

  it('turns a missing item into a readable message', async () => {
    await expect(invoke('items:get', 'ghost')).resolves.toBeNull();
    await expect(invoke('items:trash', { id: 'ghost', rev: 1 })).rejects.toThrow(/no longer exists/);
  });

  it('trashes and restores', async () => {
    const item = await invoke<{ id: string; rev: number }>('items:create', { name: 'Doomed' });

    expect(await invoke('items:trash', { id: item.id, rev: item.rev })).toMatchObject({ ok: true });
    expect(await invoke('items:list', {})).toHaveLength(0);
    expect(await invoke('items:listTrash', {})).toHaveLength(1);

    await invoke('items:restore', { id: item.id });
    expect(await invoke('items:list', {})).toHaveLength(1);
  });

  it('renames a folder on request', async () => {
    const item = await invoke<{ id: string; rev: number }>('items:create', { name: 'Widget' });
    await invoke('items:update', { id: item.id, rev: item.rev, patch: { name: 'Renamed' } });

    expect(await invoke('items:renameFolder', { id: item.id })).toMatchObject({ slug: 'renamed' });
  });

  it('reveals an item folder, creating it on demand', async () => {
    const item = await invoke<{ id: string; slug: string }>('items:create', { name: 'Widget' });
    await invoke('items:revealFolder', { id: item.id });

    expect(state.opened).toEqual([join(libraryPath, 'data', 'widget')]);
    expect(existsSync(join(libraryPath, 'data', 'widget'))).toBe(true);
  });
});

describe('fields', () => {
  beforeEach(async () => {
    await chooseLibrary();
  });

  it('creates, lists, archives and removes', async () => {
    const field = await invoke<{ id: string; key: string }>('fields:create', { label: 'Voltage', type: 'number' });
    expect(field.key).toBe('voltage');
    expect(await invoke('fields:list')).toHaveLength(1);

    expect(await invoke('fields:archive', { id: field.id, archived: true })).toMatchObject({
      archivedAt: expect.any(String),
    });
    // fields:list includes archived ones so the Fields screen can show them.
    expect(await invoke('fields:list')).toHaveLength(1);

    expect(await invoke('fields:remove', { id: field.id })).toEqual({ ok: true });
    expect(await invoke('fields:list')).toHaveLength(0);
  });

  it('reorders', async () => {
    const a = await invoke<{ id: string }>('fields:create', { label: 'A', type: 'text' });
    const b = await invoke<{ id: string }>('fields:create', { label: 'B', type: 'text' });

    const reordered = await invoke<{ label: string }[]>('fields:reorder', { ids: [b.id, a.id] });
    expect(reordered.map((field) => field.label)).toEqual(['B', 'A']);
  });

  it('refuses a type change that would lose values, with a countable message', async () => {
    const field = await invoke<{ id: string; key: string }>('fields:create', { label: 'Code', type: 'text' });
    await invoke('items:create', { name: 'A', fields: { [field.key]: 'not a number' } });

    await expect(invoke('fields:update', { id: field.id, patch: { type: 'number' } })).rejects.toThrow(
      /1 existing value could not be converted/,
    );
  });
});

describe('attachments', () => {
  let itemId: string;

  beforeEach(async () => {
    await chooseLibrary();
    itemId = (await invoke<{ id: string }>('items:create', { name: 'Widget' })).id;
  });

  it('adds files given explicit paths, as drag-and-drop does', async () => {
    const source = join(scratch, 'manual.pdf');
    writeFileSync(source, 'PDF BYTES');

    const added = await invoke<{ id: string; filename: string }[]>('attachments:add', { itemId, paths: [source] });

    expect(added).toHaveLength(1);
    expect(added[0].filename).toBe('manual.pdf');
    expect(existsSync(join(libraryPath, 'data', 'widget', 'manual.pdf'))).toBe(true);
  });

  it('falls back to the dialog when no paths are given', async () => {
    const source = join(scratch, 'picked.pdf');
    writeFileSync(source, 'PDF');
    state.dialogResult = { canceled: false, filePaths: [source] };

    const added = await invoke<{ filename: string }[]>('attachments:add', { itemId });
    expect(added.map((attachment) => attachment.filename)).toEqual(['picked.pdf']);
  });

  it('returns nothing when the dialog is cancelled', async () => {
    state.dialogResult = { canceled: true, filePaths: [] };
    expect(await invoke('attachments:add', { itemId })).toEqual([]);
  });

  it('opens and reveals by id, never by a path from the renderer', async () => {
    const source = join(scratch, 'manual.pdf');
    writeFileSync(source, 'PDF');
    const [attachment] = await invoke<{ id: string }[]>('attachments:add', { itemId, paths: [source] });

    await invoke('attachments:open', { attachmentId: attachment.id });
    await invoke('attachments:reveal', { attachmentId: attachment.id });

    const expected = join(libraryPath, 'data', 'widget', 'manual.pdf');
    expect(state.opened).toEqual([expected]);
    expect(state.revealed).toEqual([expected]);
  });

  it('refuses an attachment id it does not know', async () => {
    await expect(invoke('attachments:open', { attachmentId: 'ghost' })).rejects.toThrow(/no longer exists/);
  });

  it('removes an attachment without destroying the file', async () => {
    const source = join(scratch, 'manual.pdf');
    writeFileSync(source, 'PDF');
    const [attachment] = await invoke<{ id: string }[]>('attachments:add', { itemId, paths: [source] });

    expect(await invoke('attachments:remove', { attachmentId: attachment.id })).toEqual({ ok: true });
    expect(existsSync(join(libraryPath, 'data', 'widget', 'manual.pdf'))).toBe(false);
    expect(existsSync(join(libraryPath, 'deleted'))).toBe(true);
  });
});

describe('library:verify', () => {
  it('reports on a healthy library', async () => {
    await chooseLibrary();
    await invoke('items:create', { name: 'Widget' });

    expect(await invoke('library:verify')).toMatchObject({
      orphanFolders: [],
      missingFiles: [],
      conflictedCopies: [],
    });
  });
});

describe('library:setJournalMode', () => {
  it('reopens the library in the requested mode and remembers the choice', async () => {
    await chooseLibrary();
    expect(await invoke('library:setJournalMode', 'truncate')).toEqual({ ok: true });
    expect(await invoke('library:getState')).toMatchObject({ journalMode: 'truncate' });

    // Reopening later keeps the override rather than re-detecting.
    await invoke('library:switch', libraryPath);
    expect(await invoke('library:getState')).toMatchObject({ journalMode: 'truncate' });
  });

  it('refuses when nothing is open', async () => {
    expect(await invoke('library:setJournalMode', 'wal')).toMatchObject({ ok: false });
  });
});

describe('library:describeFolder', () => {
  it('explains what a sync folder means for the user', async () => {
    const synced = join(scratch, 'Dropbox', 'Catalogue');
    mkdirSync(synced, { recursive: true });

    expect(await invoke('library:describeFolder', synced)).toMatchObject({
      kind: 'sync',
      explanation: expect.stringMatching(/several machines/i),
      lock: { state: 'free' },
    });
  });
});

describe('app:openExternal', () => {
  it('opens a web link', async () => {
    expect(await invoke('app:openExternal', 'https://example.com/manual')).toEqual({ ok: true });
    expect(state.externals).toEqual(['https://example.com/manual']);
  });

  it('refuses anything that is not http or https', async () => {
    // A custom field holds a URL the user typed; the OS must not be handed
    // file:// or anything with a handler behind it.
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://nas/share']) {
      expect(await invoke('app:openExternal', url)).toMatchObject({ ok: false });
    }
    expect(state.externals).toEqual([]);
  });

  it('refuses a string that is not a link at all', async () => {
    expect(await invoke('app:openExternal', 'not a link')).toMatchObject({ ok: false });
  });
});

describe('app:getVersion', () => {
  it('reports the schema alongside the versions', async () => {
    expect(await invoke('app:getVersion')).toMatchObject({ schema: appSchemaVersion() });
  });
});

describe('a read-only library', () => {
  it('refuses writes with an explanation rather than failing silently', async () => {
    await chooseLibrary();
    session.current!.db.pragma(`user_version = ${appSchemaVersion() + 1}`);
    await invoke('library:switch', libraryPath);

    expect(await invoke('library:getState')).toMatchObject({ readOnly: true });
    await expect(invoke('items:create', { name: 'Should not exist' })).rejects.toThrow(/only understands/);
  });
});
