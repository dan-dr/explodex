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

When changing SDK behavior, update [docs/sdk-api.md](docs/sdk-api.md) and [sdk/explodex-sdk.d.ts](sdk/explodex-sdk.d.ts) in the same change.

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
bun run layout:snapshot     # JSON layout landmarks from live renderer (see § Layout snapshots)
```

## Verification

When the user asks to **test if working** (or similar), verify behavior in the **live Codex renderer** via **Chrome DevTools MCP** connected to the Electron app — not by code review alone.

1. Ensure a debug session is up (`bun run dev`, or an already-running Explodex with CDP on `EXPLODEX_DEBUG_PORT`, default `9333`).
2. After code changes, run `bun run package` then `bun run inject` (or restart `bun run dev`). Already-loaded dynamic plugins may need `Explodex.plugins.unload(id)` then `Explodex.plugins.load(id)` via `evaluate_script`, or a renderer reload.
3. Use the **chrome-devtools** MCP tools against `http://127.0.0.1:9333` (`list_pages` → `select_page` → `evaluate_script` / `take_snapshot` / `click`).
4. Confirm the feature under test: plugin registration, DOM hooks, bridge calls, and user-visible behavior.

`bun run dev` starts `chrome-devtools-mcp` with `--browser-url` pointed at the app; agents should use that MCP server for renderer inspection and interaction.

### Layout snapshots

Capture DOM landmarks from the live renderer when Codex may have changed sidebar/shell layout, or before editing zone selectors:

```bash
bun run layout:snapshot
# optional explicit path:
EXPLODEX_LAYOUT_SNAPSHOT_OUT=./layout.json bun run layout:snapshot
bun run react-devtools   # DOM fiber chains; reload renderer for full DevTools UI
```

Default output: `~/.explodex/snapshots/layout-<timestamp>.json`. Script: `scripts/cdp-layout-snapshot.ts`.

#### Comparing layout snapshots (when asked)

When the user asks to **compare layout snapshots**, **diff layout**, **check for layout drift**, or similar after a Codex upgrade:

1. **Capture a fresh snapshot** with the app in a known state (home or thread view, sidebar open, plugins loaded):
   ```bash
   bun run layout:snapshot
   EXPLODEX_LAYOUT_SNAPSHOT_OUT=/tmp/layout-after.json bun run layout:snapshot
   ```
2. **Pick a baseline** — previous snapshot from `~/.explodex/snapshots/`, a committed reference under `docs/` if one exists, or a second capture from the old `vendor/Codex.app` if still available.
3. **Diff the `pages[0].snapshot` objects** — agents should run the comparison themselves (do not only describe commands):
   ```bash
   # list recent snapshots
   ls -lt ~/.explodex/snapshots/layout-*.json | head -5

   # quick field diff (jq)
   jq -S '.pages[0].snapshot | {sidebar, navLandmarks, profileFooter, sidebarDataAttrs, zones, explodexNavMounts, react}' /tmp/layout-before.json > /tmp/a.json
   jq -S '.pages[0].snapshot | {sidebar, navLandmarks, profileFooter, sidebarDataAttrs, zones, explodexNavMounts, react}' /tmp/layout-after.json > /tmp/b.json
   diff -u /tmp/a.json /tmp/b.json
   ```
4. **Prioritize these fields** (sidebar/plugin breakage usually shows here first):

   | Field | What drift means |
   |-------|------------------|
   | `sidebar.testId` / `sidebar.className` | Zone anchor changed — update `ZONE_DEFINITIONS.sidebar` in `sdk/explodex-sdk.js` |
   | `navLandmarks[].ariaLabel` | Nav scoping changed — update `sidebarNavRoot` / label anchors in plugins |
   | `profileFooter` (missing or `ariaLabel` change) | Footer anchor moved — fix `sidebarNav.insertBefore(["Settings"], …)` callers |
   | `sidebarDataAttrs` keys/counts | New/removed `data-app-action-sidebar-*` attrs — update pin-scope and architecture docs |
   | `explodexNavMounts` | Plugin mounts missing after upgrade — selector/observer regression |
   | `react.domFiberChains` | Component rename (minified) — cross-check `vendor/Codex.app` ASAR chunks |
   | `zones.*` | Portal anchors moved — update injection zones in SDK + [docs/codex-architecture.md](docs/codex-architecture.md) §5 |

5. **Report findings in chat** with before/after values for each changed field, then update SDK selectors, affected plugins, and docs in the same session.
6. **Re-capture after fixes** and confirm `explodexNavMounts` lists expected plugin keys and `profileFooter` is present when testing footer-anchored plugins.

See [docs/codex-architecture.md](docs/codex-architecture.md) §4 sidebar chrome and [docs/current-findings.md](docs/current-findings.md) for the v26.623+ reference layout.

### React render performance ([react-scan](https://github.com/aidenybai/react-scan))

When investigating **UI freezes**, runaway CPU, or suspected **render loops** in the Codex renderer (plugin sidebar remounts, popover churn, Statsig/query invalidation storms), use **react-scan** before guessing from code alone.

```bash
bun scripts/cdp-react-scan.ts
# optional: mirror hot components to the console
EXPLODEX_REACT_SCAN_LOG=1 bun scripts/cdp-react-scan.ts
```

This injects react-scan into the live renderer via CDP (same port as `bun run inject`). Codex CSP blocks external script tags — the script fetches the bundle on the host and evaluates it through CDP. Codex is a production React build — the script sets `dangerouslyForceRunInProduction: true`. A toolbar appears in-app; components that re-render excessively are highlighted.

**Workflow for agents:**

1. Reproduce the jank (load plugin, open popover, navigate to settings, etc.).
2. Run `bun scripts/cdp-react-scan.ts` (or inject once per renderer reload).
3. Exercise the UI — watch which subtrees flash repeatedly (sidebar, personalization, popover host).
4. Map hot components back to plugin code (`paintNav`, `observeZone`, `refresh` ↔ `reopenPopover`, bridge cache sync).
5. Fix the feedback loop; re-scan to confirm the highlight storm stopped.

Full MCP steps, interpretation, and teardown: [skills/explodex-plugin-builder/references/testing.md](skills/explodex-plugin-builder/references/testing.md) § React Scan. Anti-freeze patterns: [skills/explodex-plugin-builder/references/hooks.md](skills/explodex-plugin-builder/references/hooks.md) § Anti-freeze.
