# Narrow AppServer Capture

## Context

`sdk/explodex-sdk.js` discovers Codex's renderer app-server bridge partly by wrapping `Function.prototype.call` and `Function.prototype.apply`. That works, but it is broad and difficult to reason about in a minified app.

## Goal

Replace or contain the broad monkeypatch with a narrower discovery path while preserving existing bridge APIs.

## Investigation Targets

- `extracted/webview/assets/` bridge callsites for `update-thread-settings-for-next-turn`
- renderer globals created near app bootstrap
- IPC preload bridge objects exposed before React mounts
- stable request/response envelope fields used by `start-turn-for-host`

## Steps

1. Add debug logging around current capture, gated by a local storage flag.
2. Record the first successful capture stack and object shape.
3. Search extracted chunks for the same method names and object construction path.
4. Prototype a narrower hook around that construction path.
5. Keep the current broad capture as fallback for one release.
6. Document the final bridge type strings in `docs/codex-architecture.md`.

## Verification

- `npm run validate`
- Prefix plugin still updates effort through the bridge.
- Project pin plugin still updates `sidebar-project-thread-orders`.
- No repeated patch/unpatch churn in renderer console logs.

