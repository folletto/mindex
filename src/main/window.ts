/**
 * Window creation and the renderer's security posture.
 *
 * The renderer is treated as untrusted: it gets no Node, no remote content, no
 * way to navigate anywhere, and no way to open a window. Links go to the OS
 * browser through an IPC call that validates the scheme first.
 */

import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings, writeSettings, type WindowBounds } from './settings.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Everything the renderer is allowed to load. In development that is the Vite
 * dev server; in production it is a single file on disk.
 */
function isAllowedNavigation(url: string, devServerUrl: string | undefined): boolean {
  if (url.startsWith('file://')) return true;
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return false;
}

export function createWindow(devServerUrl: string | undefined): BrowserWindow {
  const bounds = readSettings().windowBounds;

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Mindex',
    // Native look on macOS; a standard frame everywhere else.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
    backgroundColor: '#00000000',
    webPreferences: {
      // Built as CommonJS: a sandboxed preload has no module loader.
      preload: join(HERE, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No <webview>, no popups, nothing that could host a second renderer.
      webviewTag: false,
      spellcheck: true,
    },
  });

  if (bounds.maximized) window.maximize();

  window.once('ready-to-show', () => window.show());

  // A link is a request to leave the app, never to replace the UI.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devServerUrl)) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  // Belt and braces: nothing in this app needs a permission, so refuse them all.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const persistBounds = () => {
    if (window.isDestroyed()) return;
    const isMaximized = window.isMaximized();
    const next: WindowBounds = isMaximized
      ? { ...readSettings().windowBounds, maximized: true }
      : { ...window.getBounds(), maximized: false };
    writeSettings({ windowBounds: next });
  };

  window.on('resized', persistBounds);
  window.on('moved', persistBounds);
  window.on('maximize', persistBounds);
  window.on('unmaximize', persistBounds);
  window.on('close', persistBounds);

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(HERE, '../renderer/index.html'));
  }

  return window;
}
