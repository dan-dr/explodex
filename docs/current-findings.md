# Explodex Current Findings

Date: 2026-06-17

## Safety boundary

- The installed app at `/Applications/Codex.app` was used for initial read-only inspection only.
- The app was copied into this workspace at `vendor/Codex.app`.
- `vendor/Codex.app/Contents/Resources/app.asar` is byte-identical to the installed bundle at the time of copy:
  - SHA-256: `586dcb004fc1dc50030bcdd10677e06fbb771c2b016f62880df16e58ff134050`
- All future patching, extraction, repacking, and launch experiments should target `vendor/Codex.app` only.
- Do not operate on or mutate `/Applications/Codex.app`.

## Installed app metadata

Observed from `vendor/Codex.app/Contents/Info.plist`:

- App name: Codex
- Bundle identifier: `com.openai.codex`
- Version: `26.609.41114`
- Bundle version: `3888`
- Chromium base version: `149.0.7827.54`
- URL scheme: `codex://`
- ASAR integrity is declared in `ElectronAsarIntegrity` for `Resources/app.asar`.
- The app requests broad macOS capabilities, including Apple Events, camera, microphone, and audio capture usage descriptions.

## Bundle structure

The Electron payload is stored at:

```text
vendor/Codex.app/Contents/Resources/app.asar
```

The ASAR header shows these top-level entries:

```text
.vite/
native-menu-locales/
node_modules/
package.json
skills/
webview/
```

Important files discovered inside the ASAR:

```text
.vite/build/bootstrap.js                 Electron bootstrap entry
.vite/build/main-DFegGFWC.js             Main Electron process bundle
.vite/build/preload.js                   Main renderer preload bridge
.vite/build/sandbox-preload.js           MCP/web sandbox preload
webview/index.html                       Main renderer HTML shell
webview/assets/composer-controller-*.js   Composer UI/runtime code
webview/assets/composer-*.js             Composer UI chunks
webview/assets/local-conversation-*.js    Local thread UI chunks
webview/assets/sidebar-*.js              Sidebar state/UI chunks
webview/assets/thread-app-shell-*.js      Thread shell/chrome chunks
```

The ASAR appears to be readable with a small custom parser. Header facts from inspection:

- Header size: `771096`
- JSON header size: `771090`
- File count: about `2870`
- Content base offset for correct file reads: `8 + header_size + 4`, i.e. `771108`

## Package metadata

The embedded `package.json` identifies the app as:

```json
{
  "name": "openai-codex-electron",
  "productName": "Codex",
  "version": "26.609.41114",
  "main": ".vite/build/bootstrap.js"
}
```

Notable dependency/tooling signals from embedded metadata:

- Electron: `42.1.0`
- Vite: `8.0.3`
- Vitest: `4.1.5`
- TypeScript: `^5.9.3`
- React is bundled into the `webview/assets` chunks.
- The app has first-party concepts for plugins, skills, MCP capabilities, local conversations, browser sidebar, and composer controls.

## Electron/main-process findings

The main process is bundled and minified, but several useful patterns are visible:

- Bootstrap imports `.vite/build/main-DFegGFWC.js` and calls `runMainAppStartup()`.
- Main `BrowserWindow` construction uses secure defaults:
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `spellcheck: true`
  - `preload: this.options.preloadPath`
  - `devTools: this.options.allowDevtools`
- Several internal/utility windows set `devTools: false` explicitly.
- The main renderer preload exposes `window.electronBridge` via `contextBridge.exposeInMainWorld`.
- The preload bridge supports host messaging APIs including:
  - `sendMessageFromView`
  - `subscribeToWorkerMessages`
  - `showContextMenu`
  - `showApplicationMenu`
  - `getSharedObjectSnapshotValue`
  - `getSystemThemeVariant`
  - `getBuildFlavor`
- The main process contains IPC channels such as:
  - `codex_desktop:message-from-view`
  - `codex_desktop:message-for-view`
  - `codex_desktop:show-context-menu`
  - `codex_desktop:show-application-menu`
  - `codex_desktop:get-build-flavor`

## Renderer/webview findings

The main UI is in `webview/`, using a Vite-style module graph with many chunked assets.

`webview/index.html` is a standard shell with:

- `#root`
- startup loader CSS/HTML
- modulepreload links for renderer chunks
- a main module script for the frontend

The strongest current SDK anchor is the renderer DOM, not private React internals. Reasons:

- React component/function names are minified and chunk hashes are update-sensitive.
- Several useful DOM-oriented strings and IDs survive minification.
- DOM selectors and mutation observers can provide a first stable layer while deeper React hooks are researched.

## Extension zone evidence

### Composer zones

The composer bundle contains explicit portal markers:

```text
above-composer-portal
above-composer-queue-portal
data-above-composer-portal
data-above-composer-queue-portal
```

These are useful because they appear intentionally designed as DOM portal anchors around the composer.

Relevant bundle:

```text
webview/assets/composer-controller-DSr1Xyxe.js
```

The app also has a substantial composer surface:

```text
webview/assets/composer-DhWyK5QW.js
webview/assets/composer-controller-DSr1Xyxe.js
webview/assets/composer-footer-CPJYr1E5.js
webview/assets/composer-view-state-BcfwXUWF.js
webview/assets/use-composer-controller-Dzedh92X.js
webview/assets/focus-composer-C1SyQqFT.js
```

POC selector strategy:

- Prefer `[data-above-composer-portal]` and `#above-composer-portal` for above-composer UI.
- For composer actions, find `textarea`, `[contenteditable="true"]`, or `[role="textbox"]`, then mount near the closest form/composer shell.

### Sidebar zones

Sidebar-related chunks exist:

```text
webview/assets/sidebar-signals-BA19kopf.js
webview/assets/sidebar-project-groups-C80SCrXe.js
webview/assets/sidebar-thread-list-signals-D5pCHKg3.js
webview/assets/sidebar-thread-row-signals-De-atrPX.js
```

`sidebar-signals` includes persisted state keys such as:

```text
sidebar-organize-mode-v1
sidebar-keep-projects-in-recent-v1
projectless-sidebar-chats-first-v1
electron-sidebar-mode-v1
thread-sort-key
sidebar-section-order-v1
sidebar-collapsed-groups
sidebar-collapsed-sections-v1
sidebar-collapsed-custom-sections-v1
```

POC selector strategy:

- Prefer explicit future marker `[data-explodex-sidebar]` if inserted by a loader later.
- Fall back to `aside`, `[aria-label*="sidebar" i]`, and class names containing `sidebar`.

## Existing app plugin/sandbox signals

The shipped app already has plugin-related chunks and concepts:

```text
webview/assets/plugins-page-*.js
webview/assets/plugin-detail-page-*.js
webview/assets/plugin-install-store-*.js
webview/assets/use-plugin-install-flow-*.js
webview/assets/use-plugins-*.js
webview/assets/plugin-config-edits-*.js
webview/assets/mcp-capability-*.js
```

This suggests there may be an official/internal plugin architecture, but it is not yet clear whether it can extend the Codex app shell itself or only MCP/app integrations. A BetterDiscord-style SDK should not assume those internals are stable until tested.

## Recommended SDK architecture

Start with a layered SDK:

```diagram
╭──────────────────────────────╮
│ Explodex patcher/launcher │
╰──────────────┬───────────────╯
               │ copies/patches only vendor/Codex.app
               ▼
╭──────────────────────────────╮
│ Renderer loader              │
│ - injects SDK script         │
│ - loads user plugins         │
╰──────────────┬───────────────╯
               │ exposes window.Explodex
               ▼
╭──────────────────────────────╮
│ SDK runtime                  │
│ - zones                      │
│ - plugin registry            │
│ - DOM mutation reconciliation│
│ - composer helpers           │
╰──────────────┬───────────────╯
               │
               ▼
╭──────────────────────────────╮
│ Plugins                      │
│ - sidebar items              │
│ - composer buttons           │
│ - future panels/settings     │
╰──────────────────────────────╯
```

The first SDK surface should be intentionally small:

```ts
window.Explodex = {
  version: string,
  zones: string[],
  registerPlugin(manifest, setup): { id: string },
  mount(zoneName, nodeOrFactory, options?): boolean,
  waitForZone(zoneName, callback): () => void,
  insertIntoComposer(text): boolean,
  showStatus(message): void,
  destroy(): void,
}
```

Initial zones:

- `sidebar`
- `composerActions`
- `aboveComposer`

## POC removed (2026-06-22)

The standalone `poc/` harness and built-in `explodex-demo` plugin were removed. Validation and plugin work now run through `bun run dev` / `bun run inject` against the live Codex renderer.

## Next implementation plan

- [x] Local-only ASAR unpack/pack and patcher
- [x] Inject SDK into webview/index.html + relax for local use
- [x] Repack + remove asar integrity key
- [ ] Launch patched vendor copy + validate zones in real DOM
- [ ] Capture live DOM landmarks from sidebar/composer and harden selectors
- [ ] Iterate on plugin surface (more zones, better mount APIs)
- [ ] Explore preload / module-level hooks only after DOM zones are proven stable

## Risks and unknowns

- ASAR integrity may prevent a naive repack from launching until `Info.plist` is adjusted in the local copy.
- macOS code signing may complain after local bundle mutation. Local ad-hoc re-signing may be required for a patched app copy.
- Zone selectors are intentionally heuristic. They should be refined with runtime DOM inspection from the local copied app.
- DevTools may be gated by `allowDevtools`; if unavailable, a local loader patch is the best next step.
- React state integration is limited. Plugins mount DOM and hook official bridge paths where possible.
- Official/internal plugin chunks exist, but their scope and stability are unknown.

## Strong recommendation

Proceed in this order:

1. Keep `vendor/Codex.app` as the mutable sandbox.
2. Build a repeatable patcher that can restore from a clean copied app.
3. Keep the first SDK DOM-zone based.
4. Validate sidebar/composer zones in the real app.
5. Only then investigate deeper React/module hooking for richer APIs.
