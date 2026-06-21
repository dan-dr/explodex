# Runtime Smoke Tests

## Context

`npm run validate` is intentionally dependency-free and syntax-only. It cannot catch renderer injection failures, broken sidebar zones, or plugin catalog regressions.

## Goal

Add a small automated runtime smoke test that exercises the static harness and, when available, a Codex debug renderer.

## Proposed Shape

```text
scripts/
  smoke-harness.mjs
  smoke-cdp.py
```

Use direct Chrome DevTools Protocol calls as the fallback path because MCP tools are not always exposed to the agent runtime.

## Harness Checks

1. Load `poc/harness.html`.
2. Assert `window.Explodex` exists.
3. Assert the shell nav includes `Explodex` and the `💥` icon.
4. Assert manifest-backed plugin catalog entries are visible.
5. Toggle each bundled plugin at least once.

## Codex Renderer Checks

1. Launch with `./scripts/launch.sh --no-inject`.
2. Inject with `./scripts/cdp-inject.py`.
3. Assert `window.Explodex.version`.
4. Assert `window.Explodex.plugins.list()` contains the bundled plugins.

## Verification

- `npm run validate`
- `node scripts/smoke-harness.mjs`
- Optional: `python3 scripts/smoke-cdp.py`

