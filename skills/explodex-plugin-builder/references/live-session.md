# Existing live renderer mode

Use this mode when plugin work happens inside the Explodex-enabled Codex instance hosting the conversation.

## Preserve the live instance

1. Use Chrome DevTools MCP `list_pages` and select the existing `Codex (app://-/index.html)` renderer.
2. Probe `window.Explodex` before editing.
3. If CDP is connected, do not run `bun run dev`, navigate, reload, close the page, package, or restart Codex. Use `bun run inject` for updates.
4. If no renderer is reachable on `EXPLODEX_DEBUG_PORT` (default `9333`), fall back to offline mode. Start `bun run dev` only when it cannot disrupt an active conversation.

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

Run `bun run inject` if `sdk` is false. Do not reload the page.

## Iteration loop

1. Edit `plugins/<id>/`.
2. Run `bun run validate`.
3. Run `bun run inject`.
4. Confirm the ID appears in `Explodex.plugins.listCatalog()` and `Explodex.plugins.list()`.
5. Unload and verify all plugin UI/effects disappear.
6. Load and verify one clean copy returns.
7. Take an accessibility snapshot, exercise the real interaction, snapshot again, and inspect new console errors.
8. For sidebar, settings, observer, or popover UI, open and close twice.

Keep composer text untouched unless testing composer behavior requires it; restore test text afterward. Do not submit a real turn unless submission is the feature under test.

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

## Teardown and reload proof

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
  return { before, unloaded, absentAfterUnload, nodesAfterUnload, loaded, presentAfterLoad };
}
```

`unloaded: false` can mean the plugin is not loaded or is not dynamically unloadable. Inspect its manifest before diagnosing.

## Interaction verification

1. Take a snapshot and locate the control by accessible name.
2. Click its current UID; never reuse a UID after DOM changes.
3. Take a new snapshot.
4. Probe intended state through the SDK, bridge, or DOM.
5. Read new console errors, filtered by plugin ID when noisy.
6. Repeat open/close once to detect duplicate handlers or observer loops.
