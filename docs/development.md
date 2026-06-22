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
| `scripts/package-app.ts` | Build `dist/Explodex.app` from `templates/explodex-app/` |
| `scripts/launch.sh` | Launch Codex with remote debugging and inject Explodex |
| `templates/explodex-app/` | Tracked shell launcher template for the wrapper app |
| `poc/harness.html` | Static browser harness for SDK zones |
| `dist/` | Ignored generated output (`dist/Explodex.app`) |

For packaging, install, user-data, and plugin load-path design notes, see [local-development.md](./local-development.md).

## Prerequisites

Install [Bun](https://bun.sh). Node 22 is the target runtime (see `.node-version`).

## Local Development

```sh
bun run dev
```

This packages `dist/Explodex.app`, launches it, waits for debug port `9333`, and starts `chrome-devtools-mcp` for agent inspection (see `.mcp.json`).

The CDP injector applies the SDK/catalog to every matching Codex renderer target it sees during startup (`EXPLODEX_TARGET_WATCH_MS`, default `8000`). Inside each renderer, SDK zones can be observed with `Explodex.observeZone(zoneId, callback)` so plugins can remount after React replaces a portal/sidebar node.

Re-inject after editing SDK or plugins:

```sh
bun run inject
```

## Install to /Applications

```sh
bun run install:app
```

Packages `dist/Explodex.app` (release build, no repo project-root marker), installs to `/Applications/Explodex.app`, and creates `~/.explodex/plugins` for user-managed plugins. User plugins override bundled plugins with the same ID.

## Validate

```sh
bun run validate
```

Checks shell syntax, Bun/TS syntax, JS entrypoints, and JSON manifests.

## Plugin Development

1. Create `plugins/<id>/plugin.json`.
2. Create `plugins/<id>/index.js`.
3. Register via `Explodex.plugins.register`.
4. Return a teardown that removes listeners, timers, observers, and mounted UI.
5. Run `bun run validate`.
6. Run `bun run inject` (or `bun run dev` for a fresh session).

Keep plugin state keys namespaced with `explodex-`. When renaming old keys, read legacy keys and write the new key on the next update.

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
