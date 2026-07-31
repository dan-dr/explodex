# Feature Flags Playground

Feature Flags Playground surfaces experimental Codex flags in a compact sidebar
popover and, when enabled, at the top of General Settings.

- Persists each toggle through the public bridge, then refreshes query and
  statsig caches through `api.flags.propagate`.
- Preserves known gate mappings immediately, then augments them by scanning
  loaded Codex bundles. Scan results are cached per runtime build for 24 hours.
- Groups flags by Codex rollout stage, supports filter and stage jumps, and
  retains filter and list position while the view refreshes.
- Cleans up sidebar UI, settings panel, timers, popovers, observers, and
  plugin-owned statsig overrides on unload.

The plugin uses only the public `@explodex/sdk` API. Some flags still require a
Codex restart before every UI surface reflects the change.
