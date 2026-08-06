/**
 * The only thing the renderer can see.
 *
 * An explicit allow-list, not a proxy: adding a capability to the UI means
 * adding a line here, which is the point. `webUtils.getPathForFile` is the one
 * exception to "no paths cross the boundary" — it is how a dropped file's real
 * path is obtained, and it goes straight back to the main process.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { MENU_CHANNELS, type MenuChannel, type MindexApi } from '../shared/types.js';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

/** Subscribe to a main-process broadcast, returning an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: MindexApi = {
  library: {
    getState: () => invoke('library:getState'),
    choose: () => invoke('library:choose'),
    create: (parentPath, name) => invoke('library:create', parentPath, name),
    switchTo: (path) => invoke('library:switch', path),
    reveal: () => invoke('library:reveal'),
    verify: () => invoke('library:verify'),
    setJournalMode: (mode) => invoke('library:setJournalMode', mode),
    takeOverLock: () => invoke('library:takeOverLock'),
    onChanged: (listener) => subscribe('library:changed', listener),
    onDataChanged: (listener) => subscribe('library:dataChanged', listener),
  },
  items: {
    list: (query) => invoke('items:list', query),
    get: (id) => invoke('items:get', id),
    create: (input) => invoke('items:create', input),
    update: (input) => invoke('items:update', input),
    trash: (input) => invoke('items:trash', input),
    restore: (input) => invoke('items:restore', input),
    listTrash: (query) => invoke('items:listTrash', query ?? {}),
    renameFolder: (input) => invoke('items:renameFolder', input),
    revealFolder: (input) => invoke('items:revealFolder', input),
  },
  fields: {
    list: () => invoke('fields:list'),
    create: (input) => invoke('fields:create', input),
    update: (input) => invoke('fields:update', input),
    archive: (input) => invoke('fields:archive', input),
    remove: (input) => invoke('fields:remove', input),
    reorder: (input) => invoke('fields:reorder', input),
  },
  attachments: {
    add: (input) => invoke('attachments:add', input),
    open: (input) => invoke('attachments:open', input),
    reveal: (input) => invoke('attachments:reveal', input),
    remove: (input) => invoke('attachments:remove', input),
  },
  app: {
    getVersion: () => invoke('app:getVersion'),
    openExternal: (url) => invoke('app:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('api', api);

/**
 * Drag-and-drop gives the renderer a `File`, not a path. This is the sanctioned
 * way to get the real one, and the renderer immediately hands it back to the
 * main process rather than doing anything with it.
 */
contextBridge.exposeInMainWorld('files', {
  pathFor: (file: File): string => webUtils.getPathForFile(file),
});

/**
 * Menu commands. The channel is checked against the allow-list rather than
 * passed through, so the renderer cannot subscribe to anything it likes.
 */
contextBridge.exposeInMainWorld('menu', {
  on: (channel: MenuChannel, listener: () => void): (() => void) => {
    if (!(MENU_CHANNELS as readonly string[]).includes(channel)) return () => {};
    return subscribe(channel, listener);
  },
});
