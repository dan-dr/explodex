# Split SDK Modules

## Context

`sdk/explodex-sdk.js` is the injected runtime and currently holds zones, storage, bridge helpers, plugin lifecycle, UI, and app-server capture in one large file. That keeps injection simple but makes review and testing harder.

## Goal

Author SDK source as smaller modules while preserving a single injected output file.

## Proposed Shape

```text
sdk/
  src/
    core.js
    zones.js
    plugins.js
    bridge.js
    ui.js
    app-server.js
  explodex-sdk.js
dist/
  explodex-sdk.js
```

Keep `sdk/explodex-sdk.js` as the checked-in injection artifact until the launch/sync scripts can consume `dist/explodex-sdk.js` reliably.

## Steps

1. Add a dependency-light bundler script or use plain Node to concatenate ESM modules into the existing IIFE wrapper.
2. Move one concern at a time, starting with pure helpers and UI catalog code.
3. Keep `window.Explodex` and the legacy `window.BetterCodex` alias behavior unchanged.
4. Update `scripts/cdp-inject.py`, `scripts/sync-wrapper.sh`, and docs only after the output path is stable.
5. Add a syntax gate for every module and the generated bundle.

## Verification

- `npm run validate`
- `npm run launch`
- Confirm `window.Explodex.version` in a Codex renderer debug session.
- Confirm plugin catalog loads from `plugins/<id>/plugin.json`.

