/**
 * The application menu.
 *
 * Menu items send to the renderer rather than acting directly, so that a
 * keyboard shortcut and a click on the same button follow one code path.
 */

import { BrowserWindow, Menu, app, shell } from 'electron';

export interface MenuContext {
  getWindow: () => BrowserWindow | null;
}

export function buildMenu(context: MenuContext): void {
  const send = (channel: string) => () => context.getWindow()?.webContents.send(channel);
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: send('menu:settings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Item', accelerator: 'CmdOrCtrl+N', click: send('menu:new-item') },
        { type: 'separator' },
        { label: 'Change Library…', click: send('menu:change-library') },
        { label: 'Reveal Library in File Manager', click: send('menu:reveal-library') },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: 'Settings', accelerator: 'Ctrl+,', click: send('menu:settings') },
              { type: 'separator' },
              { role: 'quit' },
            ] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('menu:focus-search') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Items', accelerator: 'CmdOrCtrl+1', click: send('menu:view-items') },
        { label: 'Trash', accelerator: 'CmdOrCtrl+2', click: send('menu:view-trash') },
        { label: 'Fields', accelerator: 'CmdOrCtrl+3', click: send('menu:view-fields') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Mindex on GitHub',
          click: () => void shell.openExternal('https://github.com/folletto/mindex'),
        },
        { label: 'Verify Library…', click: send('menu:verify') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
