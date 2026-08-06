/**
 * Slug normalization.
 *
 * This module decides what folders are called on disk, which makes it the most
 * expensive place in the codebase to get wrong: a bad slug is a folder a user
 * cannot find, or worse, a name their filesystem refuses. It is deliberately
 * pure, dependency-free and exhaustively tested (see tests/unit/slug.test.ts).
 */

export const SLUG_MAX_LENGTH = 60;
export const FALLBACK_SLUG = 'item';

/**
 * Characters NFKD does not decompose into ASCII + combining marks, mapped by hand.
 * Both cases are listed so the map can be applied before lowercasing.
 */
const TRANSLITERATIONS: Record<string, string> = {
  ø: 'o',
  Ø: 'o',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ß: 'ss',
  ẞ: 'ss',
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  þ: 'th',
  Þ: 'th',
  ł: 'l',
  Ł: 'l',
  ħ: 'h',
  Ħ: 'h',
  ŋ: 'n',
  Ŋ: 'n',
  ŧ: 't',
  Ŧ: 't',
  ı: 'i',
  İ: 'i',
  ĸ: 'k',
  '№': 'no',
  '€': 'eur',
  '£': 'gbp',
  '$': 'usd',
  '&': 'and',
  '@': 'at',
  '%': 'pct',
  '+': 'plus',
};

/**
 * Device names Windows refuses to use for a file or folder, with or without an
 * extension. A slug that lands on one gets a `-1` suffix.
 */
export const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'clock$',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

export function isReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAMES.has(name.toLowerCase());
}

function transliterate(input: string): string {
  let out = '';
  for (const char of input) {
    out += TRANSLITERATIONS[char] ?? char;
  }
  return out;
}

function trimDashes(input: string): string {
  return input.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
}

/**
 * Normalize an arbitrary human name into a filesystem-safe folder name.
 *
 * Guarantees (asserted as properties in the test suite):
 * - the result always matches `^[a-z0-9-]{1,60}$`
 * - the result is never a Windows reserved device name
 * - `slugify(slugify(x)) === slugify(x)`
 */
export function slugify(input: unknown): string {
  if (typeof input !== 'string') return FALLBACK_SLUG;

  // NFKD splits accented characters into base + combining mark, and unfolds
  // compatibility forms (ﬁ -> fi, ① -> 1, full-width -> ASCII).
  let slug = transliterate(input.normalize('NFKD'));
  slug = slug.replace(/\p{M}+/gu, '');
  slug = slug.toLowerCase();
  slug = slug.replace(/[^a-z0-9]+/g, '-');
  slug = trimDashes(slug);

  if (slug.length > SLUG_MAX_LENGTH) {
    slug = trimDashes(slug.slice(0, SLUG_MAX_LENGTH));
  }

  if (slug.length === 0) return FALLBACK_SLUG;
  if (isReservedName(slug)) return `${slug}-1`;

  return slug;
}

/**
 * Shorten `base` so that `base + suffix` still fits inside `maxLength`.
 */
function fitWithSuffix(base: string, suffix: string, maxLength: number): string {
  if (base.length + suffix.length <= maxLength) return base;
  const trimmed = trimDashes(base.slice(0, Math.max(1, maxLength - suffix.length)));
  return trimmed.length > 0 ? trimmed : FALLBACK_SLUG.slice(0, Math.max(1, maxLength - suffix.length));
}

export interface UniqueSlugOptions {
  maxLength?: number;
  maxAttempts?: number;
}

/**
 * Find a slug for `name` that `isTaken` reports as free, appending `-2`, `-3`, …
 *
 * The caller is expected to run this inside the same transaction as the insert;
 * the partial unique index on `items(slug) WHERE deleted_at IS NULL` is the real
 * guard against a concurrent writer claiming the same name in between.
 */
export function uniqueSlug(
  name: string,
  isTaken: (candidate: string) => boolean,
  options: UniqueSlugOptions = {},
): string {
  const maxLength = options.maxLength ?? SLUG_MAX_LENGTH;
  const maxAttempts = options.maxAttempts ?? 10_000;

  const base = slugify(name);
  if (!isTaken(base)) return base;

  for (let n = 2; n <= maxAttempts; n++) {
    const suffix = `-${n}`;
    const candidate = fitWithSuffix(base, suffix, maxLength) + suffix;
    if (!isTaken(candidate)) return candidate;
  }

  throw new Error(`Could not find a free slug for "${name}" after ${maxAttempts} attempts`);
}

/**
 * Keys for user-defined fields. Same normalization as folder slugs: these end up
 * as CSV headers and stay stable while the human-facing label is renamed freely.
 */
export function fieldKey(label: string): string {
  return slugify(label);
}
