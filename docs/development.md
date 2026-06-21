# Development Guide

Explodex is a source-first repo. Keep proprietary Codex bundles and extracted reverse-engineering output local and ignored.

## Layout

| Path | Purpose |
|------|---------|
| `sdk/explodex-sdk.js` | Injected renderer SDK and plugin runtime |
| `plugins/<id>/plugin.json` | Plugin catalog metadata |
| `plugins/<id>/index.js` | Plugin runtime entrypoint |
| `scripts/cdp-inject.py` | Runtime CDP injector |
| `scripts/launch.sh` | Launch Codex with remote debugging and inject Explodex |
| `scripts/sync-wrapper.sh` | Sync source into local `Explodex.app` wrapper |
| `poc/harness.html` | Static browser harness for SDK zones |
| `dist/` | Ignored generated output |

For the proposed durable app packaging, install, user-data, and plugin load-path model, see [local-development.md](./local-development.md).

## Local Artifacts

These are intentionally not public source:

- `vendor/Codex.app`
- `extracted/`
- `tmp_extracted/`
- `Explodex.app`

If you need to inspect Codex internals, regenerate `extracted/` locally from your own Codex copy and keep findings in `docs/`.

## Validate

```sh
npm run validate
```

The gate is dependency-free:

- Python syntax checks for scripts
- zsh syntax checks for shell scripts
- Node syntax checks for SDK and plugin entrypoints
- JSON validation for package and plugin manifests

The script prefers Dan's mise Node 22 path when present because the Homebrew Node on this machine may be broken.

When using package scripts directly, prefer:

```sh
mise exec node@22 -- npm run validate
```

## Runtime Loop

```sh
npm run launch
```

This starts Codex with `--remote-debugging-port=9333`, waits for the renderer, injects `sdk/explodex-sdk.js`, and loads plugin catalog entries from `plugins/`.

For an already-running debug session:

```sh
npm run inject
```

## Plugin Development

1. Create `plugins/<id>/plugin.json`.
2. Create `plugins/<id>/index.js`.
3. Register via `Explodex.plugins.register`.
4. Return a teardown that removes listeners, timers, observers, and mounted UI.
5. Run `npm run validate`.
6. Run `npm run launch` or `npm run inject`.

Keep plugin state keys namespaced with `explodex-`. When renaming old keys, read legacy keys and write the new key on the next update.

## Browser Verification

This repo includes `.mcp.json` for `chrome-devtools-mcp` against `http://127.0.0.1:9333`. Use it after launching Codex with `npm run launch` or `./scripts/launch.sh --no-inject`.

If the MCP tools are unavailable in the current agent session, use the direct CDP injector as the fallback verification path.

## Public Repo Hygiene

Do not commit:

- Codex app bundles
- Extracted app assets
- User data directories
- Logs
- Local app wrappers

Do commit:

- SDK source
- plugin source and manifests
- scripts
- docs
- validation gates
