# Mindex

A catalogue of your things, kept in a folder you own.

Mindex is an offline desktop app for macOS and Windows that keeps a list of items — tools, parts,
equipment, whatever you need to find again — with notes, your own custom fields, and the manuals and
photos that go with them. There is no account, no server, and nothing leaves your computer.

**[Download](https://folletto.github.io/mindex/)** · [Releases](https://github.com/folletto/mindex/releases)

---

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

## Installing

Builds are currently **unsigned**, which costs one extra step the first time.

### macOS

Right-click the app and choose **Open** — double-clicking will show a warning and refuse. You only
have to do this once. If macOS still refuses:

```sh
xattr -d com.apple.quarantine /Applications/Mindex.app
```

### Windows

SmartScreen warns about an unrecognised publisher until the download builds a reputation. Choose
**More info** → **Run anyway**.

Signing is wired up but off: set `CSC_LINK` / `CSC_KEY_PASSWORD` (and `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization) as repository secrets and the
release workflow signs itself. Note that **macOS auto-update requires a signed app**, which is why
Mindex currently points you at the download page rather than updating itself.

---

## Development

```sh
npm install
npm run dev
```

That is the whole setup. `better-sqlite3` is a native module, but it ships N-API prebuilds, which are
ABI-stable across both Node and Electron — so the tests (plain Node) and the app (Electron) load the
same binary, with no rebuild step and no `postinstall` that could quietly break one of them.
`electron-builder` is configured with `npmRebuild: false` for the same reason: compiling from source
against Electron headers would add nothing but a way for the build to fail. The one thing that does
matter is `asarUnpack`, since a `.node` binary cannot be loaded from inside an asar archive.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Electron with hot reload |
| `npm run build` | Typecheck, then build to `out/` |
| `npm test` | Unit, property, integration and concurrency suites |
| `npm run test:coverage` | The same, with the 90% gate on `src/main` and `src/shared` |
| `npm run test:e2e` | Playwright against the built app (run `npm run build` first) |
| `npm run lint` | ESLint, including the rules that keep the renderer sandboxed |
| `npm run pack` | Build an unpacked app into `release/`, without making an installer |
| `npm run dist` | Build installers into `release/` |

### Layout

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

### Testing

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

### Adding a migration

Add `src/main/db/migrations/00N_what_it_does.sql`. Never edit an existing one — a test applies the
chain step by step and compares the resulting schema against a from-scratch apply, which is what
catches that mistake. Migrations run in one exclusive transaction, after backing the database up, and
an app that meets a library from a newer version refuses to write to it rather than guessing.

## Building

`npm run build` compiles TypeScript and bundles into `out/`. That is what `npm run dev` and the
end-to-end tests run against, and it is *not* an application — packaging is a separate step.

| Command | What you get |
|---|---|
| `npm run build` | Compiled `out/`. No app bundle. |
| `npm run pack` | An unpacked app under `release/` (`mac/`, `win-unpacked/`). The quickest way to check a real bundle. |
| `npm run dist` | Installers under `release/`, for **the platform you are on**. |

Both `pack` and `dist` run `npm run build` first, so the typecheck gates them too.

The rule that shapes everything below: **electron-builder packages for the machine it runs on.** This
project does not cross-compile, and the release workflow builds each installer on its own OS.

### macOS

`npm run dist` on a Mac writes `Mindex-<version>-arm64.dmg` and `-x64.dmg` into `release/`, plus the
matching zips that electron-updater reads. The build is unsigned unless the `CSC_*` and `APPLE_*`
variables are present — see [Installing](#installing) for what that costs the person opening it.

### Windows

**A Windows installer is built on Windows.** Reaching for `npx electron-builder --win` on a Mac gets
as far as the NSIS step and stops: electron-builder produces the uninstaller by *running* it, which
on a non-Windows host means running a Windows executable through Wine (`WineVmManager`). With no
`wine` on `PATH`, that step fails.

Worth knowing, because it is the thing people usually expect to be the problem and it is not: the
native dependency is fine. `better-sqlite3` ships N-API prebuilds for every platform *inside the
package* — `prebuilds/win32-x64.node` and the rest are all there after a plain `npm ci` on any OS —
and `asarUnpack` keeps the whole module outside the asar archive so the right one can be loaded. It
is NSIS that pins the build to Windows, not the database.

That leaves two honest routes:

1. **On a Windows machine** — `npm ci && npm run dist`, which writes
   `release/Mindex-<version>-Setup.exe`: NSIS, x64, per-user, install directory changeable.
2. **In CI** — the Release workflow already runs a `windows-latest` job for exactly this reason. This
   is the recommended route, and the only one that needs no Windows hardware.

### Getting a Windows installer out of CI

`release.yml` has a `workflow_dispatch` trigger, so it can be run by hand against a branch without
tagging anything:

```sh
gh workflow run Release --ref main
gh run watch
```

The `build` job uploads every installer it made as a run artifact, which is the part you want:

```sh
gh run download <run-id> --name installers-windows-latest
```

Two things to be aware of before dispatching a run:

- **`verify` gates everything.** The `build` job `needs: verify`, which re-runs the entire CI matrix —
  including the Windows end-to-end suite — against the commit. A red suite means no installer is
  built at all, which is the intended behaviour and not a misconfiguration.
- **A dispatched run still publishes.** The packaging step is `electron-builder --publish always`, so
  it creates or updates a GitHub Release rather than only leaving artifacts behind. If you want an
  `.exe` to test and nothing public, build on a Windows machine, or change that step to
  `--publish never` for the run.

## Releasing

`npm version patch|minor|major` and push. A workflow turns the version bump into a `v*.*.*` tag; the
tag reruns the full CI matrix and, only if it is green, builds and publishes installers to GitHub
Releases, then re-runs the `@smoke` tests against the packaged binary. The download page reads the
releases API at load time, so it never needs redeploying.

Two one-time repository settings:

- **Settings → Pages → Source: GitHub Actions**, or `pages.yml` fails on its first run.
- A **`RELEASE_TOKEN`** secret — a personal access token with `contents: write`. GitHub does not
  start new workflow runs from events created with the default `GITHUB_TOKEN`, so without this the
  tag is created but `release.yml` never fires. You can always run **Release** manually against the
  tag instead; the token just removes that step.

## Licence

MIT.
