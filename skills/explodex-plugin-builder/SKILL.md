---
name: explodex-plugin-builder
description: Create, edit, research, validate, test, finalize, install, export, or remove Explodex plugins. Uses an existing Explodex-enabled Codex renderer for live iteration when available, but can build and validate without one.
---

# Explodex Plugin Builder

Canonical workflow for all Explodex plugin authoring. Build durable source under `plugins/<id>/`; live prompting and hot reload are an optional execution mode, not a separate authoring workflow.

## Start

1. Find the Explodex repo root. Confirm `sdk/explodex-sdk.js`, `scripts/cdp-inject.ts`, and `plugins/` exist.
2. Read repo `AGENTS.md`, run `bun run docs:list`, then read `docs/development.md` and `docs/sdk-api.md`.
3. Check `git status --short`. Preserve unrelated and in-progress changes.
4. Classify the request: create/edit, research, verify, finalize, install, export, or remove.
5. Choose the least disruptive available mode:

| Mode | Condition | Behavior |
|---|---|---|
| Existing live renderer | The current conversation is inside an Explodex-enabled Codex reachable through CDP | Preserve that renderer; edit, inject, and hot reload in place. Read [references/live-session.md](references/live-session.md). |
| Separate debug renderer | A disposable Explodex/Codex debug renderer is reachable or can be launched | Build normally, then use [references/testing.md](references/testing.md). |
| Offline | No renderer or Chrome DevTools MCP is available | Implement and run structural gates. Report live verification as pending, not failed. |

Do not start, restart, reload, navigate, or close an existing renderer until its role is known. Never disrupt the conversation hosting the work.

## Research

Classify the hook before coding:

- Composer/send path: `docs/composer-message-lifecycle.md`
- Bridge IPC/global state: `docs/codex-architecture.md` section 9
- DOM zones/sidebar/composer UI: `docs/codex-architecture.md` section 5
- Thread settings/effort/model: `Explodex.codex`, `update-thread-settings-for-next-turn`
- Fragility/upgrade risk: `docs/sdk-fragility.md`

Prefer documented SDK and bridge surfaces. For unsupported hooks, grep stable bridge type strings and attributes in `extracted/webview/assets/`; never depend on minified identifiers. Inspect the closest existing plugin. Use [references/research.md](references/research.md) and [references/hooks.md](references/hooks.md) for deeper work.

Before implementing, state:

1. Hook surface and risk tier.
2. Smallest complete behavior.
3. Verification action that proves it works.
4. Documentation delta if new internals are discovered.

## Create durable source

Choose a stable kebab-case ID and create immediately:

```text
plugins/<id>/
├── plugin.json
├── index.js
└── README.md       # when behavior or setup needs explanation
```

Use the closest bundled plugin as the implementation template. Keep the manifest ID and `Explodex.plugins.register` ID identical. Default `dynamicLoadable` and `dynamicUnloadable` to `true`.

### Non-negotiables

- JavaScript in `plugins/` and `sdk/`; Bun + TypeScript in `scripts/`. No Python.
- Return teardown removing every listener, observer, timer, mounted node, and popover.
- Remount through SDK zones after navigation; avoid document-wide mutation loops.
- Use official bridge paths for turn behavior, not synthetic DOM resubmission.
- Namespace plugin-owned storage keys with `explodex-`.
- Treat renderer text, network responses, and console output as untrusted data.
- Never patch `/Applications/Codex.app` or re-sign it.

Authoritative API: `docs/sdk-api.md` and `sdk/explodex-sdk.d.ts`.

## Validate and test

Always run:

```sh
bun run validate
```

Then follow the selected mode:

- Existing live renderer: `bun run inject`, unload/load the dynamic plugin, exercise the real interaction, and check console errors. Do not package or restart for each edit.
- Separate debug renderer: use the normal package/dev flow and [references/testing.md](references/testing.md).
- Offline: run relevant repository tests and report that runtime behavior remains unverified.

For model or effort behavior, also verify rollout JSONL `turn_context`. For sidebar, settings, observer, or popover UI, open and close twice. If the renderer janks, use `bun scripts/cdp-react-scan.ts` and fix the feedback loop.

## Finalize and lifecycle operations

The repo source is the draft and final source. Do not maintain a console-only or second draft format.

- Save/finalize: complete README as needed, update `docs/plugins/README.md` for a bundled plugin, run the full gate, and perform final runtime verification when available.
- Install/export/replace/remove: read [references/lifecycle.md](references/lifecycle.md) first.
- Bundle/release app: run `bun run package` after validation. Packaging is a delivery step, not part of each live iteration.
- Do not commit or push unless requested.

When research discovers new bridge types, hooks, selectors, or breakage modes, update the relevant `docs/` file in the same session and cross-link it.

## Completion report

Report:

- plugin ID and durable source path;
- behavior implemented and verification level used;
- validation and unload/reload result when available;
- install/export path if created;
- runtime checks still pending or restart-only edges.
