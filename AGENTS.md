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
| [docs/sdk-api.md](docs/sdk-api.md) | **SDK API reference** for plugin authors and agents |
| [docs/sdk-fragility.md](docs/sdk-fragility.md) | SDK breakage analysis, stable vs fragile deps, upgrade checklist |
| [docs/early-injection-and-inspect-brk.md](docs/early-injection-and-inspect-brk.md) | inspect-brk vs CDP early inject, massive patch tiers, React props limits |
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

### Languages

- **Do not write Python** in this repo. Python scripts were removed; do not reintroduce them.
- **Locally run dev scripts** (`scripts/dev.ts`, `scripts/package-app.ts`, `scripts/cdp-inject.ts`, validation): **Bun + TypeScript**.
- **Inside the bundled app** (`templates/explodex-app/`, copied to `dist/Explodex.app`): **shell (zsh) only**. No TypeScript or Python in `Contents/Resources/`. The CDP injector ships as a compiled binary (`cdp-inject-bin`) invoked by `cdp-inject.sh`.
- **Renderer runtime** (`sdk/`, `plugins/`): JavaScript (injected into Codex).

### Runtime

- Plugins: `plugins/<id>/plugin.json` + `plugins/<id>/index.js`, register via `Explodex.plugins.register`.
- Hook **official** Codex bridge paths (`update-thread-settings-for-next-turn`, `start-turn-for-host`, etc.) rather than synthetic DOM events when affecting turn behavior. See [docs/composer-message-lifecycle.md](docs/composer-message-lifecycle.md).
- Match existing plugin/SDK style; minimal diffs; no drive-by refactors.
- Verify effort/model changes against rollout JSONL `turn_context` when touching reasoning-effort behavior.

## Key paths

```
sdk/explodex-sdk.js        # Plugin runtime, bridge, zones
sdk/explodex-sdk.d.ts      # TypeScript definitions (keep in sync with sdk-api.md)
plugins/                   # Feature plugins, one folder per plugin
templates/explodex-app/    # Tracked app bundle template (shell launcher)
scripts/package-app.ts     # Build dist/Explodex.app
scripts/dev.ts             # Local dev: package + MCP + launch
vendor/Codex.app/          # Patched Codex binary (do not use system Codex.app)
extracted/                 # Extracted webview assets for RE
docs/                      # Architecture and lifecycle docs (maintain these)
```

## Commands

```bash
bun run dev                 # Package dist/Explodex.app, start chrome-devtools-mcp, launch
bun run inject              # Re-inject SDK + plugins into running debug session
bun run package             # Build dist/Explodex.app only
```

## Verification

When the user asks to **test if working** (or similar), verify behavior in the **live Codex renderer** via **Chrome DevTools MCP** connected to the Electron app — not by code review alone.

1. Ensure a debug session is up (`bun run dev`, or an already-running Explodex with CDP on `EXPLODEX_DEBUG_PORT`, default `9333`).
2. After code changes, run `bun run package` then `bun run inject` (or restart `bun run dev`). Already-loaded dynamic plugins may need `Explodex.plugins.unload(id)` then `Explodex.plugins.load(id)` via `evaluate_script`, or a renderer reload.
3. Use the **chrome-devtools** MCP tools against `http://127.0.0.1:9333` (`list_pages` → `select_page` → `evaluate_script` / `take_snapshot` / `click`).
4. Confirm the feature under test: plugin registration, DOM hooks, bridge calls, and user-visible behavior.

`bun run dev` starts `chrome-devtools-mcp` with `--browser-url` pointed at the app; agents should use that MCP server for renderer inspection and interaction.
