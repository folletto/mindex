/**
 * Types shared across the process boundary.
 *
 * Everything here must be structured-clone-able: it travels over IPC.
 */

export const FIELD_TYPES = ['text', 'longtext', 'number', 'date', 'boolean', 'url', 'select'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldValue = string | number | boolean | null;

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  position: number;
  searchable: boolean;
  archivedAt: string | null;
}

export interface ItemRow {
  id: string;
  name: string;
  slug: string;
  manufacturer: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  rev: number;
  attachmentCount: number;
}

export interface Attachment {
  id: string;
  itemId: string;
  filename: string;
  sizeBytes: number | null;
  addedAt: string;
}

export interface Item extends ItemRow {
  fields: Record<string, FieldValue>;
  attachments: Attachment[];
  folderPath: string;
}

export interface TrashRow extends ItemRow {
  deletedAt: string;
  deletedPath: string | null;
}

export type SortKey = 'name' | 'manufacturer' | 'updatedAt' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

export interface ListQuery {
  query?: string;
  sort?: SortKey;
  direction?: SortDirection;
  limit?: number;
  offset?: number;
}

export interface ItemPatch {
  name?: string;
  manufacturer?: string | null;
  notes?: string | null;
}

/** The storage the library folder sits on, which decides the journal mode. */
export type StorageKind = 'local' | 'network' | 'sync';
export type JournalMode = 'wal' | 'truncate';

export interface LibraryMarker {
  app: 'mindex';
  schema: number;
  journalMode: JournalMode;
  storageKind: StorageKind;
  createdAt: string;
}

export type LibraryStatus = 'unset' | 'ready' | 'missing' | 'error';

export interface LibraryState {
  status: LibraryStatus;
  path: string | null;
  recent: string[];
  schema?: number;
  appSchema?: number;
  journalMode?: JournalMode;
  storageKind?: StorageKind;
  /** Set when the library is newer than this app, or another host holds the lock. */
  readOnly?: boolean;
  readOnlyReason?: string;
  error?: string;
}

/** A folder the user picked, classified before anything is written to it. */
export type FolderClassification =
  | { kind: 'empty' }
  | { kind: 'library'; schema: number; marker: LibraryMarker | null }
  | { kind: 'foreign'; entries: string[] }
  | { kind: 'missing' }
  | { kind: 'unwritable'; reason: string };

export interface Conflict {
  conflict: true;
  current: Item;
  /** Fields where the stored value differs from what the caller was editing. */
  overlapping: string[];
}

export type UpdateResult = { conflict?: false; item: Item } | Conflict;

export interface OkResult {
  ok: boolean;
  error?: string;
}

export interface LibraryChooseResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** Set when the folder is non-empty and not a library — the UI offers a subfolder. */
  needsConfirmation?: 'foreign';
  entries?: string[];
}

export interface VerifyReport {
  orphanFolders: string[];
  missingFolders: string[];
  missingFiles: { itemId: string; filename: string }[];
  untrackedFiles: { itemId: string; filename: string }[];
  conflictedCopies: string[];
  trashSizeBytes: number;
}

/**
 * Menu commands the main process broadcasts to the renderer. An allow-list, so
 * the preload cannot be talked into subscribing to an arbitrary channel.
 */
export const MENU_CHANNELS = [
  'menu:new-item',
  'menu:focus-search',
  'menu:change-library',
  'menu:reveal-library',
  'menu:settings',
  'menu:verify',
  'menu:view-items',
  'menu:view-trash',
  'menu:view-fields',
] as const;
export type MenuChannel = (typeof MENU_CHANNELS)[number];

/**
 * The API the preload script exposes on `window.api`. The renderer sees this
 * type and nothing else — no `fs`, no `path`, no database handle.
 */
export interface MindexApi {
  library: {
    getState(): Promise<LibraryState>;
    choose(): Promise<LibraryChooseResult>;
    create(parentPath: string, name: string): Promise<LibraryChooseResult>;
    switchTo(path: string): Promise<LibraryChooseResult>;
    reveal(): Promise<OkResult>;
    verify(): Promise<VerifyReport>;
    setJournalMode(mode: JournalMode): Promise<OkResult>;
    takeOverLock(): Promise<OkResult>;
    onChanged(listener: (state: LibraryState) => void): () => void;
    onDataChanged(listener: () => void): () => void;
  };
  items: {
    list(query: ListQuery): Promise<ItemRow[]>;
    get(id: string): Promise<Item | null>;
    create(input: {
      name: string;
      manufacturer?: string;
      notes?: string;
      fields?: Record<string, FieldValue>;
    }): Promise<Item>;
    update(input: {
      id: string;
      rev: number;
      patch: ItemPatch;
      fields?: Record<string, FieldValue>;
      /** Values the form started from, so a rev clash can be merged rather than raised. */
      base?: ItemPatch & { fields?: Record<string, FieldValue> };
    }): Promise<UpdateResult>;
    trash(input: { id: string; rev: number }): Promise<OkResult & { deletedPath?: string }>;
    restore(input: { id: string }): Promise<Item>;
    listTrash(query?: { query?: string }): Promise<TrashRow[]>;
    renameFolder(input: { id: string }): Promise<Item>;
    revealFolder(input: { id: string }): Promise<OkResult>;
  };
  fields: {
    list(): Promise<FieldDef[]>;
    create(input: { label: string; type: FieldType; options?: string[] }): Promise<FieldDef>;
    update(input: {
      id: string;
      patch: Partial<Pick<FieldDef, 'label' | 'type' | 'options' | 'position' | 'searchable'>>;
    }): Promise<FieldDef>;
    archive(input: { id: string; archived: boolean }): Promise<FieldDef>;
    remove(input: { id: string }): Promise<OkResult>;
    reorder(input: { ids: string[] }): Promise<FieldDef[]>;
  };
  attachments: {
    add(input: { itemId: string; paths?: string[] }): Promise<Attachment[]>;
    open(input: { attachmentId: string }): Promise<OkResult>;
    reveal(input: { attachmentId: string }): Promise<OkResult>;
    remove(input: { attachmentId: string }): Promise<OkResult>;
  };
  app: {
    getVersion(): Promise<{ version: string; electron: string; schema: number }>;
    openExternal(url: string): Promise<OkResult>;
  };
}
