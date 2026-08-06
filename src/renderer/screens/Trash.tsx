/**
 * The trash.
 *
 * There is no "empty trash" button on purpose: emptying it means deleting
 * files, and this app does not do that. The reveal button is the answer —
 * the user prunes `deleted/` in Finder or Explorer, deliberately.
 */

import { useEffect, useState } from 'react';
import type { TrashRow } from '@shared/types';
import { api } from '../state/api.js';
import { absoluteTime, relativeTime } from '../components/format.js';

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
    <section className="pane">
      <header className="pane-header">
        <h2>Trash</h2>
        <p className="muted">
          Nothing here has been deleted. Each item&rsquo;s folder was moved into <code>deleted/</code>, where it
          stays until you remove it yourself.
        </p>
      </header>

      <input
        type="search"
        className="search"
        placeholder="Search the trash"
        value={query}
        aria-label="Search the trash"
        onChange={(event) => setQuery(event.target.value)}
      />

      {error && <p className="error">{error}</p>}

      {rows.length === 0 ? (
        <p className="empty-state">{query ? 'Nothing matches.' : 'The trash is empty.'}</p>
      ) : (
        <ul className="trash-list">
          {rows.map((row) => (
            <li key={row.id}>
              <div>
                <span className="row-name">{row.name}</span>
                <span className="muted" title={absoluteTime(row.deletedAt)}>
                  {' '}
                  deleted {relativeTime(row.deletedAt)}
                </span>
                {row.deletedPath && <code className="folder">deleted/{row.deletedPath}</code>}
              </div>
              <div className="row">
                <button type="button" disabled={readOnly} onClick={() => void restore(row)}>
                  Restore
                </button>
                <button type="button" className="ghost" onClick={() => void api.items.revealFolder({ id: row.id })}>
                  Reveal folder
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
