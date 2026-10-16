/**
 * The control for one custom field, chosen by its type. The Field around it (in ItemDetail) supplies the label, and
 * each control takes its id and description from that Field, so the label names the control.
 *
 * Values leave here as the plain JS value the field's type implies; the main process is the one that decides
 * whether it is acceptable, so this is about offering the right control, not about validation.
 */

import { ExternalLink } from 'lucide-react';
import type { FieldDef, FieldValue } from '@shared/types';
import { api } from '../state/api.js';
import { Button, Checkbox, Input, Select, Textarea } from './ui/index.js';
import { useControlAttributes } from './ui/field-context.js';

interface Props {
  field: FieldDef;
  value: FieldValue;
  disabled?: boolean;
  onChange(value: FieldValue): void;
  onCommit(): void;
}

/** What a text-like control shows for a stored value: nothing for null, otherwise the value as text. */
function textOf(value: FieldValue): string {
  return value === null ? '' : String(value);
}

export function FieldInput({ field, value, disabled, onChange, onCommit }: Props) {
  // Input, Textarea and Select read the Field's id themselves. Checkbox does not, so its id and description are
  // taken from the Field here; without that its label would name nothing.
  const wiring = useControlAttributes({});

  switch (field.type) {
    case 'longtext':
      return (
        <Textarea
          rows={4}
          disabled={disabled}
          value={textOf(value)}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
        />
      );

    case 'number':
      return (
        <Input
          type="number"
          step="any"
          disabled={disabled}
          value={textOf(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          onBlur={onCommit}
        />
      );

    case 'date':
      return (
        <Input
          type="date"
          disabled={disabled}
          value={textOf(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          onBlur={onCommit}
        />
      );

    case 'boolean':
      return (
        <Checkbox
          id={wiring.id}
          aria-describedby={wiring['aria-describedby']}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(checked) => {
            onChange(checked);
            // A checkbox has no meaningful blur, so commit on the change itself.
            queueMicrotask(onCommit);
          }}
        />
      );

    case 'url':
      return (
        <div className="flex items-center gap-2">
          <Input
            type="url"
            inputMode="url"
            disabled={disabled}
            value={textOf(value)}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
            onBlur={onCommit}
          />
          {typeof value === 'string' && value !== '' && (
            <Button
              size="sm"
              variant="ghost"
              icon={ExternalLink}
              title="Open in your browser"
              onClick={() => void api.app.openExternal(value)}
            >
              Open
            </Button>
          )}
        </div>
      );

    case 'select':
      return (
        <Select
          disabled={disabled}
          value={value === null ? null : String(value)}
          options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
          emptyLabel="—"
          onValueChange={(next) => {
            onChange(next);
            // Choosing from a list is the whole edit, so commit on the change itself.
            queueMicrotask(onCommit);
          }}
        />
      );

    default:
      return (
        <Input
          type="text"
          disabled={disabled}
          value={textOf(value)}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
        />
      );
  }
}
