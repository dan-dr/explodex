# Explodex

Is it explore? Explode? Exploit? Ideally: explore Codex internals, explode your own local UI, exploit nothing.

Explodex is a local-only extension SDK and plugin playground for the [Codex](https://openai.com/codex) desktop app. It injects a small renderer runtime into a Codex Electron window, pokes at DOM zones like the sidebar and composer, and loads plugins from `plugins/<id>/`. That's it. No grand plan.

> **Warning** — This is a hack, not a product. Explodex is **not affiliated with, endorsed by, or supported by OpenAI**. It works by injecting into the renderer of an app whose internals are reverse-engineered, so **APIs can break between Codex releases** without warning. It runs entirely locally and does not modify your installed `/Applications/Codex.app`. Use at your own risk.

## What Works

- Runtime CDP injection via `scripts/cdp-inject.ts` (shell entry: `scripts/cdp-inject.sh`)
- A renderer SDK at `sdk/explodex-sdk.js` ([API reference](docs/sdk-api.md), [types](sdk/explodex-sdk.d.ts))
- Plugin folders with `plugin.json` + `index.js`
- Built-in plugin manager nav item: `💥 Explodex`
- Three bundled plugins:
  - `reasoning-effort-prefix`
  - `pin-scope-menu`
  - `usage-reset-sidebar`
- A lightweight browser harness at `poc/harness.html`

## Safety Boundary

Never mutate the installed Codex app in `/Applications`.

Local reverse-engineering artifacts are intentionally ignored:

- `vendor/Codex.app`
- `extracted/`
- `tmp_extracted/`
- `*.app/`

Use those locally, but do not commit them.

## Quick Start

Prerequisites: [Bun](https://bun.sh), Codex at `/Applications/Codex.app`, and Codex fully quit (Cmd+Q) before a new debug session.

Install (packages and copies `Explodex.app` to `/Applications`):

```sh
git clone https://github.com/dan-dr/explodex.git
cd explodex
bun run install:app
```

Or just build and open:

```sh
bun run package
open dist/Explodex.app
```

Dev loop (package, launch, inject, attach MCP):

```sh
bun run dev
```

Re-inject after editing SDK/plugins while Codex is already running:

```sh
bun run inject
```

Validate source:

```sh
bun run validate
```

Static harness (no Codex needed):

```sh
open poc/harness.html
```

| Command | Purpose |
|---------|---------|
| `bun run dev` | Package, launch, attach chrome-devtools-mcp |
| `bun run inject` | Re-inject SDK + plugins into a running session |
| `bun run package` | Build `dist/Explodex.app` only |
| `bun run install:app` | Package and install to `/Applications/Explodex.app` |
| `bun run launch` | Launch Codex with injection (no packaging) |
| `bun run validate` | Syntax, manifest, and type checks |

Dev state lives under `.explodex-user-data/` (override with `EXPLODEX_USER_DATA`).

## Plugin Layout

Bundled plugins ship in the app bundle. Drop your own under `~/.explodex/plugins/` (same layout; same id overrides bundled). Open the folder from the Explodex sidebar → **Open Plugins Folder**.

```text
plugins/
  usage-reset-sidebar/
    plugin.json
    index.js

~/.explodex/plugins/
  my-plugin/
    plugin.json
    index.js
```

`plugin.json` is catalog metadata. `index.js` registers against the SDK:

```js
Explodex.plugins.register({ id, name, version }, (api) => {
  // mount UI, call bridge APIs, return optional teardown
});
```

See [docs/sdk-api.md](docs/sdk-api.md) for the full API surface and [docs/plugins/README.md](docs/plugins/README.md) for bundled plugin notes.

## Documentation

- [docs/sdk-api.md](docs/sdk-api.md) — SDK API reference
- [docs/development.md](docs/development.md)
- [docs/local-development.md](docs/local-development.md)
- [docs/codex-architecture.md](docs/codex-architecture.md)
- [docs/composer-message-lifecycle.md](docs/composer-message-lifecycle.md)
- [docs/sdk-fragility.md](docs/sdk-fragility.md)
- [docs/plugins/README.md](docs/plugins/README.md)

## Public Repo Notes

This repo should contain source, docs, scripts, and manifests only. The large Codex bundles and extracted assets are local reference material and are ignored by design.