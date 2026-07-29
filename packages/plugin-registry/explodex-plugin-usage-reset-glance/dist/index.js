var __ExplodexPluginBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    default: () => index_default,
    setupUsageResetGlance: () => setupUsageResetGlance
  });

  // explodex-sdk-shim:explodex-sdk-shim.js
  function definePlugin(definition) {
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError("definePlugin requires a plugin definition object");
    }
    if (typeof definition.setup !== "function") {
      throw new TypeError("definePlugin requires setup(api)");
    }
    for (const key of Object.keys(definition)) {
      if (key !== "setup") {
        throw new TypeError('definePlugin does not accept unknown field "' + key + '"');
      }
    }
    return Object.freeze({
      setup: definition.setup,
      __explodexDefinedPlugin: true
    });
  }

  // src/model.ts
  var SETTINGS_KEY = "explodex-usage-reset-glance";
  var LEGACY_SETTINGS_KEY = "explodex-usage-reset-sidebar";
  var PATH_USAGE = "/wham/usage";
  var PATH_RESET_CREDITS = "/wham/rate-limit-reset-credits";
  var DEFAULT_TEMPLATE = "{usage.primary.label}: {usage.primary.left.percent}% {usage.primary.reset.in} \u2022 Weekly: {usage.secondary.left.percent}% {usage.secondary.reset.in} \u2022 Reset: {resets.count}";
  function toFiniteNumber(value, fallback = 0) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function clampPercent(value) {
    return Math.min(100, Math.max(0, toFiniteNumber(value)));
  }
  function normalizeUnixTimestamp(value) {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1e3) : Math.floor(value);
    }
    if (typeof value !== "string" || !value.trim()) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? Math.floor(numeric / 1e3) : Math.floor(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1e3);
  }
  function creditExpiryUnix(credit) {
    if (credit === null || credit === void 0) return null;
    const directKeys = [
      "expires_at",
      "expiration_at",
      "expiresAt",
      "valid_until",
      "valid_until_at",
      "redeem_by",
      "redeem_by_at"
    ];
    for (const key of directKeys) {
      const unix = normalizeUnixTimestamp(credit[key]);
      if (unix !== null) return unix;
    }
    for (const [key, value] of Object.entries(credit)) {
      if (!/_at$|_until$|_by$/.test(key)) continue;
      const unix = normalizeUnixTimestamp(value);
      if (unix !== null) return unix;
    }
    return null;
  }
  function creditExpiryLabel(credit, format) {
    const unix = creditExpiryUnix(credit);
    if (unix !== null) return format.datetimeCountdown(unix);
    const description = typeof credit?.description === "string" ? credit.description.trim() : "";
    return description || null;
  }
  function parseWindow(raw) {
    if (raw === null || typeof raw !== "object") return null;
    const record = raw;
    const seconds = record.limit_window_seconds == null ? null : toFiniteNumber(record.limit_window_seconds, Number.NaN);
    return {
      usedPercent: clampPercent(record.used_percent),
      resetAt: normalizeUnixTimestamp(record.reset_at),
      windowMinutes: Number.isFinite(seconds) ? seconds / 60 : null
    };
  }
  function parseUsage(body) {
    const record = body !== null && typeof body === "object" ? body : {};
    const rate = record.rate_limit !== null && typeof record.rate_limit === "object" ? record.rate_limit : null;
    return {
      planType: record.plan_type ?? null,
      limitReached: Boolean(
        rate?.limit_reached || record.rate_limit_reached_type
      ),
      primary: parseWindow(rate?.primary_window),
      secondary: parseWindow(rate?.secondary_window),
      credits: record.credits ?? null
    };
  }
  function parseResetCredits(body) {
    const record = body !== null && typeof body === "object" ? body : {};
    const rawCredits = Array.isArray(record.credits) ? record.credits : [];
    const credits = rawCredits.filter(
      (credit) => credit !== null && credit.status === "available"
    );
    const availableCount = toFiniteNumber(
      record.available_count,
      credits.length
    );
    return {
      availableCount: Math.max(0, Math.floor(availableCount)),
      credits
    };
  }
  function formatWindowLabel(minutes) {
    if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return "\u2014";
    const day = 1440;
    const week = 7 * day;
    if (minutes >= 10079) {
      const weeks = Math.ceil(minutes / week);
      return weeks === 1 ? "Weekly" : `${weeks}w`;
    }
    if (minutes >= 1439) return `${Math.ceil(minutes / day)}d`;
    if (minutes >= 60) return `${Math.ceil(minutes / 60)}h`;
    return `${Math.ceil(minutes)}m`;
  }
  function percentLeft(usedPercent) {
    return Math.round(100 - clampPercent(usedPercent));
  }
  function formatPercentLabel(usedPercent, showLeft) {
    return showLeft ? `${percentLeft(usedPercent)}% left` : `${Math.round(clampPercent(usedPercent))}% used`;
  }
  function windowContext(window, format) {
    if (!window) {
      return {
        label: "\u2014",
        left: { percent: 0 },
        used: { percent: 0 },
        reset: { in: "\u2014", at: "\u2014" }
      };
    }
    return {
      label: formatWindowLabel(window.windowMinutes),
      left: { percent: percentLeft(window.usedPercent) },
      used: { percent: Math.round(clampPercent(window.usedPercent)) },
      reset: {
        in: format.countdown(window.resetAt),
        at: format.datetimeCountdown(window.resetAt)
      }
    };
  }
  function buildUsageContext(usage, resets, format) {
    const primary = windowContext(usage?.primary, format);
    const secondary = windowContext(usage?.secondary, format);
    const resetEntries = (resets?.credits ?? []).map((credit) => ({
      title: typeof credit.title === "string" && credit.title.trim() ? credit.title : "Reset",
      expires: creditExpiryLabel(credit, format) ?? "\u2014"
    }));
    const resetsContext = {
      count: resets?.availableCount ?? 0,
      available: resets?.availableCount ?? 0
    };
    resetEntries.forEach((entry, index) => {
      resetsContext[index] = entry;
    });
    if (resetsContext[0] === void 0) {
      resetsContext[0] = { title: "\u2014", expires: "\u2014" };
    }
    return {
      usage: {
        primary,
        secondary,
        short: primary,
        week: secondary
      },
      resets: resetsContext
    };
  }
  function formatCompactUsage(usage, resets, template, format) {
    if (!usage && !resets) return "Usage: unavailable";
    const context = buildUsageContext(usage, resets, format);
    try {
      return format.template(template || DEFAULT_TEMPLATE, context, {
        fallback: "\u2014"
      });
    } catch {
      return format.template(DEFAULT_TEMPLATE, context, { fallback: "\u2014" });
    }
  }
  function defaultUsageSettings() {
    return {
      compactTemplate: DEFAULT_TEMPLATE,
      refreshIntervalSec: 60,
      refreshPreset: "60"
    };
  }
  function normalizeUsageSettings(raw) {
    const defaults = defaultUsageSettings();
    if (raw === null || typeof raw !== "object") return defaults;
    const record = raw;
    const compactTemplate = typeof record.compactTemplate === "string" && record.compactTemplate.trim() ? record.compactTemplate.trim() : defaults.compactTemplate;
    const rawInterval = Number(
      record.refreshIntervalSec ?? defaults.refreshIntervalSec
    );
    const refreshIntervalSec = Math.max(
      0,
      Number.isFinite(rawInterval) ? Math.floor(rawInterval) : defaults.refreshIntervalSec
    );
    const explicitPreset = record.refreshPreset;
    const refreshPreset = explicitPreset === "30" || explicitPreset === "60" || explicitPreset === "300" || explicitPreset === "0" || explicitPreset === "custom" ? explicitPreset : refreshIntervalSec === 0 ? "0" : refreshIntervalSec === 30 ? "30" : refreshIntervalSec === 300 ? "300" : refreshIntervalSec === 60 ? "60" : "custom";
    return { compactTemplate, refreshIntervalSec, refreshPreset };
  }
  function refreshIntervalMs(settings) {
    if (settings.refreshPreset === "custom") {
      return Math.max(5, settings.refreshIntervalSec) * 1e3;
    }
    const seconds = Number(settings.refreshPreset);
    return seconds > 0 ? seconds * 1e3 : 0;
  }
  function createViewOnlyUsageHttp(http) {
    return {
      isAvailable: () => http.isAvailable(),
      get(path, options) {
        if (path !== PATH_USAGE && path !== PATH_RESET_CREDITS) {
          return Promise.reject(
            new Error("view-only plugin: path not allowed")
          );
        }
        return http.get(path, options);
      }
    };
  }

  // src/index.ts
  var TEMPLATE_VARS_HINT = "Variables: usage.primary.label, usage.primary.left.percent, usage.primary.used.percent, usage.primary.reset.in, usage.primary.reset.at, usage.secondary.*, usage.short.*, usage.week.*, resets.count, resets[0].title, resets[0].expires";
  function errorMessage(error, fallback) {
    if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
      return error.message;
    }
    return fallback;
  }
  function isAbortError(error) {
    return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
  }
  async function setupUsageResetGlance(api, runtime = globalThis) {
    const {
      components,
      format,
      inject,
      log,
      registerOptions,
      sidebarNav,
      storage,
      ui
    } = api;
    const document = runtime.document;
    const http = createViewOnlyUsageHttp(api.http);
    await api.migrate([
      {
        id: "rename-keys-from-usage-reset-sidebar",
        run: ({ renameKey }) => {
          renameKey(LEGACY_SETTINGS_KEY, SETTINGS_KEY);
        }
      }
    ]);
    let settings = normalizeUsageSettings(
      storage.persisted.get(SETTINGS_KEY, null)
    );
    let disposed = false;
    let pollTimer = null;
    let pendingRefreshAbort = null;
    let popoverOpen = false;
    let showPercentLeft = true;
    let navButton = null;
    let stopSidebarObserver = null;
    let stopRateLimitEvents = null;
    let state = {
      loading: true,
      error: null,
      usage: null,
      resets: null,
      updatedAt: null
    };
    function saveSettings() {
      storage.persisted.set(SETTINGS_KEY, settings);
    }
    function loadSettings() {
      settings = normalizeUsageSettings(
        storage.persisted.get(SETTINGS_KEY, null)
      );
    }
    function row(label, value, options = {}) {
      const element = document.createElement("div");
      element.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:12px;line-height:18px";
      const key = document.createElement("span");
      key.textContent = label;
      key.style.color = options.muted ? "var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent))" : "inherit";
      const valueElement = document.createElement("span");
      valueElement.textContent = value;
      valueElement.style.textAlign = "right";
      if (options.accent) valueElement.style.fontWeight = "600";
      element.append(key, valueElement);
      return element;
    }
    function windowSection(title, window) {
      const block = document.createElement("div");
      block.style.cssText = "display:flex;flex-direction:column;gap:2px";
      if (!window) {
        block.appendChild(row(title, "\u2014", { muted: true }));
        return block;
      }
      block.appendChild(
        row(
          title,
          formatPercentLabel(window.usedPercent, showPercentLeft),
          { accent: true }
        )
      );
      block.appendChild(
        row("Resets", format.datetimeCountdown(window.resetAt), {
          muted: true
        })
      );
      return block;
    }
    function reopenPopover() {
      if (!popoverOpen || navButton === null) return;
      ui.popover({
        anchor: navButton,
        title: "Usage & Resets",
        width: 380,
        side: "right",
        onClose: () => {
          popoverOpen = false;
        },
        content: renderDetailPanel
      });
    }
    function percentDisplayToggle() {
      const element = document.createElement("div");
      element.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;line-height:18px";
      const label = document.createElement("span");
      label.textContent = "Usage display";
      const controls = document.createElement("div");
      controls.style.cssText = "display:inline-flex;gap:2px;border-radius:6px;padding:2px;background:color-mix(in srgb, currentColor 8%, transparent)";
      const makeOption = (text, active) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.style.cssText = [
          "border:0",
          "border-radius:4px",
          "padding:2px 8px",
          "font:inherit",
          "font-size:11px",
          "line-height:16px",
          "cursor:pointer",
          active ? "background:var(--color-bg-primary, color-mix(in srgb, currentColor 14%, transparent));font-weight:600" : "background:transparent;color:var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent))"
        ].join(";");
        return button;
      };
      const leftButton = makeOption("% left", showPercentLeft);
      const usedButton = makeOption("% used", !showPercentLeft);
      leftButton.addEventListener("click", () => {
        if (showPercentLeft) return;
        showPercentLeft = true;
        reopenPopover();
      });
      usedButton.addEventListener("click", () => {
        if (!showPercentLeft) return;
        showPercentLeft = false;
        reopenPopover();
      });
      controls.append(leftButton, usedButton);
      element.append(label, controls);
      return element;
    }
    function renderDetailPanel() {
      const body = document.createElement("div");
      body.setAttribute("aria-readonly", "true");
      body.style.cssText = "display:flex;flex-direction:column;gap:8px;user-select:text";
      if (state.loading && state.usage === null) {
        body.appendChild(row("Status", "Loading\u2026", { muted: true }));
        return body;
      }
      if (state.error !== null) {
        body.appendChild(row("Error", state.error, { muted: true }));
        return body;
      }
      if (state.usage === null && state.resets === null) {
        body.appendChild(row("Status", "Unavailable", { muted: true }));
        return body;
      }
      body.appendChild(
        row(
          "Reset credits",
          state.resets ? String(state.resets.availableCount) : "\u2014",
          { accent: true }
        )
      );
      if (state.resets?.credits.length) {
        const list = document.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;padding-left:4px;border-left:2px solid color-mix(in srgb, currentColor 12%, transparent)";
        for (const credit of state.resets.credits) {
          const detail = creditExpiryLabel(credit, format);
          list.appendChild(
            row(
              typeof credit.title === "string" && credit.title ? credit.title : "Reset",
              detail ?? "available",
              { muted: !detail }
            )
          );
        }
        body.appendChild(list);
      }
      if (state.usage?.primary || state.usage?.secondary) {
        body.appendChild(percentDisplayToggle());
      }
      if (state.usage?.primary) {
        body.appendChild(windowSection("Short window", state.usage.primary));
      }
      if (state.usage?.secondary) {
        const separator = document.createElement("div");
        separator.style.cssText = "height:1px;background:color-mix(in srgb, currentColor 10%, transparent);margin:2px 0";
        body.appendChild(separator);
        body.appendChild(windowSection("Weekly", state.usage.secondary));
      }
      if (state.usage?.limitReached) {
        body.appendChild(row("Status", "Limit reached", { accent: true }));
      }
      if (state.updatedAt) {
        const stamp = new Intl.DateTimeFormat(void 0, {
          timeStyle: "short"
        }).format(state.updatedAt);
        body.appendChild(row("Updated", stamp, { muted: true }));
      }
      const note = document.createElement("div");
      note.textContent = "View only \u2014 use Codex settings to redeem resets";
      note.style.cssText = "font-size:11px;line-height:15px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 50%,transparent));margin-top:2px";
      body.appendChild(note);
      return body;
    }
    function compactLabel() {
      if (state.loading && state.usage === null) return "Usage: loading\u2026";
      if (state.error !== null) return "Usage: error";
      return formatCompactUsage(
        state.usage,
        state.resets,
        settings.compactTemplate,
        format
      );
    }
    function setNavButtonLabel(label) {
      const labelNode = navButton?.querySelector("span:last-child");
      if (labelNode) {
        labelNode.textContent = label;
        return;
      }
      navButton?.replaceChildren(document.createTextNode(label));
    }
    function paintNav() {
      const label = compactLabel();
      if (navButton === null) {
        navButton = ui.navItem({
          label: "Usage & Resets",
          compact: true,
          onClick: (event) => {
            popoverOpen = !popoverOpen;
            if (!popoverOpen) {
              ui.closePopover();
              return;
            }
            ui.popover({
              anchor: event.currentTarget,
              title: "Usage & Resets",
              width: 380,
              side: "right",
              onClose: () => {
                popoverOpen = false;
              },
              content: renderDetailPanel
            });
          }
        });
      }
      setNavButtonLabel(label);
      const mounted = sidebarNav.insertBefore(
        ["Settings", "Profile", "Account"],
        navButton,
        "usage-reset-glance"
      );
      if (mounted) log.debug("sidebar item mounted");
      else log.warn("sidebar mount deferred \u2014 profile footer anchor not found yet");
    }
    function renderOptionsPanel(container) {
      container.replaceChildren();
      let customRefreshHost = null;
      const stack = components.fieldStack([
        components.textField({
          label: "Compact row format",
          value: settings.compactTemplate,
          monospace: true,
          onChange: (value) => {
            settings.compactTemplate = value.trim() || DEFAULT_TEMPLATE;
            saveSettings();
            paintNav();
          }
        }),
        components.metaText(TEMPLATE_VARS_HINT),
        components.selectField({
          label: "Auto-refresh",
          value: settings.refreshPreset,
          options: [
            { value: "30", label: "Every 30s" },
            { value: "60", label: "Every 1m" },
            { value: "300", label: "Every 5m" },
            { value: "0", label: "Manual only" },
            { value: "custom", label: "Custom" }
          ],
          onChange: (value) => {
            settings.refreshPreset = normalizeUsageSettings({
              ...settings,
              refreshPreset: value
            }).refreshPreset;
            if (value === "custom") {
              settings.refreshIntervalSec = Math.max(
                5,
                settings.refreshIntervalSec || 60
              );
            } else {
              settings.refreshIntervalSec = Number(value);
            }
            saveSettings();
            startPolling();
            if (customRefreshHost) {
              customRefreshHost.style.display = settings.refreshPreset === "custom" ? "" : "none";
            }
          }
        })
      ]);
      customRefreshHost = components.numberField({
        label: "Custom interval (seconds)",
        value: settings.refreshIntervalSec,
        min: 5,
        max: 3600,
        onChange: (value) => {
          settings.refreshIntervalSec = Math.max(
            5,
            Math.min(3600, value)
          );
          settings.refreshPreset = "custom";
          saveSettings();
          startPolling();
        }
      });
      customRefreshHost.style.display = settings.refreshPreset === "custom" ? "" : "none";
      stack.appendChild(customRefreshHost);
      container.appendChild(stack);
    }
    function stopPolling() {
      if (pollTimer === null) return;
      runtime.clearInterval(pollTimer);
      pollTimer = null;
    }
    function startPolling() {
      if (disposed) return;
      stopPolling();
      const milliseconds = refreshIntervalMs(settings);
      if (milliseconds > 0) {
        pollTimer = runtime.setInterval(() => {
          void refresh();
        }, milliseconds);
      }
    }
    function abortRefresh() {
      pendingRefreshAbort?.abort();
      pendingRefreshAbort = null;
    }
    function refreshPopoverPosition() {
      if (!popoverOpen || navButton === null || !navButton.isConnected) return;
      ui.repositionPopover({
        anchor: navButton,
        width: 380,
        side: "right"
      });
    }
    function handleBeforeUnload() {
      stopPolling();
      abortRefresh();
      stopSidebarObserver?.();
      stopSidebarObserver = null;
    }
    async function refresh() {
      if (disposed) return;
      abortRefresh();
      if (!http.isAvailable()) {
        log.warn("refresh skipped \u2014 HTTP bridge unavailable");
        state = { ...state, loading: false, error: "Bridge unavailable" };
        paintNav();
        reopenPopover();
        return;
      }
      const controller = new runtime.AbortController();
      pendingRefreshAbort = controller;
      log.debug("refreshing usage data");
      try {
        const [usageBody, resetBody] = await Promise.all([
          http.get(PATH_USAGE, { signal: controller.signal }).catch((error) => {
            if (errorMessage(error, "").includes("401")) return null;
            throw error;
          }),
          http.get(PATH_RESET_CREDITS, { signal: controller.signal }).catch(() => null)
        ]);
        if (disposed || controller.signal.aborted) return;
        state = {
          loading: false,
          error: null,
          usage: usageBody ? parseUsage(usageBody) : null,
          resets: resetBody ? parseResetCredits(resetBody) : null,
          updatedAt: /* @__PURE__ */ new Date()
        };
      } catch (error) {
        if (disposed || controller.signal.aborted || isAbortError(error)) return;
        log.error("refresh failed", error);
        state = {
          ...state,
          loading: false,
          error: errorMessage(error, "Failed to load usage")
        };
      } finally {
        if (pendingRefreshAbort === controller) {
          pendingRefreshAbort = null;
        }
      }
      if (disposed || controller.signal.aborted) return;
      paintNav();
      reopenPopover();
    }
    registerOptions({ render: renderOptionsPanel });
    loadSettings();
    paintNav();
    void refresh().then(() => {
      if (disposed) return;
      startPolling();
      log.info("initial refresh complete");
    });
    stopSidebarObserver = inject.observeZone(
      "sidebar",
      (anchor, { previousAnchor }) => {
        if (disposed) return;
        if (previousAnchor !== anchor) {
          log.debug(
            previousAnchor ? "sidebar zone changed \u2014 remounting nav item" : "sidebar zone ready \u2014 remounting nav item"
          );
          navButton = null;
          paintNav();
          void refresh();
          return;
        }
        if (navButton === null || !navButton.isConnected) {
          navButton = null;
          paintNav();
        }
        refreshPopoverPosition();
      },
      { includeMutations: true }
    );
    stopRateLimitEvents = api.bridge.on("account/rateLimits/updated", () => {
      log.debug("rateLimits/updated \u2014 refreshing");
      void refresh();
    });
    runtime.addEventListener("resize", refreshPopoverPosition);
    runtime.addEventListener("scroll", refreshPopoverPosition, true);
    runtime.addEventListener("beforeunload", handleBeforeUnload, { once: true });
    log.info("setup complete");
    return () => {
      if (disposed) return;
      disposed = true;
      log.info("teardown");
      stopPolling();
      abortRefresh();
      stopSidebarObserver?.();
      stopSidebarObserver = null;
      stopRateLimitEvents?.();
      stopRateLimitEvents = null;
      runtime.removeEventListener("resize", refreshPopoverPosition);
      runtime.removeEventListener("scroll", refreshPopoverPosition, true);
      runtime.removeEventListener("beforeunload", handleBeforeUnload);
      ui.closePopover();
      popoverOpen = false;
      sidebarNav.remove("usage-reset-glance");
      navButton = null;
    };
  }
  var index_default = definePlugin({
    setup(api) {
      return setupUsageResetGlance(api);
    }
  });
  return __toCommonJS(index_exports);
})();

;(function (global) {
  var exported = typeof __ExplodexPluginBundle !== "undefined" ? __ExplodexPluginBundle : undefined;
  var definition = exported;
  if (definition && typeof definition === "object" && "default" in definition) {
    definition = definition.default;
  }
  var register = global && global.__EXPLODEX_PRIVATE_REGISTER__;
  if (typeof register === "function") {
    register("usage-reset-glance", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
