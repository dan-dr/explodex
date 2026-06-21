# Explodex

Is it explore? Explode? Exploit? Ideally: explore Codex internals, explode your own local UI, exploit nothing.

Explodex is a local-only extension SDK and plugin playground for the Codex desktop app. It injects a small renderer runtime into a Codex Electron window, exposes DOM zones such as the sidebar and composer, then loads plugins from `plugins/<id>/`.

It is not an official OpenAI project. It does not patch `/Applications/Codex.app`.

## What Works

- Runtime CDP injection with `scripts/cdp-inject.py`
- A renderer SDK at `sdk/explodex-sdk.js`
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

Validate source:

```sh
mise exec node@22 -- npm run validate
```

Launch Codex with Explodex injection:

```sh
mise exec node@22 -- npm run launch
```

Inject into an already-running Codex debug session:

```sh
mise exec node@22 -- npm run inject
```

Run the static harness:

```sh
open poc/harness.html
```

## Plugin Layout

```text
plugins/
  usage-reset-sidebar/
    plugin.json
    index.js
```

`plugin.json` supplies catalog metadata. `index.js` still calls:

```js
Explodex.plugins.register({ id, name, version }, (api) => {
  // mount UI, call bridge APIs, return optional teardown
});
```

See [docs/plugins/README.md](docs/plugins/README.md) for plugin-by-plugin notes.

## Useful Commands

```sh
mise exec node@22 -- npm run docs:list
mise exec node@22 -- npm run validate
./scripts/launch.sh --no-inject
./scripts/launch.sh --inject-only
./scripts/sync-wrapper.sh
```

## Documentation

- [docs/development.md](docs/development.md)
- [docs/codex-architecture.md](docs/codex-architecture.md)
- [docs/composer-message-lifecycle.md](docs/composer-message-lifecycle.md)
- [docs/architecture-review.md](docs/architecture-review.md)
- [docs/plugins/README.md](docs/plugins/README.md)

## Public Repo Notes

This repo should contain source, docs, scripts, and manifests only. The large Codex bundles and extracted assets are local reference material and are ignored by design.
