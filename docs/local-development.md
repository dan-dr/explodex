# Local Development Design

Date: 2026-06-21

## Goal

Explodex local development should have two clear modes:

1. **Dev mode**: edit repo files, launch Codex with isolated user data, inject SDK/plugins from the repo, observe logs, repeat without rebuilding an app bundle.
2. **Installed mode**: build/package an `Explodex.app`, install it into `/Applications`, run it with isolated Explodex user data, and load bundled plus user-installed plugins without depending on the repo checkout.

The installed OpenAI app at `/Applications/Codex.app` remains an input dependency only. Explodex should not patch it.

## Current Flow

### `npm run launch`

`npm run launch` runs `scripts/launch.sh`.

Current behavior:

- finds Codex in this order:
  - `--codex`
  - `CODEX_PATH`
  - `vendor/Codex.app/Contents/MacOS/Codex`
  - `/Applications/Codex.app/Contents/MacOS/Codex`
- launches Codex with `--remote-debugging-port=9333`
- sets `CODEX_ELECTRON_USER_DATA_PATH` to `EXPLODEX_USER_DATA`, defaulting to `~/.explodex`
- writes Codex output to `$EXPLODEX_USER_DATA/codex.log`
- injects `sdk/explodex-sdk.js`
- loads plugin catalog entries from `plugins/`
- supports `--plugin PATH` for explicit extra plugin paths

This is the best current dev loop, but its default user-data path is also used by the wrapper. For local development, the safer default should be repo-local `.explodex-user-data/` or an explicit `EXPLODEX_USER_DATA`.

### `npm run inject`

`npm run inject` runs `scripts/launch.sh --inject-only`.

Current behavior:

- expects an existing process listening on `127.0.0.1:9333`
- runs `scripts/cdp-inject.py`
- injects SDK and plugin catalog into the current renderer
- also registers scripts through `Page.addScriptToEvaluateOnNewDocument` for future renderer loads

This is the fastest edit/test cycle after Codex is already running with remote debugging.

### `scripts/cdp-inject.py`

The injector is runtime-only. It does not patch ASAR files.

SDK resolution currently checks:

1. repo-style paths near the script (`sdk/explodex-sdk.js`)
2. bundled Resources paths next to the injector (`explodex-sdk.js`)
3. current working directory SDK paths
4. `EXPLODEX_SDK_PATH`

Plugin directory resolution currently checks:

1. `EXPLODEX_PLUGINS_DIR`
2. `Contents/Resources/plugins`
3. a project-ish sibling path
4. `scripts/../plugins`

Plugin discovery also supports `EXPLODEX_PLUGINS` as a path list. If set, that explicit list replaces directory discovery.

Current risk: copied wrapper Resources contain both folder plugins and stale flat `*.js` plugin files. Discovery reads both. Duplicate IDs are skipped after first discovery, so a stale flat file can shadow a newer folder copy depending on sorted order.

### `scripts/sync-wrapper.sh`

`npm run sync` copies source into the local ignored `Explodex.app` bundle:

- `sdk/explodex-sdk.js` to `Contents/Resources/explodex-sdk.js`
- `scripts/cdp-inject.py` to `Contents/Resources/cdp-inject.py`
- `scripts/relaunch-explodex.sh` to `Contents/Resources/relaunch-explodex.sh`
- `plugins/*` to `Contents/Resources/plugins/`
- repo root to `Contents/Resources/explodex-project-root`

Current risk: it does not clear `Contents/Resources/plugins` before copying. Removed or renamed plugins can stay bundled.

### `Explodex.app`

The local ignored wrapper is a shell-script app bundle. Its executable:

- writes launcher logs to `~/.explodex/launcher.log`
- finds `vendor/Codex.app`, then `/Applications/Codex.app`
- launches Codex with `CODEX_ELECTRON_USER_DATA_PATH=~/.explodex`
- injects `Contents/Resources/explodex-sdk.js`
- uses `Contents/Resources/plugins` if present, otherwise falls back to repo `plugins`

Observed local state:

- `Explodex.app/Contents/Info.plist` declares `com.explodex.app`
- `codesign -dv` may report stale ad-hoc signature metadata from prior local builds
- the signature is not a trustworthy package artifact; packaging should regenerate/sign the bundle

### `scripts/relaunch-explodex.sh`

The relaunch script waits for Codex to exit, then opens:

1. repo-local `Explodex.app`
2. `/Applications/Explodex.app`

This makes sense for dev, but installed mode should prefer `/Applications/Explodex.app` and not assume the repo exists.

### `scripts/patch.py`

`scripts/patch.py` is a local ASAR patcher for `vendor/Codex.app` only.

It:

- backs up `vendor/Codex.app/Contents/Resources/app.asar`
- injects SDK, loader, and plugin files under `webview/explodex/`
- adds a loader script tag to `webview/index.html`
- relaxes CSP for the local vendor copy
- removes `ElectronAsarIntegrity` from the local vendor Info.plist
- ad-hoc signs the mutated vendor app

This is useful for research and self-contained experiments, but should not be the default local dev or installed wrapper flow. CDP injection keeps Codex unmodified and easier to update.

### Ignored Artifacts

`.gitignore` correctly excludes:

- `.explodex/`
- `.explodex-user-data/`
- `dist/*`
- `*.app/`
- `vendor/`
- `extracted/`
- `tmp_extracted/`
- `*.asar`

This matches source-first development. The missing piece is a repeatable package/install script that rebuilds ignored app artifacts from tracked templates/source.

## Recommended Dev Loop

Use CDP injection as the default.

1. Edit tracked source:
   - `sdk/explodex-sdk.js`
   - `plugins/<id>/plugin.json`
   - `plugins/<id>/index.js`
   - docs under `docs/`
2. Run the source gate:
   - `mise exec node@22 -- npm run validate`
3. Launch an isolated dev Codex:
   - set `EXPLODEX_USER_DATA=$PWD/.explodex-user-data`
   - run `mise exec node@22 -- npm run launch`
4. For plugin-only or SDK edits after launch:
   - run `mise exec node@22 -- npm run inject`
5. Observe:
   - launcher output in the terminal
   - Codex output in `.explodex-user-data/codex.log`
   - renderer logs in DevTools/CDP when available
   - in-app Explodex plugin manager for catalog/load state

Recommended script behavior change:

- add `npm run dev` as the repo-local isolated loop
- keep `npm run launch` compatible with today, or change it only with a documented migration

## Recommended Package / Install Flow

Build the wrapper from source into `dist/Explodex.app`, then install that built artifact.

Desired commands:

- `npm run package:app`
- `npm run install:app`
- `npm run launch:app`

`package:app` should:

1. create a clean `dist/Explodex.app`
2. copy a tracked app template or generate the bundle structure
3. copy `sdk/explodex-sdk.js` to `Contents/Resources/explodex-sdk.js`
4. copy `scripts/cdp-inject.py` and `scripts/relaunch-explodex.sh`
5. copy repo plugins into `Contents/Resources/plugins`
6. remove stale plugin files before copying
7. write package metadata (`version`, build date, source commit if available)
8. ad-hoc sign the wrapper bundle
9. verify the signature and executable bit

`install:app` should:

1. remove or replace `/Applications/Explodex.app` only after explicit user action
2. copy `dist/Explodex.app` into `/Applications/Explodex.app`
3. verify `/Applications/Explodex.app/Contents/MacOS/Explodex` is executable
4. verify Info.plist and signature metadata

`launch:app` should:

- open `/Applications/Explodex.app`
- not require the repo to remain present

The installed wrapper should still launch `/Applications/Codex.app` by default, with `CODEX_PATH` as an override.

## User Data and Logs

Dev mode should be isolated from installed mode.

Recommended paths:

| Mode | Codex user data | Logs |
|------|-----------------|------|
| Dev | `$REPO/.explodex-user-data` | `$REPO/.explodex-user-data/codex.log` |
| Installed | `~/Library/Application Support/Explodex/CodexUserData` | `~/Library/Logs/Explodex/` |

Avoid using the same `~/.explodex` directory for all concerns. It mixes installed user data, logs, launcher state, and dev state.

## Plugin Load Paths

Explodex plugins are UI shell extensions. They are separate from official Codex plugins under Codex's own plugin system.

Recommended precedence:

1. **Explicit override**: `EXPLODEX_PLUGINS`
   - exact path list
   - replaces normal discovery
   - intended for targeted debugging
2. **Explicit dev directory**: `EXPLODEX_PLUGINS_DIR`
   - usually `$REPO/plugins`
   - used by `npm run dev` and `npm run inject`
3. **Installed user plugins**: `~/Library/Application Support/Explodex/plugins`
   - user-managed plugins
   - should override bundled plugins by ID
   - useful for local personal plugins without rebuilding the app
4. **Bundled plugins**: `Explodex.app/Contents/Resources/plugins`
   - stable built-in distribution plugins
   - source of truth for installed mode
5. **Repo fallback**: only in dev wrapper mode when `explodex-project-root` is present and valid
   - should not be used by `/Applications/Explodex.app` unless an explicit dev flag is set

Duplicate IDs should be deterministic:

- higher-precedence paths win
- lower-precedence duplicates are skipped with a warning that names both paths
- stale lower-precedence copies must never shadow newer higher-precedence copies

Directory discovery should prefer folder plugins (`plugins/<id>/plugin.json` + entry) over legacy flat `*.js` files. Legacy flat files should either be removed from the bundle during packaging or loaded only from explicit `EXPLODEX_PLUGINS`.

## Dev vs Installed Plugin Behavior

### Dev Mode

Default plugin source:

```text
$REPO/plugins
```

Expected behavior:

- edit plugin source
- run `npm run inject`
- SDK reloads and current plugin source is evaluated
- no bundle sync required

### Installed Mode

Default plugin sources:

```text
~/Library/Application Support/Explodex/plugins
/Applications/Explodex.app/Contents/Resources/plugins
```

Expected behavior:

- bundled plugins always available
- user plugins can override or add plugins
- no repo dependency
- app updates can replace bundled plugins without deleting user plugins

## Required Code / Doc Changes

Likely code changes:

- `scripts/cdp-inject.py`
  - implement ordered multi-root plugin discovery
  - add source/root metadata to catalog entries
  - make duplicate ID handling precedence-based
  - prefer folder plugins over flat legacy files
- `scripts/sync-wrapper.sh`
  - clear `Contents/Resources/plugins` before copying
  - stop copying stale flat plugin files
  - optionally write a dev-mode marker
- `Explodex.app/Contents/MacOS/Explodex` source/template
  - split dev wrapper behavior from installed wrapper behavior
  - use `~/Library/Application Support/Explodex/CodexUserData` for installed user data
  - use `~/Library/Logs/Explodex` for logs
  - avoid repo fallback unless dev marker/env is present
- new packaging script, likely `scripts/package-app.sh`
  - rebuild clean `dist/Explodex.app`
  - copy resources
  - sign
  - verify
- new install script, likely `scripts/install-app.sh`
  - install `dist/Explodex.app` to `/Applications`
  - verify installed bundle
- `package.json`
  - add `dev`, `package:app`, `install:app`, `launch:app`
- `.gitignore`
  - keep `dist/*` ignored, keep `*.app/` ignored
  - keep app template tracked only if it is not matched by `*.app/`
- docs
  - keep `docs/development.md` as the quick path
  - keep this file as the durable architecture for dev/install/plugin loading

## Risks

| Risk | Mitigation |
|------|------------|
| Stale bundled plugins shadow repo plugins | clean plugin destination before copy; precedence-based loader |
| Installed app silently depends on repo checkout | installed mode must not read `explodex-project-root` unless dev flag is set |
| Dev and installed state contaminate each other | separate user-data/log paths |
| Ad-hoc signature metadata drifts | package from template and sign every build |
| Debug port conflict | keep clear errors; allow `EXPLODEX_DEBUG_PORT` / `--port` |
| Codex single-instance handoff hides debug flags | detect running Codex and require quit before launch |
| CDP injection disappears after app restart | wrapper always injects on launch; `npm run inject` for running sessions |
| ASAR patch diverges from wrapper behavior | keep `scripts/patch.py` documented as research-only |

## Recommendation

Make CDP injection the only normal path.

Use repo `plugins/` only for dev. Use bundled Resources plus `~/Library/Application Support/Explodex/plugins` for installed mode. Package a clean `dist/Explodex.app`, install that into `/Applications`, and keep Codex itself unmodified.
