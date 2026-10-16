/**
 * Custom field management.
 *
 * The built-in fields (name, manufacturer, notes, last update, attachment
 * count) are fixed and not listed here. Everything else is per-library and
 * user-defined.
 */

import { ArrowDown, ArrowUp, Eye, EyeOff, ListPlus, Plus, Trash2 } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { FIELD_TYPES, type FieldDef, type FieldType } from '@shared/types';
import { api } from '../state/api.js';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Label,
  Pane,
  PaneHeader,
  Select,
  Tooltip,
} from '../components/ui/index.js';

interface Props {
  fields: FieldDef[];
  readOnly: boolean;
  onChanged(): void;
}

type Work = () => Promise<unknown>;

const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  longtext: 'Long text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
  url: 'Link',
  select: 'Choice',
};

const TYPE_OPTIONS = FIELD_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }));

/** The key a field is stored under. Shown for reference, so it is quiet rather than prominent. */
const keyClass = 'shrink-0 rounded-sm bg-bg-sunken px-1.5 font-mono text-sm text-text-muted';

export function Fields({ fields, readOnly, onChanged }: Props) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FieldDef | null>(null);

  const run = async (work: Work) => {
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
        options: type === 'select' ? parseChoices(options) : undefined,
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

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    void run(() => api.fields.remove({ id: target.id }));
  };

  const active = fields.filter((field) => field.archivedAt === null);
  const archived = fields.filter((field) => field.archivedAt !== null);

  return (
    <Pane>
      <PaneHeader description="Fields you add here appear on every item in this library. Renaming a field is free. Changing its type is checked against the values already stored, and refused rather than applied if any would be lost." />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 p-4">
          {error && <Banner tone="danger">{error}</Banner>}

          {active.length === 0 ? (
            <EmptyState icon={ListPlus} title="No custom fields yet." className="h-auto py-8" />
          ) : (
            <ul className="flex flex-col gap-3">
              {active.map((field, index) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  readOnly={readOnly}
                  first={index === 0}
                  last={index === active.length - 1}
                  run={run}
                  onMove={(delta) => move(field, delta)}
                  onHide={() => void run(() => api.fields.archive({ id: field.id, archived: true }))}
                />
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
                  Hidden
                  <Badge>{archived.length}</Badge>
                </h3>
                <p className="text-sm text-text-muted">
                  Hidden from item forms. Their values are still stored and still exported.
                </p>
              </div>
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-bg-raised">
                {archived.map((field) => (
                  <li key={field.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-text">{field.label}</span>
                      <code data-testid="field-key" className={keyClass}>
                        {field.key}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Eye}
                        disabled={readOnly}
                        onClick={() => void run(() => api.fields.archive({ id: field.id, archived: false }))}
                      >
                        Show
                      </Button>
                      <Tooltip content="Deletes the field and every value stored in it">
                        <Button
                          size="sm"
                          variant="danger"
                          icon={Trash2}
                          disabled={readOnly}
                          onClick={() => setPendingDelete(field)}
                        >
                          Delete
                        </Button>
                      </Tooltip>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text">Add a field</h3>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="New field name" className="min-w-48 flex-1">
                <Input value={label} disabled={readOnly} onChange={(event) => setLabel(event.target.value)} />
              </Field>
              <Field label="New field type" className="w-40">
                <Select
                  value={type}
                  options={TYPE_OPTIONS}
                  disabled={readOnly}
                  onValueChange={(next) => {
                    if (next !== null) setType(next as FieldType);
                  }}
                />
              </Field>
              {type === 'select' && (
                <Field label="Choices" hint="Separate the choices with commas." className="min-w-48 flex-1">
                  <Input value={options} disabled={readOnly} onChange={(event) => setOptions(event.target.value)} />
                </Field>
              )}
              <Button
                variant="primary"
                icon={Plus}
                disabled={readOnly || label.trim() === ''}
                onClick={() => void create()}
              >
                Add
              </Button>
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete “${pendingDelete?.label ?? ''}” and all of its values?`}
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </Pane>
  );
}

interface FieldRowProps {
  field: FieldDef;
  readOnly: boolean;
  first: boolean;
  last: boolean;
  run(work: Work): Promise<void>;
  onMove(delta: number): void;
  onHide(): void;
}

/**
 * One active field. The name and the choices are edited in place and saved when the box loses focus or Enter is
 * pressed, so a rename is one write rather than one per keystroke. The inputs are uncontrolled and keyed by the
 * stored value: when a save lands and the value changes, that input remounts showing what was stored.
 */
function FieldRow({ field, readOnly, first, last, run, onMove, onHide }: FieldRowProps) {
  const choices = (field.options ?? []).join(', ');
  const searchableId = `searchable-${field.id}`;

  const rename = (text: string) => {
    if (text.trim() === field.label) return;
    void run(() => api.fields.update({ id: field.id, patch: { label: text } }));
  };

  const changeChoices = (text: string) => {
    const next = parseChoices(text);
    if (next.join(', ') === choices) return;
    void run(() => api.fields.update({ id: field.id, patch: { options: next } }));
  };

  return (
    <li className="flex flex-col gap-3 rounded-md border border-border bg-bg-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          key={field.label}
          defaultValue={field.label}
          disabled={readOnly}
          aria-label={`Name of the ${field.label} field`}
          className="min-w-40 flex-1 font-medium"
          onBlur={(event) => rename(event.currentTarget.value)}
          onKeyDown={blurOnEnter}
        />
        <code data-testid="field-key" className={keyClass}>
          {field.key}
        </code>
        <Select
          value={field.type}
          options={TYPE_OPTIONS}
          disabled={readOnly}
          aria-label={`Type of the ${field.label} field`}
          className="w-36"
          onValueChange={(next) => {
            if (next !== null && next !== field.type) {
              void run(() => api.fields.update({ id: field.id, patch: { type: next as FieldType } }));
            }
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {field.type === 'select' && (
          <Input
            key={choices}
            defaultValue={choices}
            disabled={readOnly}
            placeholder="Choices, comma separated"
            aria-label={`Choices of the ${field.label} field`}
            className="min-w-48 flex-1"
            onBlur={(event) => changeChoices(event.currentTarget.value)}
            onKeyDown={blurOnEnter}
          />
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id={searchableId}
            checked={field.searchable}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              void run(() => api.fields.update({ id: field.id, patch: { searchable: checked } }))
            }
          />
          <Label htmlFor={searchableId}>Searchable</Label>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={ArrowUp}
            label={`Move the ${field.label} field up`}
            size="sm"
            disabled={readOnly || first}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon={ArrowDown}
            label={`Move the ${field.label} field down`}
            size="sm"
            disabled={readOnly || last}
            onClick={() => onMove(1)}
          />
          <Tooltip content="Hides the field from forms but keeps every value">
            <Button size="sm" variant="ghost" icon={EyeOff} disabled={readOnly} onClick={onHide}>
              Hide
            </Button>
          </Tooltip>
        </div>
      </div>
    </li>
  );
}

/** "red, green,, blue" becomes ["red", "green", "blue"]: blanks are dropped, so a stray comma is harmless. */
function parseChoices(text: string): string[] {
  return text
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);
}

/** Enter commits a text box the same way leaving it does, so nothing needs a separate Save button. */
function blurOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') event.currentTarget.blur();
}
