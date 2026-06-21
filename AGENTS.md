# AGENTS.md — Explodex

Instructions for coding agents working in this repository.

## Project summary

Explodex wraps the Codex Electron app with a plugin SDK (`sdk/explodex-sdk.js`), injects into the renderer via `Explodex.app` or CDP, and ships plugins under `plugins/<id>/`. Codex internals are reverse-engineered from `vendor/Codex.app` into `extracted/` for reference — patch experiments target `vendor/Codex.app` only, never `/Applications/Codex.app`.

## Documentation

**Keep `docs/` up to date.** Documentation is part of the deliverable, not an afterthought.

| Doc | Contents |
|-----|----------|
| [docs/codex-architecture.md](docs/codex-architecture.md) | Bundle topology, injection zones, IPC, persistence |
| [docs/composer-message-lifecycle.md](docs/composer-message-lifecycle.md) | Composer send APIs, effort/collaborationMode, plugin hook points |
| [docs/reasoning-effort-prefix-session.md](docs/reasoning-effort-prefix-session.md) | Session log: reasoning-effort prefix plugin, decisions, verification, Option D plan |
| [docs/current-findings.md](docs/current-findings.md) | Scratch pad / ongoing investigation notes |
| [docs/development.md](docs/development.md) | Public repo layout, validation, runtime loop |
| [docs/plugins/README.md](docs/plugins/README.md) | Plugin-by-plugin review and docs index |

When you change behavior, discover new Codex internals, or fix a plugin based on architecture knowledge:

1. Update the relevant doc in the same PR/session (or immediately after).
2. Add cross-links between docs when topics overlap.
3. Prefer `extracted/webview/assets/` chunk names and bridge `type` strings that survive minification greps.
4. Do not duplicate large sections — link and add a short delta.

### `research` / `document` requests

When the user says **research**, **document**, **map**, **research/document**, or similar:

- **Research** → investigate (read `extracted/`, grep bridge types, trace flows), then **write or update** docs with findings.
- **Document** → create or refresh docs even if no code changes are requested.
- Default output location: `docs/<topic>.md` (kebab-case). Update [docs/codex-architecture.md](docs/codex-architecture.md) TOC or §9 IPC when adding new bridge APIs.
- If research invalidates existing docs, fix the old doc and note what changed.

Do not leave long architectural explanations only in chat — persist them under `docs/`.

## Code conventions

- Plugins: `plugins/<id>/plugin.json` + `plugins/<id>/index.js`, register via `Explodex.plugins.register`, sync with `scripts/sync-wrapper.sh`.
- Hook **official** Codex bridge paths (`update-thread-settings-for-next-turn`, `start-turn-for-host`, etc.) rather than synthetic DOM events when affecting turn behavior. See [docs/composer-message-lifecycle.md](docs/composer-message-lifecycle.md).
- Match existing plugin/SDK style; minimal diffs; no drive-by refactors.
- Verify effort/model changes against rollout JSONL `turn_context` when touching reasoning-effort behavior.

## Key paths

```
sdk/explodex-sdk.js        # Plugin runtime, bridge, zones
plugins/                   # Feature plugins, one folder per plugin
scripts/sync-wrapper.sh    # Deploy into Explodex.app
vendor/Codex.app/          # Patched Codex binary (do not use system Codex.app)
extracted/                 # Extracted webview assets for RE
docs/                      # Architecture and lifecycle docs (maintain these)
```

## Commands

```bash
./scripts/sync-wrapper.sh   # Sync SDK + plugins into Explodex.app
```
