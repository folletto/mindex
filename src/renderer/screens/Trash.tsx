/**
 * The trash.
 *
 * There is no "empty trash" button on purpose: emptying it means deleting
 * files, and this app does not do that. The reveal button is the answer —
 * the user prunes `deleted/` in Finder or Explorer, deliberately.
 */

import { FolderOpen, RotateCcw, Search, SearchX, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TrashRow } from '@shared/types';
import { api } from '../state/api.js';
import { absoluteTime, relativeTime } from '../components/format.js';
import { Banner, Button, EmptyState, Input, Pane, PaneHeader } from '../components/ui/index.js';

interface Props {
  dataVersion: number;
  readOnly: boolean;
  onRestored(): void;
}

export function Trash({ dataVersion, readOnly, onRestored }: Props) {
  const [rows, setRows] = useState<TrashRow[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.items.listTrash({ query }).then((next) => {
      if (!cancelled) setRows(next);
    });
    return () => {
      cancelled = true;
    };
  }, [query, dataVersion]);

  const restore = async (row: TrashRow) => {
    setError(null);
    try {
      await api.items.restore({ id: row.id });
      onRestored();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <Pane>
      <PaneHeader
        title="Trash"
        titleTestId="pane-title"
        description={
          <>
            Each item&rsquo;s folder was moved into <code>deleted/</code>, where it stays until you remove it
            yourself.
          </>
        }
      />

      <div className="shrink-0 border-b border-border p-3">
        <div className="relative max-w-sm">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="search"
            className="pl-8"
            placeholder="Search the trash"
            value={query}
            aria-label="Search the trash"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
          {error && <Banner tone="danger">{error}</Banner>}

          {rows.length === 0 ? (
            <EmptyState
              icon={query ? SearchX : Trash2}
              title={query ? 'Nothing matches.' : 'The trash is empty.'}
              description={
                query
                  ? undefined
                  : 'Nothing here has been deleted. Trashed items appear here, and you can restore them.'
              }
              className="h-auto py-12"
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-bg-raised">
              {rows.map((row) => (
                <li
                  key={row.id}
                  data-testid="trash-row"
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span data-testid="trash-row-name" className="truncate font-medium text-text">
                      {row.name}
                    </span>
                    <span className="text-sm text-text-muted">
                      deleted{' '}
                      <time dateTime={row.deletedAt} title={absoluteTime(row.deletedAt)}>
                        {relativeTime(row.deletedAt)}
                      </time>
                    </span>
                    {row.deletedPath && (
                      <code className="truncate font-mono text-sm text-text-muted">deleted/{row.deletedPath}</code>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button icon={RotateCcw} disabled={readOnly} onClick={() => void restore(row)}>
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      icon={FolderOpen}
                      onClick={() => void api.items.revealFolder({ id: row.id })}
                    >
                      Reveal folder
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Pane>
  );
}
