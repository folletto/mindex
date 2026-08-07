/**
 * Persisted app settings.
 *
 * Deliberately tiny and hand-rolled: the only things worth keeping between
 * launches are which folder the library is in, the handful before it, and the
 * window geometry. Everything else lives in the library itself, so that moving
 * the folder to another machine moves the catalogue whole.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalMode } from '../shared/types.js';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface Settings {
  libraryPath: string | null;
  recentLibraries: string[];
  windowBounds: WindowBounds;
  /** Set only when the user overrode the auto-detected mode. */
  journalModeOverride: Record<string, JournalMode>;
}

const MAX_RECENT = 5;

const DEFAULTS: Settings = {
  libraryPath: null,
  recentLibraries: [],
  windowBounds: { width: 1180, height: 760 },
  journalModeOverride: {},
};

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

let cache: Settings | null = null;

export function readSettings(): Settings {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    cache = { ...DEFAULTS, ...(parsed as Partial<Settings>) };
  } catch {
    // First launch, or a settings file someone edited into nonsense. Starting
    // from defaults is always recoverable; refusing to launch is not.
    cache = { ...DEFAULTS };
  }
  return cache;
}

/** Write via a temp file so a crash mid-write cannot leave a truncated settings file. */
export function writeSettings(next: Partial<Settings>): Settings {
  const merged = { ...readSettings(), ...next };
  cache = merged;

  const target = settingsPath();
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  renameSync(temp, target);

  return merged;
}

export function rememberLibrary(path: string): Settings {
  const settings = readSettings();
  const recent = [path, ...settings.recentLibraries.filter((entry) => entry !== path)].slice(0, MAX_RECENT);
  return writeSettings({ libraryPath: path, recentLibraries: recent });
}

export function forgetLibrary(path: string): Settings {
  const settings = readSettings();
  return writeSettings({
    recentLibraries: settings.recentLibraries.filter((entry) => entry !== path),
    libraryPath: settings.libraryPath === path ? null : settings.libraryPath,
  });
}

export function setJournalModeOverride(path: string, mode: JournalMode | null): Settings {
  const settings = readSettings();
  const overrides = { ...settings.journalModeOverride };
  if (mode === null) delete overrides[path];
  else overrides[path] = mode;
  return writeSettings({ journalModeOverride: overrides });
}

export function journalModeOverrideFor(path: string): JournalMode | undefined {
  return readSettings().journalModeOverride[path];
}

/** Test seam: drop the in-memory copy so the next read hits disk. */
export function resetSettingsCache(): void {
  cache = null;
}
