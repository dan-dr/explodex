# Plugin lifecycle and delivery

## Source states

| State | Path | Meaning |
|---|---|---|
| Draft or finalized bundled plugin | `plugins/<id>/` | Durable source, whether tested live or offline |
| Installed user plugin | `~/.explodex/plugins/<id>/` | Personal override loaded outside the app bundle |
| Export | User-selected directory or archive | Portable plugin-only artifact |

Do not create a second draft format. The source that is validated or tested is the source that is finalized.

## Finalization gate

- Manifest and registration IDs match.
- Version and description are intentional.
- README covers behavior, settings, and known fragility when needed.
- `docs/plugins/README.md` includes bundled plugins.
- `bun run validate` passes.
- When a renderer is available, teardown passes unload/load without duplicate UI, the real interaction passes, and the console has no new plugin-caused errors.
- When no renderer is available, the completion report marks runtime verification pending.

Update architecture docs only when the work discovers or changes SDK behavior, bridge types, selectors, or fragility knowledge.

## Install as a user plugin

Installation writes outside the repo and may need approval. Before copying:

1. Inspect `~/.explodex/plugins/<id>/` if it exists.
2. Resolve `~/.explodex/plugins` with `realpath`. If it resolves to the repo `plugins/` directory, the dev source is already installed; do not copy onto itself.
3. Stop rather than overwriting unexpected files. Replace only when user intent is explicit.
4. Copy `plugin.json`, entry JavaScript, README, and plugin-owned assets only.
5. Run `bun run inject` when a renderer is available. Verify the intended source path because repo dev plugins take precedence during development.

Do not use the obsolete `~/Library/Application Support/Explodex/plugins` path. Current injector default: `~/.explodex/plugins`, overridable with `EXPLODEX_USER_PLUGINS_DIR`.

## Export

Default export: directory named after the plugin ID.

```text
<id>/
├── plugin.json
├── index.js
├── README.md       # optional but preferred
└── assets/         # only if referenced by the plugin
```

Validate before copying and inspect the exported files afterward. Exclude `.DS_Store`, logs, QA-only screenshots, secrets, `node_modules`, `dist/Explodex.app`, and unrelated repo files.

## Remove

Only remove source when the user explicitly says remove, delete, or discard.

When a renderer is available:

1. Unload the plugin and verify its UI/effects disappear.
2. Use `trash`, never `rm`, for the explicitly requested source or installed copy.
3. Remove docs/index references belonging to the plugin.
4. Run `bun run inject`.
5. Verify catalog false, loaded false, and plugin nodes zero.

Without a renderer, perform only the authorized filesystem cleanup and report runtime cleanup unverified. Never trash both repo and installed copies unless the request clearly covers both.
