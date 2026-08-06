/**
 * The shell: which screen is showing, what is selected, and the toast that
 * makes a deletion undoable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Item, ItemRow, SortDirection, SortKey } from '@shared/types';
import { api, onMenuCommand } from './state/api.js';
import { useDataVersion, useDebounced, useFields, useLibraryState } from './state/useLibrary.js';
import { Onboarding } from './screens/Onboarding.js';
import { ItemList } from './screens/ItemList.js';
import { ItemDetail } from './screens/ItemDetail.js';
import { Trash } from './screens/Trash.js';
import { Fields } from './screens/Fields.js';
import { Settings } from './screens/Settings.js';

type View = 'items' | 'trash' | 'fields' | 'settings';

interface Toast {
  message: string;
  undo?: () => void;
}

export function App() {
  const { state } = useLibraryState();
  const dataVersion = useDataVersion();
  const fields = useFields(dataVersion);

  const [view, setView] = useState<View>('items');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast | null>(null);
  const [localVersion, setLocalVersion] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounced(query, 200);
  const ready = state?.status === 'ready';
  const readOnly = Boolean(state?.readOnly);

  const bump = useCallback(() => setLocalVersion((current) => current + 1), []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    // Only show "Loading…" if the query is actually slow. Most are instant, and
    // a flash of loading state on every keystroke reads as jitter.
    const slow = setTimeout(() => {
      if (!cancelled) setLoading(true);
    }, 120);

    void api.items
      .list({ query: debouncedQuery, sort, direction, limit: 500 })
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      })
      .finally(() => clearTimeout(slow));

    return () => {
      cancelled = true;
      clearTimeout(slow);
    };
  }, [ready, debouncedQuery, sort, direction, dataVersion, localVersion]);

  // The selection follows the list rather than being corrected after the fact:
  // an id that has just been filtered out or trashed simply is not the selection
  // any more, and there is no intermediate render where it still is.
  const selected = selectedId && items.some((item) => item.id === selectedId) ? selectedId : (items[0]?.id ?? null);

  const createItem = useCallback(async () => {
    const item = await api.items.create({ name: 'New item' });
    bump();
    setView('items');
    setSelectedId(item.id);
  }, [bump]);

  useEffect(() => {
    if (!ready) return;
    const unsubscribes = [
      onMenuCommand('menu:new-item', () => void createItem()),
      onMenuCommand('menu:focus-search', () => {
        setView('items');
        searchRef.current?.focus();
        searchRef.current?.select();
      }),
      onMenuCommand('menu:view-items', () => setView('items')),
      onMenuCommand('menu:view-trash', () => setView('trash')),
      onMenuCommand('menu:view-fields', () => setView('fields')),
      onMenuCommand('menu:settings', () => setView('settings')),
      onMenuCommand('menu:verify', () => setView('settings')),
      onMenuCommand('menu:reveal-library', () => void api.library.reveal()),
      onMenuCommand('menu:change-library', () => void api.library.choose()),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [ready, createItem]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  const onTrashed = (item: Item) => {
    bump();
    setToast({
      message: `“${item.name}” moved to the trash.`,
      undo: () => {
        void api.items.restore({ id: item.id }).then(() => {
          bump();
          setSelectedId(item.id);
          setToast(null);
        });
      },
    });
  };

  if (!state) return <main className="loading">Opening…</main>;
  if (state.status !== 'ready') return <Onboarding state={state} />;

  return (
    <div className="app">
      <nav className="sidebar-nav">
        <span className="brand">Mindex</span>
        <button type="button" className={view === 'items' ? 'active' : ''} onClick={() => setView('items')}>
          Items
        </button>
        <button type="button" className={view === 'trash' ? 'active' : ''} onClick={() => setView('trash')}>
          Trash
        </button>
        <button type="button" className={view === 'fields' ? 'active' : ''} onClick={() => setView('fields')}>
          Fields
        </button>
        <span className="spacer" />
        <button type="button" className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
          Settings
        </button>
      </nav>

      {readOnly && (
        <div className="banner" role="status">
          {state.readOnlyReason} —{' '}
          <button type="button" className="link" onClick={() => setView('settings')}>
            details
          </button>
        </div>
      )}

      {view === 'items' && (
        <div className="split">
          <aside className="sidebar">
            <div className="sidebar-actions">
              <button type="button" className="primary" disabled={readOnly} onClick={() => void createItem()}>
                New item
              </button>
            </div>
            <ItemList
              ref={searchRef}
              items={items}
              selectedId={selected}
              query={query}
              sort={sort}
              direction={direction}
              loading={loading}
              onQueryChange={setQuery}
              onSortChange={(nextSort, nextDirection) => {
                setSort(nextSort);
                setDirection(nextDirection);
              }}
              onSelect={setSelectedId}
            />
          </aside>

          {selected ? (
            <ItemDetail
              key={selected}
              itemId={selected}
              fields={fields}
              dataVersion={dataVersion}
              readOnly={readOnly}
              onTrashed={onTrashed}
              onChanged={bump}
            />
          ) : (
            <section className="detail empty">
              <p className="empty-state">Select an item, or make a new one.</p>
            </section>
          )}
        </div>
      )}

      {view === 'trash' && <Trash dataVersion={dataVersion} readOnly={readOnly} onRestored={bump} />}
      {view === 'fields' && <Fields fields={fields} readOnly={readOnly} onChanged={bump} />}
      {view === 'settings' && <Settings state={state} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button type="button" className="link" onClick={toast.undo}>
              Undo
            </button>
          )}
          <button type="button" className="ghost small" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
