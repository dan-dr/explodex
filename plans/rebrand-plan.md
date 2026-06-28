# Rebrand Plan — Exact Changes

Status: ready to implement (decisions locked)

Decisions:
- **Keep the name Explodex** and the 💥 identity.
- **Don't lead with "BetterDiscord for Codex"** — keep it as a parenthetical far down.
- Lead with **plain-language outcomes** (real things people ask for in Codex).
- **Leave incognito-threads out** for now.
- **Full confidence** copy: kill "monstrosity / extremely hacky / use at your own risk."
- **Lean README**: keep it short, split deep content into `docs/`, link out.
- **Easy install + update**: one-line installer + prebuilt release + update path.
- **Rename plugin ids AND everything** (folders, manifest, names, storage keys).
- **Add a real migration mechanism** so plugins can carry settings across id/version
  changes (we're the only user today, but build it properly).

Nothing here is applied yet.

---

## Part A — Plugin renames (ids, folders, names, descriptions)

Final names chosen by Dan. Since we're renaming ids too, this is a full rename
(folder + `plugin.json` `id`/`name`/`description` + storage keys + SDK defaults +
docs). Old→new settings are preserved by the migration mechanism in Part B.

| Old id / folder | New id / folder | New display name | New description |
|---|---|---|---|
| `command-menu-thread-search` | `command-menu-threads` | **Threads in Command Menu** | Find any thread from ⌘K — including threads inside collapsed projects, listed first. |
| `feature-flags-settings` | `feature-flags-playground` | **Feature Flags Playground** | Toggle Codex's experimental feature flags from Settings — changes persist across restarts. |
| `pin-scope-menu` | `project-pins` | **Project Pins** | Pin a thread to its project instead of globally, and keep it at the top of that project. |
| `project-folder-colors` | `project-colors` | **Project Colors** | Color-code projects and their threads in the sidebar so you can tell them apart at a glance. |
| `reasoning-effort-prefix` | `effort-shortcuts` | **Effort Shortcuts** | Set reasoning effort from the composer — type `!m` or `!xh`, stripped on send, restored after. |
| `usage-reset-sidebar` | `usage-reset-glance` | **Usage and Reset Glance** | Always-on usage and credit-reset status in the sidebar — no clicking required. |
| `views` | `workspaces` | **Workspaces** | Split your window into persistent tiled workspaces for threads, browsers, and terminals. |

### A1. Per-plugin storage-key renames

Each plugin's localStorage keys are renamed to match the new id. Old values are
moved by a migration (Part B). Mapping of the keys to migrate:

| Plugin (new id) | Old key(s) | New key(s) |
|---|---|---|
| `command-menu-threads` | `explodex-cmdk-thread-search` | `explodex-command-menu-threads` |
| `feature-flags-playground` | `explodex-feature-flags-settings`, `explodex-feature-gate-hints` | `explodex-feature-flags-playground`, `explodex-feature-flags-playground-gate-hints` |
| `project-pins` | `explodex-project-pinned-threads` (transitional localStorage) | `explodex-project-pins-pinned-threads` |
| `project-colors` | `explodex-project-colors` | `explodex-project-colors` *(already matches — no change)* |
| `effort-shortcuts` | `explodex-reasoning-effort-prefix` | `explodex-effort-shortcuts` |
| `usage-reset-glance` | `explodex-usage-reset-sidebar` | `explodex-usage-reset-glance` |
| `workspaces` | `explodex-views-v1`, `explodex-views-settings` | `explodex-workspaces-state`, `explodex-workspaces-settings` |

Notes:
- `project-pins` also uses `globalState` keys (`projectPins`, `projectOrders`) via
  the bridge — those are **not** id-derived; leave them unchanged (no migration).
- `project-colors` key already happens to match the new id; leave as-is.
- `feature-flags-playground` reads Codex-owned keys (`statsig_*`, query keys) — only
  the `explodex-*` keys above are ours to rename.

### A2. Mechanical rename steps (per plugin)

1. `git mv plugins/<old> plugins/<new>`
2. Edit `plugins/<new>/plugin.json`: `id`, `name`, `description`, add `previousIds`.
3. Edit `plugins/<new>/index.js`: update the `*_KEY` constants to new keys, add an
   `api.migrate([...])` call (Part B3) at the top of `setup`.
4. Rename screenshot `docs/plugins/screenshots/<old>.png` → `<new>.png` and update
   README references.

Example `plugin.json` (effort-shortcuts):
```diff
-  "id": "reasoning-effort-prefix",
-  "name": "Reasoning Effort Prefix",
+  "id": "effort-shortcuts",
+  "name": "Effort Shortcuts",
+  "previousIds": ["reasoning-effort-prefix"],
   "version": "2.3.0",
   "entry": "index.js",
-  "description": "Applies a reasoning effort from composer prefixes like !m or !xh, strips the prefix on send, then restores the previous effort.",
+  "description": "Set reasoning effort from the composer — type !m or !xh, stripped on send, restored after.",
```

---

## Part B — Migration mechanism (new SDK capability)

Two layers: (1) the SDK automatically carries **enabled/disabled state** across an
id change via `previousIds`; (2) plugins move their **own storage data** via a
new `api.migrate()` with a run-once ledger.

### B1. Manifest field: `previousIds`

`plugin.json` gains an optional `previousIds: string[]`. Declares former ids so the
SDK can carry enabled-state and so migrations have context.

### B2. SDK: automatic enabled-state carryover

In `sdk/explodex-sdk.js`, update `defaultEnabledState()` to the new ids and add a
one-time carryover when a plugin is declared/registered.

```diff
 function defaultEnabledState() {
   return {
-    "command-menu-thread-search": true,
-    "usage-reset-sidebar": true,
-    "reasoning-effort-prefix": true,
-    "pin-scope-menu": true,
-    "feature-flags-settings": true,
-    "project-folder-colors": true,
+    "command-menu-threads": true,
+    "usage-reset-glance": true,
+    "effort-shortcuts": true,
+    "project-pins": true,
+    "feature-flags-playground": true,
+    "project-colors": true,
+    "workspaces": true,
   };
 }
```

New helper (reads the **raw** stored map so it only acts on explicit user choices):
```js
function migrateEnabledState(manifest) {
  const prev = manifest?.previousIds;
  if (!Array.isArray(prev) || prev.length === 0) return;
  const stored = storage.persisted.get(PLUGIN_ENABLED_KEY, {}) ?? {};
  if (manifest.id in stored) return; // user already chose for the new id
  for (const oldId of prev) {
    if (oldId in stored) {
      stored[manifest.id] = stored[oldId];
      delete stored[oldId];
      writeEnabledMap(stored);
      return;
    }
  }
}
```
Call `migrateEnabledState(normalized)` inside `declarePlugin` (and `registerPlugin`
for dynamically-loaded plugins) right after the manifest is normalized.

### B3. SDK: `api.migrate(migrations)` with a run-once ledger

Add to the per-plugin `pluginApi` (next to `registerOptions`):
```js
migrate: (migrations) => runPluginMigrations(id, normalized, migrations, pluginLog),
```

Implementation:
```js
const MIGRATIONS_LEDGER_PREFIX = "explodex-migrations:";

async function runPluginMigrations(pluginId, manifest, migrations, pluginLog) {
  if (!Array.isArray(migrations) || migrations.length === 0) return;
  const ledgerKey = `${MIGRATIONS_LEDGER_PREFIX}${pluginId}`;
  const applied = new Set(storage.persisted.get(ledgerKey, []) ?? []);
  const ctx = {
    storage,
    bridge,
    pluginId,
    previousIds: manifest.previousIds ?? [],
    log: pluginLog,
    // helper for the common case: move a localStorage value to a new key
    renameKey(oldKey, newKey) {
      const val = storage.persisted.get(oldKey, undefined);
      if (val === undefined) return false;
      if (storage.persisted.get(newKey, undefined) === undefined) {
        storage.persisted.set(newKey, val);
      }
      storage.persisted.remove(oldKey);
      return true;
    },
  };
  for (const m of migrations) {
    if (!m || !m.id || typeof m.run !== "function") continue;
    if (applied.has(m.id)) continue;
    try {
      await m.run(ctx);
      applied.add(m.id);
      storage.persisted.set(ledgerKey, [...applied]); // record after success
      pluginLog.info("migration applied", { id: m.id });
    } catch (err) {
      pluginLog.error("migration failed (will retry next load)", { id: m.id, err });
      // not recorded → retried on next load
    }
  }
}
```

Design points:
- **Idempotent**: each migration runs once; ledger keyed by plugin id.
- **Async-friendly**: `run` may be async (e.g. `project-pins` touching `globalState`).
- **Crash-safe**: a failed migration isn't recorded, so it retries next load.
- **Plugin-owned**: only the plugin knows its keys; SDK supplies `renameKey` helper.

### B4. Plugin usage (top of `setup`)

```js
await api.migrate([
  {
    id: "rename-keys-from-reasoning-effort-prefix",
    run: ({ renameKey }) => {
      renameKey("explodex-reasoning-effort-prefix", "explodex-effort-shortcuts");
    },
  },
]);
let settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null)); // SETTINGS_KEY is now the new key
```

Each renamed plugin gets one migration entry covering its key map from Part A1.
`project-colors` needs no migration (key unchanged); its existing internal
`migrateSettings()` (schema versioning) stays as-is.

### B5. Types + docs for the new API

- `sdk/explodex-sdk.d.ts`: add `previousIds?: string[]` to the manifest type, and
  `migrate(migrations: PluginMigration[]): Promise<void>` to the plugin API, with a
  `PluginMigration` / `MigrationContext` type (incl. `renameKey`).
- `docs/sdk-api.md`: document `previousIds`, `api.migrate`, the ledger semantics,
  and the `renameKey` helper, with the example above.

---

## Part C — README slimming + doc split

Goal: README is a **landing page**, not a manual. Keep what sells + the 30-second
install; push depth into `docs/` and link.

### C1. New lean README outline

```md
# Explodex 💥
**Mod the Codex desktop app.**
<one-line outcome pitch>
<quick links: Install · Plugins · Write a plugin · Docs>

<demo video>

## What you can do        → plugin showcase table (new names + screenshots)

## Install                → one-liner + zip fallback (details → docs/install.md)

## Write a plugin         → ~12-line teaser → docs/sdk-api.md, docs/development.md

## Compatibility & safety → 3 sentences → docs/sdk-fragility.md

## Docs                   → small index table

<not affiliated with OpenAI>
```

### C2. What moves OUT of the README (into docs/)

| Current README section | Destination |
|---|---|
| Prerequisites, full "Install", "Develop", "Commands" table | **new `docs/install.md`** (+ existing `docs/development.md`, `docs/local-development.md`) |
| "How it works" internals (zones, bridge, IPC) | `docs/codex-architecture.md` (already exists — link, don't duplicate) |
| Full "Write a plugin" walkthrough, folder layout, user-plugin override details | `docs/sdk-api.md` / `docs/development.md` |
| "Safety Boundary" (vendor/extracted ignore rules) | `docs/development.md` |

### C3. Hero copy (before → after)

**Before**
```md
# Explodex  💥 💥 💥 Mod the official Codex app

Explodex is an extension SDK and plugin playground for the Codex desktop app. It injects a small renderer runtime into a Codex Electron window, exposes DOM zones such as the sidebar and composer, and loads plugins from `plugins/<id>/`.

> ⚠️ **Warning** — This is extremely hacky, built almost entirely with AI. ...
```
**After**
```md
# Explodex 💥

**Mod the Codex desktop app.**

Add plugins to OpenAI's [Codex](https://openai.com/codex) desktop app: search every
thread from ⌘K, color-code your projects, keep usage stats on screen, set reasoning
effort with a keystroke, and more. Runs entirely on your machine and never touches
your installed Codex.

[**Install in 30 seconds**](#install) · [Plugins](#what-you-can-do) · [Write a plugin](#write-a-plugin) · [Docs](#docs)
```

### C4. "Why" (demote BetterDiscord) and warning (apology → fact, moved to bottom)

```md
## Why
Most of these plugins come from things people keep asking for in Codex — or things
I wanted while living in it all day. Codex is great but closed; Explodex makes it
malleable. (Used BetterDiscord or Legcord? Same idea, for Codex.)
```
```md
## Compatibility & safety
Explodex injects locally into Codex's renderer. It **never modifies** your installed
`/Applications/Codex.app` and runs entirely on your machine. Because it hooks Codex
internals, a plugin may need an update when Codex ships a new release — see
[docs/sdk-fragility.md](../docs/sdk-fragility.md).

Not affiliated with, endorsed by, or supported by OpenAI.
```
Delete: "monstrosity", "extremely hacky", "built almost entirely with AI", "Use at
your own risk".

---

## Part D — Install & update accessibility

Today the only path is clone → install **Bun** → install **Swift/Xcode** (`swiftc`
is used in `scripts/package-app.ts`) → `bun run link:app`. Wall for non-devs.
`Explodex.app` only *launches* the installed Codex (doesn't embed it), so a
prebuilt bundle is self-contained — ship it.

### D1. New `install.sh` (repo root, curl-able) — also the update path
```sh
#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/dan-dr/explodex/main/install.sh | sh
set -e
REPO="dan-dr/explodex"; APP="/Applications/Explodex.app"; USER_PLUGINS="$HOME/.explodex/plugins"
[ "$(uname)" = "Darwin" ] || { echo "macOS only."; exit 1; }
[ -d "/Applications/Codex.app" ] || { echo "Install Codex first: https://openai.com/codex"; exit 1; }
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o 'https://[^"]*Explodex\.app\.zip' | head -n1)
[ -n "$URL" ] || { echo "No release asset. See https://github.com/$REPO/releases"; exit 1; }
TMP=$(mktemp -d); curl -fsSL "$URL" -o "$TMP/Explodex.app.zip"; unzip -q "$TMP/Explodex.app.zip" -d "$TMP"
[ -d "$APP" ] && rm -rf "$APP"; cp -R "$TMP/Explodex.app" "$APP"
xattr -cr "$APP" 2>/dev/null || true; codesign --force --deep -s - "$APP" 2>/dev/null || true
mkdir -p "$USER_PLUGINS"; rm -rf "$TMP"
echo "Installed $APP — launch with: open \"$APP\" (quit Codex first)."
```
Re-running it updates an existing install.

### D2. New `scripts/release.ts` (build + zip the distributable)
```ts
#!/usr/bin/env bun
import { join } from "node:path"; import { spawn } from "bun"; import { packageApp } from "./package-app.ts";
const ROOT = join(import.meta.dir, ".."); const APP = join(ROOT,"dist","Explodex.app"); const ZIP = join(ROOT,"dist","Explodex.app.zip");
const run = async (c: string[]) => { const p = spawn(c,{cwd:ROOT,stdout:"inherit",stderr:"inherit"}); if (await p.exited) throw new Error(c.join(" ")); };
await packageApp({ release: true });
await run(["codesign","--force","--deep","-s","-",APP]).catch(()=>{});
await run(["ditto","-c","-k","--keepParent",APP,ZIP]);
console.log("Release asset: "+ZIP);
```

### D3. New `.github/workflows/release.yml` (build prebuilt on tag)
```yaml
name: release
on: { push: { tags: ["v*"] } }
jobs:
  build:
    runs-on: macos-14
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun scripts/release.ts
      - uses: softprops/action-gh-release@v2
        with: { files: dist/Explodex.app.zip }
```

### D4. `package.json`
```diff
     "dev": "bun scripts/dev.ts",
+    "release": "bun scripts/release.ts",
```
Bump `version` per release; tag `vX.Y.Z` drives the GitHub Release + asset.

### D5. Optional follow-up: in-app "Check for updates"
Button on the 💥 Explodex settings page comparing bundled version to latest release
tag; if newer, show the one-line install command. Defer until D1–D4 land.

---

## Part E — Repo metadata
- Description (outcome-first): "Mod the Codex desktop app — plugins for OpenAI's
  Codex: thread search, project colors, usage stats, reasoning shortcuts, and more."
- Topics: keep existing + add `plugins`, `macos`, `electron`.
- Homepage: Releases page.

---

## Part F — Order of operations
1. **SDK migration mechanism (Part B2–B5)** first — it must exist before renames so
   settings carry over. Land + type + document.
2. **Plugin renames (Part A)** — folders, manifests, keys, `previousIds`, per-plugin
   `migrate()` calls. Update `defaultEnabledState()`.
3. **README slim + doc split (Part C)** — move sections into `docs/`, add `docs/install.md`.
4. **Release pipeline (Part D)** — `install.sh`, `scripts/release.ts`, workflow,
   package.json; cut `v0.2.0`; verify one-liner on a clean machine.
5. **Distribution** — post plugins one at a time, each linking the one-liner.

## Verification checklist
- [ ] `bun run validate` passes after renames + manifest edits.
- [ ] Live renderer (chrome-devtools MCP): each renamed plugin shows the new name in
      the 💥 Explodex settings page and still works.
- [ ] Migration: pre-seed an old key (e.g. `explodex-reasoning-effort-prefix`),
      load, confirm value moved to the new key and the ledger recorded it; reload and
      confirm it doesn't run twice.
- [ ] Enabled-state carryover: disable a plugin under its old id in stored map,
      rename, confirm it stays disabled under the new id.
- [ ] Tagged release produces `Explodex.app.zip`; `install.sh` installs it on a
      machine with only Codex (no Bun/Swift); re-run updates cleanly.
- [ ] README links resolve; deep docs reachable from the index.

## Open questions for Dan
1. Storage-key convention: `explodex-<id>-<sub>` (used above) OK, or prefer
   `explodex:<id>:<sub>`?
2. Rename the screenshot files to new ids now (tidier) or leave them?
3. Ad-hoc signing only, or notarize later to avoid the Gatekeeper "unidentified
   developer" prompt? (Notarization needs an Apple Developer account.)
```
