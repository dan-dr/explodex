# Feature Flags (Settings)

![Feature flags settings](../../docs/plugins/screenshots/feature-flags-settings.png)

## Purpose

Surface all Codex experimental feature flags with live on/off state, persistent toggles, and optional injection into **General Settings**. Opens from the sidebar **Feature Flags** row (popover) or the embedded panel on `/settings/general-settings`.

## Flag sources

| Badge | Meaning |
|-------|---------|
| `config` | Persisted override in `config.toml` (`features.<name>`) |
| `default` | Statsig snapshot only (no config override) |
| `config+statsig` | Dual-channel: config override **and** discovered Statsig gate override |
| `catalog` | Fallback catalog entry when list API is unavailable |

Dual-channel flags (e.g. `chronicle`, `computer_use`, `browser_use`) need both config persistence and Statsig gate overrides so Codex UI hooks stay in sync after restart. Gate IDs are discovered from localStorage evaluations, `statsig_default_enable_features`, bundle proximity hints, and persisted `explodex-feature-gate-hints`.

## Stage grouping

Flags from `list-experimental-features` are grouped by Codex `stage`:

| Stage | Header | Meaning |
|-------|--------|---------|
| `stable` | Stable | Generally available |
| `beta` | Beta | Wider rollout, still changing |
| `underDevelopment` | Under development | Experimental / internal |
| `removed` | Removed | Deprecated; toggle may be noop |
| (null) | Unclassified | Catalog fallback when stage is missing |

The popover and settings panel show a **Jump to** row above the scrollable list (Stable · Beta · …) when more than one stage section is visible. Filtering updates both the list and jump links.

## Implementation

- **List**: `list-experimental-features` when AppServer is captured; otherwise Statsig snapshot + `get-configuration`.
- **Persist**: `batch-write-config-value` or `set-configuration` RPC fallback, then `Explodex.flags.propagate()` to refresh Codex caches and Statsig hooks.
- **Rehydrate**: On init and after refresh, reads `config.user` overrides, propagates, then re-applies cache overrides (propagate would otherwise wipe them).
- **Settings mount**: `.main-surface` content on `/settings/general-settings` (router pathname via React fiber, not `location.pathname`).
- **Popover layout**: Flex column; only the flags list scrolls (`sdk/explodex-sdk.js` `.ex-popover` / `.ex-popover-body`).

## Lifecycle

- Teardown clears route polling, refresh timers, sidebar subscription, settings panel, and popover.
- `rehydratePersistedFlags()` runs on load and after each refresh.

## Risks

- Private Codex APIs and Statsig gate IDs can change across releases.
- Some flags (e.g. chronicle sidecar) may need a native Codex enable flow or restart beyond config + gate override.
- Settings panel mount selectors may drift after Codex sidebar/shell upgrades — compare layout snapshots.

## Verify

1. `bun run dev` (or `bun run inject` into a running session).
2. Open sidebar **Feature Flags** — confirm stage headers, jump links, and single scroll area in the popover.
3. Toggle a flag — confirm toast, badge, and persistence after `Explodex.plugins.unload/load` or app restart.
4. Navigate to **Settings → General** — confirm embedded panel mounts.
5. For dual-channel flags, confirm Statsig gate override in localStorage after toggle.