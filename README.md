# Mindex

A catalogue of your things, kept in a folder you own.

Mindex is an offline desktop app for macOS and Windows that keeps a list of items — tools, parts,
equipment, whatever you need to find again — with notes, your own custom fields, and the manuals and
photos that go with them. There is no account, no server, and nothing leaves your computer.

**[Download](https://folletto.github.io/mindex/)** · [Releases](https://github.com/folletto/mindex/releases)

---

## The data folder is the point

You pick a folder on first launch, and everything lives inside it: a SQLite database for the
metadata, and one real folder of real files per item. That shape is a promise, not an implementation
detail — the folder is portable, it is inspectable without Mindex, and nothing is ever destroyed
behind your back. Two machines can share one catalogue through Dropbox, iCloud or Syncthing without
losing an edit.

How that works, and where it stops working, is in [docs/architecture.md](docs/architecture.md).

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

Signing is wired up but off — see [docs/setup.md](docs/setup.md#3-code-signing-optional) for the
secrets that turn it on. Note that **macOS auto-update requires a signed app**, which is why Mindex
currently points you at the download page rather than updating itself.

---

## Development

```sh
npm install
npm run dev
```

That is the whole setup. Node 22, no native rebuild step, nothing to configure —
[docs/setup.md](docs/setup.md) covers the details, the environment variables, and the one-time
repository settings a release needs.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Electron with hot reload |
| `npm run build` | Typecheck, then build to `out/` |
| `npm test` | Unit, property, integration and concurrency suites |
| `npm run test:coverage` | The same, with the 90% gate on `src/main` and `src/shared` |
| `npm run test:e2e` | Playwright against the built app (run `npm run build` first) |
| `npm run lint` | ESLint, including the rules that keep the renderer sandboxed |
| `npm run dist` | Build installers into `release/` |

### Documentation

- **[docs/architecture.md](docs/architecture.md)** — the on-disk format, the multi-writer design, the
  source layout and security model, the testing strategy, and how to add a migration.
- **[docs/setup.md](docs/setup.md)** — local prerequisites, environment variables, the GitHub
  repository settings and signing secrets, and what to change in a fork.
- **[CLAUDE.md](CLAUDE.md)** — the short version for coding agents.

## Releasing

`npm version patch|minor|major` and push. A workflow turns the version bump into a `v*.*.*` tag; the
tag reruns the full CI matrix and, only if it is green, builds and publishes installers to GitHub
Releases, then re-runs the `@smoke` tests against the packaged binary. The download page reads the
releases API at load time, so it never needs redeploying.

This depends on two one-time repository settings — the Pages source and a `RELEASE_TOKEN` secret.
Both are in [docs/setup.md](docs/setup.md#github-repository).
