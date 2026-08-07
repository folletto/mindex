/**
 * Custom field typing.
 *
 * Values are stored as a canonical string in `field_values.value`, with a
 * parallel `num_value` for the types that want sorting and range filters. This
 * module owns both directions of that conversion, so the SQL layer never has to
 * think about what a "date" is.
 */

import { FIELD_TYPES, type FieldDef, type FieldType, type FieldValue } from './types.js';

export interface StoredValue {
  value: string | null;
  numValue: number | null;
}

export type CoerceResult = { ok: true; stored: StoredValue } | { ok: false; reason: string };

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && (FIELD_TYPES as readonly string[]).includes(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * Convert whatever the UI produced into the canonical stored form.
 *
 * Returns a reason rather than throwing, because the caller (a type change, or
 * a form save) usually wants to count the failures and report them together.
 */
export function coerceFieldValue(field: Pick<FieldDef, 'type' | 'options'>, raw: unknown): CoerceResult {
  if (isBlank(raw)) return { ok: true, stored: { value: null, numValue: null } };

  switch (field.type) {
    case 'text':
    case 'longtext': {
      const text = String(raw);
      return { ok: true, stored: { value: text, numValue: null } };
    }

    case 'number': {
      const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(parsed)) return { ok: false, reason: `"${String(raw)}" is not a number` };
      return { ok: true, stored: { value: String(parsed), numValue: parsed } };
    }

    case 'date': {
      const text = String(raw).trim();
      const date = ISO_DATE.test(text) ? new Date(`${text}T00:00:00Z`) : new Date(text);
      if (Number.isNaN(date.getTime())) return { ok: false, reason: `"${text}" is not a date` };
      const iso = date.toISOString().slice(0, 10);
      return { ok: true, stored: { value: iso, numValue: date.getTime() } };
    }

    case 'boolean': {
      const truthy = raw === true || raw === 1 || /^(true|yes|1|on)$/i.test(String(raw).trim());
      const falsy = raw === false || raw === 0 || /^(false|no|0|off)$/i.test(String(raw).trim());
      if (!truthy && !falsy) return { ok: false, reason: `"${String(raw)}" is not a yes/no value` };
      return { ok: true, stored: { value: truthy ? '1' : '0', numValue: truthy ? 1 : 0 } };
    }

    case 'url': {
      const text = String(raw).trim();
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
      let url: URL;
      try {
        url = new URL(withScheme);
      } catch {
        return { ok: false, reason: `"${text}" is not a URL` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: `only http and https links are stored, not ${url.protocol}` };
      }
      return { ok: true, stored: { value: url.toString(), numValue: null } };
    }

    case 'select': {
      const text = String(raw);
      const options = field.options ?? [];
      if (!options.includes(text)) return { ok: false, reason: `"${text}" is not one of the choices` };
      return { ok: true, stored: { value: text, numValue: options.indexOf(text) } };
    }

    default: {
      // Reached only if a library written by a newer app version uses a type we
      // do not know. Keep the raw string rather than dropping the user's data.
      return { ok: true, stored: { value: String(raw), numValue: null } };
    }
  }
}

/** Turn the stored canonical string back into something the UI can render. */
export function parseFieldValue(type: FieldType, stored: string | null): FieldValue {
  if (stored === null) return null;
  switch (type) {
    case 'number':
      return Number(stored);
    case 'boolean':
      return stored === '1';
    default:
      return stored;
  }
}

export interface ConversionReport {
  convertible: number;
  failures: { itemId: string; value: string; reason: string }[];
}

/**
 * Dry-run a field type change. The UI refuses the change if any value would be
 * lost, and offers archiving the field instead.
 */
export function planTypeChange(
  target: Pick<FieldDef, 'type' | 'options'>,
  values: { itemId: string; value: string | null }[],
): ConversionReport {
  const report: ConversionReport = { convertible: 0, failures: [] };
  for (const row of values) {
    if (row.value === null) continue;
    const result = coerceFieldValue(target, row.value);
    if (result.ok) report.convertible++;
    else report.failures.push({ itemId: row.itemId, value: row.value, reason: result.reason });
  }
  return report;
}
