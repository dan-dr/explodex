/**
 * Explodex SDK v1.0.0
 *
 * DOM-zone plugin runtime for the Codex Electron renderer.
 * Mirrors Codex design tokens and exposes injection, components, storage, and bridge APIs.
 *
 * @see docs/codex-architecture.md
 */
(function initExplodex(global) {
  if (global.Explodex?.destroy) {
    console.info("[Explodex] reloading", global.Explodex.version);
    try {
      global.Explodex.destroy({ reason: "reload" });
    } catch (err) {
      console.warn("[Explodex] previous runtime destroy failed", err);
    }
  } else if (global.Explodex?.version) {
    delete global.Explodex;
  }

  // Capture Codex in-renderer AppServer router (Ut/Dr.sendRequest) when React mounts.
  // Plugins must NOT use electronBridge.sendMessageFromView alone — that IPC path does not
  // update the renderer manager that collaborationMode reads at submit time.
  (function installAppServerRouterCapture() {
    if (global.__explodexAppServerRouterCaptureInstalled || global.__bcAppServerRouterCaptureInstalled) {
      if (!global.__explodexAppServerSend && global.__bcAppServerSend) {
        global.__explodexAppServerSend = global.__bcAppServerSend;
      }
      return;
    }
    global.__explodexAppServerRouterCaptureInstalled = true;

    const bindRouter = (router) => {
      if (!router?.sendRequest || global.__explodexAppServerSend) return;
      global.__explodexAppServerSend = (type, payload) => router.sendRequest(type, payload);
      global.__bcAppServerSend = global.__explodexAppServerSend;
    };

    const isAppServerRouter = (obj) =>
      obj &&
      typeof obj.sendRequest === "function" &&
      typeof obj.setMessageHandler === "function";

    const maybeBindRouterCall = (thisArg, args) => {
      if (!isAppServerRouter(thisArg) || !args.length || typeof args[0] !== "string") {
        return false;
      }
      bindRouter(thisArg);
      return true;
    };

    const maybeBindRouterSetHandler = (thisArg, args) => {
      if (
        !isAppServerRouter(thisArg) ||
        args.length !== 1 ||
        typeof args[0] !== "function"
      ) {
        return false;
      }
      return true;
    };

    Function.prototype.call = function captureAppServerCall(thisArg, ...args) {
      try {
        if (maybeBindRouterSetHandler(thisArg, args)) {
          const result = Reflect.apply(this, thisArg, args);
          bindRouter(thisArg);
          return result;
        }
        maybeBindRouterCall(thisArg, args);
      } catch {
        // fall through
      }
      return Reflect.apply(this, thisArg, args);
    };

    Function.prototype.apply = function captureAppServerApply(thisArg, args) {
      const argv = args ?? [];
      try {
        if (maybeBindRouterSetHandler(thisArg, argv)) {
          const result = Reflect.apply(this, thisArg, argv);
          bindRouter(thisArg);
          return result;
        }
        maybeBindRouterCall(thisArg, argv);
      } catch {
        // fall through
      }
      return Reflect.apply(this, thisArg, argv);
    };
  })();

  // open-in-targets returns icon paths like `apps/cursor.png` (relative). On nested
  // routes (/settings/apps, /settings/personalization, …) the browser resolves those
  // against the current path → 404. thread-app-shell onError then sets `apps/vscode.png`
  // (also relative) which can loop. Rewrite bundle-relative apps/* to /apps/*.
  (function installAppIconPathFix() {
    if (global.__explodexAppIconPathFixInstalled) return;
    global.__explodexAppIconPathFixInstalled = true;

    const RELATIVE_APPS_RE = /^apps\/[A-Za-z0-9._-]+\.(?:png|svg)$/;

    const toAbsoluteAppIcon = (value) => {
      if (typeof value !== "string") return value;
      if (!RELATIVE_APPS_RE.test(value)) return value;
      try {
        return new URL(`/${value}`, global.location?.href ?? `/${value}`).href;
      } catch {
        return `/${value}`;
      }
    };

    const fixBrokenResolvedSrc = (src) => {
      // e.g. app://-/settings/apps/apps/cursor.png → app://-/apps/cursor.png
      const match = src.match(/\/apps\/(apps\/[A-Za-z0-9._-]+\.(?:png|svg))$/);
      if (!match) return null;
      try {
        return new URL(`/${match[1]}`, global.location?.href ?? `/${match[1]}`).href;
      } catch {
        return `/${match[1]}`;
      }
    };

    const proto = global.HTMLImageElement?.prototype;
    const srcDesc = proto && Object.getOwnPropertyDescriptor(proto, "src");
    if (srcDesc?.set) {
      const nativeSet = srcDesc.set;
      Object.defineProperty(proto, "src", {
        ...srcDesc,
        set(value) {
          nativeSet.call(this, toAbsoluteAppIcon(value));
        },
      });
    }

    global.document?.addEventListener?.(
      "error",
      (ev) => {
        const img = ev.target;
        if (!img || img.tagName !== "IMG") return;
        const fixed = fixBrokenResolvedSrc(img.currentSrc || img.src || "");
        if (!fixed) return;
        img.onerror = null;
        img.src = fixed;
      },
      true,
    );
  })();

  const VERSION = "1.2.0";
  const PLUGIN_ENABLED_KEY = "explodex-plugin-enabled";
  const PLUGIN_RESTART_KEY = "explodex-plugin-restart-pending";
  const STYLE_ID = "explodex-sdk-style";
  const MOUNT_ATTR = "data-explodex-mount";
  const PLUGIN_ATTR = "data-explodex-plugin";
  const PERSISTED_PREFIX = "codex:persisted-atom:";
  const RUNTIME_DOM_SELECTOR = [
    ".ex-pill",
    ".ex-status-fixed",
    ".ex-dialog-backdrop",
    ".ex-popover-backdrop",
    ".ex-nav-row",
  ].join(",");

  const mounted = new Map();
  const observers = new Set();
  const plugins = new Map();
  const pluginCatalog = new Map();
  const pluginTeardowns = new Map();
  const pluginOptionsHandlers = new Map();
  const pluginSources = new Map();
  const navMounts = new Map();
  let activePopover = null;
  const messageHandlers = new Map();

  // ─── Logging ──────────────────────────────────────────────────────────────

  const LOG_MAX = 500;
  const logEntries = [];
  const logSubscribers = new Set();

  function serializeDetail(detail) {
    if (detail == null) return null;
    if (detail instanceof Error) {
      return { name: detail.name, message: detail.message, stack: detail.stack };
    }
    if (typeof detail === "object") {
      try {
        return JSON.parse(JSON.stringify(detail));
      } catch {
        return String(detail);
      }
    }
    return detail;
  }

  function emitLog(level, scope, message, detail) {
    const entry = {
      ts: Date.now(),
      level,
      scope: scope ?? "sdk",
      message,
      detail: serializeDetail(detail),
    };
    logEntries.push(entry);
    if (logEntries.length > LOG_MAX) logEntries.shift();

    const tag = scope ? `[Explodex:${scope}]` : "[Explodex]";
    const line = detail != null ? [message, detail] : [message];
    if (level === "error") console.error(tag, ...line);
    else if (level === "warn") console.warn(tag, ...line);
    else if (level === "debug") console.debug(tag, ...line);
    else console.info(tag, ...line);

    for (const fn of logSubscribers) {
      try {
        fn(entry);
      } catch (_) {
        /* ignore subscriber errors */
      }
    }
    return entry;
  }

  function pluginLogger(pluginId) {
    return {
      debug: (message, detail) => emitLog("debug", pluginId, message, detail),
      info: (message, detail) => emitLog("info", pluginId, message, detail),
      warn: (message, detail) => emitLog("warn", pluginId, message, detail),
      error: (message, detail) => emitLog("error", pluginId, message, detail),
    };
  }

  const log = {
    debug: (message, detail) => emitLog("debug", "sdk", message, detail),
    info: (message, detail) => emitLog("info", "sdk", message, detail),
    warn: (message, detail) => emitLog("warn", "sdk", message, detail),
    error: (message, detail) => emitLog("error", "sdk", message, detail),
    plugin: pluginLogger,
    entries: () => [...logEntries],
    subscribe: (fn) => {
      logSubscribers.add(fn);
      return () => logSubscribers.delete(fn);
    },
    clear: () => {
      logEntries.length = 0;
    },
  };

  // ─── Design tokens (mirrors Codex button-DO-oxX3-.js) ─────────────────────

  const BUTTON_RADIUS = {
    default: "rounded-full",
    large: "rounded-full",
    medium: "rounded-lg",
    icon: "rounded-full",
    iconSm: "rounded-md",
    composer: "rounded-full",
    composerSm: "rounded-full",
    toolbar: "rounded-lg",
  };

  const BUTTON_COLOR = {
    primary:
      "background:var(--color-foreground,#fff);color:var(--color-dropdown-background,#111);border-color:transparent",
    secondary:
      "background:color-mix(in srgb,var(--color-foreground,currentColor) 5%,transparent);color:var(--color-foreground,inherit);border-color:transparent",
    outline:
      "background:var(--color-bg-fog,transparent);color:inherit;border:1px solid var(--color-border,currentColor)",
    outlineActive:
      "background:color-mix(in srgb,var(--color-foreground,currentColor) 10%,transparent);color:inherit;border:1px solid var(--color-border,currentColor)",
    ghost:
      "background:transparent;color:var(--color-text-tertiary,inherit);border-color:transparent",
    ghostActive:
      "background:var(--color-list-hover-background,color-mix(in srgb,currentColor 8%,transparent));color:inherit;border-color:transparent",
    ghostMuted:
      "background:transparent;color:var(--color-muted-foreground,inherit);border-color:transparent",
    ghostTertiary:
      "background:transparent;color:var(--color-text-tertiary,inherit);border-color:transparent",
    danger:
      "background:color-mix(in srgb,#ef4444 10%,transparent);color:#ef4444;border-color:transparent",
  };

  const BUTTON_SIZE = {
    default: "padding:2px 8px;font-size:14px;line-height:18px",
    large: "padding:8px 20px;font-size:16px;line-height:18px",
    medium: "padding:6px 16px;font-size:16px;line-height:18px",
    icon: "padding:2px;display:inline-flex;align-items:center;justify-content:center",
    iconSm: "padding:2px;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center",
    composer: "padding:0 8px;font-size:14px;line-height:18px;height:var(--button-composer-height,28px)",
    composerSm: "padding:0 6px;font-size:14px;line-height:18px;height:var(--button-composer-sm-height,24px)",
    toolbar: "padding:0 8px;font-size:16px;line-height:18px;height:var(--button-composer-height,28px)",
  };

  // ─── Zone registry ────────────────────────────────────────────────────────

  const ZONE_DEFINITIONS = {
    aboveComposer: {
      id: "aboveComposer",
      description: "Official portal above the composer input",
      selectors: [
        "[data-above-composer-portal]",
        "#above-composer-portal",
      ],
      mount: "append",
      priority: 1,
    },
    aboveComposerQueue: {
      id: "aboveComposerQueue",
      description: "Queued message UI portal above composer",
      selectors: [
        "[data-above-composer-queue-portal]",
        "#above-composer-queue-portal",
      ],
      mount: "append",
      priority: 2,
    },
    mcpAppPortal: {
      id: "mcpAppPortal",
      description: "MCP app iframe portal in thread scroll",
      selectors: ['[data-mcp-app-portal-target="true"]'],
      mount: "append",
      priority: 3,
    },
    threadFooter: {
      id: "threadFooter",
      description: "Sticky thread scroll footer (composer region)",
      selectors: ['[data-thread-scroll-footer="true"]'],
      mount: "prepend",
      priority: 4,
    },
    browserSidebarBanner: {
      id: "browserSidebarBanner",
      description: "Browser sidebar top banner portal",
      selectors: ['[data-testid="browser-sidebar-top-banner-portal"]'],
      mount: "append",
      priority: 5,
    },
    homeAmbient: {
      id: "homeAmbient",
      description: "Home page ambient suggestions strip",
      selectors: ["[data-home-ambient-suggestions]"],
      mount: "append",
      priority: 6,
    },
    sidebar: {
      id: "sidebar",
      description: "Left sidebar / floating panel",
      selectors: [
        'aside[data-testid="app-shell-floating-left-panel"]',
        '[data-testid="app-shell-floating-left-panel"]',
        "aside.app-shell-left-panel",
        '[data-pip-obstacle="app-shell-floating-left-panel"] aside',
        "[data-explodex-sidebar]",
      ],
      mount: "append",
      priority: 10,
    },
    composerActions: {
      id: "composerActions",
      description: "Near the ProseMirror composer input",
      selectors: [
        "[data-explodex-composer-actions]",
        ".ProseMirror",
      ],
      mount: "after-input",
      priority: 11,
    },
    statusOverlay: {
      id: "statusOverlay",
      description: "Fixed overlay on document body",
      selectors: ["body"],
      mount: "fixed",
      priority: 99,
    },
  };

  // ─── Utilities ────────────────────────────────────────────────────────────

  function firstExisting(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function closestComposerShell(input) {
    if (!input) return null;
    return (
      input.closest("form") ||
      input.closest('[class*="composer" i]') ||
      input.closest('[data-above-composer-portal]')?.parentElement ||
      input.parentElement?.parentElement ||
      input.parentElement
    );
  }

  function resolveZoneAnchor(zoneId) {
    const def = ZONE_DEFINITIONS[zoneId];
    if (!def) return null;

    if (zoneId === "composerActions") {
      const explicit = firstExisting(["[data-explodex-composer-actions]"]);
      if (explicit) return explicit;
      const pm = document.querySelector(".ProseMirror");
      if (pm) return closestComposerShell(pm);
      return firstExisting(def.selectors.slice(1));
    }

    if (zoneId === "statusOverlay") return document.body;
    return firstExisting(def.selectors);
  }

  function applyButtonStyles(el, { color = "primary", size = "default", uniform = false } = {}) {
    const base =
      "box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;" +
      "border:1px solid transparent;white-space:nowrap;cursor:pointer;" +
      "font:inherit;outline:none;-webkit-app-region:no-drag";
    const disabled = "cursor:not-allowed;opacity:0.4";
    el.style.cssText = `${base};${BUTTON_SIZE[size] || BUTTON_SIZE.default};${BUTTON_COLOR[color] || BUTTON_COLOR.primary}`;
    if (uniform) {
      el.style.aspectRatio = "1";
      el.style.justifyContent = "center";
      el.style.padding = "0";
    }
    el.addEventListener("mouseenter", () => {
      if (!el.disabled) el.style.filter = "brightness(1.08)";
    });
    el.addEventListener("mouseleave", () => {
      el.style.filter = "";
    });
    Object.defineProperty(el, "_bcSetDisabled", {
      value(disabled) {
        el.disabled = disabled;
        el.style.cssText = disabled
          ? `${el.style.cssText};${disabled}`
          : el.style.cssText.replace(disabled, "");
      },
    });
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${MOUNT_ATTR}] { box-sizing: border-box; }
      .ex-mount-above-composer { width: 100%; }
      .ex-mount-composer-actions { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; }
      .ex-sidebar-item {
        display: flex; align-items: center; gap: 8px;
        width: calc(100% - 12px); margin: 6px; padding: 7px 9px;
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, currentColor 6%, transparent);
        color: inherit; font: inherit; cursor: pointer;
        -webkit-app-region: no-drag;
      }
      .ex-sidebar-item:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .ex-panel {
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        border-radius: 12px;
        background: color-mix(in srgb, currentColor 4%, transparent);
        padding: 10px 12px;
        color: inherit;
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ex-badge {
        display: inline-flex; align-items: center;
        padding: 1px 6px; border-radius: 999px;
        font-size: 11px; font-weight: 600; line-height: 16px;
        background: color-mix(in srgb, currentColor 12%, transparent);
        color: inherit;
      }
      .ex-pill {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
        padding: 6px 10px; border-radius: 999px;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        background: color-mix(in srgb, var(--color-bg-primary,#1a1a1a) 92%, transparent);
        color: inherit;
        font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
        backdrop-filter: blur(8px);
      }
      .ex-status-fixed {
        position: fixed; right: 12px; bottom: 48px; z-index: 2147483646;
        padding: 6px 10px; border-radius: 8px;
        background: color-mix(in srgb, #111 88%, transparent);
        color: #fff; font: 12px/1.3 system-ui, sans-serif;
        pointer-events: none;
      }
      .ex-nav-row { width: 100%; -webkit-app-region: no-drag; }
      .ex-sidebar-footer-plugins {
        display: flex; flex-direction: column; gap: 0; width: 100%;
        padding: 4px var(--padding-row-x, 8px) 2px; box-sizing: border-box;
        background: transparent;
        color: var(--color-token-foreground, inherit);
        border-top: 0.5px solid color-mix(in srgb, var(--color-token-foreground, currentColor) 10%, transparent);
      }
      .ex-nav-row-above-footer { padding: 0; width: 100%; }
      .ex-nav-btn {
        box-sizing: border-box; display: flex; align-items: center; gap: 8px;
        width: 100%; min-height: var(--height-token-row, 30px);
        padding: var(--padding-row-y, 4px) var(--padding-row-cell-x, var(--padding-row-x, 8px));
        border: 0; border-radius: var(--radius-token-row, 10px);
        background: transparent;
        color: var(--color-token-foreground, inherit);
        font: 445 14px/1.43 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: left; cursor: pointer; -webkit-app-region: no-drag;
        outline: none;
      }
      .ex-nav-btn:hover {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      }
      .ex-nav-btn:focus-visible {
        outline: 2px solid var(--color-token-border, color-mix(in srgb, currentColor 20%, transparent));
        outline-offset: 1px;
      }
      .ex-nav-btn[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 10%, transparent));
      }
      .ex-nav-btn-compact {
        font: 445 13px/1.43 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--color-token-text-secondary, inherit);
        font-variant-numeric: tabular-nums;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ex-nav-icon { width: 16px; text-align: center; flex-shrink: 0; opacity: 0.85; }
      .ex-popover-backdrop {
        position: fixed; inset: 0; z-index: 2147483645; background: transparent;
      }
      .ex-popover {
        position: fixed; z-index: 2147483646;
        width: min(380px, calc(100vw - 24px)); max-height: min(70vh, 560px);
        overflow: hidden; display: flex; flex-direction: column; border-radius: 12px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        background: var(--color-bg-primary, #111);
        color: inherit;
        box-shadow: 0 12px 40px color-mix(in srgb, #000 45%, transparent);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ex-popover-header {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 12px 14px; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        position: sticky; top: 0; background: inherit; z-index: 1;
      }
      .ex-popover-title { font-weight: 600; font-size: 14px; }
      .ex-popover-body {
        padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px;
        flex: 1; min-height: 0; overflow: hidden;
      }
      .ex-dialog-backdrop {
        position: fixed; inset: 0; z-index: 2147483647;
        background: color-mix(in srgb, #000 55%, transparent);
        display: flex; align-items: center; justify-content: center; padding: 16px;
      }
      .ex-dialog {
        width: min(420px, 100%); border-radius: 12px; padding: 16px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        background: var(--color-bg-primary, #111); color: inherit;
        box-shadow: 0 16px 48px color-mix(in srgb, #000 50%, transparent);
        font: 13px/1.45 system-ui, -apple-system, sans-serif;
      }
      .ex-plugin-row {
        display: flex; align-items: flex-start; gap: 10px; padding: 8px 0;
        border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
      }
      .ex-plugin-list .ex-plugin-row:last-child { border-bottom: 0; }
      .ex-plugin-footer {
        display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
        padding-top: 8px; margin-top: 4px;
        border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent);
      }
      .ex-explodex-page {
        position: absolute; inset: 0; z-index: 24; overflow: auto;
        background: var(--color-bg-primary, #111); color: inherit;
        font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ex-explodex-page-inner {
        max-width: 720px; margin: 0 auto; padding: 28px 20px 48px;
        display: flex; flex-direction: column; gap: 16px;
      }
      .ex-explodex-page-header h1 {
        margin: 0; font-size: 22px; line-height: 1.25; font-weight: 600;
      }
      .ex-explodex-page-header p {
        margin: 6px 0 0;
        color: var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent));
        font-size: 13px; line-height: 1.4;
      }
      .ex-explodex-plugin-section {
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 12px; background: color-mix(in srgb, currentColor 3%, transparent);
        overflow: hidden;
      }
      .ex-explodex-plugin-section > summary {
        list-style: none; cursor: pointer; padding: 12px 14px;
        display: flex; align-items: flex-start; gap: 10px;
        border-bottom: 1px solid transparent;
      }
      .ex-explodex-plugin-section > summary::-webkit-details-marker { display: none; }
      .ex-explodex-plugin-section[open] > summary {
        border-bottom-color: color-mix(in srgb, currentColor 10%, transparent);
      }
      .ex-explodex-plugin-section-body {
        padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 12px;
      }
      .ex-explodex-plugin-meta {
        font-size: 11px; line-height: 1.4;
        color: var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent));
      }
      .ex-explodex-page-actions {
        display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px;
        border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
      }
      .ex-field-stack {
        display: flex; flex-direction: column; gap: 10px;
      }
      .ex-field-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        font-size: 13px; line-height: 20px;
      }
      .ex-field-row > label, .ex-field-row > .ex-field-label {
        flex: 1; min-width: 0; cursor: pointer;
      }
      .ex-field-row > input[type="checkbox"], .ex-field-row > input[type="radio"] {
        flex-shrink: 0; cursor: pointer;
      }
      .ex-field-input {
        width: 88px; padding: 4px 8px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        background: transparent; color: inherit; font: inherit;
      }
      .ex-field-input-wide {
        width: 100%; max-width: 100%; box-sizing: border-box;
        padding: 6px 8px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        background: transparent; color: inherit; font: inherit;
      }
      .ex-field-input-mono { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .ex-field-select {
        padding: 4px 8px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        background: var(--color-bg-primary, #111); color: inherit; font: inherit;
      }
      .ex-field-meta {
        font-size: 11px; line-height: 1.4;
        color: var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent));
      }
      .ex-section {
        display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        background: color-mix(in srgb, currentColor 3%, transparent);
      }
      .ex-section-title { font-weight: 600; font-size: 12px; line-height: 16px; }
      .ex-section-body { display: flex; flex-direction: column; gap: 6px; }
      .ex-sortable-list { display: flex; flex-direction: column; gap: 4px; }
      .ex-sortable-item {
        display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
        border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        background: color-mix(in srgb, currentColor 2%, transparent);
      }
      .ex-sortable-item-label { flex: 1; min-width: 0; font-size: 13px; }
      .ex-sortable-item-actions { display: inline-flex; gap: 2px; flex-shrink: 0; }
      .ex-sortable-btn {
        border: 0; border-radius: 4px; padding: 2px 6px; background: transparent;
        color: inherit; font: inherit; font-size: 11px; cursor: pointer;
      }
      .ex-sortable-btn:hover:not(:disabled) {
        background: color-mix(in srgb, currentColor 10%, transparent);
      }
      .ex-sortable-btn:disabled { opacity: 0.35; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  // ─── Bridge ───────────────────────────────────────────────────────────────

  function postMessageToCodex(message) {
    const electron = global.electronBridge;
    let forwarded = false;
    if (electron?.sendMessageFromView) {
      electron.sendMessageFromView(message).catch((err) => {
        if (message.type !== "log-message") {
          console.warn("[Explodex] sendMessageFromView failed for", message.type, err);
        }
      });
      forwarded = true;
    }
    const event = new CustomEvent("codex-message-from-view", { detail: message });
    if (forwarded) event.__codexForwardedViaBridge = true;
    global.dispatchEvent(event);
  }

  const bridge = {
    isAvailable() {
      return Boolean(
        global.__explodexAppServerSend ||
          global.__bcAppServerSend ||
          global.electronBridge?.sendMessageFromView,
      );
    },

    async send(type, payload = {}) {
      const appServerSend = global.__explodexAppServerSend || global.__bcAppServerSend;
      if (appServerSend) {
        try {
          return await appServerSend(type, payload);
        } catch (err) {
          console.warn("[Explodex] AppServer send failed for", type, err);
          return null;
        }
      }

      const electron = global.electronBridge;
      if (!electron?.sendMessageFromView) {
        console.warn("[Explodex] electronBridge unavailable for", type);
        return null;
      }
      postMessageToCodex({ type, ...payload });
      return undefined;
    },

    async rpc(method, params = {}) {
      const appServerSend = global.__explodexAppServerSend || global.__bcAppServerSend;
      if (appServerSend) {
        try {
          return await appServerSend(method, params);
        } catch (err) {
          console.warn("[Explodex] AppServer RPC failed:", method, err);
          return null;
        }
      }

      if (!http.isAvailable()) return null;
      try {
        const flatRpcMethods = new Set(["get-global-state", "set-global-state"]);
        const body = flatRpcMethods.has(method)
          ? (params.params ?? params)
          : params.params != null
            ? { params: params.params }
            : params;
        return await http.post(`vscode://codex/${method}`, body);
      } catch (err) {
        console.warn("[Explodex] RPC failed:", method, err);
        return null;
      }
    },

    navigate(path, state) {
      const payload = state != null ? { path, state } : { path };
      return bridge.send("navigate-to-route", payload);
    },

    theme() {
      return global.electronBridge?.getSystemThemeVariant?.() ?? "dark";
    },

    onThemeChange(callback) {
      return global.electronBridge?.subscribeToSystemThemeVariant?.(callback) ?? (() => {});
    },

    on(type, handler) {
      const set = messageHandlers.get(type) ?? new Set();
      set.add(handler);
      messageHandlers.set(type, set);

      if (!bridge._messageListenerInstalled) {
        bridge._messageListenerInstalled = true;
        global.addEventListener("message", (event) => {
          const data = event.data;
          if (!data?.type) return;
          const handlers = messageHandlers.get(data.type);
          if (handlers) handlers.forEach((h) => h(data));
        });
      }

      return () => {
        const s = messageHandlers.get(type);
        if (s) {
          s.delete(handler);
          if (s.size === 0) messageHandlers.delete(type);
        }
      };
    },

    buildFlavor() {
      return global.electronBridge?.getBuildFlavor?.() ?? "unknown";
    },

    usesOwlShell() {
      return global.electronBridge?.usesOwlAppShell?.() ?? false;
    },
  };

  // ─── HTTP (authenticated Codex backend proxy) ─────────────────────────────

  const httpPending = new Map();
  let httpListenerInstalled = false;

  function ensureHttpListener() {
    if (httpListenerInstalled) return;
    httpListenerInstalled = true;
    global.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.type !== "fetch-response") return;
      const pending = httpPending.get(data.requestId);
      if (!pending) return;
      httpPending.delete(data.requestId);
      pending.cleanup?.();
      if (data.responseType === "success") {
        if (data.status >= 200 && data.status < 300) {
          try {
            pending.resolve({
              status: data.status,
              headers: data.headers,
              body: data.bodyJsonString ? JSON.parse(data.bodyJsonString) : null,
            });
          } catch (err) {
            pending.reject(err);
          }
        } else {
          pending.reject(new Error(data.bodyJsonString || `HTTP ${data.status}`));
        }
      } else {
        pending.reject(new Error(data.errorMessage || data.bodyJsonString || "fetch failed"));
      }
    });
  }

  const http = {
    isAvailable() {
      return bridge.isAvailable();
    },

    async request(method, url, options = {}) {
      if (!bridge.isAvailable()) {
        throw new Error("electronBridge unavailable");
      }
      ensureHttpListener();
      const requestId = crypto.randomUUID();
      const headers = {
        "OAI-Language": "en",
        originator: "Codex Desktop",
        ...options.headers,
      };
      const controller = new AbortController();
      const payload = {
        requestId,
        method,
        url,
        headers,
        body: options.body == null ? undefined : JSON.stringify(options.body),
      };

      return new Promise((resolve, reject) => {
        const onAbort = () => {
          httpPending.delete(requestId);
          bridge.send("cancel-fetch", { requestId }).catch(() => {});
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (options.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
        httpPending.set(requestId, {
          resolve,
          reject,
          cleanup: () => options.signal?.removeEventListener("abort", onAbort),
        });
        bridge.send("fetch", payload).catch((err) => {
          httpPending.delete(requestId);
          reject(err);
        });
      });
    },

    get(url, options) {
      return this.request("GET", url, options).then((r) => r.body);
    },

    post(url, body, options = {}) {
      return this.request("POST", url, { ...options, body }).then((r) => r.body);
    },
  };

  // ─── Storage ──────────────────────────────────────────────────────────────

  function reactFiber(node) {
    if (!node || typeof node !== "object") return null;
    const key = Object.keys(node).find((name) => name.startsWith("__reactFiber"));
    return key ? node[key] : null;
  }

  function getQueryClient() {
    let fiber = reactFiber(document.querySelector("nav") ?? document.documentElement);
    for (let depth = 0; depth < 200 && fiber; depth += 1) {
      const client = fiber.memoizedProps?.value;
      if (client?.getQueryCache && client?.setQueryData) return client;
      fiber = fiber.return;
    }
    return null;
  }

  const STATSIG_PATCH_STORE_KEY = "__explodexStatsigGatePatchStore";

  function getStatsigClients() {
    const statsig = global.__STATSIG__;
    if (!statsig) return [];

    const clients = [];
    if (statsig.firstInstance) clients.push(statsig.firstInstance);
    if (statsig.instance) clients.push(statsig.instance);
    for (const instance of Object.values(statsig.instances ?? {})) {
      clients.push(instance);
    }

    return [...new Set(clients)].filter(
      (client) =>
        client &&
        (typeof client.checkGate === "function" ||
          typeof client.getFeatureGate === "function"),
    );
  }

  function ensureStatsigPatchStore(client) {
    if (!client[STATSIG_PATCH_STORE_KEY]) {
      client[STATSIG_PATCH_STORE_KEY] = {
        origCheckGate: client.checkGate?.bind(client),
        origGetFeatureGate: client.getFeatureGate?.bind(client),
        origOverrideAdapter: client.overrideAdapter ?? null,
        gates: new Map(),
      };
    }
    return client[STATSIG_PATCH_STORE_KEY];
  }

  function reinstallStatsigOverrides(client) {
    const store = client[STATSIG_PATCH_STORE_KEY];
    if (!store || store.gates.size === 0) {
      if (store) {
        if (store.origCheckGate) client.checkGate = store.origCheckGate;
        if (store.origGetFeatureGate) client.getFeatureGate = store.origGetFeatureGate;
        client.overrideAdapter = store.origOverrideAdapter;
        delete client[STATSIG_PATCH_STORE_KEY];
      }
      return;
    }

    const previous = store.origOverrideAdapter;
    client.overrideAdapter = {
      getGateOverride(gate, user, options) {
        const entry = store.gates.get(gate?.name);
        if (entry) {
          return {
            ...gate,
            value: entry.value,
            ruleID: "explodex-override",
          };
        }
        return previous?.getGateOverride?.(gate, user, options) ?? null;
      },
      getDynamicConfigOverride: previous?.getDynamicConfigOverride?.bind(previous),
      getExperimentOverride: previous?.getExperimentOverride?.bind(previous),
      getLayerOverride: previous?.getLayerOverride?.bind(previous),
      getParamStoreOverride: previous?.getParamStoreOverride?.bind(previous),
    };

    const origCheckGate = store.origCheckGate;
    if (origCheckGate) {
      client.checkGate = (gate, ...rest) => {
        const entry = store.gates.get(gate);
        return entry ? entry.value : origCheckGate(gate, ...rest);
      };
    }

    const origGetFeatureGate = store.origGetFeatureGate;
    if (origGetFeatureGate) {
      client.getFeatureGate = (gate, ...rest) => {
        const entry = store.gates.get(gate);
        if (!entry) return origGetFeatureGate(gate, ...rest);
        return {
          name: gate,
          value: entry.value,
          ruleID: "explodex-override",
          idType: "userID",
          details: { reason: "explodex-override" },
        };
      };
    }
  }

  function notifyStatsigValuesUpdated(clients = getStatsigClients()) {
    for (const client of clients) {
      try {
        client._memoCache = {};
        client.$emt?.({
          name: "values_updated",
          status: client.loadingStatus ?? "Ready",
          values: null,
        });
      } catch {
        // ignore emit failures
      }
    }
  }

  function standardConfigQueryKeys(hostId) {
    return [
      ["experimental-features", "list", hostId],
      ["config", "user", hostId],
      ["user-saved-config"],
    ];
  }

  const flags = {
    getQueryClient,

    getStatsigClients,

    readStatsigGate(gateId) {
      try {
        for (let i = 0; i < (global.localStorage?.length ?? 0); i += 1) {
          const storageKey = global.localStorage.key(i);
          if (!storageKey?.startsWith("statsig.cached.evaluations.")) continue;
          const raw = global.localStorage.getItem(storageKey);
          if (!raw) continue;
          const envelope = JSON.parse(raw);
          const data = JSON.parse(envelope.data);
          const gate = data.feature_gates?.[gateId];
          if (gate && typeof gate.value === "boolean") return gate.value;
        }
      } catch {
        // ignore parse errors
      }

      const clients = getStatsigClients();
      if (!clients.length) return null;
      try {
        return clients[0].checkGate?.(gateId);
      } catch {
        return null;
      }
    },

    setStatsigGateOverride(
      gateId,
      value,
      { pluginId = "explodex", notify = true } = {},
    ) {
      const clients = getStatsigClients();
      if (!clients.length || !gateId) return false;

      for (const client of clients) {
        const store = ensureStatsigPatchStore(client);
        if (value == null) {
          const entry = store.gates.get(gateId);
          if (entry) {
            entry.owners.delete(pluginId);
            if (entry.owners.size === 0) store.gates.delete(gateId);
          }
        } else {
          const entry = store.gates.get(gateId) ?? { value, owners: new Set() };
          entry.value = value;
          entry.owners.add(pluginId);
          store.gates.set(gateId, entry);
        }
        reinstallStatsigOverrides(client);
      }

      if (notify) notifyStatsigValuesUpdated(clients);
      return true;
    },

    clearStatsigGateOverrides({ pluginId } = {}) {
      const clients = getStatsigClients();
      for (const client of clients) {
        const store = client[STATSIG_PATCH_STORE_KEY];
        if (!store) continue;

        if (pluginId) {
          for (const [gateId, entry] of [...store.gates.entries()]) {
            entry.owners.delete(pluginId);
            if (entry.owners.size === 0) store.gates.delete(gateId);
          }
        } else {
          store.gates.clear();
        }
        reinstallStatsigOverrides(client);
      }

      if (clients.length) notifyStatsigValuesUpdated(clients);
    },

    notifyStatsigValuesUpdated,

    async invalidateQueries(queryKeys = []) {
      const normalized = queryKeys
        .map((queryKey) => (Array.isArray(queryKey) ? queryKey : null))
        .filter(Boolean);
      if (!normalized.length) return;

      const queryClient = getQueryClient();
      if (queryClient) {
        await Promise.all(
          normalized.map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }).catch(() => {}),
          ),
        );
      }

      const electron = global.electronBridge;
      if (!electron?.sendMessageFromView) return;

      await Promise.all(
        normalized.map((queryKey) =>
          electron
            .sendMessageFromView({ type: "query-cache-invalidate", queryKey })
            .catch(() => {}),
        ),
      );
    },

    async propagate({
      hostId,
      queryKeys = [],
      statsigGates,
      skipStandardInvalidation = false,
      pluginId = "explodex",
    } = {}) {
      if (statsigGates && typeof statsigGates === "object") {
        for (const [gateId, value] of Object.entries(statsigGates)) {
          flags.setStatsigGateOverride(gateId, value, { pluginId, notify: false });
        }
      }

      notifyStatsigValuesUpdated();

      const keys = [...queryKeys];
      if (!skipStandardInvalidation && hostId) {
        keys.push(...standardConfigQueryKeys(hostId));
      }

      const unique = [];
      const seen = new Set();
      for (const key of keys) {
        const signature = JSON.stringify(key);
        if (seen.has(signature)) continue;
        seen.add(signature);
        unique.push(key);
      }

      if (unique.length) {
        await flags.invalidateQueries(unique);
      }
    },
  };

  function codexGlobalStateQueryKey(key) {
    return ["vscode", "get-global-state", JSON.stringify({ key })];
  }

  function syncGlobalStateQueryCache(key, value) {
    const queryClient = getQueryClient();
    if (!queryClient) return;
    queryClient.setQueryData(codexGlobalStateQueryKey(key), { value });
  }

  const storage = {
    persisted: {
      _fullKey(key) {
        return key.startsWith(PERSISTED_PREFIX) ? key : `${PERSISTED_PREFIX}${key}`;
      },

      get(key, fallback) {
        const raw = global.localStorage?.getItem(this._fullKey(key));
        if (raw == null) return fallback;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      },

      set(key, value) {
        if (value === undefined) {
          global.localStorage?.removeItem(this._fullKey(key));
          return;
        }
        global.localStorage?.setItem(this._fullKey(key), JSON.stringify(value));
      },

      remove(key) {
        global.localStorage?.removeItem(this._fullKey(key));
      },

      keys() {
        const result = [];
        for (let i = 0; i < (global.localStorage?.length ?? 0); i++) {
          const k = global.localStorage.key(i);
          if (k?.startsWith(PERSISTED_PREFIX)) {
            result.push(k.slice(PERSISTED_PREFIX.length));
          }
        }
        return result;
      },

      subscribe(key, callback) {
        const fullKey = this._fullKey(key);
        const handler = (event) => {
          if (event.key === fullKey) {
            callback(this.get(key));
          }
        };
        global.addEventListener("storage", handler);
        return () => global.removeEventListener("storage", handler);
      },
    },

    settings: {
      async get(key, fallback) {
        const res = await bridge.rpc("get-setting", { params: { key } });
        return res?.value ?? fallback;
      },

      async set(key, value) {
        await bridge.rpc("set-setting", { params: { key, value } });
      },
    },

    globalState: {
      async get(key) {
        const res = await bridge.rpc("get-global-state", { params: { key } });
        return res?.value;
      },

      async set(key, value) {
        await bridge.rpc("set-global-state", { params: { key, value } });
        syncGlobalStateQueryCache(key, value);
      },
    },
  };

  // ─── Components ───────────────────────────────────────────────────────────

  const components = {
    button({
      label,
      children,
      color = "primary",
      size = "default",
      uniform = false,
      loading = false,
      disabled = false,
      type = "button",
      className = "",
      onClick,
      icon,
      ...rest
    } = {}) {
      const el = document.createElement("button");
      el.type = type;
      el.className = ["ex-button", className].filter(Boolean).join(" ");
      applyButtonStyles(el, { color, size, uniform });
      if (disabled || loading) el.disabled = true;

      if (loading) {
        const spinner = document.createElement("span");
        spinner.textContent = "…";
        spinner.style.marginRight = "4px";
        el.appendChild(spinner);
      }
      if (icon) {
        const iconEl = typeof icon === "string" ? document.createTextNode(icon) : icon;
        el.appendChild(iconEl);
      }
      const text = children ?? label ?? "";
      if (text) {
        const span = document.createElement("span");
        span.textContent = text;
        el.appendChild(span);
      }
      if (onClick) el.addEventListener("click", onClick);
      Object.assign(el, rest);
      return el;
    },

    sidebarItem({ label, icon, onClick, active = false } = {}) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ex-sidebar-item";
      if (active) el.style.background = "color-mix(in srgb, currentColor 12%, transparent)";
      if (icon) {
        const i = document.createElement("span");
        i.textContent = icon;
        i.setAttribute("aria-hidden", "true");
        el.appendChild(i);
      }
      const text = document.createElement("span");
      text.textContent = label ?? "Item";
      el.appendChild(text);
      if (onClick) el.addEventListener("click", onClick);
      return el;
    },

    pill({ label, position = "bottom-right" } = {}) {
      const el = document.createElement("div");
      el.className = "ex-pill";
      el.textContent = label ?? "";
      if (position === "top-right") {
        el.style.top = "12px";
        el.style.bottom = "auto";
      }
      return el;
    },

    badge({ label, count } = {}) {
      const el = document.createElement("span");
      el.className = "ex-badge";
      el.textContent = count != null ? String(count) : (label ?? "");
      return el;
    },

    panel({ title, children, className = "" } = {}) {
      const el = document.createElement("div");
      el.className = ["ex-panel", className].filter(Boolean).join(" ");
      if (title) {
        const h = document.createElement("div");
        h.style.cssText = "font-weight:600;margin-bottom:6px";
        h.textContent = title;
        el.appendChild(h);
      }
      if (children) {
        if (typeof children === "function") el.appendChild(children());
        else if (children instanceof Node) el.appendChild(children);
        else el.appendChild(document.createTextNode(String(children)));
      }
      return el;
    },

    statusToast(message, { duration = 2800 } = {}) {
      let toast = document.querySelector(".ex-status-fixed");
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "ex-status-fixed";
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      clearTimeout(components.statusToast._timer);
      components.statusToast._timer = setTimeout(() => toast.remove(), duration);
    },

    metaText(text) {
      const el = document.createElement("div");
      el.className = "ex-field-meta ex-explodex-plugin-meta";
      el.textContent = text ?? "";
      return el;
    },

    fieldRow({ label, control, hint } = {}) {
      const row = document.createElement("div");
      row.className = "ex-field-row";
      if (label != null) {
        const labelEl = document.createElement("span");
        labelEl.className = "ex-field-label";
        labelEl.textContent = String(label);
        row.appendChild(labelEl);
      }
      if (control) row.appendChild(control);
      if (hint) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
        wrap.appendChild(row);
        wrap.appendChild(components.metaText(hint));
        return wrap;
      }
      return row;
    },

    checkboxField({ label, checked = false, onChange } = {}) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(checked);
      if (onChange) input.addEventListener("change", () => onChange(input.checked));
      const row = document.createElement("label");
      row.className = "ex-field-row";
      const text = document.createElement("span");
      text.className = "ex-field-label";
      text.textContent = label ?? "";
      row.appendChild(text);
      row.appendChild(input);
      return row;
    },

    radioField({ label, name, value, checked = false, onChange } = {}) {
      const input = document.createElement("input");
      input.type = "radio";
      if (name) input.name = name;
      if (value != null) input.value = String(value);
      input.checked = Boolean(checked);
      if (onChange) input.addEventListener("change", () => {
        if (input.checked) onChange(value);
      });
      const row = document.createElement("label");
      row.className = "ex-field-row";
      const text = document.createElement("span");
      text.className = "ex-field-label";
      text.textContent = label ?? "";
      row.appendChild(text);
      row.appendChild(input);
      return row;
    },

    numberField({ label, value = 0, min, max, onChange } = {}) {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "ex-field-input";
      input.value = String(value);
      if (min != null) input.min = String(min);
      if (max != null) input.max = String(max);
      if (onChange) {
        input.addEventListener("change", () => {
          const parsed = Number(input.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        });
      }
      return components.fieldRow({ label, control: input });
    },

    textField({ label, value = "", placeholder, monospace = false, onChange } = {}) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = ["ex-field-input-wide", monospace ? "ex-field-input-mono" : ""]
        .filter(Boolean)
        .join(" ");
      input.value = value ?? "";
      if (placeholder) input.placeholder = placeholder;
      if (onChange) input.addEventListener("change", () => onChange(input.value));
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
      if (label) {
        const labelEl = document.createElement("div");
        labelEl.className = "ex-field-label";
        labelEl.style.fontSize = "13px";
        labelEl.textContent = label;
        wrap.appendChild(labelEl);
      }
      wrap.appendChild(input);
      return wrap;
    },

    selectField({ label, value, options = [], onChange } = {}) {
      const select = document.createElement("select");
      select.className = "ex-field-select";
      for (const opt of options) {
        const option = document.createElement("option");
        option.value = String(opt.value);
        option.textContent = opt.label ?? String(opt.value);
        option.selected = String(opt.value) === String(value);
        select.appendChild(option);
      }
      if (onChange) {
        select.addEventListener("change", () => onChange(select.value));
      }
      return components.fieldRow({ label, control: select });
    },

    section({ title, hint, children } = {}) {
      const el = document.createElement("div");
      el.className = "ex-section";
      if (title) {
        const heading = document.createElement("div");
        heading.className = "ex-section-title";
        heading.textContent = title;
        el.appendChild(heading);
      }
      if (hint) el.appendChild(components.metaText(hint));
      const body = document.createElement("div");
      body.className = "ex-section-body";
      if (children) {
        if (typeof children === "function") body.appendChild(children());
        else if (children instanceof Node) body.appendChild(children);
        else if (Array.isArray(children)) {
          for (const child of children) {
            if (child instanceof Node) body.appendChild(child);
          }
        }
      }
      el.appendChild(body);
      return { el, body };
    },

    sortableList({ label, items = [], onReorder, renderLabel } = {}) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
      if (label) {
        const labelEl = document.createElement("div");
        labelEl.className = "ex-field-label";
        labelEl.style.fontSize = "13px";
        labelEl.textContent = label;
        wrap.appendChild(labelEl);
      }

      const list = document.createElement("div");
      list.className = "ex-sortable-list";

      function moveItem(index, delta) {
        const next = items.slice();
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        items = next;
        onReorder?.(next.map((entry) => entry.id));
        paint();
      }

      function paint() {
        list.replaceChildren();
        items.forEach((item, index) => {
          const row = document.createElement("div");
          row.className = "ex-sortable-item";
          const text = document.createElement("div");
          text.className = "ex-sortable-item-label";
          text.textContent = renderLabel ? renderLabel(item) : (item.label ?? item.id ?? "");
          const actions = document.createElement("div");
          actions.className = "ex-sortable-item-actions";
          const up = document.createElement("button");
          up.type = "button";
          up.className = "ex-sortable-btn";
          up.textContent = "▲";
          up.disabled = index === 0;
          up.addEventListener("click", () => moveItem(index, -1));
          const down = document.createElement("button");
          down.type = "button";
          down.className = "ex-sortable-btn";
          down.textContent = "▼";
          down.disabled = index === items.length - 1;
          down.addEventListener("click", () => moveItem(index, 1));
          actions.append(up, down);
          row.append(text, actions);
          list.appendChild(row);
        });
      }

      paint();
      wrap.appendChild(list);
      return wrap;
    },

    fieldStack(children = []) {
      const el = document.createElement("div");
      el.className = "ex-field-stack";
      for (const child of children) {
        if (child instanceof Node) el.appendChild(child);
      }
      return el;
    },
  };

  // ─── Format utilities ─────────────────────────────────────────────────────

  const TEMPLATE_PLACEHOLDER_RE = /\{([^{}]+)\}/g;

  function resolveTemplatePath(context, path) {
    if (!path || context == null) return undefined;
    const segments = [];
    const re = /([^[.\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = re.exec(path)) !== null) {
      if (match[1] != null) segments.push(match[1]);
      else if (match[2] != null) segments.push(Number(match[2]));
    }
    let current = context;
    for (const segment of segments) {
      if (current == null) return undefined;
      current = current[segment];
    }
    return current;
  }

  const format = {
    template(template, context, { fallback = "—" } = {}) {
      if (typeof template !== "string" || !template) return "";
      return template.replace(TEMPLATE_PLACEHOLDER_RE, (_full, path) => {
        const value = resolveTemplatePath(context, String(path).trim());
        if (value == null || value === "") return fallback;
        return String(value);
      });
    },
  };

  // ─── Composer ───────────────────────────────────────────────────────────────

  const composer = {
    getInput() {
      return (
        document.querySelector(".ProseMirror") ||
        firstExisting(["textarea", '[contenteditable="true"]', '[role="textbox"]'])
      );
    },

    focus() {
      const input = this.getInput();
      if (!input) return false;
      input.focus();
      return true;
    },

    getText() {
      const input = this.getInput();
      if (!input) return "";
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        return input.value;
      }
      return input.textContent ?? "";
    },

    _composerBlocked() {
      const dialogOpen = document.querySelector('[role="dialog"][data-state="open"]');
      const terminalActive = document.querySelector("[data-codex-terminal]:focus-within");
      return Boolean(dialogOpen || terminalActive);
    },

    _dispatchComposerInput(input, text, inputType = "insertText") {
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType, data: text }),
      );
    },

    insertText(text) {
      const input = this.getInput();
      if (!input || this._composerBlocked()) return false;

      input.focus();

      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
        input.selectionStart = input.selectionEnd = start + text.length;
        this._dispatchComposerInput(input, text);
        return true;
      }

      const inserted = document.execCommand("insertText", false, text);
      this._dispatchComposerInput(input, text);
      return inserted || true;
    },

    setText(text) {
      const input = this.getInput();
      if (!input || this._composerBlocked()) return false;

      input.focus();

      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        input.value = text;
        input.selectionStart = input.selectionEnd = text.length;
        this._dispatchComposerInput(input, text, "insertReplacementText");
        return true;
      }

      const selection = global.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const inserted = document.execCommand("insertText", false, text);
      this._dispatchComposerInput(input, text, "insertReplacementText");
      return inserted || true;
    },
  };

  // ─── Codex internals (React fiber access) ─────────────────────────────────
  // The in-renderer AppServer router and thread managers live in module scope and
  // are not reachable via globals. The official `electronBridge.sendMessageFromView`
  // IPC path routes to the MAIN-process AppServer and does NOT update the renderer
  // manager / Jotai atoms that the composer reads at submit time, so settings sent
  // that way never reach the turn. Instead we reach the same in-renderer callbacks
  // the UI uses (e.g. the intelligence dropdown) by walking the React fiber tree.
  const FIBER_WALK_MAX = 150_000;
  const FIBER_HOOK_MAX = 400;

  function reactFiberRoot() {
    const host = document.querySelector("#root") || document.body;
    if (!host) return null;
    const key = Object.keys(host).find(
      (k) => k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"),
    );
    let fiber = key ? host[key] : null;
    while (fiber && fiber.return) fiber = fiber.return;
    return fiber;
  }

  // DFS the fiber tree, calling visit(fiber) on each node. Stops early when visit
  // returns true. Returns true if visit matched, false otherwise.
  function walkFibers(visit, max = FIBER_WALK_MAX) {
    const root = reactFiberRoot();
    if (!root) return false;
    const seen = new Set();
    const stack = [root];
    let count = 0;
    while (stack.length && count < max) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      count += 1;
      try {
        if (visit(fiber) === true) return true;
      } catch {
        /* ignore per-fiber errors */
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return false;
  }

  // Collect each hook node's `memoizedState` from a fiber's hook linked-list.
  function fiberHookStates(fiber) {
    const states = [];
    let hook = fiber.memoizedState;
    let guard = 0;
    while (hook && typeof hook === "object" && guard++ < FIBER_HOOK_MAX) {
      states.push(hook.memoizedState);
      hook = hook.next;
    }
    return states;
  }

  // Find the in-renderer conversation-state object for a thread by scanning fiber
  // hook states + props for an object whose `id` matches and that carries
  // `latestThreadSettings`. Used to read the thread's current model / effort.
  function findThreadConversation(conversationId) {
    if (!conversationId) return null;
    let found = null;
    walkFibers((fiber) => {
      const seenObj = new WeakSet();
      const scan = (val, depth) => {
        if (found || depth > 4 || !val || typeof val !== "object" || seenObj.has(val)) return;
        seenObj.add(val);
        if (
          val.id === conversationId &&
          val.latestThreadSettings &&
          typeof val.latestThreadSettings === "object" &&
          "model" in val.latestThreadSettings
        ) {
          found = val;
          return;
        }
        let keys;
        try {
          keys = Object.keys(val);
        } catch {
          return;
        }
        for (const k of keys.slice(0, 50)) {
          if (found) return;
          try {
            scan(val[k], depth + 1);
          } catch {
            /* ignore getters that throw */
          }
        }
      };
      for (const state of fiberHookStates(fiber)) scan(state, 1);
      const props = fiber.memoizedProps;
      if (props && typeof props === "object") {
        try {
          for (const k of Object.keys(props)) scan(props[k], 1);
        } catch {
          /* ignore */
        }
      }
      return found != null;
    });
    return found;
  }

  // Find the `useCallback` setter the intelligence dropdown calls to update model
  // + reasoning effort for the next turn. Its source contains the literal view
  // message name, and its dependency array's first entry is the bound
  // conversationId, so we can match the active thread precisely.
  function findNextTurnSettingsSetter(conversationId) {
    if (!conversationId) return null;
    let setter = null;
    walkFibers((fiber) => {
      for (const state of fiberHookStates(fiber)) {
        if (!Array.isArray(state) || typeof state[0] !== "function") continue;
        let src = "";
        try {
          src = Function.prototype.toString.call(state[0]);
        } catch {
          continue;
        }
        if (!src.includes("update-thread-settings-for-next-turn")) continue;
        const deps = state[1];
        if (Array.isArray(deps) && deps[0] === conversationId) {
          setter = state[0];
          return true;
        }
      }
      return false;
    });
    return setter;
  }

  const codex = {
    reactFiberRoot,
    walkFibers,
    getThreadConversation: findThreadConversation,

    getThreadModel(conversationId) {
      const conv = findThreadConversation(conversationId);
      return (
        conv?.latestThreadSettings?.model ??
        conv?.latestCollaborationMode?.settings?.model ??
        conv?.latestModel ??
        null
      );
    },

    getThreadEffort(conversationId) {
      const conv = findThreadConversation(conversationId);
      return (
        conv?.latestCollaborationMode?.settings?.reasoning_effort ??
        conv?.latestThreadSettings?.effort ??
        conv?.latestReasoningEffort ??
        null
      );
    },

    // Apply model + reasoning effort for the NEXT turn of an existing thread via
    // the same in-renderer callback the intelligence dropdown uses. This updates
    // the Jotai atoms the composer ships, unlike the broken IPC bridge path.
    // Returns true on success, false if the setter could not be found/applied.
    async applyThreadSettingsForNextTurn(conversationId, { model, effort } = {}) {
      const setter = findNextTurnSettingsSetter(conversationId);
      if (typeof setter !== "function") return false;
      const resolvedModel = model ?? codex.getThreadModel(conversationId);
      if (!resolvedModel) return false;
      try {
        const result = await setter(resolvedModel, effort);
        return result !== false;
      } catch (err) {
        console.warn("[Explodex] applyThreadSettingsForNextTurn failed", err);
        return false;
      }
    },
  };

  // ─── Query ────────────────────────────────────────────────────────────────

  const query = {
    testId(id) {
      return document.querySelector(`[data-testid="${id}"]`);
    },

    portal(name) {
      const map = {
        aboveComposer: "[data-above-composer-portal]",
        aboveComposerQueue: "[data-above-composer-queue-portal]",
        mcpApp: '[data-mcp-app-portal-target="true"]',
        threadFooter: '[data-thread-scroll-footer="true"]',
        browserBanner: '[data-testid="browser-sidebar-top-banner-portal"]',
      };
      return document.querySelector(map[name] ?? `[data-${name}]`);
    },

    one(selector) {
      return document.querySelector(selector);
    },

    all(selector) {
      return [...document.querySelectorAll(selector)];
    },
  };

  // ─── Injection ────────────────────────────────────────────────────────────

  function placeMount(anchor, mount, zoneId, position) {
    const def = ZONE_DEFINITIONS[zoneId];
    const strategy = position ?? def?.mount ?? "append";

    if (strategy === "prepend") {
      anchor.insertBefore(mount, anchor.firstChild);
    } else if (strategy === "after-input" && anchor.classList?.contains("ProseMirror")) {
      const shell = closestComposerShell(anchor) ?? anchor.parentElement;
      mount.className = "ex-mount-composer-actions";
      shell?.appendChild(mount);
    } else if (strategy === "fixed") {
      mount.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483640";
      mount.querySelectorAll("*").forEach((c) => (c.style.pointerEvents = "auto"));
      anchor.appendChild(mount);
    } else {
      if (zoneId === "aboveComposer") mount.className = "ex-mount-above-composer";
      anchor.appendChild(mount);
    }
  }

  function ensureMount(zoneId, pluginId, position) {
    const key = `${zoneId}:${pluginId}`;
    const existing = mounted.get(key);
    if (existing?.isConnected) return existing;

    const anchor = resolveZoneAnchor(zoneId);
    if (!anchor) return null;

    const mount = document.createElement("div");
    mount.setAttribute(MOUNT_ATTR, zoneId);
    mount.setAttribute(PLUGIN_ATTR, pluginId);
    placeMount(anchor, mount, zoneId, position);
    mounted.set(key, mount);
    return mount;
  }

  function observeZone(zoneId, callback, options = {}) {
    const { once = false, includeMutations = false } = options;
    let lastAnchor = null;
    let frame = null;
    let stopped = false;

    const stop = () => {
      stopped = true;
      if (frame != null) {
        global.cancelAnimationFrame(frame);
        frame = null;
      }
      observer.disconnect();
      observers.delete(observer);
    };

    const check = () => {
      frame = null;
      if (stopped) return;

      const anchor = resolveZoneAnchor(zoneId);
      if (!anchor) {
        lastAnchor = null;
        return;
      }

      if (!includeMutations && anchor === lastAnchor && anchor.isConnected) return;
      const previousAnchor = lastAnchor;
      lastAnchor = anchor;
      callback(anchor, { zoneId, previousAnchor });
      if (once) stop();
    };

    const schedule = () => {
      if (stopped || frame != null) return;
      frame = global.requestAnimationFrame(check);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    observers.add(observer);
    schedule();

    return stop;
  }

  const inject = {
    mount(zoneId, nodeOrFactory, options = {}) {
      const pluginId = options.pluginId ?? "anonymous";
      const mountPoint = ensureMount(zoneId, pluginId, options.position);
      if (!mountPoint) return false;
      if (mountPoint.childElementCount > 0 && !options.replace) return true;

      const ctx = { api, mountPoint, zoneId, pluginId };
      const node =
        typeof nodeOrFactory === "function" ? nodeOrFactory(ctx) : nodeOrFactory;
      mountPoint.replaceChildren(node);
      return true;
    },

    waitFor(zoneId, callback) {
      return observeZone(zoneId, callback, { once: true });
    },

    observeZone,

    observe(zoneId, callback, options = {}) {
      return observeZone(zoneId, callback, options);
    },

    unmount(pluginId) {
      for (const [key, node] of mounted) {
        if (key.endsWith(`:${pluginId}`)) {
          node.remove();
          mounted.delete(key);
        }
      }
    },
  };

  // ─── Sidebar navigation helpers ───────────────────────────────────────────

  function sidebarRoot() {
    return resolveZoneAnchor("sidebar");
  }

  const FOOTER_REFERENCE_LABELS = new Set(["settings", "profile", "account"]);

  function elementLabel(el) {
    return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function buttonAccessibleLabel(el) {
    if (!el) return "";
    const aria = el.getAttribute?.("aria-label")?.trim();
    if (aria) return aria;
    return elementLabel(el);
  }

  function isFooterReference(labels) {
    return labels.some((label) => FOOTER_REFERENCE_LABELS.has(String(label).toLowerCase()));
  }

  function labelMatchesNav(text, label, { exact = false } = {}) {
    if (!text || !label) return false;
    const hay = text.toLowerCase();
    const needle = label.toLowerCase();
    if (exact) return hay === needle || hay.startsWith(`${needle} `);
    return hay === needle || hay.startsWith(`${needle} `) || hay.includes(needle);
  }

  function findProfileFooterButton(root) {
    if (!root) return null;
    const buttons = root.querySelectorAll("button[aria-label]");
    for (const btn of buttons) {
      const aria = (btn.getAttribute("aria-label") ?? "").toLowerCase();
      if (aria.includes("settings") || aria.includes("open settings")) return btn;
    }
    const footerHost = root.querySelector('[class*="absolute"][class*="bottom-0"]');
    return footerHost?.querySelector("button") ?? null;
  }

  function findNavByLabels(labels, { exact = false, fromEnd = false } = {}) {
    const root = sidebarRoot();
    if (!root) return null;
    const wanted = labels.map((l) => l.toLowerCase());

    if (isFooterReference(labels)) {
      const profile = findProfileFooterButton(root);
      if (profile) return profile;
    }

    const nodes = Array.from(
      root.querySelectorAll("button, a, [role='button'], [role='menuitem']"),
    );
    const ordered = fromEnd ? nodes.reverse() : nodes;
    for (const node of ordered) {
      const text = buttonAccessibleLabel(node).toLowerCase();
      if (!text) continue;
      for (const label of wanted) {
        if (labelMatchesNav(text, label, { exact })) return node;
      }
    }
    return null;
  }

  function navRowFor(node) {
    if (!node) return null;
    return (
      node.closest("[data-explodex-nav]") ||
      node.closest("li") ||
      node.parentElement?.closest("div") ||
      node.parentElement
    );
  }

  function findSidebarFooterHost(root = sidebarRoot()) {
    if (!root) return null;
    const btn = findProfileFooterButton(root);
    if (btn) {
      const host = btn.closest('[class*="absolute"][class*="bottom-0"]');
      if (host) return host;
    }
    return root.querySelector('[class*="absolute"][class*="bottom-0"]');
  }

  function footerProfileRow(root = sidebarRoot()) {
    const host = findSidebarFooterHost(root);
    if (!host) return null;
    const btn = findProfileFooterButton(host);
    if (!btn) return null;
    return (
      btn.closest("div.relative") ||
      btn.closest('[class*="px-row-x"]') ||
      btn.parentElement
    );
  }

  function ensureFooterPluginStrip(root = sidebarRoot()) {
    const host = findSidebarFooterHost(root);
    if (!host) return null;

    const existing = host.querySelector("[data-explodex-footer-plugins]");
    if (existing) return existing;

    const strip = document.createElement("div");
    strip.className = "ex-sidebar-footer-plugins sidebar-foreground-muted";
    strip.setAttribute("data-explodex-footer-plugins", "true");

    const profileRow = footerProfileRow(root);
    if (profileRow?.parentElement) {
      profileRow.parentElement.insertBefore(strip, profileRow);
    } else {
      host.insertBefore(strip, host.firstChild);
    }
    return strip;
  }

  function footerRowFor(node) {
    if (!node) return null;
    const footerRow =
      node.closest('[class*="absolute"][class*="bottom-0"]') ||
      node.closest("div.flex.items-center.gap-3") ||
      node.closest("div.flex.items-center.gap-2") ||
      node.closest("div.flex.items-center.gap-px") ||
      node.closest("[class*='profile-footer' i]") ||
      node.closest("[class*='ProfileFooter' i]");
    if (footerRow?.parentElement) return footerRow;
    return navRowFor(node);
  }

  function ensureNavMount(key) {
    let mount = navMounts.get(key);
    if (mount?.isConnected) return mount;
    mount = document.createElement("div");
    mount.className = "ex-nav-row";
    mount.setAttribute("data-explodex-nav", key);
    navMounts.set(key, mount);
    return mount;
  }

  const sidebarNav = {
    find: findNavByLabels,

    insertAfter(referenceLabels, elementOrFactory, key = "nav-after") {
      const ref = findNavByLabels(referenceLabels);
      const row = navRowFor(ref);
      if (!row?.parentElement) return false;
      const mount = ensureNavMount(key);
      const node =
        typeof elementOrFactory === "function" ? elementOrFactory({ mount }) : elementOrFactory;
      mount.replaceChildren(node);
      row.parentElement.insertBefore(mount, row.nextSibling);
      return true;
    },

    insertBefore(referenceLabels, elementOrFactory, key = "nav-before") {
      const labels = Array.isArray(referenceLabels) ? referenceLabels : [referenceLabels];
      const footerTarget = isFooterReference(labels);
      const ref = findNavByLabels(labels, { exact: footerTarget, fromEnd: footerTarget });
      const mount = ensureNavMount(key);
      const node =
        typeof elementOrFactory === "function" ? elementOrFactory({ mount }) : elementOrFactory;
      mount.replaceChildren(node);

      if (footerTarget) {
        const strip = ensureFooterPluginStrip();
        if (!strip) return false;
        mount.classList.add("ex-nav-row-above-footer");
        strip.appendChild(mount);
        return true;
      }

      mount.classList.remove("ex-nav-row-above-footer");
      const row = navRowFor(ref);
      if (!row?.parentElement) return false;
      row.parentElement.insertBefore(mount, row);
      return true;
    },

    remove(key) {
      const mount = navMounts.get(key);
      if (mount) {
        mount.remove();
        navMounts.delete(key);
      }
    },
  };

  // ─── UI overlays (popover / dialog) ───────────────────────────────────────

  function resolvePopoverAnchorRect(anchor, anchorRect) {
    if (anchorRect && typeof anchorRect === "object") {
      const left = Number(anchorRect.left ?? anchorRect.x ?? 0);
      const top = Number(anchorRect.top ?? anchorRect.y ?? 0);
      const width = Number(anchorRect.width ?? 0);
      const height = Number(anchorRect.height ?? 0);
      const right = Number(anchorRect.right ?? left + width);
      const bottom = Number(anchorRect.bottom ?? top + height);
      return { left, top, right, bottom, width, height };
    }
    return anchor?.getBoundingClientRect?.() ?? null;
  }

  function positionPopoverPanel(panel, { width, side, anchor, anchorRect } = {}) {
    const margin = 8;
    const offset = 6;
    const rect = resolvePopoverAnchorRect(anchor, anchorRect);
    if (!rect) {
      panel.style.left = "12px";
      panel.style.top = "12px";
      return;
    }

    const panelHeight = Math.min(panel.offsetHeight || 360, window.innerHeight - margin * 2);
    let left;
    let top;
    if (side === "left") {
      left = rect.left - width - offset;
      top = rect.top;
    } else if (side === "bottom") {
      left = rect.left;
      top = rect.bottom + offset;
    } else {
      left = rect.right + offset;
      top = rect.top;
    }
    left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - panelHeight - margin);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(160, window.innerHeight - top - margin)}px`;
  }

  const ui = {
    navItem({
      label,
      icon,
      subtitle,
      compact = false,
      active = false,
      onClick,
      className = "",
    } = {}) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = ["ex-nav-btn", compact ? "ex-nav-btn-compact" : "", className]
        .filter(Boolean)
        .join(" ");
      if (active) btn.setAttribute("aria-current", "page");
      if (icon) {
        const i = document.createElement("span");
        i.className = "ex-nav-icon";
        i.textContent = icon;
        i.setAttribute("aria-hidden", "true");
        btn.appendChild(i);
      }
      const text = document.createElement("span");
      text.style.flex = "1";
      text.textContent = subtitle ?? label ?? "";
      if (subtitle && label) {
        text.title = label;
      }
      btn.appendChild(text);
      if (onClick) btn.addEventListener("click", onClick);
      return btn;
    },

    closePopover() {
      activePopover?.remove();
      activePopover = null;
    },

    repositionPopover({ anchor, anchorRect, width, side } = {}) {
      const backdrop = activePopover;
      const state = backdrop?.__explodexPopover;
      if (!state) return false;

      if (anchor !== undefined) state.anchor = anchor;
      if (anchorRect !== undefined) state.anchorRect = anchorRect;
      if (width !== undefined) {
        state.width = width;
        state.panel.style.width = `${width}px`;
      }
      if (side !== undefined) state.side = side;
      positionPopoverPanel(state.panel, state);
      return true;
    },

    popover({
      anchor,
      anchorRect,
      title,
      content,
      width = 380,
      side = "right",
      onClose,
    } = {}) {
      ui.closePopover();
      const backdrop = document.createElement("div");
      backdrop.className = "ex-popover-backdrop";
      const panel = document.createElement("div");
      panel.className = "ex-popover";
      panel.style.width = `${width}px`;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", title ?? "Panel");

      const header = document.createElement("div");
      header.className = "ex-popover-header";
      const h = document.createElement("div");
      h.className = "ex-popover-title";
      h.textContent = title ?? "";
      const close = components.button({
        label: "✕",
        color: "ghost",
        size: "iconSm",
        onClick: () => {
          ui.closePopover();
          onClose?.();
        },
      });
      header.appendChild(h);
      header.appendChild(close);

      const body = document.createElement("div");
      body.className = "ex-popover-body";
      if (typeof content === "function") body.appendChild(content());
      else if (content instanceof Node) body.appendChild(content);
      else if (content != null) body.textContent = String(content);

      panel.appendChild(header);
      panel.appendChild(body);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      activePopover = backdrop;

      const state = { panel, width, side, anchor, anchorRect };
      backdrop.__explodexPopover = state;
      positionPopoverPanel(panel, state);

      const onBackdrop = (event) => {
        if (event.target === backdrop) {
          ui.closePopover();
          onClose?.();
        }
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          ui.closePopover();
          onClose?.();
        }
      };
      backdrop.addEventListener("click", onBackdrop);
      global.addEventListener("keydown", onKey, { once: true });
      return backdrop;
    },

    confirm({
      title,
      message,
      confirmLabel = "Confirm",
      cancelLabel = "Cancel",
      onConfirm,
      onCancel,
    } = {}) {
      const backdrop = document.createElement("div");
      backdrop.className = "ex-dialog-backdrop";
      const dialog = document.createElement("div");
      dialog.className = "ex-dialog";
      dialog.setAttribute("role", "alertdialog");

      const h = document.createElement("div");
      h.style.cssText = "font-weight:600;font-size:15px;margin-bottom:8px";
      h.textContent = title ?? "Confirm";
      const p = document.createElement("div");
      p.style.cssText = "color:var(--color-text-tertiary,color-mix(in srgb,currentColor 65%,transparent))";
      p.textContent = message ?? "";

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px";
      actions.appendChild(
        components.button({
          label: cancelLabel,
          color: "ghost",
          onClick: () => {
            backdrop.remove();
            onCancel?.();
          },
        }),
      );
      actions.appendChild(
        components.button({
          label: confirmLabel,
          color: "primary",
          onClick: () => {
            backdrop.remove();
            onConfirm?.();
          },
        }),
      );

      dialog.appendChild(h);
      dialog.appendChild(p);
      dialog.appendChild(actions);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      return backdrop;
    },
  };

  // ─── Plugin lifecycle ─────────────────────────────────────────────────────

  function defaultEnabledState() {
    return {
      "command-menu-thread-search": true,
      "usage-reset-sidebar": true,
      "reasoning-effort-prefix": true,
      "pin-scope-menu": true,
      "feature-flags-settings": true,
      "project-folder-colors": true,
    };
  }

  function readEnabledMap() {
    const stored = storage.persisted.get(PLUGIN_ENABLED_KEY, null);
    return { ...defaultEnabledState(), ...(stored ?? {}) };
  }

  function writeEnabledMap(map) {
    storage.persisted.set(PLUGIN_ENABLED_KEY, map);
  }

  function isPluginEnabled(id) {
    const map = readEnabledMap();
    return map[id] !== false;
  }

  function setPluginEnabled(id, enabled) {
    const map = readEnabledMap();
    map[id] = enabled;
    writeEnabledMap(map);
  }

  function normalizeManifest(manifest = {}) {
    return {
      dynamicLoadable: true,
      dynamicUnloadable: true,
      builtin: false,
      ...manifest,
    };
  }

  function registerPlugin(manifest, setup) {
    const normalized = normalizeManifest(manifest);
    const id = normalized.id ?? `plugin-${Math.random().toString(36).slice(2, 9)}`;
    normalized.id = id;
    installStyles();

    if (pluginCatalog.has(id) && !plugins.has(id)) {
      pluginCatalog.set(id, { ...pluginCatalog.get(id), ...normalized });
    } else if (!pluginCatalog.has(id)) {
      pluginCatalog.set(id, normalized);
    }

    const pluginApi = {
      ...api,
      pluginId: id,
      log: log.plugin(id),
      flags: {
        ...flags,
        propagate: (opts = {}) => flags.propagate({ ...opts, pluginId: opts.pluginId ?? id }),
        setStatsigGateOverride: (gateId, value, opts = {}) =>
          flags.setStatsigGateOverride(gateId, value, {
            ...opts,
            pluginId: opts.pluginId ?? id,
          }),
        clearStatsigGateOverrides: (opts = {}) =>
          flags.clearStatsigGateOverrides({ ...opts, pluginId: opts.pluginId ?? id }),
      },
      waitFor: inject.waitFor,
      mount: (zoneId, nodeOrFactory, opts = {}) =>
        inject.mount(zoneId, nodeOrFactory, { ...opts, pluginId: id }),
      registerOptions: (handlers) => {
        if (handlers && typeof handlers.render === "function") {
          pluginOptionsHandlers.set(id, handlers);
        }
      },
    };

    const pluginLog = log.plugin(id);
    pluginLog.info("registering", { name: normalized.name, version: normalized.version });

    let teardown;
    try {
      teardown = typeof setup === "function" ? setup(pluginApi) : undefined;
    } catch (err) {
      pluginLog.error("setup failed", err);
      return { id, ok: false, error: err };
    }

    if (typeof teardown === "function") {
      pluginTeardowns.set(id, teardown);
    }

    plugins.set(id, { manifest: normalized, api: pluginApi });
    pluginLog.info("registered");
    return { id };
  }

  function unregisterPlugin(id, { runTeardown = true } = {}) {
    const pluginLog = log.plugin(id);
    pluginLog.info("unregistering");
    if (runTeardown) {
      const teardown = pluginTeardowns.get(id);
      if (teardown) {
        try {
          teardown();
          pluginLog.info("teardown complete");
        } catch (err) {
          pluginLog.error("teardown failed", err);
        }
      }
      pluginTeardowns.delete(id);
    }
    inject.unmount(id);
    sidebarNav.remove(`plugin-${id}`);
    pluginOptionsHandlers.delete(id);
    plugins.delete(id);
  }

  function declarePlugin(manifest, source) {
    const normalized = normalizeManifest(manifest);
    if (!normalized.id) return null;
    pluginCatalog.set(normalized.id, normalized);
    if (source) pluginSources.set(normalized.id, source);
    return normalized.id;
  }

  function loadPluginSource(id) {
    const pluginLog = log.plugin(id);
    const source = pluginSources.get(id);
    if (!source) {
      pluginLog.warn("no source in catalog");
      return false;
    }
    if (plugins.has(id)) {
      pluginLog.debug("already loaded");
      return true;
    }
    pluginLog.info("loading source");
    try {
      // eslint-disable-next-line no-new-func
      const runner = new Function(source);
      runner();
      const ok = plugins.has(id);
      if (ok) pluginLog.info("loaded");
      else pluginLog.warn("source ran but plugin did not register");
      return ok;
    } catch (err) {
      pluginLog.error("load failed", err);
      return false;
    }
  }

  function unloadPlugin(id) {
    const entry = pluginCatalog.get(id);
    if (!entry) return false;
    if (entry.builtin) return false;
    if (entry.dynamicUnloadable === false) return false;
    unregisterPlugin(id);
    return true;
  }

  async function restartWrapped({ reason } = {}) {
    storage.persisted.set(PLUGIN_RESTART_KEY, {
      at: Date.now(),
      reason: reason ?? "plugin-change",
    });
    const metaPaths = global.__EXPLODEX_PATHS__ ?? {};
    const relaunch = metaPaths.relaunchScript;
    if (relaunch && bridge.isAvailable()) {
      try {
        await bridge.send("open-external", { url: relaunch });
      } catch (err) {
        console.warn("[Explodex] open-external relaunch failed", err);
      }
      global.setTimeout(() => {
        bridge.send("quit-app").catch(() => {});
      }, 350);
      return true;
    }
    components.statusToast("Quit Codex (Cmd+Q), then relaunch via Explodex.app");
    return false;
  }

  function requestPluginToggle(id, enabled) {
    const entry = pluginCatalog.get(id) ?? plugins.get(id)?.manifest;
    if (!entry) return;

    const needsRestart =
      (enabled && entry.dynamicLoadable === false) ||
      (!enabled && entry.dynamicUnloadable === false);

    if (needsRestart) {
      ui.confirm({
        title: "Restart required",
        message: `${entry.name ?? id} requires a restart to ${enabled ? "enable" : "disable"}. Relaunch via Explodex?`,
        confirmLabel: "Restart Explodex",
        onConfirm: () => {
          setPluginEnabled(id, enabled);
          restartWrapped({ reason: `${enabled ? "enable" : "disable"}:${id}` });
        },
      });
      return;
    }

    setPluginEnabled(id, enabled);
    if (enabled) {
      loadPluginSource(id);
    } else {
      unloadPlugin(id);
    }
  }

  function initFromCatalog() {
    const catalog = global.__EXPLODEX_PLUGIN_CATALOG__;
    if (!Array.isArray(catalog)) return;
    for (const entry of catalog) {
      if (!entry?.id) continue;
      declarePlugin(entry, entry.source);
      if (isPluginEnabled(entry.id)) {
        loadPluginSource(entry.id);
      }
    }
  }

  const pluginManager = {
    register: registerPlugin,
    unregister: unregisterPlugin,
    declare: declarePlugin,
    list: () => [...plugins.keys()],
    listCatalog: () => [...pluginCatalog.keys()],
    get: (id) => plugins.get(id)?.manifest ?? pluginCatalog.get(id) ?? null,
    isEnabled: isPluginEnabled,
    setEnabled: setPluginEnabled,
    enable: (id) => requestPluginToggle(id, true),
    disable: (id) => requestPluginToggle(id, false),
    load: loadPluginSource,
    unload: unloadPlugin,
    initFromCatalog,
    restartWrapped,
    getOptionsHandler: (id) => pluginOptionsHandlers.get(id) ?? null,
  };

  function destroy() {
    flags.clearStatsigGateOverrides();
    for (const id of [...plugins.keys()]) {
      unregisterPlugin(id);
    }
    ui.closePopover();
    for (const node of mounted.values()) node.remove();
    mounted.clear();
    for (const mount of navMounts.values()) mount.remove();
    navMounts.clear();
    for (const observer of observers) observer.disconnect();
    observers.clear();
    plugins.clear();
    pluginCatalog.clear();
    pluginTeardowns.clear();
    pluginOptionsHandlers.clear();
    pluginSources.clear();
    messageHandlers.clear();
    document.getElementById(STYLE_ID)?.remove();
    removeRuntimeDom();
    delete global.Explodex;
  }

  function removeRuntimeDom() {
    document.querySelectorAll(RUNTIME_DOM_SELECTOR).forEach((n) => n.remove());
  }

  // ─── Meta reference ───────────────────────────────────────────────────────

  const meta = {
    codexVersion: null,
    selectors: Object.fromEntries(
      Object.values(ZONE_DEFINITIONS).map((z) => [z.id, z.selectors]),
    ),
    routes: [
      "/",
      "thread/:conversationId",
      "/remote/:taskId",
      "/settings/*",
      "/plugins",
      "/skills",
      "/inbox",
      "/automations",
      "/mcp-app/:server/:toolName",
      "/hotkey-window/*",
      "/global-dictation/*",
      "/avatar-overlay",
      "/diff",
      "/pull-requests/:pullRequestNumber",
    ],
    persistedKeys: {
      sidebarOrganizeMode: "sidebar-organize-mode-v1",
      sidebarMode: "electron-sidebar-mode-v1",
      threadSortKey: "thread-sort-key",
      sidebarCollapsedGroups: "sidebar-collapsed-groups",
      sidebarSectionOrder: "sidebar-section-order-v1",
      sidebarCollapsedSections: "sidebar-collapsed-sections-v1",
    },
    buttonTokens: { colors: Object.keys(BUTTON_COLOR), sizes: Object.keys(BUTTON_SIZE) },
  };

  // ─── Public API ───────────────────────────────────────────────────────────

  const api = {
    version: VERSION,
    zones: Object.keys(ZONE_DEFINITIONS),
    zoneDefinitions: ZONE_DEFINITIONS,
    inject,
    components,
    format,
    storage,
    bridge,
    http,
    composer,
    codex,
    flags,
    query,
    sidebarNav,
    ui,
    log,
    plugins: pluginManager,
    meta,
    destroy,

    // Legacy aliases (v0.0.1-poc compat)
    mount: inject.mount,
    waitFor: inject.waitFor,
    waitForZone: inject.waitFor,
    observeZone: inject.observeZone,
    registerPlugin,
    insertIntoComposer: composer.insertText.bind(composer),
    showStatus: components.statusToast,
  };

  installStyles();
  removeRuntimeDom();
  global.Explodex = api;

  // ─── Built-in shell plugin (nav + plugin manager) ─────────────────────────

  registerPlugin(
    {
      id: "explodex-shell",
      name: "Explodex",
      version: VERSION,
      builtin: true,
      dynamicLoadable: false,
      dynamicUnloadable: false,
    },
    (ctx) => {
      const { observeZone: observe, components: c, plugins: pm, sidebarNav: nav, ui: overlay, bridge, composer } =
        ctx;
      const EXPLODEX_ROUTE = "/explodex";
      const PAGE_ID = "explodex-settings-page";
      const ROUTE_POLL_MS = 500;
      let pageVisible = false;
      let routePollId = null;
      let lastRoutePath = "";

      const CREATE_PLUGIN_LIVE_PROMPT = `Use $explodex-live-plugins to help me create and debug a new Explodex plugin in this repo. If that skill is not installed, read and follow skills/explodex-live-plugins/SKILL.md from this checkout for this turn.

Plugin goal: [describe what the plugin should do — sidebar item, composer hook, settings panel, bridge RPC, etc.]

If the goal is still a placeholder, ask one clarifying question, then scaffold durable files under plugins/<id>/ and run the same-instance live loop: bun run validate → bun run inject → verify, interact, and unload/reload in the Codex renderer via Chrome DevTools MCP at http://127.0.0.1:9333. Package only when I ask to bundle or export it.`;

      function sleep(ms) {
        return new Promise((resolve) => global.setTimeout(resolve, ms));
      }

      async function prepopulateComposer(text, { attempts = 40, intervalMs = 100 } = {}) {
        for (let i = 0; i < attempts; i += 1) {
          if (composer.setText(text)) {
            composer.focus();
            return true;
          }
          await sleep(intervalMs);
        }
        return false;
      }

      function reactFiber(node) {
        if (!node || typeof node !== "object") return null;
        const key = Object.keys(node).find((name) => name.startsWith("__reactFiber"));
        return key ? node[key] : null;
      }

      function getAppRoutePathname() {
        const start =
          document.querySelector('nav[aria-label="Settings"]') ??
          document.querySelector("nav") ??
          document.documentElement;
        let fiber = reactFiber(start);
        for (let depth = 0; depth < 200 && fiber; depth += 1) {
          const loc = fiber.memoizedProps?.location ?? fiber.memoizedProps?.value?.location;
          if (loc?.pathname) return loc.pathname;
          fiber = fiber.return;
        }
        return global.location?.pathname ?? "";
      }

      function isExplodexRoute() {
        const path = getAppRoutePathname();
        return path === EXPLODEX_ROUTE || global.location?.pathname === EXPLODEX_ROUTE;
      }

      function pageViewport() {
        return (
          document.querySelector(".app-shell-main-content-viewport") ??
          document.querySelector(".app-shell-main-content-frame") ??
          document.querySelector("[data-app-shell-main-content-layout]") ??
          document.querySelector(".main-surface")?.parentElement ??
          null
        );
      }

      function hideExplodexPage() {
        document.getElementById(PAGE_ID)?.remove();
        pageVisible = false;
        if (global.location?.pathname === EXPLODEX_ROUTE) {
          try {
            history.replaceState({}, "", "/");
          } catch {
            /* ignore */
          }
        }
      }

      function stopRouteWatch() {
        if (routePollId != null) {
          global.clearInterval(routePollId);
          routePollId = null;
        }
      }

      function startRouteWatch() {
        if (routePollId != null) return;
        lastRoutePath = getAppRoutePathname();
        routePollId = global.setInterval(() => {
          const path = getAppRoutePathname();
          if (path === lastRoutePath) return;
          lastRoutePath = path;
          if (pageVisible && path !== EXPLODEX_ROUTE) hideExplodexPage();
        }, ROUTE_POLL_MS);
      }

      function onPopState() {
        if (pageVisible && !isExplodexRoute()) hideExplodexPage();
      }

      function pluginEnableCheckbox(id, manifest) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = pm.isEnabled(id);
        checkbox.disabled =
          manifest.dynamicLoadable === false && manifest.dynamicUnloadable === false;
        checkbox.addEventListener("click", (event) => event.stopPropagation());
        checkbox.addEventListener("change", () => {
          const next = checkbox.checked;
          const entry = pm.get(id);
          const needsRestart =
            (next && entry?.dynamicLoadable === false) ||
            (!next && entry?.dynamicUnloadable === false);
          if (needsRestart) {
            checkbox.checked = pm.isEnabled(id);
          }
          if (next) pm.enable(id);
          else pm.disable(id);
          if (!needsRestart) {
            global.setTimeout(() => {
              checkbox.checked = pm.isEnabled(id);
              renderExplodexPage(document.getElementById(PAGE_ID));
            }, 0);
          }
        });
        return checkbox;
      }

      function renderPluginOptions(id, host) {
        host.replaceChildren();
        const handler = pm.getOptionsHandler(id);
        if (!handler) {
          const empty = document.createElement("div");
          empty.className = "ex-explodex-plugin-meta";
          empty.textContent = "No configurable options for this plugin.";
          host.appendChild(empty);
          return;
        }
        if (!pm.list().includes(id)) {
          const empty = document.createElement("div");
          empty.className = "ex-explodex-plugin-meta";
          empty.textContent = "Enable this plugin to configure options.";
          host.appendChild(empty);
          return;
        }
        const panel = document.createElement("div");
        panel.className = "ex-explodex-plugin-options";
        host.appendChild(panel);
        handler.render(panel, {
          pluginId: id,
          refresh: () => renderExplodexPage(document.getElementById(PAGE_ID)),
        });
      }

      function renderExplodexPage(root) {
        if (!root) return;
        root.replaceChildren();

        const inner = document.createElement("div");
        inner.className = "ex-explodex-page-inner";

        const header = document.createElement("div");
        header.className = "ex-explodex-page-header";
        const title = document.createElement("h1");
        title.textContent = "Explodex";
        const subtitle = document.createElement("p");
        subtitle.textContent = "Manage bundled and user plugins. Expand a plugin to view details and options.";
        header.appendChild(title);
        header.appendChild(subtitle);
        inner.appendChild(header);

        const ids = pm.listCatalog().filter((id) => id !== "explodex-shell");
        if (!ids.length) {
          const empty = document.createElement("div");
          empty.className = "ex-explodex-plugin-meta";
          empty.textContent = "No plugins in catalog.";
          inner.appendChild(empty);
        }

        for (const id of ids) {
          const manifest = pm.get(id);
          if (!manifest) continue;

          const section = document.createElement("details");
          section.className = "ex-explodex-plugin-section";
          section.open = pm.getOptionsHandler(id) != null;

          const summary = document.createElement("summary");
          summary.appendChild(pluginEnableCheckbox(id, manifest));

          const titleCol = document.createElement("div");
          titleCol.style.flex = "1";
          const name = document.createElement("div");
          name.style.fontWeight = "600";
          name.textContent = manifest.name ?? id;
          const meta = document.createElement("div");
          meta.className = "ex-explodex-plugin-meta";
          const flags = [];
          if (manifest.dynamicLoadable === false) flags.push("load: restart");
          if (manifest.dynamicUnloadable === false) flags.push("unload: restart");
          const loaded = pm.list().includes(id);
          meta.textContent = [
            `v${manifest.version ?? "?"}`,
            loaded ? "loaded" : "not loaded",
            flags.length ? flags.join(" · ") : null,
          ]
            .filter(Boolean)
            .join(" — ");
          titleCol.appendChild(name);
          titleCol.appendChild(meta);
          summary.appendChild(titleCol);
          section.appendChild(summary);

          const body = document.createElement("div");
          body.className = "ex-explodex-plugin-section-body";
          if (manifest.description) {
            const desc = document.createElement("div");
            desc.textContent = manifest.description;
            body.appendChild(desc);
          }
          const optionsHost = document.createElement("div");
          body.appendChild(optionsHost);
          renderPluginOptions(id, optionsHost);
          section.appendChild(body);
          inner.appendChild(section);
        }

        const actions = document.createElement("div");
        actions.className = "ex-explodex-page-actions";
        actions.appendChild(
          c.button({
            label: "Create Plugin Live",
            color: "primary",
            size: "composerSm",
            onClick: () => {
              void startCreatePluginLiveThread();
            },
          }),
        );
        actions.appendChild(
          c.button({
            label: "Open Plugins Folder",
            color: "secondary",
            size: "composerSm",
            onClick: () => {
              void openUserPluginsFolder();
            },
          }),
        );
        actions.appendChild(
          c.button({
            label: "Restart",
            color: "ghost",
            size: "composerSm",
            onClick: () => {
              void pm.restartWrapped({ reason: "explodex-page-restart" });
            },
          }),
        );
        inner.appendChild(actions);
        root.appendChild(inner);
      }

      function showExplodexPage() {
        const host = pageViewport();
        if (!host) {
          c.statusToast("Main viewport not found");
          return;
        }
        if (getComputedStyle(host).position === "static") {
          host.style.position = "relative";
        }

        let page = document.getElementById(PAGE_ID);
        if (!page) {
          page = document.createElement("div");
          page.id = PAGE_ID;
          page.className = "ex-explodex-page";
          page.setAttribute("data-explodex-plugin", "explodex-shell");
          host.appendChild(page);
        }

        pageVisible = true;
        renderExplodexPage(page);
        try {
          history.pushState({ explodexPage: true }, "", EXPLODEX_ROUTE);
        } catch {
          /* ignore */
        }
        startRouteWatch();
      }

      async function startCreatePluginLiveThread() {
        hideExplodexPage();

        await bridge.navigate("/", { focusComposerNonce: Date.now() });

        const ok = await prepopulateComposer(CREATE_PLUGIN_LIVE_PROMPT);
        if (!ok) {
          c.statusToast("Composer not ready — copy prompt from Explodex menu and retry");
        }
      }

      async function openUserPluginsFolder() {
        const metaPaths = global.__EXPLODEX_PATHS__ ?? {};
        const dir = metaPaths.userPluginsDir;
        if (!dir) {
          c.statusToast("Plugins folder path unavailable");
          return;
        }
        const params = { path: dir, cwd: dir, target: "fileManager" };
        if (http.isAvailable()) {
          try {
            const res = await http.post("vscode://codex/open-file", params);
            if (res?.success !== false) return;
          } catch (err) {
            console.warn("[Explodex] open-file plugins folder failed", err);
          }
        }
        c.statusToast(dir);
      }

      function mountShellNav() {
        if (document.querySelector('[data-explodex-nav="explodex-shell"]')?.isConnected) {
          return true;
        }
        const btn = overlay.navItem({
          icon: "💥",
          label: "Explodex",
          onClick: () => {
            if (pageVisible && document.getElementById(PAGE_ID)?.isConnected) return;
            pageVisible = false;
            showExplodexPage();
          },
        });
        return nav.insertAfter(["Plugins", "Skills"], btn, "explodex-shell");
      }

      mountShellNav();
      observe("sidebar", mountShellNav, { includeMutations: true });
      global.addEventListener("popstate", onPopState);
      startRouteWatch();

      return () => {
        hideExplodexPage();
        stopRouteWatch();
        global.removeEventListener("popstate", onPopState);
        nav.remove("explodex-shell");
      };
    },
  );

  log.info("initializing", { version: VERSION });
  initFromCatalog();

  log.info("ready", {
    zones: api.zones.length,
    bridge: bridge.isAvailable(),
    theme: bridge.theme(),
    catalog: pluginManager.listCatalog().length,
    loaded: pluginManager.list().length,
  });
})(window);
