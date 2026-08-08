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
| `npm run pack` | Build an unpacked app into `release/`, without making an installer |
| `npm run dist` | Build installers into `release/` |

### Documentation

- **[docs/architecture.md](docs/architecture.md)** — the on-disk format, the multi-writer design, the
  source layout and security model, the testing strategy, and how to add a migration.
- **[docs/setup.md](docs/setup.md)** — local prerequisites, environment variables, the GitHub
  repository settings and signing secrets, and what to change in a fork.
- **[CLAUDE.md](CLAUDE.md)** — the short version for coding agents.

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
`-arm64-mac.zip` and `-x64-mac.zip` that electron-updater reads. The build is unsigned unless the
`CSC_*` and `APPLE_*` variables are present — see [Installing](#installing) for what that costs the
person opening it.

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
- **A dispatched run still publishes.** The `build` jobs package with `--publish never` and only
  upload artifacts, but the `publish` job that follows them attaches everything to a GitHub Release.
  If you want an `.exe` to test and nothing public, build on a Windows machine.

## Releasing

Two ways in, both ending in the same place.

**Run the workflow.** `release.yml` takes two `workflow_dispatch` inputs:

| Input | Effect |
|---|---|
| `version` | `0.0.0`, `v0.0.0` or `0.0.0-pre`. Bumps `package.json`, commits it as `vX.Y.Z`, tags it, then releases that commit. Leave it empty to release the current version as it stands. |
| `channel` | `auto` marks the release as a pre-release when the version has a suffix; `release` and `prerelease` decide it outright. |

```sh
gh workflow run Release --ref main -f version=0.2.0 -f channel=release
gh run watch
```

A version that is not *later* than the current one is refused before anything is built, by semver
precedence — so `0.2.0-pre` over `0.1.0` is fine, while `0.0.9` or a re-release of the same
pre-release is not.

**Or bump it yourself.** `npm version patch|minor|major` and push: `tag.yml` turns the version bump
into a `v*.*.*` tag, and the tag starts the same release. This is the path that needs the
`RELEASE_TOKEN` secret — see [docs/setup.md](docs/setup.md#github-repository).

Either way the tag reruns the full CI matrix against the exact commit being packaged and, only if it
is green, builds both platforms, re-runs the `@smoke` tests against the packaged binary, and attaches
every installer in one pass. The download page reads the releases API at load time, so it never needs
redeploying.

**Why one job does all the attaching.** Each `build` job used to publish for itself, which raced:
whichever finished second could take the other's installers off the release, and v0.1.0 shipped
macOS-only as a result. Packaging and publishing are now separate steps, and `publish` refuses to
attach anything unless both platforms' installers *and* both `electron-updater` feeds are present.
