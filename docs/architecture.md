# Architecture

How Mindex is put together, and why. For getting the app running see the
[README](../README.md); for the one-time configuration a fork or a release needs see
[setup.md](setup.md).

## The data folder is the point

You pick a folder on first launch. Everything lives inside it:

```
My Catalogue/
├─ catalogue.db          # SQLite: the source of truth for metadata
├─ .catalogue-library    # marker: {"app":"mindex","schema":1,…}
├─ data/
│  ├─ acme-widget-mk2/
│  │  ├─ datasheet.pdf
│  │  └─ photo.jpg
│  └─ bosch-gsb-13-re/
│     └─ manual.pdf
└─ deleted/              # created lazily; never emptied automatically
   └─ old-thing--20260806-141530/
      └─ manual.pdf
```

That shape is a promise, not an implementation detail:

- **It is portable.** Put the folder in Dropbox, iCloud or Syncthing and several machines share one
  catalogue. Move it to another disk and open it there.
- **It is inspectable.** Every attachment is a real file in a folder named after the item. You do not
  need Mindex to get your files back.
- **Nothing is destroyed.** Deleting an item moves its folder into `deleted/` with a timestamp.
  Removing an attachment moves the file there too. If you want the bytes gone, you delete them
  yourself, in your file manager, on purpose.

## Several machines, one catalogue

Two copies of Mindex — or Mindex and a script — can write to the same library at once without
corrupting it or losing an edit. This is the part of the design that took the most care:

- Every write runs in a short `BEGIN IMMEDIATE` transaction. A transaction never spans user input, a
  file copy or an IPC round-trip: the form you are typing into is not a transaction, the save is.
- Contention is waited out (`busy_timeout`) and then retried with jittered backoff before you ever
  hear about it.
- Every update is conditional on a revision number. If another machine got there first, Mindex does
  **not** silently overwrite: it reloads, merges the fields the other writer did not touch, and shows
  you a panel for the ones that genuinely disagree. Your typing is never swallowed by a dialog.
- The journal mode follows the storage. WAL is faster but relies on shared memory that network shares
  and file-sync clients do not provide, so those get the slower, correct rollback journal instead.
- On a sync folder, Mindex takes an advisory heartbeat lock. If another machine has the library open,
  this one opens read-only and says whose machine it is — with a way through, because the lock is
  advice, not a wall.

**The honest limitation:** two machines editing the *same item* in the *same second* on a
*cloud-synced* folder can still make the sync client produce a conflicted copy of the database file.
That is a property of file-level sync, not of the app. Mindex detects those copies and tells you.
Real multi-writer over the internet would need a server, which this app deliberately does not have.

## Layout

```
src/
├─ main/        # Electron main: the database handle, the filesystem, the dialogs
│  ├─ db/       # connection pragmas, migrations, all SQL
│  ├─ service.ts   # the one place that sequences disk and database work
│  ├─ library.ts   # classify, initialise and open a library folder
│  └─ ipc.ts       # the entire IPC surface, in one readable file
├─ preload/     # the typed allow-list the renderer can see
├─ renderer/    # React. No fs, no path, no Electron — enforced by lint
└─ shared/      # types and pure logic used by both sides
```

The renderer runs with `contextIsolation`, `sandbox`, no Node integration, a strict CSP, and no way
to navigate or open a window. Only IDs cross the IPC boundary; the main process resolves them to
paths from the database, and every resolved path is checked for containment inside the library folder
before it is used.

## The native module

`better-sqlite3` is a native module, but it ships N-API prebuilds, which are ABI-stable across both
Node and Electron — so the tests (plain Node) and the app (Electron) load the same binary, with no
rebuild step and no `postinstall` that could quietly break one of them. `electron-builder` is
configured with `npmRebuild: false` for the same reason: compiling from source against Electron
headers would add nothing but a way for the build to fail. The one thing that does matter is
`asarUnpack`, since a `.node` binary cannot be loaded from inside an asar archive.

## Testing

Testing is a deliverable here, not a milestone. Around 435 tests, in layers:

| Layer | What it covers |
|---|---|
| Unit + property (`fast-check`) | slug generation, filename sanitisation, path containment, retry backoff |
| Integration | real SQLite on a real temp folder — repositories, migrations, constraints, compensating writes |
| Concurrency | **real child processes** writing to one shared library, on both journal modes |
| IPC contract | every handler against a real temp library, with Electron mocked and nothing else |
| End-to-end | Playwright driving the built Electron app |

Two areas get the heaviest coverage because they are the ones that would hurt most if they broke
quietly:

- **`slug.ts`** decides folder names on disk. It has table-driven cases for accents, CJK, emoji, RTL,
  every Windows reserved device name, and NFC-vs-NFD pairs (macOS decomposes filenames, Windows does
  not — the canonical trap for an app like this), plus properties asserting the output always matches
  `^[a-z0-9-]{1,60}$`, is idempotent, and is never a reserved name.
- **Concurrency** is tested with actual processes, never mocks. SQLite's locking is a property of
  processes and files; a mock would hide exactly the behaviour the tests exist to verify. The suite
  covers an eight-process hammer (then `integrity_check`, `foreign_key_check`, no duplicate live
  slugs, and every attachment's bytes still present), a lost-update race where exactly one writer
  must win, a busy storm where a three-second write lock must be waited out rather than errored on,
  and migration skew where an older app must degrade to read-only.

There is no mocked database anywhere, and no test asserts on a mock's call log.

## Adding a migration

Add `src/main/db/migrations/00N_what_it_does.sql`. Never edit an existing one — a test applies the
chain step by step and compares the resulting schema against a from-scratch apply, which is what
catches that mistake. Migrations run in one exclusive transaction, after backing the database up, and
an app that meets a library from a newer version refuses to write to it rather than guessing.
