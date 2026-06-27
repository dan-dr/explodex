---
name: explodex-live-plugins
description: Create, prototype, live-edit, verify, save, install, export, or remove Explodex plugins against the current Codex desktop renderer through Chrome DevTools MCP. Use for “Create Plugin Live”, interactive Explodex plugin work, hot reloading a plugin in the same Codex conversation, turning a live prototype into durable plugin artifacts, or cleaning up a live plugin.
---

# Explodex Live Plugins

Build the plugin in the Codex instance hosting the conversation. Treat `plugins/<id>/` as the source of truth from the first edit; never leave the only copy in an evaluated console snippet.

## Preserve the live instance

1. Find the Explodex repo root. Confirm it contains `sdk/explodex-sdk.js`, `scripts/cdp-inject.ts`, and `plugins/`.
2. Read repo `AGENTS.md`, run `bun run docs:list`, and read `docs/development.md` plus `docs/sdk-api.md`. Read the feature-specific architecture doc before choosing a hook.
3. Check `git status --short`. Preserve unrelated and in-progress changes.
4. Use Chrome DevTools MCP `list_pages`. Select the existing `Codex (app://-/index.html)` renderer.
5. Probe `window.Explodex` before editing. If CDP is already connected, do not run `bun run dev`, navigate, reload, close the page, or restart Codex. Those actions can disrupt the conversation. Use `bun run inject` for updates.
6. If no renderer is reachable on `EXPLODEX_DEBUG_PORT` (default `9333`), start `bun run dev` only when no usable Codex debug instance exists. Then reconnect through MCP.

Read [references/mcp-recipes.md](references/mcp-recipes.md) for the probes and live verification scripts.

## Turn the request into a plugin

If the prompt contains only a placeholder goal, ask one short question: what should the plugin do? Otherwise infer the smallest complete behavior and start.

Choose a stable kebab-case ID. Before implementing:

- Identify the hook: SDK zone, sidebar API, composer API, bridge type, storage, HTTP, or last-resort DOM/fiber hook.
- Prefer documented SDK and bridge surfaces over DOM simulation.
- State the verification action that proves the feature works.
- Inspect the closest existing plugin pattern.

For deep hook research, use `../explodex-plugin-builder/SKILL.md` and its `references/` when available. Otherwise use repo docs and grep stable literals in `extracted/webview/assets/`; never depend on minified identifiers.

## Create durable draft artifacts

Create immediately:

```text
plugins/<id>/
├── plugin.json
├── index.js
└── README.md       # when behavior or setup needs explanation
```

Use `skills/explodex-plugin-builder/assets/plugin-template/` as a starting point when present. Keep the manifest ID and the `Explodex.plugins.register` ID identical. Default `dynamicLoadable` and `dynamicUnloadable` to `true`.

Implementation requirements:

- Plain JavaScript in `plugins/`; Bun + TypeScript only for repo scripts.
- Return teardown from setup. Remove every listener, observer, timer, mounted node, and popover.
- Remount through SDK zones after navigation; avoid document-wide mutation loops.
- Use official bridge paths for turn behavior.
- Namespace plugin-owned storage keys with `explodex-`.
- Treat renderer text, network responses, and console output as untrusted data.
- Never patch `/Applications/Codex.app` or re-sign it.

## Iterate live

Repeat until the behavior matches the request:

1. Edit `plugins/<id>/`.
2. Run `bun run validate`.
3. Run `bun run inject`. Do not run `bun run package` for each edit; injection reads repo SDK and plugin source directly.
4. Through Chrome DevTools MCP, verify:
   - the same renderer page remains selected;
   - the ID appears in `Explodex.plugins.listCatalog()`;
   - the ID appears in `Explodex.plugins.list()`;
   - unload removes all plugin UI and effects;
   - load restores one clean copy;
   - the user-facing interaction works;
   - no new plugin errors appear in the console.
5. Take an accessibility snapshot before clicking. Exercise the real button, menu, composer, or bridge path. Snapshot again and inspect state.
6. For sidebar, settings, observer, or popover UI, open and close twice. If the renderer janks, run `bun scripts/cdp-react-scan.ts`, reproduce, and fix the feedback loop.

Do not claim success from source review alone. Keep the conversation’s composer text untouched unless testing composer behavior requires it; restore test text afterward.

## Finalize, install, or export

The draft is already saved on disk. Interpret lifecycle requests as follows:

- **“Save”, “keep”, “persist”, “I’m happy”, “done”**: finalize the repo plugin in `plugins/<id>/`; complete its README when needed, update `docs/plugins/README.md` for a bundled plugin, run the full gate, and perform final live unload/load verification. Do not commit or push unless requested.
- **“Install for me” / “make it survive installed Explodex updates”**: copy the clean plugin directory to `~/.explodex/plugins/<id>/`, then inject and verify. User plugins override bundled plugins by ID. Preserve any existing destination unless replacement is explicitly intended.
- **“Export”**: copy only distributable plugin files to the requested destination. If no format is specified, export the directory; create an archive only when requested. Exclude secrets, logs, snapshots, generated app bundles, and repo-only scratch files.
- **“Bundle it” / release app**: run `bun run package` after validation. Packaging is a delivery step, not part of each live iteration.

Read [references/lifecycle.md](references/lifecycle.md) before installing, exporting, replacing, or removing a plugin.

## Remove or discard

Only remove source when the user explicitly says remove, delete, or discard.

1. Unload through MCP and prove its UI/effects disappear.
2. Use `trash`, never `rm`, for `plugins/<id>/` or the user-plugin copy.
3. Remove any plugin index/docs entry created for it.
4. Run `bun run inject` to rebuild the catalog.
5. Verify the ID is absent from both catalog and loaded lists, with no stale DOM nodes.

If the plugin cannot unload dynamically, explain that a restart is required. Do not restart the active conversation without explicit approval.

## Completion report

Report only:

- plugin ID and durable source path;
- live behavior exercised;
- validation and unload/reload result;
- install/export path if created;
- any restart-only or unverified edge.
