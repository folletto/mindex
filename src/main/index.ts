/**
 * Application lifecycle.
 *
 * One window, one library, one instance per machine — which says nothing about
 * how many *other* machines have the same library open. See src/main/session.ts.
 */

import { BrowserWindow, app } from 'electron';
import { existsSync } from 'node:fs';
import { registerIpc } from './ipc.js';
import { buildMenu } from './menu.js';
import { Session } from './session.js';
import { journalModeOverrideFor, readSettings, rememberLibrary } from './settings.js';
import { createWindow } from './window.js';

const session = new Session();
let mainWindow: BrowserWindow | null = null;

const devServerUrl = process.env.ELECTRON_RENDERER_URL;

function broadcast(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * A second launch focuses the window we already have. This is a statement about
 * this machine's UI, not about the library.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.flashFrame(true);
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('id.folletto.mindex');

    registerIpc({
      session,
      getWindow: () => mainWindow,
      broadcast,
    });

    mainWindow = createWindow(devServerUrl);
    buildMenu({ getWindow: () => mainWindow });

    // Reopen last time's library, if it is still there. A folder that has moved
    // is not an error worth a dialog — the onboarding screen explains it.
    //
    // MINDEX_LIBRARY overrides the saved path. It exists because the folder
    // picker is a native dialog that Playwright cannot click: the end-to-end
    // tests point this at a temp folder and get the real open-or-initialise
    // path, rather than a mocked one.
    const settings = readSettings();
    const override = process.env.MINDEX_LIBRARY;
    const startupPath = override || settings.libraryPath;

    if (startupPath && existsSync(startupPath)) {
      try {
        // Only the override initialises an empty folder. Doing that for a
        // remembered path would mean creating a fresh database inside a synced
        // library whose files have not finished downloading yet.
        session.open(startupPath, {
          journalMode: journalModeOverrideFor(startupPath),
          initialize: Boolean(override),
        });
        rememberLibrary(startupPath);
      } catch (error) {
        console.error('[mindex] could not reopen the last library:', error);
      }
    }

    // Another machine committing is indistinguishable, from here, from a local
    // write: the renderer just reloads what it is showing.
    session.onExternalChange(() => broadcast('library:dataChanged'));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow(devServerUrl);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Checkpoint the WAL and release the advisory lock before the process goes.
  app.on('before-quit', () => session.close());
}
