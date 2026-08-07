-- Initial schema.
--
-- Note for future migrations: never edit this file. Add 002_*.sql instead.
-- A test asserts that the migration chain and a from-scratch apply produce an
-- identical schema dump, which is what catches an edit here.

CREATE TABLE items (
  id            TEXT PRIMARY KEY,             -- UUID v4, stable across renames
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,                -- normalized unique name -> folder name
  manufacturer  TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL,                -- ISO 8601 UTC
  updated_at    TEXT NOT NULL,                -- ISO 8601 UTC ("last update")
  updated_by    TEXT,                         -- hostname, so conflicts can name the other machine
  rev           INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency token
  deleted_at    TEXT,                         -- NULL = live; set = in the trash
  deleted_path  TEXT                          -- folder name under deleted/, for restore
);

-- Slugs are unique among *live* items only, so deleting frees the name for reuse.
CREATE UNIQUE INDEX idx_items_slug_live ON items(slug) WHERE deleted_at IS NULL;

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,                 -- name as stored inside data/<slug>/
  size_bytes   INTEGER,
  added_at     TEXT NOT NULL,
  UNIQUE (item_id, filename)
);

-- Custom fields: user-defined columns, defined once per library, valued per item.
CREATE TABLE field_defs (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,           -- slugified, stable, used for export/CSV headers
  label       TEXT NOT NULL,                  -- what the user sees; freely renameable
  type        TEXT NOT NULL,                  -- text | longtext | number | date | boolean | url | select
  options     TEXT,                           -- JSON array of choices, for type = select
  position    INTEGER NOT NULL DEFAULT 0,
  searchable  INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT                            -- hidden from forms, values retained
);

CREATE TABLE field_values (
  item_id   TEXT NOT NULL REFERENCES items(id)      ON DELETE CASCADE,
  field_id  TEXT NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
  value     TEXT,                             -- canonical string form; typed on read
  num_value REAL,                             -- mirror for number/date, enables sorting + ranges
  PRIMARY KEY (item_id, field_id)
) WITHOUT ROWID;

CREATE INDEX idx_items_name         ON items(name);
CREATE INDEX idx_items_manufacturer ON items(manufacturer);
CREATE INDEX idx_items_updated_at   ON items(updated_at DESC);
CREATE INDEX idx_items_deleted_at   ON items(deleted_at);
CREATE INDEX idx_attachments_item   ON attachments(item_id);
CREATE INDEX idx_field_values_field ON field_values(field_id, num_value);

-- Attachment counts are derived, never stored, so they cannot drift.
CREATE VIEW items_with_counts AS
SELECT
  i.*,
  (SELECT COUNT(*) FROM attachments a WHERE a.item_id = i.id) AS attachment_count
FROM items i;
