/**
 * The item detail pane.
 *
 * Autosaves on blur. No modal editing, and no dialog that could swallow what
 * the user just typed — including when another machine has edited the same item,
 * which surfaces as an inline panel offering both values side by side.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, Conflict, FieldDef, FieldValue, Item, ItemPatch } from '@shared/types';
import { api, pathsForDrop } from '../state/api.js';
import { absoluteTime, fileSize, relativeTime } from '../components/format.js';
import { FieldInput } from '../components/FieldInput.js';

interface Props {
  itemId: string;
  fields: FieldDef[];
  dataVersion: number;
  readOnly: boolean;
  onTrashed(item: Item): void;
  onChanged(): void;
}

type Draft = { name: string; manufacturer: string; notes: string; fields: Record<string, FieldValue> };

function draftOf(item: Item): Draft {
  return {
    name: item.name,
    manufacturer: item.manufacturer ?? '',
    notes: item.notes ?? '',
    fields: { ...item.fields },
  };
}

export function ItemDetail({ itemId, fields, dataVersion, readOnly, onTrashed, onChanged }: Props) {
  const [item, setItem] = useState<Item | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [dropping, setDropping] = useState(false);

  // What the form started from. Sent with the save so that a rev clash can be
  // resolved as a three-way merge instead of an argument.
  const base = useRef<Draft | null>(null);
  const dirty = useRef(false);

  /**
   * Mirrors of the two pieces of state that `save` needs.
   *
   * A blur can land in the same tick as the keystroke before it, ahead of the
   * re-render — type and tab away quickly and a `save` reading `draft` from its
   * closure would write the *previous* value and then mark the form clean,
   * losing the edit. Refs are always current, so the save always writes what is
   * actually in the form.
   */
  const draftRef = useRef<Draft | null>(null);
  const itemRef = useRef<Item | null>(null);

  const applyItem = useCallback((next: Item | null) => {
    itemRef.current = next;
    setItem(next);
  }, []);

  const applyDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const load = useCallback(async () => {
    const next = await api.items.get(itemId);
    applyItem(next);
    if (next && !dirty.current) {
      const fresh = draftOf(next);
      applyDraft(fresh);
      base.current = fresh;
    }
  }, [itemId, applyItem, applyDraft]);

  /**
   * Load on mount, and again whenever anything commits — this window's own
   * write or another machine's, which from here are the same event. `load`
   * leaves a mid-edit draft alone, so a background refresh never eats typing.
   *
   * There is no per-item reset here because App keys this component by item id:
   * select a different item and React gives us a fresh component, fresh state.
   */
  useEffect(() => {
    // load() is async, so every setState it performs happens after an await
    // rather than during this render; the rule cannot see through the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [dataVersion, load]);

  const save = useCallback(async () => {
    const current = itemRef.current;
    const pending = draftRef.current;
    if (!current || !pending || !dirty.current || readOnly) return;
    dirty.current = false;
    setError(null);

    const patch: ItemPatch = {
      name: pending.name,
      manufacturer: pending.manufacturer,
      notes: pending.notes,
    };

    try {
      const result = await api.items.update({
        id: current.id,
        rev: current.rev,
        patch,
        fields: pending.fields,
        base: base.current
          ? {
              name: base.current.name,
              manufacturer: base.current.manufacturer,
              notes: base.current.notes,
              fields: base.current.fields,
            }
          : undefined,
      });

      if ('conflict' in result && result.conflict) {
        setConflict(result);
        return;
      }

      applyItem(result.item);
      base.current = draftOf(result.item);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [readOnly, onChanged, applyItem]);

  const edit = (patch: Partial<Draft>) => {
    dirty.current = true;
    if (draftRef.current) applyDraft({ ...draftRef.current, ...patch });
  };

  const editField = (key: string, value: FieldValue) => {
    dirty.current = true;
    if (draftRef.current) {
      applyDraft({ ...draftRef.current, fields: { ...draftRef.current.fields, [key]: value } });
    }
  };

  const resolveConflict = async (keep: 'mine' | 'theirs') => {
    if (!conflict) return;
    if (keep === 'theirs') {
      const fresh = draftOf(conflict.current);
      applyItem(conflict.current);
      applyDraft(fresh);
      base.current = fresh;
      setConflict(null);
      return;
    }
    // Keep mine: rebase onto what is stored now and save again.
    applyItem(conflict.current);
    base.current = draftOf(conflict.current);
    setConflict(null);
    dirty.current = true;
    await save();
  };

  const addFiles = async (paths?: string[]) => {
    try {
      await api.attachments.add({ itemId, paths });
      await load();
      onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const removeAttachment = async (attachment: Attachment) => {
    try {
      await api.attachments.remove({ attachmentId: attachment.id });
      await load();
      onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const trash = async () => {
    if (!item) return;
    const result = await api.items.trash({ id: item.id, rev: item.rev });
    if (!result.ok) {
      setError(result.error ?? 'Could not move that to the trash.');
      await load();
      return;
    }
    onTrashed(item);
  };

  if (!item || !draft) return <section className="detail empty">Loading…</section>;

  const visibleFields = fields.filter((field) => field.archivedAt === null);
  const folderMatches = item.slug === slugPreview(draft.name);

  return (
    <section
      className={`detail${dropping ? ' dropping' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        const paths = pathsForDrop(event.dataTransfer.files);
        if (paths.length > 0) void addFiles(paths);
      }}
    >
      <header className="detail-header">
        <input
          className="title-input"
          value={draft.name}
          disabled={readOnly}
          aria-label="Name"
          onChange={(event) => edit({ name: event.target.value })}
          onBlur={save}
        />
        <div className="detail-meta">
          <span title={absoluteTime(item.updatedAt)}>Updated {relativeTime(item.updatedAt)}</span>
          {item.updatedBy && <span className="muted"> by {item.updatedBy}</span>}
          {saved && <span className="saved">Saved</span>}
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {conflict && (
        <div className="conflict">
          <p>
            <strong>Another copy of Mindex changed this while you were editing.</strong> Nothing has been overwritten.
            The fields that disagree are: {conflict.overlapping.join(', ')}.
          </p>
          <div className="conflict-columns">
            <div>
              <h4>Theirs (saved)</h4>
              <pre>{summarize(conflict.current, conflict.overlapping)}</pre>
            </div>
            <div>
              <h4>Yours (not saved)</h4>
              <pre>{summarizeDraft(draft, conflict.overlapping)}</pre>
            </div>
          </div>
          <div className="row">
            <button type="button" onClick={() => resolveConflict('mine')}>
              Keep mine
            </button>
            <button type="button" className="ghost" onClick={() => resolveConflict('theirs')}>
              Keep theirs
            </button>
          </div>
        </div>
      )}

      <div className="fields">
        <label htmlFor="manufacturer">Manufacturer</label>
        <input
          id="manufacturer"
          value={draft.manufacturer}
          disabled={readOnly}
          onChange={(event) => edit({ manufacturer: event.target.value })}
          onBlur={save}
        />

        {visibleFields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            value={draft.fields[field.key] ?? null}
            disabled={readOnly}
            onChange={(value) => editField(field.key, value)}
            onCommit={save}
          />
        ))}

        <label htmlFor="notes">Notes</label>
        <textarea
          id="notes"
          rows={5}
          value={draft.notes}
          disabled={readOnly}
          onChange={(event) => edit({ notes: event.target.value })}
          onBlur={save}
        />
      </div>

      <section className="attachments">
        <h3>
          Attachments <span className="count">{item.attachments.length}</span>
        </h3>
        {item.attachments.length === 0 ? (
          <p className="muted">Nothing yet. Drop files here, or use the button below.</p>
        ) : (
          <ul>
            {item.attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  type="button"
                  className="link filename"
                  onClick={() => void api.attachments.open({ attachmentId: attachment.id })}
                >
                  {attachment.filename}
                </button>
                <span className="muted size">{fileSize(attachment.sizeBytes)}</span>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void api.attachments.reveal({ attachmentId: attachment.id })}
                >
                  Reveal
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={readOnly}
                  title="Removes it from the list and moves the file into deleted/"
                  onClick={() => void removeAttachment(attachment)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button type="button" disabled={readOnly} onClick={() => void addFiles()}>
            Add attachment…
          </button>
          <button type="button" className="ghost" onClick={() => void api.items.revealFolder({ id: item.id })}>
            Reveal item folder
          </button>
        </div>
      </section>

      <footer className="detail-footer">
        <p className="muted folder" title={item.folderPath}>
          Folder: <code>data/{item.slug}</code>
          {!folderMatches && (
            <button
              type="button"
              className="link"
              disabled={readOnly}
              title="The folder keeps its original name when an item is renamed. This moves it."
              onClick={async () => {
                await api.items.renameFolder({ id: item.id });
                await load();
                onChanged();
              }}
            >
              rename folder to match
            </button>
          )}
        </p>
        <button type="button" className="danger" disabled={readOnly} onClick={trash}>
          Move to trash
        </button>
      </footer>
    </section>
  );
}

function FieldRow({
  field,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  field: FieldDef;
  value: FieldValue;
  disabled: boolean;
  onChange(value: FieldValue): void;
  onCommit(): void;
}) {
  return (
    <>
      <label htmlFor={`field-${field.key}`}>{field.label}</label>
      <FieldInput field={field} value={value} disabled={disabled} onChange={onChange} onCommit={onCommit} />
    </>
  );
}

function summarize(item: Item, keys: string[]): string {
  return keys.map((key) => `${key}: ${String(readKey(item, key) ?? '')}`).join('\n');
}

function summarizeDraft(draft: Draft, keys: string[]): string {
  return keys
    .map((key) => {
      const own = (draft as unknown as Record<string, unknown>)[key];
      return `${key}: ${String(own ?? draft.fields[key] ?? '')}`;
    })
    .join('\n');
}

function readKey(item: Item, key: string): unknown {
  const own = (item as unknown as Record<string, unknown>)[key];
  return own ?? item.fields[key];
}

/**
 * Mirrors the main process's slug rules closely enough to decide whether to
 * offer the "rename folder" action. The main process still computes the real
 * name — this is a hint, not a decision.
 */
function slugPreview(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug === '' ? 'item' : slug;
}
