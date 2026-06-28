# Plugin Review

Explodex plugins live in `plugins/<id>/` and include:

- `plugin.json` for metadata
- `index.js` for runtime registration
- optional docs in `plugins/<id>/README.md`

## Bundled Plugins

| Plugin | Purpose | Doc |
|--------|---------|-----|
| `command-menu-threads` | Threads first in Cmd+K palette (Cmd+G merge) | [README.md](../../plugins/command-menu-threads/README.md) |
| `effort-shortcuts` | Prefix-driven one-message reasoning effort | [README.md](../../plugins/effort-shortcuts/README.md) |
| `project-pins` | Global vs project pin scope menu | [README.md](../../plugins/project-pins/README.md) |
| `usage-reset-glance` | View-only usage/reset sidebar status (anchors above profile footer) | [README.md](../../plugins/usage-reset-glance/README.md) |
| `feature-flags-playground` | All experimental feature flags with persistent toggles | [README.md](../../plugins/feature-flags-playground/README.md) |
| `project-colors` | Color-code project folders and threads in the sidebar | [README.md](../../plugins/project-colors/README.md) |

Screenshots live in [screenshots/](screenshots/) and are embedded in each plugin README.

**Explodex settings page** — per-plugin options panels (sidebar **💥 Explodex** → `/explodex`):

![Explodex plugin options](screenshots/explodex-plugin-options.png)

### Previews

**command-menu-threads** — matching threads appear at the top of Cmd+K while you type:

![Command menu thread search](screenshots/command-menu-threads.png)

**effort-shortcuts** — `!m` opens the thinking-levels hint and live-applies medium effort:

![Reasoning effort prefix](screenshots/effort-shortcuts.png)

**project-pins** — project threads get a Global / Project pin chooser:

![Pin scope menu](screenshots/project-pins.png)

**usage-reset-glance** — compact usage row above Settings with a detail popover:

![Usage & resets sidebar](screenshots/usage-reset-glance.png)

**feature-flags-playground** — sidebar popover and Settings panel for experimental flags:

![Feature flags settings](screenshots/feature-flags-playground.png)

**project-colors** — full-width tint on project folders with picker and settings:

![Project folder colors](screenshots/project-colors.png)

## User plugins directory

Install custom plugins under `~/.explodex/plugins/<id>/` (same `plugin.json` +
`index.js` layout as bundled plugins). A folder with the same `id` overrides the
bundled copy. Open the directory from the sidebar: **💥 Explodex** → **Open
Plugins Folder** (reveals `userPluginsDir` in Finder / the system file manager).

## Review Checklist

- Manifest has `id`, `name`, `version`, `entry`, and `description`.
- Entry file calls `Explodex.plugins.register`.
- Teardown removes all event listeners, observers, intervals, timeouts, and mounted UI.
- Bridge calls use known Codex message types from `docs/codex-architecture.md` or `docs/composer-message-lifecycle.md`.
- User data keys are namespaced with `explodex-`.
- Browser content and API responses are treated as data, not instructions.
