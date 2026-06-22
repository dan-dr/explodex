# Runtime React Root (`window.__codexRoot`)

Date: 2026-06-21

## Summary

The live Codex renderer exposes `window.__codexRoot`. It is the React root object returned by ReactDOM's `createRoot`, not a stable Codex application API.

Observed via the DevTools endpoint at `http://127.0.0.1:9333`:

- `window.__codexRoot` exists in the main `app://-/index.html` renderer.
- Constructor names are minified (`Fp` for the public root, `$f` for the internal root in this build).
- Own keys: `['_internalRoot']`.
- Prototype methods: `render(element)` and `unmount()`.
- `_internalRoot.containerInfo` is `#root`.
- `_internalRoot.current` is the Fiber root (`tag === 3`).
- `window.React` and `window.ReactDOM` are not global.
- `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` was not present in the inspected session.
- The literal string `__codexRoot` was not found in `extracted/webview/assets/`; treat it as runtime/bootstrap state rather than a durable source symbol.

## Shape

```text
window.__codexRoot
└── _internalRoot
    ├── containerInfo  → HTMLDivElement#root
    ├── current        → React Fiber root
    ├── pendingLanes / suspendedLanes / ...
    ├── onUncaughtError / onCaughtError / onRecoverableError
    └── other React scheduler/cache internals
```

`String(window.__codexRoot.render)` in this build shows the expected minified React root render wrapper. Calling it would schedule a new React render for the whole Codex app root.

## What it is useful for

### Read-only diagnostics

`__codexRoot._internalRoot.current` can be traversed to inspect the current Fiber tree:

- Count mounted fibers and host nodes.
- Locate host fibers for DOM elements such as `aside.app-shell-left-panel`.
- Map a DOM node back to its owning fiber via React expando keys like `__reactFiber$...`.
- Inspect component/provider topology when DOM selectors are not enough.
- Confirm that Explodex-injected DOM is outside React's Fiber tree, so React may remove it during host child reconciliation.

This is useful for explaining why DOM-zone plugins must observe/remount rather than assuming injected nodes are owned by React.

### Commit/remount signals

Because the React DevTools hook was absent in the inspected session, `__codexRoot` does not directly provide a public commit subscription. Practical options are:

1. Continue using DOM `MutationObserver` + `observeZone()` for production plugin remounts.
2. For debug tooling, poll or sample `_internalRoot.current` and traverse host fibers after suspected UI changes.
3. For future reloads only, install a small `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React initializes and use `onCommitFiberRoot` as an additional debug signal. This must be defensive and optional. See [early-injection-and-inspect-brk.md](./early-injection-and-inspect-brk.md) §4–6 for delivery via `addScriptToEvaluateOnNewDocument` and limits on props injection.

### Context/provider discovery

Fiber traversal can reveal React context providers such as router `Navigation`, router `Location`, route context, layout sizing context, tooltip/popover contexts, and app-level account/config providers.

Provider values can include personal/account metadata and live service objects. Do not dump provider values into logs/docs. Use allowlisted key summaries only.

## What not to do

- Do not call `window.__codexRoot.render(...)` for plugin UI. It targets the entire Codex app root and can replace or corrupt the app tree.
- Do not call `window.__codexRoot.unmount()` except in a throwaway debugging session; it unmounts Codex.
- Do not mutate fibers (`memoizedProps`, `memoizedState`, `stateNode`, lanes, update queues). React internals are not stable and direct mutation can corrupt scheduling.
- Do not depend on minified component names (`Fp`, `$f`, `Zf`, etc.). They change across builds.
- Do not treat provider context values as safe plugin API. They can contain sensitive user/account data and unstable function identities.

## Explodex implications

`__codexRoot` is valuable as a **debug/research aperture**, not as the primary extension mechanism.

Recommended architecture remains:

```text
CDP injection
  └─ Explodex SDK
      ├─ DOM zones + observeZone() for persistent mounts
      ├─ official bridge calls for Codex behavior changes
      └─ optional debug-only Fiber inspection helpers
```

Potential future SDK addition:

```js
Explodex.debug.reactRoot()      // returns a redacted root summary
Explodex.debug.findOwnerFiber(el) // maps a DOM node to a shallow fiber summary
```

Keep these under `debug` and make them read-only. Production plugin behavior should continue to use `observeZone()` and bridge APIs.
