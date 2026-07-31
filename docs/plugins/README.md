# First-party plugin registry

The physical first-party collection is
`packages/plugin-registry/explodex-plugin-*`. Each direct child is an
independent TypeScript package workspace with public `@explodex/sdk` imports,
tests, documentation, and generated `dist/` artifacts.

`registry.json` is generated release metadata. It is not the source collection
and is never edited by hand.

## Required seven workspaces

| Plugin | Purpose | Package documentation |
| --- | --- | --- |
| `command-menu-threads` | Threads first in the Cmd+K palette | [README.md](../../packages/plugin-registry/explodex-plugin-command-menu-threads/README.md) |
| `effort-shortcuts` | Prefix-driven one-message reasoning effort | [README.md](../../packages/plugin-registry/explodex-plugin-effort-shortcuts/README.md) |
| `feature-flags-playground` | Experimental feature flags with persistent toggles | package README pending |
| `project-colors` | Color-code project folders and threads | [README.md](../../packages/plugin-registry/explodex-plugin-project-colors/README.md) |
| `project-pins` | Global versus project pin scope | [README.md](../../packages/plugin-registry/explodex-plugin-project-pins/README.md) |
| `toggle-autoscroll` | Per-thread autoscroll control above the composer | [README.md](../../packages/plugin-registry/explodex-plugin-toggle-autoscroll/README.md) |
| `usage-reset-glance` | View-only usage and reset status | [README.md](../../packages/plugin-registry/explodex-plugin-usage-reset-glance/README.md) |

Screenshots remain under [screenshots/](./screenshots/) for visual regression
reference while package READMEs move with their independent workspaces.

## Package contract

Each workspace contains:

```text
README.md
explodex.config.ts
package.json
src/index.ts
test/
tsconfig.json
dist/
```

`explodex.config.ts` owns plugin version, display name, description, and
lifecycle. `package.json` owns package identity and SDK dependency authority.
Source exports one `definePlugin(...)` result. The package CLI generates
`dist/index.js`, `dist/index.js.map`, `dist/plugin.json`, `dist/checksums.json`,
and `dist/.explodex-generation.json`.

Do not hand-edit generated files. Build them with:

```sh
explodex plugin validate packages/plugin-registry/explodex-plugin-NAME
explodex plugin build packages/plugin-registry/explodex-plugin-NAME
explodex plugin package packages/plugin-registry/explodex-plugin-NAME
```

New `dist/` directories are ignored by the root pattern, so reviewed
first-party generated output must be force-staged explicitly. Existing tracked
generations update normally.

## Collection gates

```sh
bun run --cwd packages/plugin-registry test
bun run --cwd packages/plugin-registry typecheck
```

The registry contract requires exactly the seven direct workspaces listed
above, public SDK imports only, inert generated registration, and generated
artifacts free of private renderer authority.

Release staging accepts exactly seven independently validated archives and
atomically emits those archives plus deterministic `registry.json`. See
[development.md](../development.md#seven-workspace-first-party-registry) and
[RELEASING.md](../RELEASING.md).

## Review checklist

- Package name is `explodex-plugin-<id>` and matches the generated manifest ID.
- `@explodex/sdk` peer and development versions match the supported package SDK.
- Source uses only public package imports and no repository-relative SDK path.
- Setup has no top-level host side effects; generated evaluation stays inert.
- Teardown disposes listeners, observers, timers, subscriptions, and UI.
- Browser content, archive metadata, and API responses are treated as data.
- Behavior changes include focused tests and updated package documentation.
- `plugin validate`, build, package, and standalone artifact validation pass.
- Rebuilding unchanged inputs reproduces the same payload and generation ID.
