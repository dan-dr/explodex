# Public hook patterns

Use only typed members of `PluginApi`. Prefer SDK-owned resource tracking so
replacement and unload remain deterministic.

## Mounting

- `api.mount(zone, nodeOrFactory)` for tracked zone content.
- `api.waitFor(zone, callback)` when the anchor may appear after navigation.
- `api.sidebarNav.upsert(...)` for keyed sidebar entries.
- `api.registerOptions(...)` for settings UI.

## State and host behavior

- `api.storage` for plugin-owned persisted state.
- `api.composer` for composer text and submission behavior.
- `api.codex` for documented thread model and effort operations.
- `api.bridge`, `api.http`, and `api.flags` only through documented methods.

## Cleanup

- Return a teardown from `setup` for every untracked resource.
- Prefer `api.track` for listeners, timers, observers, and subscriptions.
- Make asynchronous work generation-aware and inert after disposal.
- Keep mutation observers scoped to the smallest stable anchor.

See [sdk-api.md](sdk-api.md) for exact signatures and failure behavior.
