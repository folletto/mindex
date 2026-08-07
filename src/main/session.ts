/**
 * The currently open library, and the polling that keeps the UI honest when
 * another machine writes to it.
 *
 * Exactly one library is open at a time (§ "one library, one window"). That is a
 * constraint on this machine's UI, not on the library: other machines may have
 * the same folder open and writing, which is what the watcher is for.
 */

import { existsSync } from 'node:fs';
import { dataVersion } from './db/connection.js';
import { appSchemaVersion } from './db/migrations.js';
import { openLibrary, type Library, type OpenLibraryOptions } from './library.js';
import { LibraryService } from './service.js';
import type { LibraryState } from '../shared/types.js';

/** Cheap enough to run on a timer; it does no I/O of its own. */
const POLL_INTERVAL_MS = 2000;

export type ChangeListener = () => void;

export class Session {
  private library: Library | null = null;
  private serviceInstance: LibraryService | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastDataVersion = -1;
  private readonly listeners = new Set<ChangeListener>();

  get isOpen(): boolean {
    return this.library !== null;
  }

  get service(): LibraryService {
    if (!this.serviceInstance) throw new Error('No library is open.');
    return this.serviceInstance;
  }

  get current(): Library | null {
    return this.library;
  }

  open(path: string, options: OpenLibraryOptions = {}): Library {
    this.close();
    const library = openLibrary(path, { useLock: true, ...options });
    this.library = library;
    this.serviceInstance = new LibraryService(library);
    this.lastDataVersion = dataVersion(library.db);
    this.startWatching();
    return library;
  }

  close(): void {
    this.stopWatching();
    this.serviceInstance = null;
    const library = this.library;
    this.library = null;
    library?.close();
  }

  onExternalChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Poll `PRAGMA data_version`, which moves only when a *different* connection
   * commits. Watching the file would be faster but is not reliable across
   * network shares and sync clients, so this is the mechanism and file watching
   * would only ever be an optimisation on top.
   */
  private startWatching(): void {
    this.timer = setInterval(() => {
      const library = this.library;
      if (!library) return;
      try {
        const version = dataVersion(library.db);
        if (version !== this.lastDataVersion) {
          this.lastDataVersion = version;
          for (const listener of this.listeners) listener();
        }
      } catch {
        // The folder may have gone away underneath us. state() reports that;
        // a failed poll is not worth interrupting the user for.
      }
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Everything the renderer needs to decide which screen to show. */
  state(recent: string[], savedPath: string | null): LibraryState {
    const library = this.library;

    if (!library) {
      if (savedPath && !existsSync(savedPath)) {
        return { status: 'missing', path: savedPath, recent };
      }
      return { status: savedPath ? 'missing' : 'unset', path: savedPath, recent };
    }

    if (!existsSync(library.paths.root)) {
      return { status: 'missing', path: library.paths.root, recent };
    }

    return {
      status: 'ready',
      path: library.paths.root,
      recent,
      schema: library.schema,
      appSchema: appSchemaVersion(),
      journalMode: library.journalMode,
      storageKind: library.storageKind,
      readOnly: library.readOnly,
      readOnlyReason: library.readOnlyReason,
    };
  }
}
