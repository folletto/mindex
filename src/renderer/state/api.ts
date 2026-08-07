/**
 * The renderer's view of the world.
 *
 * `window.api` is the whole of it — there is no `fs`, no `path`, no database
 * handle here, and an ESLint rule makes sure it stays that way.
 */

import type { MenuChannel, MindexApi } from '@shared/types';

declare global {
  interface Window {
    api: MindexApi;
    files: { pathFor(file: File): string };
    menu: { on(channel: MenuChannel, listener: () => void): () => void };
  }
}

export const api: MindexApi = window.api;

/** Real paths for dropped files, obtained through the sanctioned Electron API. */
export function pathsForDrop(list: FileList | File[]): string[] {
  return Array.from(list)
    .map((file) => {
      try {
        return window.files.pathFor(file);
      } catch {
        // A file with no path on disk — a drag out of a browser, say.
        return '';
      }
    })
    .filter((path) => path !== '');
}

/**
 * Menu items are broadcasts rather than direct actions, so a keyboard shortcut
 * and a click on the same button follow one code path.
 */
export function onMenuCommand(channel: MenuChannel, listener: () => void): () => void {
  return window.menu.on(channel, listener);
}
