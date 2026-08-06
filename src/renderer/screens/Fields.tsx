/**
 * Custom field management.
 *
 * The built-in fields (name, manufacturer, notes, last update, attachment
 * count) are fixed and not listed here. Everything else is per-library and
 * user-defined.
 */

import { useState } from 'react';
import { FIELD_TYPES, type FieldDef, type FieldType } from '@shared/types';
import { api } from '../state/api.js';

interface Props {
  fields: FieldDef[];
  readOnly: boolean;
  onChanged(): void;
}

const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  longtext: 'Long text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
  url: 'Link',
  select: 'Choice',
};

export function Fields({ fields, readOnly, onChanged }: Props) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const create = () =>
    run(async () => {
      await api.fields.create({
        label,
        type,
        options: type === 'select' ? options.split(',').map((option) => option.trim()).filter(Boolean) : undefined,
      });
      setLabel('');
      setOptions('');
    });

  const move = (field: FieldDef, delta: number) => {
    const active = fields.filter((candidate) => candidate.archivedAt === null);
    const index = active.findIndex((candidate) => candidate.id === field.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= active.length) return;
    const reordered = [...active];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    void run(() => api.fields.reorder({ ids: reordered.map((candidate) => candidate.id) }));
  };

  const active = fields.filter((field) => field.archivedAt === null);
  const archived = fields.filter((field) => field.archivedAt !== null);

  return (
    <section className="pane">
      <header className="pane-header">
        <h2>Fields</h2>
        <p className="muted">
          Fields you add here appear on every item in this library. Renaming a field is free. Changing its type
          is checked against the values already stored, and refused rather than applied if any would be lost.
        </p>
      </header>

      {error && <p className="error">{error}</p>}

      {active.length === 0 ? (
        <p className="empty-state">No custom fields yet.</p>
      ) : (
        <ul className="field-list">
          {active.map((field, index) => (
            <li key={field.id}>
              <div className="field-main">
                <input
                  value={field.label}
                  disabled={readOnly}
                  aria-label={`Name of the ${field.label} field`}
                  onChange={(event) => {
                    const next = event.target.value;
                    void run(() => api.fields.update({ id: field.id, patch: { label: next } }));
                  }}
                />
                <code className="key">{field.key}</code>
                <select
                  value={field.type}
                  disabled={readOnly}
                  aria-label={`Type of the ${field.label} field`}
                  onChange={(event) =>
                    void run(() => api.fields.update({ id: field.id, patch: { type: event.target.value as FieldType } }))
                  }
                >
                  {FIELD_TYPES.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {TYPE_LABELS[candidate]}
                    </option>
                  ))}
                </select>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={field.searchable}
                    disabled={readOnly}
                    onChange={(event) =>
                      void run(() => api.fields.update({ id: field.id, patch: { searchable: event.target.checked } }))
                    }
                  />
                  Searchable
                </label>
              </div>
              <div className="row">
                <button type="button" className="ghost small" disabled={readOnly || index === 0} onClick={() => move(field, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={readOnly || index === active.length - 1}
                  onClick={() => move(field, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={readOnly}
                  title="Hides the field from forms but keeps every value"
                  onClick={() => void run(() => api.fields.archive({ id: field.id, archived: true }))}
                >
                  Archive
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <section className="archived">
          <h3>Archived</h3>
          <p className="muted">Hidden from item forms. Their values are still stored and still exported.</p>
          <ul className="field-list">
            {archived.map((field) => (
              <li key={field.id}>
                <div className="field-main">
                  <span>{field.label}</span>
                  <code className="key">{field.key}</code>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="ghost small"
                    disabled={readOnly}
                    onClick={() => void run(() => api.fields.archive({ id: field.id, archived: false }))}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="danger small"
                    disabled={readOnly}
                    title="Deletes the field and every value stored in it"
                    onClick={() => {
                      if (confirm(`Delete “${field.label}” and all of its values? This cannot be undone.`)) {
                        void run(() => api.fields.remove({ id: field.id }));
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="new-field">
        <h3>Add a field</h3>
        <div className="row">
          <input
            placeholder="Field name"
            value={label}
            disabled={readOnly}
            aria-label="New field name"
            onChange={(event) => setLabel(event.target.value)}
          />
          <select
            value={type}
            disabled={readOnly}
            aria-label="New field type"
            onChange={(event) => setType(event.target.value as FieldType)}
          >
            {FIELD_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {TYPE_LABELS[candidate]}
              </option>
            ))}
          </select>
          {type === 'select' && (
            <input
              placeholder="Choices, comma separated"
              value={options}
              disabled={readOnly}
              aria-label="Choices"
              onChange={(event) => setOptions(event.target.value)}
            />
          )}
          <button type="button" disabled={readOnly || label.trim() === ''} onClick={create}>
            Add
          </button>
        </div>
      </section>
    </section>
  );
}
