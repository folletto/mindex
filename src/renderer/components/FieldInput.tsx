/**
 * One input per custom field type.
 *
 * Values leave here as the plain JS value the field's type implies; the main
 * process is the one that decides whether it is acceptable, so this is about
 * offering the right control, not about validation.
 */

import type { FieldDef, FieldValue } from '@shared/types';
import { api } from '../state/api.js';

interface Props {
  field: FieldDef;
  value: FieldValue;
  disabled?: boolean;
  onChange(value: FieldValue): void;
  onCommit(): void;
}

export function FieldInput({ field, value, disabled, onChange, onCommit }: Props) {
  const id = `field-${field.key}`;

  switch (field.type) {
    case 'longtext':
      return (
        <textarea
          id={id}
          rows={4}
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
        />
      );

    case 'number':
      return (
        <input
          id={id}
          type="number"
          step="any"
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          onBlur={onCommit}
        />
      );

    case 'date':
      return (
        <input
          id={id}
          type="date"
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          onBlur={onCommit}
        />
      );

    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
            // A checkbox has no meaningful blur, so commit on the change itself.
            queueMicrotask(onCommit);
          }}
        />
      );

    case 'url':
      return (
        <div className="url-input">
          <input
            id={id}
            type="url"
            inputMode="url"
            disabled={disabled}
            value={value === null ? '' : String(value)}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
            onBlur={onCommit}
          />
          {typeof value === 'string' && value !== '' && (
            <button
              type="button"
              className="ghost small"
              title="Open in your browser"
              onClick={() => void api.app.openExternal(value)}
            >
              Open
            </button>
          )}
        </div>
      );

    case 'select':
      return (
        <select
          id={id}
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) => {
            onChange(event.target.value === '' ? null : event.target.value);
            queueMicrotask(onCommit);
          }}
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    default:
      return (
        <input
          id={id}
          type="text"
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
        />
      );
  }
}
