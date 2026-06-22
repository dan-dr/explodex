# Runtime Smoke Tests

## Context

`npm run validate` is intentionally dependency-free and syntax-only. It cannot catch renderer injection failures, broken sidebar zones, or plugin catalog regressions.

## Goal

Add a small automated runtime smoke test that exercises a Codex debug renderer via CDP.

## Proposed Shape

```text
scripts/
  smoke-harness.mjs
  smoke-cdp.py
```

Use direct Chrome DevTools Protocol calls as the fallback path because MCP tools are not always exposed to the agent runtime.

## Renderer Checks (CDP)

1. Launch with `bun run dev` or an existing debug session on port `9333`.
2. Inject with `bun run inject`.
3. Assert `window.Explodex` exists.
4. Assert the shell nav includes `Explodex` and the `💥` icon.
5. Assert manifest-backed plugin catalog entries are visible.
6. Toggle each bundled plugin at least once.

## Verification

- `bun run validate`
- Optional: `bun scripts/smoke-cdp.ts` (future)

