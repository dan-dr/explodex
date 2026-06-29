# Researching Codex Internals for Plugins

Use this when you need to find hook points before implementing.

## Decision tree

```
Affects message send / turn context?
  YES → composer-message-lifecycle.md, bridge types:
        update-thread-settings-for-next-turn, start-turn-for-host, steer-turn-for-host
  NO ↓

Needs persisted app state?
  YES → bridge rpc get-global-state / set-global-state, storage.globalState
  NO ↓

Needs UI in composer/sidebar?
  YES → inject zones (aboveComposer, sidebar, …), components, sidebarNav
  NO ↓

Needs thread model/effort without bridge?
  YES → Explodex.codex (fiber walk — fragile, see sdk-fragility.md)
  NO ↓

Needs backend HTTP?
  YES → Explodex.http (authenticated proxy)
```

## Grep patterns (extracted/)

Run from Explodex repo root. `extracted/` is local-only (not committed).

| Goal | Pattern | Path |
|------|---------|------|
| Bridge message types | `"type":"` or `sendRequest("` | `extracted/webview/assets/` |
| Specific API | `update-thread-settings-for-next-turn` | `extracted/` |
| Composer submit | `handleSubmit`, `start-turn-for-host` | `extracted/webview/assets/composer*.js` |
| Stable DOM hooks | `data-above-composer`, `data-testid` | `extracted/webview/assets/` |
| Global state keys | `thread-project-assignments`, `sidebar-` | `extracted/` |
| Preload bridge | `electronBridge`, `sendMessageFromView` | `extracted/.vite/build/preload.js` |

Prefer **string literals** (bridge `type` names, `data-*` attributes, localStorage prefixes) over minified identifiers (`Ut`, `gw`).

## Docs to read (in order)

1. [docs/sdk-api.md](../../../docs/sdk-api.md): plugin API surface
2. [docs/codex-architecture.md](../../../docs/codex-architecture.md): bundle topology, zones, IPC section 9
3. [docs/composer-message-lifecycle.md](../../../docs/composer-message-lifecycle.md): send path, effort hooks
4. [docs/sdk-fragility.md](../../../docs/sdk-fragility.md): what breaks on Codex upgrade
5. [docs/plugins/README.md](../../../docs/plugins/README.md): bundled plugin index

## Study existing plugins

| Plugin | Teaches |
|--------|---------|
| `reasoning-effort-prefix` | Composer intercept, `codex` settings, bridge models API, debounce/teardown |
| `pin-scope-menu` | Capture-phase DOM, `bridge.rpc`, `storage.globalState`, MutationObserver |
| `usage-reset-sidebar` | `sidebarNav.mount`, `http` proxy, polling, popover UI |

## Research output

Before implementing, write a short plan:

1. **Hook:** bridge type / zone / DOM selector / codex API
2. **Risk tier** (from sdk-fragility): low (data-*) vs high (fiber, Tailwind classes)
3. **Verification:** what MCP script/snapshot proves it works
4. **Doc delta:** which `docs/` file to update if findings are new

## Vendor reference only

- Patch experiments: `vendor/Codex.app` only — never `/Applications/Codex.app`
- Do not commit `extracted/` or `vendor/` — keep findings in `docs/`
