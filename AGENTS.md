# AGENTS.md - Explodex

Instructions for coding agents working in this repository.

## Project summary

Explodex is a package SDK and one-shot CLI for trusted plugins inside the
installed, read-only `/Applications/ChatGPT.app`. `packages/sdk/` owns the
public authoring API and renderer runtime, `packages/cli/` owns host and plugin
operations, and `packages/plugin-registry/explodex-plugin-*` is the physical
seven-workspace first-party collection. Never copy, patch, re-sign, or vendor
the installed host bundle.

## Workspace

- Git worktrees for Explodex should live adjacent to this checkout, not under `/tmp`.
- Use a feature-prefixed sibling path, for example `../Explodex-feature-welcome-screen`.
- Reserve `/tmp` for disposable QA profiles, screenshots, recordings, and build scratch.

## Documentation

**Keep `docs/` up to date.** Documentation is part of the deliverable, not an afterthought.

| Doc | Contents |
|-----|----------|
| [docs/development.md](docs/development.md) | Public repo layout, validation, runtime loop |
| [docs/installation.md](docs/installation.md) | Public CLI installation and plugin trust model |
| [docs/local-development.md](docs/local-development.md) | Isolated development workflow on port 9444 |
| [docs/sdk-api.md](docs/sdk-api.md) | **SDK API reference** for plugin authors and agents |
| [docs/RELEASING.md](docs/RELEASING.md) | **Release procedure** and registry propagation/recovery guidelines |
| [docs/decisions/](docs/decisions/) | Current architecture decisions |

When you change behavior or fix a plugin based on architecture knowledge:

1. Update the relevant doc in the same PR/session (or immediately after).
2. Add cross-links between docs when topics overlap.
3. Record only public SDK contracts and observed host behavior. Do not commit private host extraction.
4. Do not duplicate large sections - link and add a short delta.

When changing SDK behavior, update [docs/sdk-api.md](docs/sdk-api.md), public
types under `packages/sdk/src/types/`, and generated SDK output in the same
change.

### `research` / `document` requests

When the user says **research**, **document**, **map**, **research/document**, or similar:

- **Research** -> investigate public SDK types, package runtime behavior, and exact live observations, then **write or update** docs with findings.
- **Document** → create or refresh docs even if no code changes are requested.
- Default output location: `docs/<topic>.md` (kebab-case). Update [docs/sdk-api.md](docs/sdk-api.md) when adding public SDK behavior.
- If research invalidates existing docs, fix the old doc and note what changed.

Do not leave long architectural explanations only in chat - persist them under `docs/`.

## Code conventions

### Languages

- **Do not write Python** in this repo. Python scripts were removed; do not reintroduce them.
- **Repository scripts and package sources**: Bun + TypeScript.
- **Published CLI and SDK**: Node.js 22 and 24 compatible package output.
- **Plugin authoring**: TypeScript importing only public `@explodex/sdk`.
- **Generated renderer runtime and plugin entries**: browser-safe JavaScript;
  never hand-edit generated `dist/` files.

### Runtime

- Plugins: `package.json` + `explodex.config.ts` + `src/index.ts`; export one
  `definePlugin` result. The CLI generates the manifest and inert registration.
- Use only documented `PluginApi` capabilities when affecting host behavior.
- Match existing plugin/SDK style; minimal diffs; no drive-by refactors.
- Verify effort/model changes against rollout JSONL `turn_context` when touching reasoning-effort behavior.

## Key paths

```
packages/sdk/              # Public authoring API and generated renderer runtime
packages/cli/              # Package CLI, host evidence, artifacts, lifecycle
packages/plugin-registry/  # Seven first-party workspaces and registry tooling
skills/                    # Self-contained authoring workflow and snapshots
docs/                      # Architecture, lifecycle, SDK, and release docs
```

## Commands

```bash
bun run build:npm            # Generate SDK and CLI package output
bun run checkTs              # Type-check SDK and CLI
bun run validate             # Full repository gate
bun run dev:ensure           # Reuse or start isolated development on 9444
bun run dev:status           # Read-only owned development status
bun scripts/cdp-layout-snapshot.ts  # Exact 9444 renderer layout evidence
bun scripts/cdp-react-devtools.ts   # Exact 9444 React fiber probe
bun scripts/cdp-react-scan.ts       # Exact 9444 render performance overlay
```

## Verification

When the user asks to **test if working** (or similar), verify behavior in an
exact live Codex renderer inside ChatGPT through CDP, not by code review alone.

1. Build and validate the plugin artifact before touching a renderer.
2. Prefer the exact owned development instance on `127.0.0.1:9444` for
   disruptive work. Never restart, reload, navigate, close, or stop an authoring
   main.
3. Run `explodex --json plugin develop <workspace>` for the exact identified
   target. Dynamic plugins may then unload/load without a renderer restart.
4. Confirm the feature under test: plugin registration, DOM hooks, bridge calls, and user-visible behavior.

Normal operations are bounded and exit. There is no daemon or supervisor. Only
an explicitly invoked foreground plugin development command may remain alive.
