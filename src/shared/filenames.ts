/**
 * Attachment filename sanitisation.
 *
 * Attachment names come from whatever the user dropped on the window, which
 * means they can contain path separators, control characters, Windows-illegal
 * punctuation, or 300 characters of Cyrillic. They are never concatenated into
 * a path before passing through here.
 */

import { WINDOWS_RESERVED_NAMES } from './slug.js';

/** Keeps the whole `<library>/data/<slug>/<filename>` path clear of MAX_PATH. */
export const FILENAME_MAX_LENGTH = 120;
const EXTENSION_MAX_LENGTH = 16;
export const FALLBACK_FILENAME = 'file';

/** Illegal on Windows, plus control characters, which are illegal everywhere sane. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

export interface SplitName {
  stem: string;
  extension: string;
}

/**
 * Split at the last dot, treating a leading dot as part of the stem so
 * `.gitignore` keeps its name instead of becoming an extension.
 */
export function splitExtension(filename: string): SplitName {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return { stem: filename, extension: '' };
  const extension = filename.slice(dot);
  if (extension.length - 1 > EXTENSION_MAX_LENGTH) return { stem: filename, extension: '' };
  return { stem: filename.slice(0, dot), extension };
}

/**
 * Reduce an arbitrary string to a single safe path segment.
 *
 * Always returns a non-empty name that contains no path separator, so the result
 * can never escape the folder it is joined onto.
 */
export function sanitizeFilename(input: unknown): string {
  if (typeof input !== 'string') return FALLBACK_FILENAME;

  // Take the basename by hand rather than with path.basename: the input may use
  // the *other* platform's separator, and we want both stripped either way.
  let name = input.normalize('NFC').split(/[/\\]/).pop() ?? '';
  name = name.replace(ILLEGAL_CHARACTERS, '_');
  name = name.trim();

  // Windows silently strips trailing dots and spaces, which would let "a." and
  // "a" collide after the fact.
  name = name.replace(/[. ]+$/, '');
  name = name.replace(/^\.+/, (dots) => (dots.length > 1 ? '' : '.'));

  if (name === '' || name === '.' || name === '..') return FALLBACK_FILENAME;

  const split = splitExtension(name);
  const extension = split.extension;
  let stem = split.stem;
  if (stem.trim() === '') stem = FALLBACK_FILENAME;

  if (WINDOWS_RESERVED_NAMES.has(stem.toLowerCase())) stem = `${stem}-1`;

  const budget = FILENAME_MAX_LENGTH - extension.length;
  if (stem.length > budget) stem = stem.slice(0, Math.max(1, budget)).replace(/[. ]+$/, '');
  if (stem === '') stem = FALLBACK_FILENAME;

  return stem + extension;
}

/**
 * Find a name that does not collide, appending ` (2)`, ` (3)`, … before the
 * extension. The filesystem and the UNIQUE(item_id, filename) constraint remain
 * the real authorities; this just picks the candidate to try.
 */
export function nextAvailableFilename(
  desired: string,
  isTaken: (candidate: string) => boolean,
  maxAttempts = 10_000,
): string {
  const safe = sanitizeFilename(desired);
  if (!isTaken(safe)) return safe;

  const { stem, extension } = splitExtension(safe);
  for (let n = 2; n <= maxAttempts; n++) {
    const suffix = ` (${n})`;
    const budget = FILENAME_MAX_LENGTH - extension.length - suffix.length;
    const trimmed = stem.length > budget ? stem.slice(0, Math.max(1, budget)) : stem;
    const candidate = `${trimmed}${suffix}${extension}`;
    if (!isTaken(candidate)) return candidate;
  }

  throw new Error(`Could not find a free filename for "${desired}" after ${maxAttempts} attempts`);
}
