/**
 * The item list: search, sort, and one row per item. The rows are buttons in a plain list, so Tab moves between them
 * and Enter or Space opens one. A listbox would promise arrow-key movement, which this list does not implement.
 */

import { ArrowDown, ArrowUp, Paperclip, Search } from 'lucide-react';
import type { Ref } from 'react';
import type { ItemRow, SortDirection, SortKey } from '@shared/types';
import { absoluteTime, relativeTime } from '../components/format.js';
import { Badge, IconButton, Input, Select, type SelectOption } from '../components/ui/index.js';

interface ItemListProps {
  items: ItemRow[];
  selectedId: string | null;
  query: string;
  sort: SortKey;
  direction: SortDirection;
  loading: boolean;
  onQueryChange(query: string): void;
  onSortChange(sort: SortKey, direction: SortDirection): void;
  onSelect(id: string): void;
  /** The search box, so the shell can focus it. React 19 passes ref as an ordinary prop, so no forwardRef is needed. */
  ref?: Ref<HTMLInputElement>;
}

/** Names read A–Z or Z–A, so their label follows the direction. Dates are told apart by the arrow beside the select. */
function sortOptions(direction: SortDirection): SelectOption[] {
  const order = direction === 'asc' ? 'A–Z' : 'Z–A';
  return [
    { value: 'updatedAt', label: 'Last updated' },
    { value: 'name', label: `Name ${order}` },
    { value: 'manufacturer', label: `Manufacturer ${order}` },
    { value: 'createdAt', label: 'Created' },
  ];
}

export function ItemList({
  items,
  selectedId,
  query,
  sort,
  direction,
  loading,
  onQueryChange,
  onSortChange,
  onSelect,
  ref,
}: ItemListProps) {
  const ascending = direction === 'asc';
  const emptyMessage = loading
    ? 'Loading…'
    : query
      ? `Nothing matches “${query}”.`
      : 'No items yet. Add your first one.';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted"
          />
          <Input
            ref={ref}
            type="search"
            placeholder="Search"
            aria-label="Search items"
            value={query}
            className="pl-8"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onQueryChange('');
            }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            aria-label="Sort by"
            value={sort}
            options={sortOptions(direction)}
            className="min-w-0 flex-1"
            onValueChange={(next) => {
              if (next !== null) onSortChange(next as SortKey, direction);
            }}
          />
          <IconButton
            icon={ascending ? ArrowUp : ArrowDown}
            label={ascending ? 'Sort ascending' : 'Sort descending'}
            className="border border-transparent bg-transparent p-0"
            onClick={() => onSortChange(sort, ascending ? 'desc' : 'asc')}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <p data-testid="list-empty" className="px-4 py-6 text-sm text-text-muted">
          {emptyMessage}
        </p>
      ) : (
        <ul aria-label="Items" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {items.map((item) => (
            <ItemRowButton key={item.id} item={item} current={item.id === selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ItemRowButtonProps {
  item: ItemRow;
  current: boolean;
  onSelect(id: string): void;
}

/** One item. The name and update time sit on the first line; the open item is filled. */
function ItemRowButton({ item, current, onSelect }: ItemRowButtonProps) {
  const attachments = item.attachmentCount === 1 ? '1 attachment' : `${item.attachmentCount} attachments`;

  return (
    <li>
      <button
        type="button"
        data-testid="item-row"
        aria-current={current ? 'true' : undefined}
        onClick={() => onSelect(item.id)}
        className="group flex w-full min-w-0 flex-col gap-0.5 rounded-md border border-transparent bg-transparent px-2.5 py-2 text-left hover:bg-bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[current=true]:bg-accent aria-[current=true]:text-accent-text aria-[current=true]:hover:bg-accent"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span data-testid="item-row-name" className="min-w-0 flex-1 truncate font-medium">
            {item.name}
          </span>
          <time
            dateTime={item.updatedAt}
            title={absoluteTime(item.updatedAt)}
            className="shrink-0 text-sm text-text-muted group-aria-[current=true]:text-accent-text"
          >
            {relativeTime(item.updatedAt)}
          </time>
        </span>
        {item.manufacturer || item.attachmentCount > 0 ? (
          <span className="flex min-w-0 items-center gap-2 text-sm text-text-muted group-aria-[current=true]:text-accent-text">
            {item.manufacturer ? <span className="min-w-0 flex-1 truncate">{item.manufacturer}</span> : null}
            {item.attachmentCount > 0 ? (
              <Badge className="shrink-0" title={attachments}>
                <Paperclip aria-hidden="true" className="size-3.5" />
                <span aria-hidden="true">{item.attachmentCount}</span>
                <span className="sr-only">{attachments}</span>
              </Badge>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}
