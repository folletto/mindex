import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FALLBACK_FILENAME,
  FILENAME_MAX_LENGTH,
  nextAvailableFilename,
  sanitizeFilename,
  splitExtension,
} from '../../src/shared/filenames.js';
import { WINDOWS_RESERVED_NAMES } from '../../src/shared/slug.js';

describe('sanitizeFilename', () => {
  const cases: [string, string, string][] = [
    ['ordinary name', 'datasheet.pdf', 'datasheet.pdf'],
    ['spaces are fine', 'user manual v2.pdf', 'user manual v2.pdf'],
    ['unicode is fine', 'Bedienungsanleitung — Größe.pdf', 'Bedienungsanleitung — Größe.pdf'],
    ['cjk is fine', '说明书.pdf', '说明书.pdf'],
    ['posix path is stripped', '/etc/passwd', 'passwd'],
    ['windows path is stripped', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
    ['traversal is stripped', '../../etc/passwd', 'passwd'],
    ['traversal with backslashes', '..\\..\\secret.txt', 'secret.txt'],
    ['bare dot-dot', '..', FALLBACK_FILENAME],
    ['bare dot', '.', FALLBACK_FILENAME],
    ['only dots', '.....', FALLBACK_FILENAME],
    ['dotfile survives', '.gitignore', '.gitignore'],
    ['windows illegal characters', 'a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['trailing dot removed', 'report..', 'report'],
    ['trailing space removed', 'report .pdf', 'report .pdf'],
    ['empty string', '', FALLBACK_FILENAME],
    ['only spaces', '    ', FALLBACK_FILENAME],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('re\u0000po\u001frt.txt')).toBe('re_po_rt.txt');
  });

  it('never returns a path separator', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (input) => {
        const safe = sanitizeFilename(input);
        expect(safe).not.toContain('/');
        expect(safe).not.toContain('\\');
        expect(safe.length).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });

  it('never returns "." or ".." however hard you try', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[./\\ ]{0,20}$/), (input) => {
        const safe = sanitizeFilename(input);
        expect(safe).not.toBe('.');
        expect(safe).not.toBe('..');
      }),
      { numRuns: 500 },
    );
  });

  it('stays inside the length budget while keeping the extension', () => {
    const long = `${'x'.repeat(400)}.pdf`;
    const safe = sanitizeFilename(long);
    expect(safe.length).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
    expect(safe.endsWith('.pdf')).toBe(true);
  });

  it('is length-bounded for any input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (input) => {
        expect(sanitizeFilename(input).length).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
      }),
      { numRuns: 1000 },
    );
  });

  it.each([...WINDOWS_RESERVED_NAMES])('escapes the device name %s even with an extension', (reserved) => {
    expect(sanitizeFilename(`${reserved}.txt`)).toBe(`${reserved}-1.txt`);
    expect(sanitizeFilename(reserved)).toBe(`${reserved}-1`);
  });

  it('handles non-strings', () => {
    expect(sanitizeFilename(undefined)).toBe(FALLBACK_FILENAME);
    expect(sanitizeFilename(null)).toBe(FALLBACK_FILENAME);
    expect(sanitizeFilename(7)).toBe(FALLBACK_FILENAME);
  });
});

describe('splitExtension', () => {
  it('splits on the last dot', () => {
    expect(splitExtension('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' });
  });

  it('treats a leading dot as part of the name', () => {
    expect(splitExtension('.gitignore')).toEqual({ stem: '.gitignore', extension: '' });
  });

  it('ignores a trailing dot', () => {
    expect(splitExtension('report.')).toEqual({ stem: 'report.', extension: '' });
  });

  it('refuses to treat a long tail as an extension', () => {
    const name = 'notes.this-is-not-really-an-extension';
    expect(splitExtension(name)).toEqual({ stem: name, extension: '' });
  });
});

describe('nextAvailableFilename', () => {
  it('returns the sanitized name when it is free', () => {
    expect(nextAvailableFilename('photo.jpg', () => false)).toBe('photo.jpg');
  });

  it('suffixes before the extension', () => {
    const taken = new Set(['photo.jpg', 'photo (2).jpg']);
    expect(nextAvailableFilename('photo.jpg', (name) => taken.has(name))).toBe('photo (3).jpg');
  });

  it('suffixes extensionless names too', () => {
    const taken = new Set(['README']);
    expect(nextAvailableFilename('README', (name) => taken.has(name))).toBe('README (2)');
  });

  it('keeps suffixed names inside the length budget', () => {
    const taken = new Set<string>();
    let name = `${'x'.repeat(400)}.pdf`;
    for (let i = 0; i < 12; i++) {
      name = nextAvailableFilename(`${'x'.repeat(400)}.pdf`, (candidate) => taken.has(candidate));
      expect(name.length).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it('gives up rather than looping forever', () => {
    expect(() => nextAvailableFilename('a.txt', () => true, 3)).toThrow(/Could not find a free filename/);
  });
});
