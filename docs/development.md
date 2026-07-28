# Development Guide

Explodex is a source-first repo. Keep proprietary Codex bundles and extracted reverse-engineering output local and ignored.

## Layout

| Path | Purpose |
|------|---------|
| `sdk/explodex-sdk.js` | Injected renderer SDK and plugin runtime |
| `plugins/<id>/plugin.json` | Plugin catalog metadata |
| `plugins/<id>/index.js` | Plugin runtime entrypoint |
| `scripts/cdp-inject.ts` | CDP injector (Bun TypeScript; shell entry `cdp-inject.sh`) |
| `scripts/dev.ts` | Local dev: package + chrome-devtools-mcp + launch |
| `scripts/package-app.ts` | Build the source-development `dist/Explodex.app` |
| `lib/launcher-bundle.mjs` | Generate the lightweight npm-installed launcher |
| `lib/platform/macos.mjs` | Installed-mode macOS launch state adapter |
| `scripts/launch.sh` | Launch Codex with remote debugging and inject Explodex |
| `templates/explodex-app/` | Tracked shell launcher template for the wrapper app |
| `dist/` | Ignored generated output (`dist/Explodex.app`) |

For packaging, install, user-data, and plugin load-path design notes, see [local-development.md](./local-development.md).

## Prerequisites

Install [Bun](https://bun.sh). Node 22 is the target runtime (see `.node-version`).

## Local Development

```sh
bun run dev
```

This packages `dist/Explodex.app`, launches it, waits for debug port `9333`, and starts `chrome-devtools-mcp` for agent inspection (see `.mcp.json`).

The CDP injector applies the SDK/catalog to every matching Codex renderer target it sees during startup. After the first injection it keeps polling (every 250ms) for late-mounting secondary renderers but exits as soon as two consecutive polls find nothing new; `EXPLODEX_TARGET_WATCH_MS` (default `8000`) is only the absolute upper bound, so the common single-window case finishes in ~0.5s instead of waiting out the full window. Inside each renderer, SDK zones can be observed with `Explodex.observeZone(zoneId, callback)` so plugins can remount after React replaces a portal/sidebar node.

Re-inject after editing SDK or plugins:

```sh
bun run inject
```

The injector publishes the refreshed plugin catalog before evaluating the SDK.
The SDK initializes from that catalog during startup, so one injection both adds
new plugins and removes deleted plugin IDs without reloading the renderer.

### Layout snapshot (sidebar / shell landmarks)

After `bun run dev` (or any session with CDP on `9333`), capture a JSON layout
report for debugging selector drift:

```sh
bun scripts/cdp-layout-snapshot.ts
# optional explicit output path:
EXPLODEX_LAYOUT_SNAPSHOT_OUT=./layout.json bun scripts/cdp-layout-snapshot.ts
```

Default write path: `~/.explodex/snapshots/layout-<timestamp>.json`. The snapshot
includes sidebar testids, nav `aria-label`s, profile footer button, zone portal
presence, `data-app-action-sidebar-*` counts, and a short React fiber chain when
the DevTools hook is present.

### React layout probe via CDP

Codex ships production React. `cdp-react-devtools.ts` installs the DevTools global
hook (for reload) and immediately walks `__reactFiber$*` chains on sidebar DOM
nodes — no reload required for the fiber report:

```sh
bun run react-devtools
# optional: also attempt react-devtools-inline backend eval (needs renderer reload for UI)
EXPLODEX_REACT_DEVTOOLS_BACKEND=1 bun run react-devtools
```

Pair with `bun run layout:snapshot` when Codex changes layout between releases.

`bun run inject` (`--inject-only`) connects to whatever is listening on the debug port — including an SSH tunnel to a remote Codex. The **Explodex.app launcher** is stricter: it only takes the “inject into existing instance” fast path when **local** Codex owns port `9333` (or the process is otherwise identifiable as `Codex.app/Contents/MacOS/Codex`). If another process (e.g. `ssh -L 9333:…`) holds the port, the launcher reports a port conflict instead of falsely claiming injection into a running local Codex.

## Distribution boundary

Production distribution is through the npm registry and supports global installation with pnpm, Bun, npm, or Yarn. The generated user launcher is documented in [installation.md](./installation.md). `bun run package` and `dist/Explodex.app` remain source-development tools only.

## Validate

```sh
bun run validate
```

Checks shell syntax, Bun/TS syntax, JS entrypoints, JSON manifests, npm injector build, and launcher tests.

## Plugin Development

For a plugin that needs an unreleased SDK change, name the canonical SDK source
workspace explicitly:

```sh
explodex --json plugin develop . \
  --sdk-source /absolute/path/to/explodex/packages/sdk
```

The foreground operation completes SDK generation N and plugin generation N
before it probes or applies the pair. Shared `dist/` publication and renderer
application are serialized. A newer request can invalidate an older build
before commit, but an apply that has crossed renderer evaluation settles before
the next apply starts. Pre-evaluation SDK failures preserve the prior complete
live pair without restarting. Only classified post-evaluation SDK runtime
contamination permits one bounded restart using the operation-frozen prior
compatibility proof. Local SDK paths and authority do not enter JSONL events,
maps, checksums, archives, plugin metadata, or persisted activation state.

Local-SDK generations are dev-only. `.explodex-generation.json` is untrusted
workspace metadata, not publication authority. Packaging independently rebuilds
the same source against the exact published SDK in disposable storage and
requires byte-identical output. Main staging requires one immutable receipt
binding the verified generation, artifact payload, published SDK identity,
owned development target, and validation operation.

The public V1 workflow is:

1. Run `explodex --json dev status` with the exact `--home` and optional
   `--dev-root` context.
2. Use only the lifecycle operation authorized by that result. Recovery is
   allowed only when status reports the predicate-specific recovery eligibility.
3. Run public build, validation, and package operations with `--json`.
4. Run `explodex --json plugin develop <workspace>`. Stdout is one JSONL stream
   owned by the foreground command. Dispatch owns `SIGINT`/`SIGTERM`, cleanup
   settles before exactly one terminal record, and cleanup residue supplements
   rather than replaces the primary terminal reason.
5. For management, execute only the exact command rendered by the CLI. Each
   command carries the selected home/root context and reports success only
   after installed, enabled, live identity, lifecycle, and boundary facts
   correlate.
6. For a hot-safe main transfer, complete the publishable rebuild and exact
   owned-development revalidation, retain the staged receipt, then run the
   public staged `main apply` flow. A fresh interactive checkpoint authorizes
   only the staged artifact for one exact main process, target, context,
   compatibility key, and SDK identity. The operation renews the real
   one-operation reconciliation capability without replacing SDK bytes and
   verifies selected-thread, navigation, SDK, and every live unrelated plugin
   baseline before and after apply.

Do not substitute repository injectors, direct CDP evaluation, a reachable
debug port, a previous authorization, or generic process signaling for these
public operations. Interactive authentication is performed manually only in
the exact already-running isolated development profile named by the blocker.
Resume with a new `dev status` and a new foreground operation.

Keep plugin state keys namespaced with `explodex-`. When renaming old keys, read legacy keys and write the new key on the next update.

### Use your local `plugins/` checkout

To run the plugins in your working copy instead of the bundled copies, either symlink your checkout into the user plugins directory (user plugins override bundled plugins with the same id):

```sh
ln -sf "$(pwd)/plugins" ~/.explodex/plugins
```

or point the user plugins directory at your repo:

```sh
export EXPLODEX_USER_PLUGINS_DIR="$(pwd)/plugins"
```

Then run `bun run inject` after editing plugin source.

## Browser Verification

`.mcp.json` configures `chrome-devtools-mcp` against `http://127.0.0.1:9333`. `bun run dev` starts that MCP server automatically. Cursor agents should use the chrome-devtools MCP tools after dev is running.

## Public Repo Hygiene

Do not commit:

- Codex app bundles
- Extracted app assets
- User data directories
- Logs
- Generated `dist/Explodex.app`

Do commit:

- SDK source
- plugin source and manifests
- scripts and templates
- docs
- validation gates
