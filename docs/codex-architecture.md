# Codex Desktop Architecture Reference

> Reverse-engineered from `vendor/Codex.app/Contents/Resources/app.asar` (v26.609.41114, build 3888, Electron 42.1.0).  
> Extraction lives in `extracted/`. All patching experiments target `vendor/Codex.app` only — never `/Applications/Codex.app`.

---

## Table of contents

1. [Bundle topology](#1-bundle-topology)
2. [Source maps](#2-source-maps)
3. [Process architecture](#3-process-architecture)
4. [Renderer layout & panels](#4-renderer-layout--panels)
5. [Injection zones](#5-injection-zones)
6. [UI components](#6-ui-components)
7. [Routes & pages](#7-routes--pages)
8. [Data & persistence](#8-data--persistence)
9. [IPC & bridge APIs](#9-ipc--bridge-apis)
   - See also: [composer-message-lifecycle.md](./composer-message-lifecycle.md) — send/submit APIs, effort, hook points
10. [Suggested Explodex injection API](#10-suggested-explodex-injection-api)
11. [Injection methods](#11-injection-methods)
12. [Risks & stability](#12-risks--stability)
    - See also: [sdk-fragility.md](./sdk-fragility.md) — SDK breakage modes, fiber/bridge risks, upgrade checklist

---

## 1. Bundle topology

### ASAR layout

```
app.asar/
├── package.json              # openai-codex-electron, main → .vite/build/bootstrap.js
├── .vite/build/              # Electron main + preload bundles
│   ├── bootstrap.js          # Entry: sets userData, imports main
│   ├── main-DFegGFWC.js      # Window manager, IPC, services
│   ├── preload.js            # contextBridge → window.electronBridge
│   ├── sandbox-preload.js    # MCP web sandbox guest
│   ├── comment-preload.js    # Browser sidebar comment overlay
│   └── worker.js             # Git / heavy tasks off main thread
├── webview/                  # React SPA (Vite chunks)
│   ├── index.html            # #root, CSP, module entry
│   └── assets/               # ~2800 chunked JS/CSS modules
├── skills/                   # Bundled skill templates
└── node_modules/             # better-sqlite3, ws, zod, etc.
```

### Key version signals

| Field | Value |
|-------|-------|
| App version | `26.609.41114` |
| Build number | `3888` |
| Electron | `42.1.0` |
| Chromium | `149.0.7827.54` |
| Vite | `8.0.3` |
| Runtime shell | `owl` (`owl-electron-app.json`) |
| Bundle ID | `com.openai.codex` |

---

## 2. Source maps

**Finding:** Production webview chunks reference source maps via `//# sourceMappingURL=<chunk>.js.m`, but the `.map` / `.js.m` files are **not shipped** in the ASAR. Only third-party maps exist under `cua_node/` (pdfjs, tesseract).

**Implication:** Reverse engineering relies on:
- String literals surviving minification (`data-*`, `data-testid`, i18n keys)
- Chunk filenames (hashed, update-sensitive)
- Inline `//# sourceMappingURL` hints for original module names (e.g. `button-DO-oxX3-.js` → Button component)

**Useful surviving identifiers in chunks:**

| Chunk hash file | Logical module |
|-----------------|----------------|
| `button-DO-oxX3-.js` | `Button` component |
| `dialog-layout-DyzgPiHE.js` | Radix Dialog wrapper |
| `composer-DhWyK5QW.js` | Composer orchestration |
| `composer-controller-DSr1Xyxe.js` | ProseMirror editor controller |
| `app-shell-CPw_WmZQ.js` | App shell layout |
| `thread-scroll-layout-CQlmRS86.js` | Thread scroll + footer portal |
| `setting-storage-II74UqER.js` | Settings React Query bridge |
| `persisted-signal-C9s53PEH.js` | Persisted atom store |
| `vscode-api-B47PzOKa.js` | Electron message bridge |
| `sidebar-signals-BA19kopf.js` | Sidebar persisted state |

---

## 3. Process architecture

```
┌─────────────────────────────────────────────────────────────┐
│ bootstrap.js                                                │
│  - CODEX_ELECTRON_USER_DATA_PATH override                   │
│  - single-instance lock                                     │
│  - → main-DFegGFWC.js (runMainAppStartup)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
     ┌─────────────────────┼─────────────────────┐
     ▼                     ▼                     ▼
┌──────────┐        ┌──────────────┐       ┌─────────────┐
│ Main     │◄─IPC──►│ Renderer     │       │ Worker      │
│ process  │        │ (webview/)   │       │ (git, etc.) │
│          │        │ preload.js   │       └─────────────┘
│ sqlite   │        │ React SPA    │
│ services │        └──────────────┘
└──────────┘
```

### Main process services

| Service | Role |
|---------|------|
| WindowManager | BrowserWindow, preload, zoom, DevTools policy |
| ElectronMessageHandler | ~175 RPC methods via `message-from-view` |
| AppServerConnectionRegistry | Local/remote Codex app-server |
| AutomationSchedulerController | SQLite automations + cron |
| BrowserSidebarManager | In-app browser, CDP input |
| SharedObjectRepository | `host_config`, SSH connections |
| PrimaryRuntimeService | CLI/runtime install |
| GlobalDictationService | System dictation hotkeys |

### Preload surfaces

| Preload | Exposed API |
|---------|-------------|
| `preload.js` | `window.electronBridge`, `window.codexWindowType` |
| `sandbox-preload.js` | MCP sandbox guest (origin-locked) |
| `comment-preload.js` | Browser sidebar comment runtime |

### Security defaults

- `contextIsolation: true`
- `nodeIntegration: false`
- CSP on renderer: `default-src 'none'`, `style-src 'unsafe-inline'`
- IPC sender validation via registered `webContents`

---

## 4. Renderer layout & panels

### App shell (`app-shell-CPw_WmZQ.js`)

```
┌────────────────────────────────────────────────────────────────┐
│ App header / titlebar (.app-header-tint)                       │
├──────────┬─────────────────────────────────────┬───────────────┤
│ Left     │ Main content viewport               │ Right tab     │
│ panel    │ (.app-shell-main-content-viewport)  │ panel         │
│ (sidebar)│  └─ frame (.app-shell-main-content- │ (browser,    │
│          │      frame)                          │  diff, mcp,   │
│          │  [data-app-shell-main-content-layout]│  sandbox,     │
│          │                                      │  timeline)    │
└──────────┴─────────────────────────────────────┴───────────────┘
```

**Layout modes** (`data-app-shell-main-content-layout`):
- `default`, `full-bleed`, `thread-edge-scroll`, `floating`

**Tab kinds** (`data-tab-id`):
- `browser`, `diff`, `mcp-app`, `sandbox`, `timeline`
- Legacy: `artifact:*`, `automation:*`

### Thread view (`thread-scroll-layout-CQlmRS86.js`)

Column-reverse scroll container:

```
┌─────────────────────────────┐
│  Thread messages (children) │
│  [data-mcp-app-portal-target]│  ← MCP iframe teleports here
├─────────────────────────────┤
│  [data-thread-scroll-footer]│  ← Composer sticky footer
│    [data-above-composer-portal]
│    [data-above-composer-queue-portal]
│    .ProseMirror (composer)  │
│    attachments / footer     │
└─────────────────────────────┘
```

### Right panel surfaces

| Panel | Key files | testid / data attrs |
|-------|-----------|---------------------|
| Browser sidebar | `thread-side-panel-tabs-*.js` | `browser-sidebar-top-banner-portal` |
| MCP app frame | `mcp-capability-view-frame-*.js` | `data-mcp-app-portal-target`, `data-mcp-app-expanded` |
| PDF preview | `pdf-preview-panel-*.js` | popcorn/artifact testids |
| DOCX preview | `docx-preview-panel-*.js` | section annotations |
| Composer overlay | `review-runtime-bridge-*.js` | `right-panel-composer-overlay` |

### Dialog system (`dialog-layout-DyzgPiHE.js`)

Radix Dialog + Codex overlay. Width presets:

| `width` prop | CSS width |
|--------------|-----------|
| `narrow` | 380px |
| `feature` | 400px |
| `compact` | 420px |
| (default) | 520px |
| `wide` | 600px |
| `xwide` | 680px |
| `xxwide` | 800px |
| `editor` | 600×720 |

---

## 5. Injection zones

### Tier A — Official portal anchors (recommended)

| Zone ID | Selector | File | Purpose |
|---------|----------|------|---------|
| `aboveComposer` | `[data-above-composer-portal]` | `composer-DhWyK5QW.js` | Extension UI above composer; Codex portals suggestions here via `createPortal` |
| `aboveComposerQueue` | `[data-above-composer-queue-portal]` | `composer-DhWyK5QW.js` | Queued message UI |
| `mcpAppPortal` | `[data-mcp-app-portal-target="true"]` | `thread-scroll-layout-*.js` | MCP app iframe host |
| `threadFooter` | `[data-thread-scroll-footer="true"]` | `thread-scroll-layout-*.js` | Sticky composer footer region |
| `browserSidebarBanner` | `[data-testid="browser-sidebar-top-banner-portal"]` | `thread-side-panel-tabs-*.js` | Browser panel top banner |
| `homeAmbient` | `[data-home-ambient-suggestions]` | `app-main-*.js` | Home page suggestion strip |
| `composerOverlay` | `[data-composer-overlay-floating-ui]` | `composer-controller-*.js` | Floating autocomplete (portaled) |

**Above-composer scoping:** portal also carries `data-above-composer-conversation-id` for per-thread targeting.

### Tier B — Heuristic zones (fallback)

| Zone ID | Selectors (priority order) |
|---------|---------------------------|
| `sidebar` | `[data-testid="app-shell-floating-left-panel"]`, `aside`, `[aria-label*="sidebar" i]`, `[class*="sidebar" i]` |
| `composerActions` | `.ProseMirror` parent form/shell, `[class*="composer" i]` |
| `appHeader` | `.app-header-tint`, header landmark |
| `statusOverlay` | `document.body` (fixed position, z-index max) |

### Tier C — Shell control attributes (read-only, for layout awareness)

| Attribute | Values |
|-----------|--------|
| `data-app-shell-main-content-layout` | `full-bleed`, `thread-edge-scroll`, `default`, `floating` |
| `data-app-shell-focus-area` | Focus routing |
| `data-tab-id` | Active right panel tab |

### Injection pattern

```javascript
// DOM append (SDK default)
const portal = document.querySelector('[data-above-composer-portal]');
const mount = document.createElement('div');
mount.setAttribute('data-explodex-mount', 'aboveComposer');
portal.appendChild(mount);

// React portal equivalent (if you have React in your plugin)
createPortal(<MyUI />, portal);
```

**Note:** `[data-above-composer-portal]` uses `empty:hidden` — it hides when empty. Children must be appended to make it visible.

---

## 6. UI components

Codex uses React + Tailwind design tokens (`bg-token-*`, `text-token-*`, `border-token-*`). Explodex mirrors these in plain DOM.

### Button (`button-DO-oxX3-.js`)

```typescript
type ButtonProps = {
  color?: 'primary' | 'secondary' | 'outline' | 'outlineActive'
         | 'ghost' | 'ghostActive' | 'ghostMuted' | 'ghostTertiary' | 'danger';
  size?: 'default' | 'large' | 'medium' | 'icon' | 'iconSm'
       | 'composer' | 'composerSm' | 'toolbar';
  uniform?: boolean;      // square aspect
  allowShrink?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  children: ReactNode;
  onClick?: () => void;
};
```

Defaults: `color="primary"`, `size="default"`. Uses `no-drag` for Electron titlebar regions.

### Composer input

- **Not** a `<textarea>` — uses **ProseMirror** (`.ProseMirror`)
- Placeholder: `.ProseMirror .placeholder[data-placeholder]`
- Controller API (`composer-controller-*.js`):

| Read | Write |
|------|-------|
| `getText()` | `setText(text)` |
| `getPersistedText()` | `appendText(text)` |
| `hasText()` | `insertText(text)` |
| `isCursorAtEnd()` | `insertTextAtSelection(text)` |
| | `setPromptText(text)` |
| | `insertMention(...)`, `insertSkillMention(...)` |
| | `focus()`, `clear()` |

Controller instance is **not** exposed on `window` — DOM insertion via `document.execCommand('insertText')` or InputEvent is the practical SDK path.

### Settings (`setting-storage-II74UqER.js`)

```typescript
getSettingValue({ key, default })  // from React Query cache
setSetting(queryClient, { key, default }, value)
fetchSetting({ key, default })     // RPC get-setting
persistSetting({ key, default }, value)  // RPC set-setting
```

### Persisted atoms (`persisted-signal-C9s53PEH.js`)

```typescript
// Storage key prefix
const PREFIX = 'codex:persisted-atom:';

// API shape (React hook internals)
getItem(key, fallback)
setItem(key, value)
removeItem(key)
subscribe(key, callback, fallback)
```

Main process mirrors to `globalState['electron-persisted-atom-state']`.

### Known persisted atom keys (sidebar)

| Key | Default | Purpose |
|-----|---------|---------|
| `sidebar-organize-mode-v1` | `"project"` | Sidebar organize mode |
| `sidebar-keep-projects-in-recent-v1` | `true` | Keep projects in recent |
| `projectless-sidebar-chats-first-v1` | `false` | Chats-first ordering |
| `electron-sidebar-mode-v1` | `"codex"` | Electron sidebar mode |
| `thread-sort-key` | `"updated_at"` | Thread sort |
| `sidebar-section-order-v1` | `undefined` | Section order |
| `sidebar-collapsed-groups` | `{}` | Collapsed groups |
| `sidebar-collapsed-sections-v1` | `{chats,cloud,pinned,threads}` | Section collapse |
| `sidebar-collapsed-custom-sections-v1` | `{}` | Custom sections |

---

## 7. Routes & pages

Router entry: `app-main-fcIxOLz5.js`

### Top-level routes

| Path | Surface |
|------|---------|
| `/` | Home |
| `thread/:conversationId` | Local thread |
| `/remote/:taskId` | Remote/cloud task |
| `/settings/*` | Settings shell |
| `/plugins` | Plugin marketplace |
| `/skills` | Skills |
| `/inbox` | Inbox |
| `/automations` | Automations |
| `/mcp-app/:server/:toolName` | Standalone MCP app |
| `/hotkey-window/*` | Compact hotkey window |
| `/global-dictation/*` | Dictation overlay |
| `/avatar-overlay` | Avatar pet overlay |
| `/login`, `/welcome`, `/first-run` | Onboarding |
| `/diff` | Diff view |
| `/pull-requests/:n` | PR view |

### Settings sections (`/settings/{slug}`)

`general-settings`, `profile`, `appearance`, `usage`, `mcp-settings`, `plugins-settings`, `skills-settings`, `data-controls`, `keyboard-shortcuts`, `browser-use`, `computer-use`, `hooks-settings`, `git-settings`, `worktrees`, `agent`, `personalization`, `connections`, `local-environments`, `appshots`

### Route scope kinds

`home`, `new-thread-panel`, `local-thread`, `remote-thread`, `chatgpt-thread`, `other`

---

## 8. Data & persistence

### Storage layers

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: ~/.codex/sqlite/codex.db (better-sqlite3, main)    │
│   inbox_items, automations, automation_runs, feature flags  │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: userData/.codex-global-state.json (main process)   │
│   workspace roots, remote projects, hotkeys, enrollments    │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: localStorage codex:persisted-atom:* (renderer)    │
│   ↔ synced to globalState electron-persisted-atom-state     │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: ~/.codex/config.toml (CLI/desktop config)          │
│   plugins, MCP, browser settings                            │
├─────────────────────────────────────────────────────────────┤
│ Layer 5: Server-side (rate limits, usage — not local DB)    │
└─────────────────────────────────────────────────────────────┘
```

### Paths

| Path | Contents |
|------|----------|
| `~/Library/Application Support/Codex/` | Electron userData (macOS) |
| `~/.codex/` | Codex home (config, sqlite, automations) |
| `~/.codex/sqlite/codex.db` | Production DB |
| `~/.codex/sqlite/codex-dev.db` | Dev DB |
| `~/.codex/config.toml` | Configuration |
| `~/.codex/automations/` | Automation TOML files |
| `~/Documents/Codex/{date}/{slug}/` | Projectless chat output |

### SQLite schema (v21)

| Table | Purpose |
|-------|---------|
| `inbox_items` | Notifications |
| `automations` | Scheduled prompts (rrule, model, cwd) |
| `automation_runs` | Run instances + status |
| `local_app_server_feature_enablement` | Feature flags |

### Rate limits & usage

- **Not** in local SQLite
- UI: `rate-limit-summary-*.js`, `rate-limit-rows-*.js`
- RPC: `fast-mode-rollout-metrics`
- Analytics: `CodexRateLimitResetCreditRedeemed`, `CodexSidebarUsageAlertViewed`

### Reset mechanisms

| Action | Effect |
|--------|--------|
| `persisted-atom-reset` IPC | Clears all persisted atoms |
| `reset-codex-command-keybindings` RPC | Resets keybindings |
| `npm run devtools:reset` | Clears DevTools extension cache |
| Settings → data-controls | User-facing data wipe (in-app) |

---

## 9. IPC & bridge APIs

### Electron channels

| Channel | Pattern |
|---------|---------|
| `codex_desktop:message-from-view` | Renderer → main RPC (`invoke`) |
| `codex_desktop:message-for-view` | Main → renderer events |
| `codex_desktop:get-shared-object-snapshot` | `sendSync` initial state |
| `codex_desktop:connect-app-host` | Cap'n Proto app host bridge |

### `window.electronBridge` (preload)

```typescript
{
  sendMessageFromView(msg: { type: string; ... }): Promise<unknown>;
  getPathForFile(file: File): string | null;
  showContextMenu(spec): Promise<void>;
  showApplicationMenu(menuId, x, y): Promise<void>;
  getSharedObjectSnapshotValue(key: string): unknown;
  getSystemThemeVariant(): 'light' | 'dark';
  subscribeToSystemThemeVariant(cb): () => void;
  getBuildFlavor(): string;
  usesOwlAppShell(): boolean;
  getAppSessionId(): string;
}
```

### Message flow for settings

```
Renderer → sendMessageFromView({ type: 'get-setting', params: { key } })
Main → message-for-view reply
```

Explodex SDK wraps common RPCs: `get-setting`, `set-setting`, `get-global-state`, `set-global-state`, `navigate-to-route`.

### Persisted atom sync

| Message | Direction |
|---------|-----------|
| `persisted-atom-sync-request` | view → main |
| `persisted-atom-sync` | main → view (full snapshot) |
| `persisted-atom-update` | view → main |
| `persisted-atom-updated` | main → all windows |
| `persisted-atom-reset` | view → main |

---

## 10. Suggested Explodex injection API

```typescript
interface Explodex {
  version: string;

  // Zone registry
  zones: Record<ZoneId, ZoneDefinition>;
  inject: {
    mount(zoneId: ZoneId, node: Node | (ctx) => Node, opts?: MountOptions): boolean;
    waitFor(zoneId: ZoneId, cb: (anchor: Element) => void): () => void;
    unmount(pluginId: string): void;
  };

  // DOM component factories (Codex-styled)
  components: {
    button(opts: ButtonOptions): HTMLButtonElement;
    sidebarItem(opts: SidebarItemOptions): HTMLButtonElement;
    pill(opts: PillOptions): HTMLSpanElement;
    badge(opts: BadgeOptions): HTMLSpanElement;
    panel(opts: PanelOptions): HTMLDivElement;
    statusToast(message: string, opts?: { duration?: number }): void;
  };

  // Storage accessors
  storage: {
    persisted: {
      get<T>(key: string, fallback?: T): T;
      set(key: string, value: unknown): void;
      remove(key: string): void;
      keys(): string[];
      subscribe(key: string, cb: (value: unknown) => void): () => void;
    };
    settings: {
      get(key: string, fallback?: unknown): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
    };
    globalState: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
    };
  };

  // Electron bridge
  bridge: {
    send(type: string, payload?: object): Promise<unknown>;
    on(type: string, handler: (data: object) => void): () => void;
    navigate(path: string): void;
    theme(): 'light' | 'dark';
    onThemeChange(cb: () => void): () => void;
  };

  // Composer helpers
  composer: {
    getInput(): Element | null;
    focus(): boolean;
    insertText(text: string): boolean;
    getText(): string;
  };

  // Query helpers
  query: {
    testId(id: string): Element | null;
    portal(name: string): Element | null;
    one(selector: string): Element | null;
  };

  // Plugin lifecycle
  plugins: {
    register(manifest: PluginManifest, setup: (api: PluginAPI) => void): { id: string };
    unregister(id: string): void;
  };

  // Reference data
  meta: {
    selectors: Record<string, string>;
    routes: string[];
    persistedKeys: Record<string, string>;
  };

  destroy(): void;
}
```

---

## 11. Injection methods

### Method 1: CDP runtime injection (recommended for dev)

```bash
CODEX_ELECTRON_USER_DATA_PATH="$PWD/.explodex-user-data" \
  ./vendor/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9333

bun scripts/cdp-inject.ts
```

Uses `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`. No ASAR mutation. The injector applies the SDK/catalog to all matching renderer page targets found during its startup watch window (`EXPLODEX_TARGET_WATCH_MS`, default `8000`) so secondary startup renderers are not missed.

For how this compares to `--inspect-brk`, what can be patched before React loads, and why massive early hooks still do not enable generic React props injection, see [early-injection-and-inspect-brk.md](./early-injection-and-inspect-brk.md).

Within a renderer, plugins that depend on React-owned DOM should prefer `Explodex.observeZone(zoneId, callback)` over one-shot `waitFor()`. `observeZone` calls immediately when a zone appears and again when React replaces that zone anchor, allowing plugins to reinsert sidebar/nav mounts after resize, display, or route lifecycle remounts. Pass `{ includeMutations: true }` only for idempotent callbacks that also need a debounced signal when React rewrites children under the same anchor.

### Method 2: ASAR patch (self-contained bundle)

```bash
python3 scripts/patch.py --apply   # inject SDK + loader into index.html
python3 scripts/patch.py --restore # restore pristine vendor copy
```

Patches `webview/index.html`, relaxes CSP, removes `ElectronAsarIntegrity` from local copy.

### Method 3: DevTools console

Paste `sdk/explodex-sdk.js` into console (lost on reload unless CDP pre-inject).

---

## 12. Risks & stability

| Risk | Mitigation |
|------|------------|
| Chunk hash changes each release | Prefer `data-testid` and `data-*` portal attrs over class names |
| CSP blocks external scripts | Bundle plugins inline; `style-src 'unsafe-inline'` allows injected CSS |
| Code signing after ASAR patch | Ad-hoc re-sign or use CDP injection |
| React internals unstable | Stay DOM-zone based; avoid fiber for production — SDK `codex.*` is a fallback only ([sdk-fragility.md](./sdk-fragility.md) §2) |
| Official plugin system exists | `plugins-page-*.js`, MCP sandbox — scope unclear for shell extension |
| ProseMirror controller not exposed | Use DOM `insertText` / `execCommand` |
| Rate limit data server-side | Use `Explodex.http.get("/wham/usage")`; not in local storage |

### Selector stability ranking

1. `data-testid="..."` — intentional test hooks
2. `data-above-composer-portal` etc. — intentional portal anchors
3. `data-app-shell-*` — layout control
4. `[role="dialog"][data-state="open"]` — Radix state
5. `.ProseMirror` — composer (class stable across builds)
6. Hashed CSS modules (`_content_pk7td_1`) — **avoid**

---

## 13. Rate limits & weekly reset (build 4108 / 26.616.30709)

Usage and manual reset credits are **server-side** — not in local SQLite or `localStorage`.

### Usage query

| Item | Value |
|------|-------|
| React Query key | `rate-limit-status` |
| Endpoint | `GET /wham/usage` |
| Refetch | every 60s (`refetchInterval: ONE_MINUTE`) |
| Live signal | `account/rateLimits/updated` (app-server notification) |
| Source | `thread-context-inputs-BhGjWqLR.js` |

### Response shape (`/wham/usage`)

```json
{
  "rate_limit": {
    "primary_window": { "used_percent": 42, "limit_window_seconds": 604800, "reset_at": 1750000000 },
    "secondary_window": { "used_percent": 10, "limit_window_seconds": 86400, "reset_at": 1750000000 },
    "limit_reached": false,
    "allowed": true
  },
  "credits": { "has_credits": true, "unlimited": false, "balance": null },
  "plan_type": "…",
  "rate_limit_reached_type": null,
  "additional_rate_limits": [],
  "spend_control": { "reached": false }
}
```

- `reset_at` is **Unix seconds** (not ms).
- Window labels are inferred from `limit_window_seconds / 60`:
  - `>= 10079` min → weekly (7×1440)
  - `>= 1439` min → daily
  - `>= 30×1440` → monthly
  - `>= 365×1440` → annual
- Logic: `use-rate-limit-BV5pYGKd.js`

### Manual reset credits (“the reset”)

These are consumable credits that **reset your weekly usage** when rate-limited.

| Item | Value |
|------|-------|
| List query key | `rate-limit-reset-credits` |
| List endpoint | `GET /wham/rate-limit-reset-credits` |
| Consume endpoint | `POST /wham/rate-limit-reset-credits/consume` |
| Consume body | `{ credit_id, redeem_request_id }` |
| Success code | `{ code: "reset" }` |
| Source | `codex-api-DfC2XBrP.js`, `rate-limit-reset-modal-*.js` |

List response:

```json
{
  "available_count": 2,
  "credits": [
    { "id": "…", "title": "…", "description": "…", "status": "available", "profile_image_url": "…", "profile_user_id": "…" }
  ]
}
```

Only credits with `status === "available"` are redeemable (`rate-limit-reset-modal` filter).

### HTTP transport

Renderer calls go through `request-CpO3zZKU.js` → `vscode-api` fetch proxy:

1. `electronBridge.sendMessageFromView({ type: "fetch", requestId, method, url, headers, body })`
2. Response on `window` `message` event: `{ type: "fetch-response", requestId, status, bodyJsonString, responseType }`

Explodex SDK exposes this as `Explodex.http.get("/wham/usage")`.

### Explodex plugin: usage sidebar

`plugins/usage-reset-sidebar/index.js` mounts a **view-only** panel at the **top of the left sidebar** showing:

- Available reset credit count + credit titles (display only — no redeem/consume)
- Primary/secondary window usage % and reset dates
- Polls every 60s; listens for `account/rateLimits/updated`
- GET-only HTTP wrapper blocks `/consume` and any non-`/wham/` paths

Load via CDP (`python3 scripts/cdp-inject.py`) or ASAR patch (`python3 scripts/patch.py --apply`).

---

## 14. Plugin systems (two different things)

### A) Official Codex plugins (agent capabilities)

Location: `vendor/Codex.app/Contents/Resources/plugins/openai-bundled/`

```
openai-bundled/
├── .agents/plugins/marketplace.json    # marketplace catalog
└── plugins/<name>/
    ├── .codex-plugin/plugin.json       # manifest (required)
    ├── skills/                         # optional SKILL.md folders
    ├── .mcp.json                       # optional MCP servers
    ├── assets/                         # logos, icons
    └── scripts/                        # native helpers (browser, latex, etc.)
```

`plugin.json` fields: `name`, `version`, `description`, `author`, `keywords`, `mcpServers`, `skills`, `interface` (displayName, logos, defaultPrompt, category, …).

Bundled plugins: `sites`, `browser`, `chrome`, `computer-use`, `record-and-replay`, `latex`.

These extend **agent tooling** (MCP, skills, browser-use) — **not** renderer DOM injection.

### B) Explodex plugins (UI shell extensions)

Location: `plugins/<id>/` in this repo.

```js
Explodex.plugins.register({ id, name, version }, (api) => {
  api.mount("sidebar", () => api.components.panel({ … }), { position: "prepend" });
  api.http.get("/wham/usage").then(…);
});
```

Loaded after the SDK by `scripts/cdp-inject.py` or `poc/loader.js` (ASAR patch).

| | Official Codex | Explodex |
|--|----------------|-------------|
| Purpose | Agent skills / MCP / apps | DOM zones in the shell |
| Manifest | `.codex-plugin/plugin.json` | `plugin.json` + JS `register()` call |
| Install | Codex Plugins settings page | CDP inject or ASAR patch |
| UI injection | No | Yes (`sidebar`, `aboveComposer`, …) |

---

## Appendix: Key file index

| Concern | Path under `extracted/` |
|---------|-------------------------|
| HTML bootstrap | `webview/index.html` |
| App router | `webview/assets/app-main-fcIxOLz5.js` |
| App shell | `webview/assets/app-shell-CPw_WmZQ.js` |
| Composer | `webview/assets/composer-DhWyK5QW.js` |
| Composer controller | `webview/assets/composer-controller-DSr1Xyxe.js` |
| Thread scroll | `webview/assets/thread-scroll-layout-CQlmRS86.js` |
| Button | `webview/assets/button-DO-oxX3-.js` |
| Dialog | `webview/assets/dialog-layout-DyzgPiHE.js` |
| Settings | `webview/assets/setting-storage-II74UqER.js` |
| Persisted atoms | `webview/assets/persisted-signal-C9s53PEH.js` |
| Sidebar state | `webview/assets/sidebar-signals-BA19kopf.js` |
| Electron API | `webview/assets/vscode-api-CISfap9F.js` |
| Rate limit hooks | `webview/assets/use-rate-limit-BV5pYGKd.js` |
| Reset credits API | `webview/assets/codex-api-DfC2XBrP.js` |
| Usage query | `webview/assets/thread-context-inputs-BhGjWqLR.js` |
| Main process | `.vite/build/main-DFegGFWC.js` |
| Preload | `.vite/build/preload.js` |
| Bootstrap | `.vite/build/bootstrap.js` |
