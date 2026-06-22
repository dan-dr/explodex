# Explodex

**Extend the [Codex](https://openai.com/codex) desktop app with plugins.**

Explodex is a community-built plugin SDK for Codex. It injects a small runtime into the Codex renderer, exposes stable DOM zones (sidebar, composer, thread footer, and more), and loads plugins from `plugins/<id>/` so you can add UI and behavior without forking the app.

Is it explore? Explode? Exploit? Ideally: explore Codex internals, explode your own local UI, exploit nothing.

> Explodex is an independent open-source project. It is not affiliated with, endorsed by, or supported by OpenAI. It runs entirely on your machine and does not modify your installed Codex app.

## Why Explodex?

- **Plugin-first** — drop a folder with `plugin.json` + `index.js` and register against `Explodex`
- **Typed SDK** — full [API reference](docs/sdk-api.md) and [TypeScript definitions](sdk/explodex-sdk.d.ts)
- **Codex-native UI** — components and overlays that match Codex design tokens
- **Bridge access** — read/write composer state, thread settings, settings, and authenticated HTTP
- **Hot reload in dev** — re-inject SDK and plugins into a running debug session

## Bundled plugins

| Plugin | What it does |
|--------|----------------|
| [reasoning-effort-prefix](plugins/reasoning-effort-prefix/) | Set reasoning effort from composer prefixes like `!m` or `!xh` |
| [pin-scope-menu](plugins/pin-scope-menu/) | Pin and scope menu for thread context |
| [usage-reset-sidebar](plugins/usage-reset-sidebar/) | Usage reset controls in the sidebar |

The built-in **💥 Explodex** sidebar item opens the plugin manager (enable/disable, open plugins folder).

## Write a plugin

A plugin is a folder with a manifest and an entry script:

```text
my-plugin/
  plugin.json
  index.js
```

```js
// @ts-check
/// <reference path="../../sdk/explodex-sdk.d.ts" />

(function (global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) return;

  Explodex.plugins.register(
    { id: "hello", name: "Hello", version: "1.0.0" },
    (api) => {
      const render = () =>
        api.mount("aboveComposer", () =>
          api.components.button({
            label: "Insert greeting",
            color: "secondary",
            size: "composerSm",
            onClick: () => api.composer.insertText("Hello! "),
          }),
        );

      render();
      const stop = api.waitFor("aboveComposer", render);
      return () => stop();
    },
  );
})(window);
```

Install user plugins under `~/.explodex/plugins/` (same layout). They override bundled plugins with the same id. Open the folder from the Explodex sidebar → **Open Plugins Folder**.

**SDK reference:** [docs/sdk-api.md](docs/sdk-api.md) — complete API for agents and humans, with signatures, failure modes, and examples.

**Types:** [sdk/explodex-sdk.d.ts](sdk/explodex-sdk.d.ts)

## Get started

### Prerequisites

- [Bun](https://bun.sh) (Node 22-compatible runtime for dev scripts)
- [Codex desktop app](https://openai.com/codex) installed at `/Applications/Codex.app`
- Quit Codex completely (Cmd+Q) before starting a new debug session

### Install

```sh
git clone https://github.com/dan-dr/explodex.git
cd explodex
bun run install:app
```

This builds `dist/Explodex.app`, copies it to `/Applications/Explodex.app`, and creates `~/.explodex/plugins` for your plugins.

To build without installing:

```sh
bun run package
open dist/Explodex.app
```

### Develop

```sh
bun run dev
```

`bun run dev` packages the app, launches Codex with remote debugging on port `9333`, injects the SDK + plugins, and starts Chrome DevTools MCP for live renderer inspection.

After changing SDK or plugin source while Codex is running:

```sh
bun run inject
```

Validate source and types:

```sh
bun run validate
```

Try the static harness (no Codex required):

```sh
open poc/harness.html
```

Dev state is isolated under `.explodex-user-data/` (override with `EXPLODEX_USER_DATA`).

### Commands

| Command | Purpose |
|---------|---------|
| `bun run dev` | Package, launch, and attach chrome-devtools-mcp |
| `bun run inject` | Re-inject SDK + plugins into a running debug session |
| `bun run package` | Build `dist/Explodex.app` only |
| `bun run install:app` | Package and install to `/Applications/Explodex.app` |
| `bun run launch` | Launch Codex directly with injection (no packaging) |
| `bun run validate` | Syntax, manifest, and TypeScript definition checks |

## How it works

Explodex wraps Codex in a thin launcher (`Explodex.app`) that enables Chrome DevTools Protocol injection. The SDK (`sdk/explodex-sdk.js`) installs into the renderer and provides:

- **DOM zones** — `aboveComposer`, `sidebar`, `composerActions`, and more
- **Components** — buttons, panels, toasts styled like Codex
- **Bridge** — AppServer router and Electron IPC to Codex internals
- **Plugin manager** — catalog, enable/disable, hot load in dev

Codex internals can change between releases. See [docs/sdk-fragility.md](docs/sdk-fragility.md) for stability notes and upgrade guidance.

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/sdk-api.md](docs/sdk-api.md) | **SDK API reference** (start here for plugin development) |
| [docs/development.md](docs/development.md) | Repo layout, validation, dev loop |
| [docs/local-development.md](docs/local-development.md) | Packaging, user data, plugin paths |
| [docs/codex-architecture.md](docs/codex-architecture.md) | Bundle topology, injection, IPC |
| [docs/composer-message-lifecycle.md](docs/composer-message-lifecycle.md) | Composer send APIs and hook points |
| [docs/plugins/README.md](docs/plugins/README.md) | Bundled plugin notes |

## Contributing

Issues and pull requests are welcome. This repo ships source, docs, scripts, and plugin manifests. Large Codex bundles used for local reverse-engineering stay out of git (see `.gitignore`).

When changing SDK behavior, update [docs/sdk-api.md](docs/sdk-api.md) and [sdk/explodex-sdk.d.ts](sdk/explodex-sdk.d.ts) in the same change.