/**
 * The shell: the navigation rail, which screen is showing, what is selected, and the read-only banner. A deletion
 * offers to undo itself through the toast from useToast, so the shell keeps no toast state of its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Package, Plus, Settings as SettingsIcon, SlidersHorizontal, Trash2, type LucideIcon } from 'lucide-react';
import type { Item, ItemRow, SortDirection, SortKey } from '@shared/types';
import { api, onMenuCommand } from './state/api.js';
import { useDataVersion, useDebounced, useFields, useLibraryState } from './state/useLibrary.js';
import { Banner, Button, EmptyState, Pane, useToast } from './components/ui/index.js';
import { Onboarding } from './screens/Onboarding.js';
import { ItemList } from './screens/ItemList.js';
import { ItemDetail } from './screens/ItemDetail.js';
import { Trash } from './screens/Trash.js';
import { Fields } from './screens/Fields.js';
import { Settings } from './screens/Settings.js';

type View = 'items' | 'trash' | 'fields' | 'settings';

/** The rail's destinations above Settings. Settings sits apart at the bottom. */
const RAIL_VIEWS: { view: Exclude<View, 'settings'>; label: string; icon: LucideIcon }[] = [
  { view: 'items', label: 'Items', icon: Package },
  { view: 'trash', label: 'Trash', icon: Trash2 },
  { view: 'fields', label: 'Fields', icon: SlidersHorizontal },
];

export function App() {
  const { state } = useLibraryState();
  const dataVersion = useDataVersion();
  const fields = useFields(dataVersion);
  const toast = useToast();

  const [view, setView] = useState<View>('items');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [loading, setLoading] = useState(true);
  const [localVersion, setLocalVersion] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounced(query, 200);
  const ready = state?.status === 'ready';
  const readOnly = Boolean(state?.readOnly);

  const bump = useCallback(() => setLocalVersion((current) => current + 1), []);

  /**
   * Reload the list. Returns the rows so a caller can select something it just
   * created without waiting for a render to come round.
   */
  const loadItems = useCallback(async (): Promise<ItemRow[]> => {
    // Only show "Loading…" if the query is actually slow. Most are instant, and
    // a flash of loading state on every keystroke reads as jitter.
    const slow = setTimeout(() => setLoading(true), 120);
    try {
      const next = await api.items.list({ query: debouncedQuery, sort, direction, limit: 500 });
      setItems(next);
      return next;
    } finally {
      clearTimeout(slow);
      setLoading(false);
    }
  }, [debouncedQuery, sort, direction]);

  useEffect(() => {
    if (!ready) return;
    void loadItems();
  }, [ready, loadItems, dataVersion, localVersion]);

  /**
   * An explicit selection always wins; the top of the list is only a fallback.
   *
   * Deliberately not "the selected id, but only if it is in the current list":
   * that version hands the detail pane back to the previous item for the render
   * between creating an item and the list catching up, and anything typed in
   * that window goes to the wrong record. The detail pane loads by id over IPC,
   * so it never needed the row to be in `items` anyway. The places where a
   * selection genuinely stops making sense — trashing it, changing the search —
   * clear it below, where the intent is obvious.
   */
  const selected = selectedId ?? items[0]?.id ?? null;

  const createItem = useCallback(async () => {
    const item = await api.items.create({ name: 'New item' });
    setView('items');
    setSelectedId(item.id);
    await loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (!ready) return;
    const unsubscribes = [
      onMenuCommand('menu:new-item', () => void createItem()),
      onMenuCommand('menu:focus-search', () => {
        // The search box exists only in the Items view. Switching synchronously means it is on screen to be focused.
        flushSync(() => setView('items'));
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

  const onTrashed = (item: Item) => {
    // The item is gone from the list, so the selection goes with it and the
    // fallback picks whatever is now at the top.
    setSelectedId(null);
    bump();
    toast.show({
      message: `“${item.name}” moved to the trash.`,
      actionLabel: 'Undo',
      onAction: () => {
        void api.items.restore({ id: item.id }).then(async () => {
          // Same ordering as createItem: the row has to be back in the list
          // before it can be the selection.
          await loadItems();
          setSelectedId(item.id);
        });
      },
    });
  };

  if (!state) {
    return <main className="flex h-screen items-center justify-center bg-bg text-text-muted">Opening…</main>;
  }
  if (state.status !== 'ready') return <Onboarding state={state} />;

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <nav aria-label="Main" className="flex w-40 shrink-0 flex-col border-r border-border bg-bg-sunken">
        {/* macOS hides the title bar: the traffic lights sit on this strip, which also drags the window. */}
        <div className="h-10 shrink-0 app-drag" />
        <div data-testid="brand" className="px-4 pb-3 text-base font-semibold">
          Mindex
        </div>
        <ul className="flex flex-col gap-0.5 px-2">
          {RAIL_VIEWS.map((entry) => (
            <li key={entry.view}>
              <NavButton
                icon={entry.icon}
                label={entry.label}
                current={view === entry.view}
                onSelect={() => setView(entry.view)}
              />
            </li>
          ))}
        </ul>
        <ul className="mt-auto px-2 pb-2">
          <li>
            <NavButton
              icon={SettingsIcon}
              label="Settings"
              current={view === 'settings'}
              onSelect={() => setView('settings')}
            />
          </li>
        </ul>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {readOnly ? (
          <Banner
            tone="warning"
            className="rounded-none border-0 border-b"
            action={
              <Button
                variant="link"
                size="sm"
                className="border border-transparent bg-transparent py-0"
                onClick={() => setView('settings')}
              >
                details
              </Button>
            }
          >
            {state.readOnlyReason ?? 'This library is read-only.'}
          </Banner>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === 'items' && (
            <div className="flex min-h-0 min-w-0 flex-1">
              <aside aria-label="Item list" className="flex w-80 shrink-0 flex-col border-r border-border bg-bg">
                <div className="border-b border-border p-3">
                  <Button
                    variant="primary"
                    icon={Plus}
                    className="w-full"
                    disabled={readOnly}
                    onClick={() => void createItem()}
                  >
                    New item
                  </Button>
                </div>
                <ItemList
                  ref={searchRef}
                  items={items}
                  selectedId={selected}
                  query={query}
                  sort={sort}
                  direction={direction}
                  loading={loading}
                  onQueryChange={(next) => {
                    setQuery(next);
                    // A selection the search has filtered away is not a selection.
                    setSelectedId(null);
                  }}
                  onSortChange={(nextSort, nextDirection) => {
                    setSort(nextSort);
                    setDirection(nextDirection);
                  }}
                  onSelect={setSelectedId}
                />
              </aside>

              <Pane>
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
                  <EmptyState icon={Package} title="Select an item, or make a new one." />
                )}
              </Pane>
            </div>
          )}

          {view === 'trash' && <Trash dataVersion={dataVersion} readOnly={readOnly} onRestored={bump} />}
          {view === 'fields' && <Fields fields={fields} readOnly={readOnly} onChanged={bump} />}
          {view === 'settings' && <Settings state={state} />}
        </main>
      </div>
    </div>
  );
}

interface NavButtonProps {
  icon: LucideIcon;
  label: string;
  current: boolean;
  onSelect(): void;
}

/**
 * One destination in the rail. The open one carries aria-current, and the styling keys off that same attribute, so
 * what is announced and what is shown cannot drift apart.
 */
function NavButton({ icon, label, current, onSelect }: NavButtonProps) {
  return (
    <Button
      variant="ghost"
      icon={icon}
      aria-current={current ? 'page' : undefined}
      onClick={onSelect}
      className="w-full justify-start border border-transparent bg-transparent px-2.5 hover:bg-bg-raised aria-[current=page]:border-border aria-[current=page]:bg-bg-raised aria-[current=page]:font-semibold"
    >
      {label}
    </Button>
  );
}
