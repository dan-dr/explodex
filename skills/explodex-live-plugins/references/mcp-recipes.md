# Live renderer recipes

Use Chrome DevTools MCP against the current Codex renderer. Prefer `take_snapshot` over screenshots unless visual layout matters.

## Preflight

Run with `evaluate_script`:

```js
() => ({
  href: location.href,
  title: document.title,
  sdk: typeof window.Explodex !== "undefined",
  version: window.Explodex?.version ?? null,
  bridge: window.Explodex?.bridge?.isAvailable?.() ?? false,
  catalog: window.Explodex?.plugins?.listCatalog?.() ?? [],
  loaded: window.Explodex?.plugins?.list?.() ?? [],
  composerPresent: Boolean(window.Explodex?.composer?.getInput?.()),
})
```

Stop and run `bun run inject` if `sdk` is false. Do not reload the page.

## Plugin status

```js
() => {
  const id = "PLUGIN_ID";
  return {
    cataloged: window.Explodex.plugins.listCatalog().includes(id),
    loaded: window.Explodex.plugins.list().includes(id),
    manifest: window.Explodex.plugins.get(id) ?? null,
    nodes: document.querySelectorAll(`[data-explodex-plugin="${CSS.escape(id)}"]`).length,
  };
}
```

Do not assume `plugins.list()` returns manifest objects; it returns loaded IDs.

## Teardown and reload proof

After `bun run inject` has refreshed the catalog source:

```js
() => {
  const id = "PLUGIN_ID";
  const before = window.Explodex.plugins.list().includes(id);
  const unloaded = window.Explodex.plugins.unload(id);
  const absentAfterUnload = !window.Explodex.plugins.list().includes(id);
  const nodesAfterUnload = document.querySelectorAll(
    `[data-explodex-plugin="${CSS.escape(id)}"]`,
  ).length;
  const loaded = window.Explodex.plugins.load(id);
  const presentAfterLoad = window.Explodex.plugins.list().includes(id);
  return {
    before,
    unloaded,
    absentAfterUnload,
    nodesAfterUnload,
    loaded,
    presentAfterLoad,
  };
}
```

`unloaded: false` can mean the plugin is not loaded or is not dynamically unloadable. Inspect its manifest before diagnosing.

## Removal proof

After unloading, trashing the source, and running `bun run inject`:

```js
() => {
  const id = "PLUGIN_ID";
  return {
    cataloged: window.Explodex.plugins.listCatalog().includes(id),
    loaded: window.Explodex.plugins.list().includes(id),
    nodes: document.querySelectorAll(`[data-explodex-plugin="${CSS.escape(id)}"]`).length,
  };
}
```

All three results must be false, false, and zero.

## Interaction verification

1. Take a snapshot and locate the plugin control by accessible name.
2. Click the returned UID; never reuse a UID after DOM changes.
3. Take a new snapshot.
4. Probe the intended state through the SDK, bridge, or DOM.
5. Read new console errors. Filter by the plugin ID when logs are noisy.
6. Repeat open/close once to detect duplicate handlers or observer loops.

For composer plugins, record the current text before modifying it and restore it after the test. Do not submit a real turn unless submission behavior is the feature under test.
