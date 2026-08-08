# Mindex — working notes

Offline Electron desktop app (React renderer + SQLite via `better-sqlite3`) over a user-chosen
library folder. README.md holds the full rationale; this file is the short version for making changes.

## Layout

```
src/main/      Electron main: DB handle, filesystem, dialogs
  db/          connection pragmas, migrations, ALL SQL (repos)
  service.ts   the only place disk + database work is sequenced
  library.ts   classify / init / open a library folder
  ipc.ts       the entire IPC surface, one file
  paths.ts     path containment helpers (resolveInside)
  lock.ts      advisory heartbeat lock for synced folders
src/preload/   explicit allow-list bridged to the renderer
src/renderer/  React only — no fs, no path, no Electron (lint-enforced)
src/shared/    types + pure logic used by both sides
tests/         unit · integration · concurrency · e2e (see below)
```

## Commands

```bash
npm run dev          # Electron, hot reload
npm run typecheck    # both tsconfigs; `npm run build` runs this first
npm run lint
npm test             # vitest: unit, property, integration, concurrency
npm run test:coverage  # 90% gate on src/main + src/shared
npm run test:e2e     # Playwright against out/ — run `npm run build` first
npm run dist         # installers into release/
```

## Rules that matter

- **Renderer stays sandboxed.** No `fs`/`path`/`child_process`/`electron` imports, no `require`,
  no importing `src/main/**`. New capability = new channel in `src/main/ipc.ts` + a line in
  `src/preload/index.ts`. ESLint enforces this; don't work around it.
- **Only IDs cross IPC.** Main resolves IDs to paths from the DB and checks containment inside the
  library folder (`src/main/paths.ts`) before touching anything.
- **Transactions never span I/O.** `BEGIN IMMEDIATE` writes contain no filesystem work (they may be
  retried); mixed operations compensate by hand in `src/main/service.ts`.
- **Updates are revision-conditional.** Never blind-overwrite — reload, merge, surface real conflicts.
- **Migrations are append-only.** Add `src/main/db/migrations/00N_name.sql`; never edit an existing
  one. A test replays the chain and diffs it against a from-scratch apply.
- **No mocked database anywhere.** Tests run real SQLite on real temp dirs; the concurrency suite
  spawns real child processes. Keep it that way.
- `better-sqlite3` is native and uses N-API prebuilds: no rebuild step, `npmRebuild: false`,
  `asarUnpack` required. Don't add a `postinstall` rebuild.

## Before finishing a change

`npm run typecheck && npm run lint && npm test`. Touching main/shared? Check coverage stays above the
gate. Touching UI or app startup? Build, then run the e2e suite.

Local note: Electron launches and TLS fetches fail under the command sandbox — run e2e (and `gh`)
with the sandbox disabled, or the failures look real but aren't.

## Keep this file current

This file points at real paths, scripts, thresholds and rules. **If any of them change — scripts in
`package.json`, the layout under `src/`, the lint boundaries, the coverage gate, the migration or
locking rules — update this file in the same change.** A stale pointer here is worse than no pointer.
