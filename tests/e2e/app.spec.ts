/**
 * End-to-end tests against the real Electron app.
 *
 * These drive the built `out/` bundle, so they exercise the parts unit tests
 * cannot: the preload bridge, the IPC round trip, and the renderer's sandbox.
 * The first thing this suite ever caught was the preload failing to load at
 * all, which no amount of main-process testing would have found.
 *
 * The folder picker is a native dialog, which Playwright cannot click. Rather
 * than mocking the app, each test points MINDEX_LIBRARY at a temp folder that
 * the main process adopts on launch — the same open-or-initialise code path a
 * chosen folder takes, minus the dialog.
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
    items: { list(query: { limit: number }): Promise<Record<string, unknown>[]> };
    attachments: { add(input: { itemId: string; paths: string[] }): Promise<unknown> };
  };
}

let app: ElectronApplication | undefined;
let window: Page;

/**
 * How long to wait for Electron to exit before stopping asking politely. Well
 * under both the per-test timeout and Playwright's worker teardown budget, so a
 * stuck process surfaces as a killed process rather than as a failed run.
 */
const CLOSE_TIMEOUT_MS = 15_000;
let libraryPath: string;
let userDataPath: string;

/**
 * The installed application binary, for the smoke test that runs on a tag
 * against what was actually built. Returns null when there is no packaged build
 * to point at, which is the normal case during development.
 */
function packagedExecutable(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? ['mac-arm64/Mindex.app/Contents/MacOS/Mindex', 'mac/Mindex.app/Contents/MacOS/Mindex']
      : process.platform === 'win32'
        ? ['win-unpacked/Mindex.exe']
        : ['linux-unpacked/mindex'];

  for (const candidate of candidates) {
    const full = join(PROJECT_ROOT, 'release', candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

async function launch(): Promise<void> {
  // Chromium's setuid sandbox cannot start as root, which is how Linux CI
  // containers run. This does not affect the renderer's own sandbox, which is
  // what the security test below actually checks.
  const chromiumArgs = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];

  // On a tag, the release workflow re-runs the @smoke tests against the real
  // installed binary rather than against out/ — that is the difference between
  // "the code works" and "the thing we are about to publish works".
  const packaged = process.env.MINDEX_E2E_PACKAGED ? packagedExecutable() : null;
  if (process.env.MINDEX_E2E_PACKAGED && !packaged) {
    throw new Error('MINDEX_E2E_PACKAGED is set, but there is no packaged build under release/.');
  }

  app = await electron.launch({
    ...(packaged
      ? { executablePath: packaged, args: [`--user-data-dir=${userDataPath}`, ...chromiumArgs] }
      : {
          args: [join(PROJECT_ROOT, 'out', 'main', 'index.js'), `--user-data-dir=${userDataPath}`, ...chromiumArgs],
        }),
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_ENV: 'test', MINDEX_LIBRARY: libraryPath },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
}

/**
 * Close the app, and never let a stuck one hang the worker.
 *
 * Windows can hold the Electron process — and the SQLite handle inside it — a
 * moment longer than we do, and `close()` waits for the process to exit. On the
 * last test of a run that wait happens during worker teardown, where exceeding
 * the budget fails the entire suite as an error belonging to no test, even
 * though every test passed. So the wait is bounded, and then the process is
 * killed outright: this is cleanup, and cleanup must not be able to fail a run.
 */
async function closeApp(): Promise<void> {
  const closing = app;
  if (!closing) return;
  app = undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closing.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Electron did not exit in time')), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    try {
      closing.process().kill();
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete a temp folder, retrying briefly for the Windows case where the handle
 * outlives the process. A folder we failed to remove is the OS's problem to
 * mop up, not a reason to fail a green suite.
 */
function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Left behind under the system temp directory; harmless.
  }
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
  await closeApp();
  removeQuietly(join(libraryPath, '..'));
});

/**
 * Read the newest item straight out of the database, through the same IPC the
 * UI uses. Asserting on this rather than on the "Saved" flash keeps the tests
 * about whether the edit landed, not about whether we caught a 1.5s indicator.
 */
async function newestItem(): Promise<Record<string, unknown> | null> {
  return window.evaluate(async () => {
    const api = (globalThis as unknown as RendererApi).api;
    const items = await api.items.list({ limit: 1 });
    return items[0] ?? null;
  });
}

/** Create an item and give it a name, waiting until the name has been stored. */
async function createItem(name: string): Promise<void> {
  await window.getByRole('button', { name: 'New item' }).click();
  // Wait for the new item's form to be the one on screen before typing into it.
  await expect(window.locator('.title-input')).toHaveValue('New item');
  await window.locator('.title-input').fill(name);
  await window.locator('.title-input').blur();
  await expect(window.locator('.item-list .row-name').first()).toHaveText(name);
}

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
  await createItem('Acme Widget');

  await window.locator('#manufacturer').fill('Acme');
  await window.locator('#manufacturer').blur();
  await window.locator('#notes').fill('the good one');
  await window.locator('#notes').blur();

  // Wait for the write to reach the database rather than for the UI to flash.
  await expect.poll(async () => (await newestItem())?.notes).toBe('the good one');

  await closeApp();
  await launch();

  await expect(window.locator('.item-list .row-name')).toHaveText('Acme Widget');
  await window.locator('.item-list button.row').click();
  await expect(window.locator('#manufacturer')).toHaveValue('Acme');
  await expect(window.locator('#notes')).toHaveValue('the good one');
});

test('search filters the list', async () => {
  for (const name of ['Bosch Drill', 'Makita Grinder', 'Acme Widget']) {
    await createItem(name);
  }

  await expect(window.locator('.item-list button.row')).toHaveCount(3);

  await window.getByLabel('Search items').fill('makita');
  await expect(window.locator('.item-list button.row')).toHaveCount(1);
  await expect(window.locator('.item-list .row-name')).toHaveText('Makita Grinder');

  await window.getByLabel('Search items').fill('nothing matches this');
  // Scoped to the list: the detail pane shows its own empty state at the same time.
  await expect(window.locator('.item-list .empty-state')).toContainText('Nothing matches');
});

test('a custom field appears on the item form and is searchable', async () => {
  await window.getByRole('button', { name: 'Fields' }).click();
  await window.getByLabel('New field name').fill('Serial');
  await window.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(window.locator('.field-list .key')).toHaveText('serial');

  await window.getByRole('button', { name: 'Items' }).click();
  await createItem('Tagged thing');

  const serial = window.locator('#field-serial');
  await expect(serial).toBeVisible();
  await serial.fill('XJ-9000');
  await serial.blur();

  await window.getByLabel('Search items').fill('xj-9000');
  await expect(window.locator('.item-list .row-name')).toHaveText('Tagged thing');
});

test('trashing an item moves its folder and can be undone', async () => {
  await createItem('Doomed');

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

test('an attachment is copied in, and the folder only moves when asked', async () => {
  const source = mkdtempSync(join(tmpdir(), 'mindex-e2e-src-'));
  const file = join(source, 'manual.pdf');
  writeFileSync(file, 'PDF BYTES');

  await createItem('Bosch Drill');

  // The file dialog is native, so drive the same IPC the dialog would have.
  const itemId = String((await newestItem())?.id);
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

  // The folder keeps the name the item had when it was created. Renaming an
  // item does not move it: the id is the real key, and a stable folder is worth
  // more than a tidy one.
  expect(existsSync(join(libraryPath, 'data', 'new-item', 'manual.pdf'))).toBe(true);
  expect(existsSync(join(libraryPath, 'data', 'bosch-drill'))).toBe(false);

  // Copied, never moved: the original is where the user left it.
  expect(existsSync(file)).toBe(true);

  // Bringing the folder in line is an explicit, offered action.
  await window.getByRole('button', { name: 'rename folder to match' }).click();
  await expect(window.locator('.detail-footer code')).toHaveText('data/bosch-drill');
  expect(existsSync(join(libraryPath, 'data', 'bosch-drill', 'manual.pdf'))).toBe(true);
  expect(existsSync(join(libraryPath, 'data', 'new-item'))).toBe(false);

  rmSync(source, { recursive: true, force: true });
});

test('the verify report is clean for a healthy library', async () => {
  await createItem('Widget');

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
