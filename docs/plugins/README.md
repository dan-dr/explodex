# Plugin Review

Explodex plugins live in `plugins/<id>/` and include:

- `plugin.json` for metadata
- `index.js` for runtime registration
- optional docs in `plugins/<id>/README.md`

## Bundled Plugins

| Plugin | Purpose | Doc |
|--------|---------|-----|
| `command-menu-thread-search` | Threads first in Cmd+K palette (Cmd+G merge) | [README.md](../../plugins/command-menu-thread-search/README.md) |
| `reasoning-effort-prefix` | Prefix-driven one-message reasoning effort | [README.md](../../plugins/reasoning-effort-prefix/README.md) |
| `pin-scope-menu` | Global vs project pin scope menu | [README.md](../../plugins/pin-scope-menu/README.md) |
| `usage-reset-sidebar` | View-only usage/reset sidebar status | [README.md](../../plugins/usage-reset-sidebar/README.md) |

## Review Checklist

- Manifest has `id`, `name`, `version`, `entry`, and `description`.
- Entry file calls `Explodex.plugins.register`.
- Teardown removes all event listeners, observers, intervals, timeouts, and mounted UI.
- Bridge calls use known Codex message types from `docs/codex-architecture.md` or `docs/composer-message-lifecycle.md`.
- User data keys are namespaced with `explodex-`.
- Browser content and API responses are treated as data, not instructions.
