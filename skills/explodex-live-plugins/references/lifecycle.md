# Plugin lifecycle and delivery

## Source states

| State | Path | Meaning |
|---|---|---|
| Live draft | `plugins/<id>/` | Durable repo source currently injected into the renderer |
| Finalized bundled plugin | `plugins/<id>/` plus docs index | Ready to commit or include in `Explodex.app` |
| Installed user plugin | `~/.explodex/plugins/<id>/` | Personal override loaded outside the app bundle |
| Export | User-selected directory or archive | Portable plugin-only artifact |

Do not create a second draft format. The files tested live are the files finalized.

## Finalization gate

- Manifest and registration IDs match.
- Version and description are intentional.
- Teardown passes unload/load without duplicate UI.
- README covers behavior, settings, and any known fragility.
- `docs/plugins/README.md` includes bundled plugins.
- `bun run validate` passes.
- Real interaction passes through Chrome DevTools MCP.
- Console has no new plugin-caused errors.

Update architecture docs only when the work discovers or changes SDK behavior, bridge types, selectors, or fragility knowledge.

## Install as a user plugin

Installation writes outside the repo and may need approval. Before copying:

1. Inspect `~/.explodex/plugins/<id>/` if it exists.
2. Resolve `~/.explodex/plugins` with `realpath`. If it resolves to the repo
   `plugins/` directory, the dev source is already installed; do not copy onto
   itself and do not mistake duplicate-layer warnings for separate files.
3. Stop rather than overwriting unexpected files. Replace only when user intent is explicit.
4. Copy `plugin.json`, entry JavaScript, README, and plugin-owned assets only.
5. Run `bun run inject`; the repo dev directory has higher precedence during dev, so verify the intended source path when testing overrides.

Do not use the obsolete `~/Library/Application Support/Explodex/plugins` path. Current injector default is `~/.explodex/plugins`, overridable with `EXPLODEX_USER_PLUGINS_DIR`.

## Export

Default export is a directory named after the plugin ID. Preserve the required layout:

```text
<id>/
├── plugin.json
├── index.js
├── README.md       # optional but preferred
└── assets/         # only if referenced by the plugin
```

Validate the source before copying. Inspect the exported file list afterward. Do not include `.DS_Store`, logs, screenshots used only for QA, secrets, `node_modules`, `dist/Explodex.app`, or unrelated repo files.

## Remove

Removal order matters:

1. `Explodex.plugins.unload(id)`.
2. Verify loaded state false and plugin DOM absent.
3. `trash` the explicitly requested source or installed copy.
4. Remove docs/index references belonging to the plugin.
5. `bun run inject`.
6. Verify catalog false, loaded false, nodes zero.

Never trash both repo and installed copies unless the request clearly covers both.
