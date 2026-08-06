/**
 * The item list: search, sort, and one row per item.
 */

import { forwardRef } from 'react';
import type { ItemRow, SortDirection, SortKey } from '@shared/types';
import { absoluteTime, relativeTime } from '../components/format.js';

interface Props {
  items: ItemRow[];
  selectedId: string | null;
  query: string;
  sort: SortKey;
  direction: SortDirection;
  loading: boolean;
  onQueryChange(query: string): void;
  onSortChange(sort: SortKey, direction: SortDirection): void;
  onSelect(id: string): void;
}

export const ItemList = forwardRef<HTMLInputElement, Props>(function ItemList(
  { items, selectedId, query, sort, direction, loading, onQueryChange, onSortChange, onSelect },
  searchRef,
) {
  return (
    <div className="item-list">
      <div className="list-controls">
        <input
          ref={searchRef}
          type="search"
          className="search"
          placeholder="Search"
          value={query}
          aria-label="Search items"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onQueryChange('');
          }}
        />
        <select
          className="sort"
          aria-label="Sort by"
          value={`${sort}:${direction}`}
          onChange={(event) => {
            const [nextSort, nextDirection] = event.target.value.split(':');
            onSortChange(nextSort as SortKey, nextDirection as SortDirection);
          }}
        >
          <option value="updatedAt:desc">Last update</option>
          <option value="name:asc">Name A–Z</option>
          <option value="name:desc">Name Z–A</option>
          <option value="manufacturer:asc">Manufacturer</option>
          <option value="createdAt:desc">Newest first</option>
        </select>
      </div>

      {items.length === 0 ? (
        <p className="empty-state">
          {loading ? 'Loading…' : query ? `Nothing matches “${query}”.` : 'No items yet. Add your first one.'}
        </p>
      ) : (
        <ul role="listbox" aria-label="Items">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={item.id === selectedId}
                className={item.id === selectedId ? 'row selected' : 'row'}
                onClick={() => onSelect(item.id)}
              >
                <span className="row-name">{item.name}</span>
                <span className="row-meta">
                  {item.manufacturer && <span className="manufacturer">{item.manufacturer}</span>}
                  {item.attachmentCount > 0 && (
                    <span className="badge" title={`${item.attachmentCount} attachment(s)`}>
                      {item.attachmentCount}
                    </span>
                  )}
                  <span className="updated" title={absoluteTime(item.updatedAt)}>
                    {relativeTime(item.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
