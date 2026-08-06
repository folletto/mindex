/**
 * Every path the app touches is derived here.
 *
 * The containment check is the security boundary between renderer-supplied data
 * and the filesystem: only IDs cross IPC, the main process resolves them from
 * the database, and the resulting path is checked before it is used.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

export const DB_FILENAME = 'catalogue.db';
export const MARKER_FILENAME = '.catalogue-library';
export const LOCK_FILENAME = '.catalogue-lock';
export const DATA_DIRNAME = 'data';
export const DELETED_DIRNAME = 'deleted';

export interface LibraryPaths {
  root: string;
  dbPath: string;
  dataDir: string;
  deletedDir: string;
  markerPath: string;
  lockPath: string;
}

export function libraryPaths(root: string): LibraryPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    dbPath: resolve(absoluteRoot, DB_FILENAME),
    dataDir: resolve(absoluteRoot, DATA_DIRNAME),
    deletedDir: resolve(absoluteRoot, DELETED_DIRNAME),
    markerPath: resolve(absoluteRoot, MARKER_FILENAME),
    lockPath: resolve(absoluteRoot, LOCK_FILENAME),
  };
}

export class PathEscapeError extends Error {
  constructor(candidate: string, root: string) {
    super(`Refusing to touch ${candidate}: it is outside the library folder ${root}`);
    this.name = 'PathEscapeError';
  }
}

/** True when `candidate` is `root` itself or something strictly inside it. */
export function isContained(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (absoluteCandidate === absoluteRoot) return true;

  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === '') return true;
  // `..` at the front means we climbed out; an absolute result means a different
  // Windows drive letter entirely.
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Return `candidate` resolved, or throw if it would escape `root`. */
export function assertContained(root: string, candidate: string): string {
  if (!isContained(root, candidate)) throw new PathEscapeError(candidate, root);
  return resolve(candidate);
}

/**
 * Resolve a single path segment inside `parent`.
 *
 * Both arguments are trusted by the time they get here (slugs and filenames
 * come out of the database), but the containment check runs anyway — it is the
 * one place a bug in normalisation would otherwise reach the disk.
 */
export function resolveInside(parent: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (segment.includes('/') || segment.includes('\\')) {
      throw new PathEscapeError(segments.join('/'), parent);
    }
  }
  return assertContained(parent, resolve(parent, ...segments));
}

export function itemFolder(paths: LibraryPaths, slug: string): string {
  return resolveInside(paths.dataDir, slug);
}

export function trashFolder(paths: LibraryPaths, deletedPath: string): string {
  return resolveInside(paths.deletedDir, deletedPath);
}

/**
 * `<slug>--<YYYYMMDD-HHMMSS>`: repeated create/delete cycles of the same name
 * never collide, and the folder stays identifiable by eye in a file manager.
 */
export function trashFolderName(slug: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${slug}--${stamp}`;
}
