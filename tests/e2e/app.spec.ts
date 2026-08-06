/**
 * End-to-end tests against the real Electron app.
 *
 * These drive the built `out/` bundle, so they exercise the parts unit tests
 * cannot: the preload bridge, the IPC round trip, and the renderer's sandbox.
 *
 * The folder picker is a native dialog, which Playwright cannot click. Rather
 * than mocking the app, each test points MINDEX_LIBRARY at a temp folder that
 * the main process adopts on launch — the same code path as a chosen folder,
 * minus the dialog.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * The slice of `window.api` these tests reach for. Declared locally because
 * evaluate() runs in the renderer, where this file's own types do not apply.
 */
interface RendererApi {
  api: {
    items: { list(query: { limit: number }): Promise<{ id: string }[]> };
    attachments: { add(input: { itemId: string; paths: string[] }): Promise<unknown> };
  };
}

let app: ElectronApplication;
let window: Page;
let libraryPath: string;
let userDataPath: string;

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [join(PROJECT_ROOT, 'out', 'main', 'index.js'), `--user-data-dir=${userDataPath}`],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MINDEX_LIBRARY: libraryPath,
    },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
}

test.beforeEach(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mindex-e2e-'));
  libraryPath = join(scratch, 'library');
  userDataPath = join(scratch, 'user-data');
  mkdirSync(libraryPath, { recursive: true });
  mkdirSync(userDataPath, { recursive: true });
  await launch();
});

test.afterEach(async () => {
  await app?.close();
  try {
    rmSync(join(libraryPath, '..'), { recursive: true, force: true });
  } catch {
    // Windows sometimes holds the database handle a moment longer than we do.
  }
});

test('@smoke opens a window and initialises the library folder', async () => {
  await expect(window.locator('.sidebar-nav .brand')).toHaveText('Mindex');

  // The whole data-folder contract, on disk.
  expect(existsSync(join(libraryPath, 'catalogue.db'))).toBe(true);
  expect(existsSync(join(libraryPath, '.catalogue-library'))).toBe(true);
  expect(existsSync(join(libraryPath, 'data'))).toBe(true);
  // Nothing has been deleted, so there is no trash folder yet.
  expect(existsSync(join(libraryPath, 'deleted'))).toBe(false);
});

test('@smoke creates an item and shows it in the list', async () => {
  await window.getByRole('button', { name: 'New item' }).click();

  const title = window.locator('.title-input');
  await expect(title).toHaveValue('New item');

  await title.fill('Bosch GSB 13 RE');
  await title.blur();

  await expect(window.locator('.detail-meta')).toContainText('Updated');
  await expect(window.locator('.item-list .row-name')).toHaveText('Bosch GSB 13 RE');
});

test('edits are saved and survive a restart', async () => {
  await window.getByRole('button', { name: 'New item' }).click();
  await window.locator('.title-input').fill('Acme Widget');
  await window.locator('.title-input').blur();
  await window.locator('#manufacturer').fill('Acme');
  await window.locator('#manufacturer').blur();
  await window.locator('#notes').fill('the good one');
  await window.locator('#notes').blur();
  await expect(window.locator('.saved')).toBeVisible();

  await app.close();
  await launch();

  await expect(window.locator('.item-list .row-name')).toHaveText('Acme Widget');
  await window.locator('.item-list button.row').click();
  await expect(window.locator('#manufacturer')).toHaveValue('Acme');
  await expect(window.locator('#notes')).toHaveValue('the good one');
});

test('search filters the list', async () => {
  for (const name of ['Bosch Drill', 'Makita Grinder', 'Acme Widget']) {
    await window.getByRole('button', { name: 'New item' }).click();
    await window.locator('.title-input').fill(name);
    await window.locator('.title-input').blur();
    await expect(window.locator('.saved')).toBeVisible();
  }

  await expect(window.locator('.item-list button.row')).toHaveCount(3);

  await window.getByLabel('Search items').fill('makita');
  await expect(window.locator('.item-list button.row')).toHaveCount(1);
  await expect(window.locator('.item-list .row-name')).toHaveText('Makita Grinder');

  await window.getByLabel('Search items').fill('nothing matches this');
  await expect(window.locator('.empty-state')).toContainText('Nothing matches');
});

test('a custom field appears on the item form and is searchable', async () => {
  await window.getByRole('button', { name: 'Fields' }).click();
  await window.getByLabel('New field name').fill('Serial');
  await window.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(window.locator('.field-list .key')).toHaveText('serial');

  await window.getByRole('button', { name: 'Items' }).click();
  await window.getByRole('button', { name: 'New item' }).click();
  await window.locator('.title-input').fill('Tagged thing');
  await window.locator('.title-input').blur();

  const serial = window.locator('#field-serial');
  await expect(serial).toBeVisible();
  await serial.fill('XJ-9000');
  await serial.blur();
  await expect(window.locator('.saved')).toBeVisible();

  await window.getByLabel('Search items').fill('xj-9000');
  await expect(window.locator('.item-list .row-name')).toHaveText('Tagged thing');
});

test('trashing an item moves its folder and can be undone', async () => {
  await window.getByRole('button', { name: 'New item' }).click();
  await window.locator('.title-input').fill('Doomed');
  await window.locator('.title-input').blur();
  await expect(window.locator('.saved')).toBeVisible();

  await window.getByRole('button', { name: 'Move to trash' }).click();

  await expect(window.locator('.toast')).toContainText('moved to the trash');
  await expect(window.locator('.item-list button.row')).toHaveCount(0);

  await window.getByRole('button', { name: 'Trash' }).click();
  await expect(window.locator('.trash-list .row-name')).toHaveText('Doomed');

  await window.getByRole('button', { name: 'Restore' }).click();
  await expect(window.locator('.trash-list')).toHaveCount(0);

  await window.getByRole('button', { name: 'Items' }).click();
  await expect(window.locator('.item-list .row-name')).toHaveText('Doomed');
});

test('the trash explains that nothing was deleted', async () => {
  await window.getByRole('button', { name: 'Trash' }).click();
  await expect(window.locator('.pane-header')).toContainText('Nothing here has been deleted');
});

test('an attachment is copied into the item folder and listed', async () => {
  const source = mkdtempSync(join(tmpdir(), 'mindex-e2e-src-'));
  const file = join(source, 'manual.pdf');
  writeFileSync(file, 'PDF BYTES');

  await window.getByRole('button', { name: 'New item' }).click();
  await window.locator('.title-input').fill('Bosch Drill');
  await window.locator('.title-input').blur();
  await expect(window.locator('.saved')).toBeVisible();

  // The dialog is native, so drive the same IPC the dialog would have called.
  const itemId = await window.evaluate(async () => {
    const api = (globalThis as unknown as RendererApi).api;
    const items = await api.items.list({ limit: 1 });
    return items[0].id;
  });
  await window.evaluate(
    async ([id, path]: [string, string]) => {
      const api = (globalThis as unknown as RendererApi).api;
      await api.attachments.add({ itemId: id, paths: [path] });
    },
    [itemId, file] as [string, string],
  );

  await window.reload();
  await window.locator('.item-list button.row').click();

  await expect(window.locator('.attachments .filename')).toHaveText('manual.pdf');
  expect(existsSync(join(libraryPath, 'data', 'bosch-drill', 'manual.pdf'))).toBe(true);
  // Copied, never moved: the original is where the user left it.
  expect(existsSync(file)).toBe(true);

  rmSync(source, { recursive: true, force: true });
});

test('the verify report is clean for a healthy library', async () => {
  await window.getByRole('button', { name: 'New item' }).click();
  await window.locator('.title-input').fill('Widget');
  await window.locator('.title-input').blur();
  await expect(window.locator('.saved')).toBeVisible();

  await window.getByRole('button', { name: 'Settings' }).click();
  await window.getByRole('button', { name: 'Check now' }).click();
  await expect(window.locator('.report .ok')).toHaveText('Everything matches.');
});

test('the renderer has no access to the machine', async () => {
  // The security model, asserted rather than assumed.
  const exposure = await window.evaluate(() => ({
    require: typeof (globalThis as unknown as { require?: unknown }).require,
    process: typeof (globalThis as unknown as { process?: unknown }).process,
    module: typeof (globalThis as unknown as { module?: unknown }).module,
    api: typeof (globalThis as unknown as { api?: object }).api,
    apiKeys: Object.keys((globalThis as unknown as { api: object }).api).sort(),
  }));

  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.module).toBe('undefined');
  expect(exposure.api).toBe('object');
  expect(exposure.apiKeys).toEqual(['app', 'attachments', 'fields', 'items', 'library']);
});
