# Architecture Review

Date: 2026-06-21

## Current Shape

Explodex injects one renderer SDK into Codex through CDP. The SDK exposes DOM zones, storage helpers, bridge helpers, HTTP helpers, and plugin lifecycle APIs. Plugins are loaded from a catalog produced by `scripts/cdp-inject.py`.

The project now uses plugin folders:

```text
plugins/<id>/
  plugin.json
  index.js
```

This mirrors Codex's own manifest-oriented plugin conventions without pretending to be the official Codex plugin system.

## Findings

| Finding | Impact | Change Made |
|---------|--------|-------------|
| Public repo would have captured huge local artifacts | `vendor/` and `extracted/` include proprietary/reverse-engineered output | Added `.gitignore`; kept artifacts local |
| Flat plugin files did not carry standalone metadata | Harder to document, catalog, review, or selectively load plugins | Added `plugin.json` per plugin and folder discovery |
| Reasoning prefix restored effort on next frame | Restore could race async submit and revert before Codex consumed settings | Changed restore to a bounded post-submit timer |
| Project pin preserved `sortKey` | Codex ignores manual `threadIds` when `sortKey` is set, so project pins appeared saved but did not reorder | Project-pin order now removes `sortKey` and reconciles pinned order |
| SDK is a large single injected file | Harder to review and test; currently above repo LOC guidance | Deferred: split into modules plus a build step |
| AppServer router capture patches `Function.prototype.call/apply` | Powerful but broad monkeypatch; possible perf/debug risk | Deferred: isolate capture or find official hook |

## Direction

The concrete follow-up plans live in [plans/](../plans/README.md).

### Split SDK Source

Keep the injected runtime as one bundled file, but author it as modules under `sdk/src/` and build `sdk/explodex-sdk.js` into `dist/` or the current SDK path. This gives reviewers smaller files while preserving CDP injection simplicity.

### Treat Plugins as Packages

The new manifest layout should grow fields over time:

- `permissions`
- `zones`
- `docs`
- `settings`
- `codexVersionRange`

Do not add those until the loader enforces or displays them.

### Add Runtime Smoke Tests

The current `npm run validate` gate is syntax-only. Add a CDP smoke test that launches the static harness, verifies `window.Explodex`, verifies the plugin catalog, and checks that the shell nav label is `Explodex` with `💥`.

### Reduce Global Monkeypatching

The app-server capture in `sdk/explodex-sdk.js` is the riskiest mechanism. Keep it documented, and prefer a narrower capture once Codex exposes a stable renderer-side router object or event.

## Rejected For Now

- Publishing extracted Codex assets: not appropriate for a public repo.
- Fully reimplementing composer send paths: too much private Codex logic; plugins should stay on official bridge/native composer paths.
- Inline ProseMirror prefix pill: requires editor decorations or node registration not exposed to plugins.
