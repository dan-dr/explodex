# Development Guide

Explodex is a Bun workspace monorepo with three package boundaries:

| Path | Responsibility |
| --- | --- |
| `packages/sdk/` | Public `@explodex/sdk` authoring API, types, test helpers, and generated renderer runtime |
| `packages/cli/` | Public `explodex` CLI for host evidence, plugin artifacts, installation, review, and isolated development |
| `packages/plugin-registry/` | Private physical collection of seven first-party plugin workspaces and deterministic release-index tooling |

`registry.json` is generated install metadata, not the plugin collection. Host
inspection output remains local and ignored. `/Applications/ChatGPT.app` is a
read-only input and is never copied, patched, re-signed, or vendored.

## Prerequisites

- macOS
- Bun 1.3.14 for repository work
- Node.js 22 or 24 for the published CLI and SDK packages
- ChatGPT installed at `/Applications/ChatGPT.app` for runtime verification

```sh
bun install --frozen-lockfile
bun run docs:list
```

## Package builds and validation

```sh
bun run build:npm
bun run checkTs
bun run validate
```

`build:npm` generates the publishable SDK and CLI `dist/` trees. Each package
uses staged generation and atomic replacement so a failed build preserves the
prior committed output. `validate` rebuilds package output, checks scripts and
manifests, and runs the repository test suite.

The plugin-builder skill carries generated SDK documentation and type snapshots.
Refresh them with `bun scripts/sync-plugin-skill.ts`; validation rejects drift.

## Isolated renderer diagnostics

Start or reuse the owned development instance, then run diagnostics against its
exact renderer:

```sh
explodex --timeout 10m dev prove
explodex --json dev ensure
bun scripts/cdp-layout-snapshot.ts
bun scripts/cdp-react-devtools.ts
bun scripts/cdp-react-scan.ts
```

All three tools require exactly one `app://-/index.html` page on
`127.0.0.1:9444`. They never fall back to the authoring endpoint on port 9333.
The layout tool writes JSON to `~/.explodex/snapshots/`; override the path with
`EXPLODEX_LAYOUT_SNAPSHOT_OUT`. The React DevTools probe inspects fibers without
reloading the renderer. React Scan caches its downloaded bundle under
`~/.explodex/cache/`; set `EXPLODEX_REACT_SCAN_LOG=1` to mirror hot renders to
the console.

## Plugin workspace workflow

Create a standalone package workspace:

```sh
explodex plugin create ./explodex-plugin-example
cd explodex-plugin-example
explodex plugin validate
explodex plugin build
explodex plugin package
```

The generated shape is:

```text
explodex-plugin-example/
  README.md
  explodex.config.ts
  package.json
  src/index.ts
  tsconfig.json
  dist/                       # generated, committed for first-party packages
```

Author source imports `definePlugin`, `defineConfig`, and public types from
`@explodex/sdk`. Do not import renderer-private globals or reach into the
Explodex repository by relative path.

`plugin validate` checks package metadata, configuration, public SDK authority,
source boundaries, and lifecycle compatibility. `plugin build` produces a
browser-safe single entry, required source map, manifest, checksums, and a
generation receipt. `plugin package` accepts only a complete publishable-SDK
generation and produces an immutable named-root `.tar.gz`. Validate a packaged
archive independently:

```sh
explodex plugin artifact validate ./example-1.0.0-<payload-sha256>.tar.gz
```

Build output is deterministic. Identical source, configuration, package
metadata, and SDK input must reproduce the same payload digest and generation
ID. A failed build must leave the previous `dist/` byte-for-byte unchanged.

The CLI provides an explicit foreground path for a plugin that needs an
unreleased SDK:

```sh
explodex plugin develop . \
  --sdk-source /absolute/path/to/explodex/packages/sdk
```

Local-SDK authority is restricted to the exact owned development renderer. It
cannot be packaged, recommended, transferred to main, or treated as release
proof. Graduate by rebuilding against publishable SDK bytes and validating the
new artifact in development. Do not claim a local-SDK artifact has crossed
this graduation boundary until that publishable rebuild and validation pass.

## Seven-workspace first-party registry

The required workspaces are:

- `command-menu-threads`
- `effort-shortcuts`
- `feature-flags-playground`
- `project-colors`
- `project-pins`
- `toggle-autoscroll`
- `usage-reset-glance`

Run the registry gates from the repository root:

```sh
bun run --cwd packages/plugin-registry test
bun run --cwd packages/plugin-registry typecheck
```

Build and package each workspace with the same public CLI used by third-party
authors. Commit each first-party `dist/` generation. The repository root ignores
new `dist/` paths, so a new workspace's generated files require an explicit
force-stage after review; never regenerate manifests or checksums by hand.

Generate registry metadata from exactly seven validated archives:

```sh
bun run --cwd packages/plugin-registry registry:generate -- \
  --artifact-dir /absolute/path/to/archives \
  --release-tag vX.Y.Z \
  --output /absolute/path/to/registry.json
```

For release staging, use a new or empty output directory:

```sh
bun run --cwd packages/plugin-registry registry:stage -- \
  --artifact-dir /absolute/path/to/archives \
  --output-dir /absolute/path/to/release-staging \
  --release-tag vX.Y.Z
```

Staging atomically writes exactly eight files: `registry.json` plus the seven
validated archives. It rejects extra files, wrong IDs, mutable artifact URLs,
metadata or digest disagreement, and non-empty replacement targets. The command
prints the exact SHA-256 of staged `registry.json`. Publication requires that
same digest as an explicit approval value:

```sh
bun run --cwd packages/plugin-registry registry:publish -- \
  --staging-dir /absolute/path/to/release-staging \
  --release-tag vX.Y.Z \
  --approval <registry-json-sha256>
```

That command creates the GitHub Release and uploads only the verified staging
set. It does not authorize a git tag, git push, or npm publication. See
[RELEASING.md](./RELEASING.md) for separate mutation approvals.

## Protected authoring main

An authoring main may receive an exact dynamic plugin inject, unload, load, or
interaction test. It must never be automatically restarted, reloaded,
navigated, closed, stopped, or selected merely because it is the first reachable
renderer.

Build and validate before touching a renderer. Restart-required, startup,
renderer-reload, SDK-runtime, and disruptive compatibility work belongs in the
separate development instance. If no exact safe target is available, report
verification pending.

Normal host, install, refresh, review, update, and lifecycle operations exit
after their bounded action. There is no daemon or supervisor. Only an explicitly
invoked foreground plugin watch may remain alive.

## Isolated development instance

```sh
explodex dev ensure
explodex dev status
explodex dev inject ./plugin.tar.gz
explodex dev focus
explodex dev restart
explodex dev stop
```

The persistent isolated root is `~/.explodex/dev/plugin-dev`; the fixed default
CDP endpoint is `127.0.0.1:9444`. The instance has private application data,
`CODEX_HOME`, Explodex state, launch marker, and ownership record.

`dev ensure` reuses a healthy instance, recovers only a confirmed-dead record
with a free port, or launches once. Stop and restart revalidate exact PID,
kernel process-start identity, launch marker, paths, listener, target, and
execution context. They use dev-port `Browser.close` or exact-PID termination,
never app-wide quit, `killall`, or a process-name signal.

From this checkout, `bun run dev:prove`, `bun run dev:ensure`, `bun run dev:status`,
`bun run dev:restart`, and `bun run dev:stop` invoke the current CLI source.

## Runtime inspection

Use only the exact target and observations returned by the foreground public
development operation. Do not substitute direct CDP evaluation or repository
debug scripts for a missing public result.
