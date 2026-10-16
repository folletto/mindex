/**
 * The item detail pane.
 *
 * Autosaves on blur. No modal editing, and no dialog that could swallow what
 * the user just typed — including when another machine has edited the same item,
 * which surfaces as an inline panel offering both values side by side.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, FilePlus, FolderOpen, FolderSearch, FolderSync, Paperclip, Trash2, X } from 'lucide-react';
import type { Attachment, Conflict, FieldDef, FieldValue, Item, ItemPatch } from '@shared/types';
import { api, pathsForDrop } from '../state/api.js';
import { absoluteTime, fileSize, relativeTime } from '../components/format.js';
import { FieldInput } from '../components/FieldInput.js';
import { Badge, Banner, Button, Field, Input, Pane, Textarea } from '../components/ui/index.js';
import { cn } from '../lib/cn.js';

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
  const attachmentsHeading = useId();

  // What the form started from, and the revision it was read at. Sent with the save so that a rev clash can be
  // resolved as a three-way merge instead of an argument. The revision lives here rather than on `item`: a refresh
  // that lands mid-edit moves `item` on to the other writer's revision, and a save conditioned on that one would
  // skip the merge and overwrite what they changed.
  const base = useRef<{ rev: number; draft: Draft } | null>(null);
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
      base.current = { rev: next.rev, draft: fresh };
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

    const started = base.current;
    try {
      const result = await api.items.update({
        id: current.id,
        rev: started ? started.rev : current.rev,
        patch,
        fields: pending.fields,
        base: started
          ? {
              name: started.draft.name,
              manufacturer: started.draft.manufacturer,
              notes: started.draft.notes,
              fields: started.draft.fields,
            }
          : undefined,
      });

      if ('conflict' in result && result.conflict) {
        // The draft still holds edits the store does not have, so it is dirty again. Otherwise a refresh that lands
        // while the conflict is showing would replace the very values the user is being asked to choose between.
        dirty.current = true;
        setConflict(result);
        return;
      }

      applyItem(result.item);
      base.current = { rev: result.item.rev, draft: draftOf(result.item) };
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
      base.current = { rev: conflict.current.rev, draft: fresh };
      // The form now shows what is stored, so there is nothing left to save.
      dirty.current = false;
      setConflict(null);
      return;
    }
    // Keep mine: rebase onto what is stored now and save again.
    applyItem(conflict.current);
    base.current = { rev: conflict.current.rev, draft: draftOf(conflict.current) };
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
    try {
      const result = await api.items.trash({ id: item.id, rev: item.rev });
      if (!result.ok) {
        setError(result.error ?? 'Could not move that to the trash.');
        await load();
        return;
      }
      onTrashed(item);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const renameFolder = async () => {
    if (!item) return;
    try {
      await api.items.renameFolder({ id: item.id });
      await load();
      onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  if (!item || !draft) {
    return <Pane className="items-center justify-center text-sm text-text-muted">Loading…</Pane>;
  }

  const visibleFields = fields.filter((field) => field.archivedAt === null);
  const folderMatches = item.slug === slugPreview(draft.name);

  return (
    <Pane
      className={cn('overflow-y-auto', dropping && 'outline-2 -outline-offset-2 outline-accent outline-dashed')}
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
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
        <div className="flex flex-col gap-1">
          <Input
            data-testid="item-title"
            aria-label="Name"
            value={draft.name}
            disabled={readOnly}
            onChange={(event) => edit({ name: event.target.value })}
            onBlur={save}
            className="-ml-1.5 h-auto border-transparent bg-transparent px-1.5 py-1 text-2xl font-semibold enabled:hover:border-border"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
            <p data-testid="item-meta" className="flex flex-wrap gap-x-2">
              <span title={absoluteTime(item.updatedAt)}>Updated {relativeTime(item.updatedAt)}</span>
              {item.updatedBy && <span>by {item.updatedBy}</span>}
            </p>
            <span role="status" className="inline-flex items-center gap-1 font-medium text-ok">
              {saved && (
                <>
                  <Check aria-hidden="true" className="size-3.5" />
                  Saved
                </>
              )}
            </span>
          </div>
        </div>

        {error && <Banner tone="danger">{error}</Banner>}

        {conflict && (
          <Banner tone="warning">
            <div className="flex flex-col gap-3">
              <p>
                <strong className="font-semibold">Another copy of Mindex changed this while you were editing.</strong>{' '}
                Nothing has been overwritten. The fields that disagree are: {conflict.overlapping.join(', ')}.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">Theirs (saved)</p>
                  <pre className="rounded-md bg-bg-sunken p-2 font-mono text-sm break-words whitespace-pre-wrap text-text">
                    {summarize(conflict.current, conflict.overlapping)}
                  </pre>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">Yours (not saved)</p>
                  <pre className="rounded-md bg-bg-sunken p-2 font-mono text-sm break-words whitespace-pre-wrap text-text">
                    {summarizeDraft(draft, conflict.overlapping)}
                  </pre>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void resolveConflict('mine')}>
                  Keep mine
                </Button>
                <Button onClick={() => void resolveConflict('theirs')}>Keep theirs</Button>
              </div>
            </div>
          </Banner>
        )}

        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
          <Field label="Manufacturer">
            <Input
              value={draft.manufacturer}
              disabled={readOnly}
              onChange={(event) => edit({ manufacturer: event.target.value })}
              onBlur={save}
            />
          </Field>

          {visibleFields.map((field) => (
            <Field key={field.id} label={field.label} className={cn(field.type === 'longtext' && 'sm:col-span-2')}>
              <FieldInput
                field={field}
                value={draft.fields[field.key] ?? null}
                disabled={readOnly}
                onChange={(value) => editField(field.key, value)}
                onCommit={save}
              />
            </Field>
          ))}

          <Field label="Notes" className="sm:col-span-2">
            <Textarea
              rows={5}
              value={draft.notes}
              disabled={readOnly}
              onChange={(event) => edit({ notes: event.target.value })}
              onBlur={save}
            />
          </Field>
        </div>

        <section
          aria-labelledby={attachmentsHeading}
          className="flex flex-col gap-3 rounded-md border border-border bg-bg-raised p-4"
        >
          <h2 id={attachmentsHeading} className="flex items-center gap-2 text-sm font-semibold text-text">
            Attachments
            <Badge>{item.attachments.length}</Badge>
          </h2>
          {item.attachments.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing yet. Drop files here, or use Add attachment….</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {item.attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5"
                >
                  <Paperclip aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
                  <Button
                    variant="link"
                    data-testid="attachment-name"
                    title={attachment.filename}
                    className="min-w-0 flex-1 shrink justify-start text-left"
                    onClick={() => void api.attachments.open({ attachmentId: attachment.id })}
                  >
                    <span className="min-w-0 truncate">{attachment.filename}</span>
                  </Button>
                  <span className="shrink-0 text-sm text-text-muted">{fileSize(attachment.sizeBytes)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={FolderSearch}
                    aria-label={`Reveal ${attachment.filename}`}
                    onClick={() => void api.attachments.reveal({ attachmentId: attachment.id })}
                  >
                    Reveal
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    disabled={readOnly}
                    aria-label={`Remove ${attachment.filename}`}
                    title="Removes it from the list and moves the file into deleted/"
                    onClick={() => void removeAttachment(attachment)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button icon={FilePlus} disabled={readOnly} onClick={() => void addFiles()}>
              Add attachment…
            </Button>
            <Button variant="ghost" icon={FolderOpen} onClick={() => void api.items.revealFolder({ id: item.id })}>
              Reveal item folder
            </Button>
          </div>
        </section>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p
            title={item.folderPath}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted"
          >
            <span>Folder:</span>
            <code data-testid="item-folder" className="font-mono text-text">
              data/{item.slug}
            </code>
            {!folderMatches && (
              <Button
                variant="link"
                size="sm"
                icon={FolderSync}
                disabled={readOnly}
                title="The folder keeps its original name when an item is renamed. This moves it."
                onClick={() => void renameFolder()}
              >
                rename folder to match
              </Button>
            )}
          </p>
          <Button variant="danger" icon={Trash2} disabled={readOnly} onClick={() => void trash()}>
            Move to trash
          </Button>
        </div>
      </div>
    </Pane>
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
