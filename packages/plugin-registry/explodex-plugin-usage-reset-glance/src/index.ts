import {
  definePlugin,
  type PluginApi,
  type PluginTeardown,
} from "@explodex/sdk";
import {
  DEFAULT_TEMPLATE,
  LEGACY_SETTINGS_KEY,
  PATH_RESET_CREDITS,
  PATH_USAGE,
  SETTINGS_KEY,
  createViewOnlyUsageHttp,
  creditExpiryLabel,
  formatCompactUsage,
  formatPercentLabel,
  normalizeUsageSettings,
  parseResetCredits,
  parseUsage,
  refreshIntervalMs,
  type ResetCreditStatus,
  type UsageSettings,
  type UsageStatus,
  type UsageWindow,
} from "./model";

const TEMPLATE_VARS_HINT =
  "Variables: usage.primary.label, usage.primary.left.percent, usage.primary.used.percent, usage.primary.reset.in, usage.primary.reset.at, usage.secondary.*, usage.short.*, usage.week.*, resets.count, resets[0].title, resets[0].expires";

type UsageRuntime = {
  readonly document: Pick<Document, "createElement" | "createTextNode">;
  readonly AbortController: typeof AbortController;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  setInterval(handler: () => void, milliseconds: number): number;
  clearInterval(intervalId: number): void;
};

type UsageViewState = {
  loading: boolean;
  error: string | null;
  usage: UsageStatus | null;
  resets: ResetCreditStatus | null;
  updatedAt: Date | null;
};

function errorMessage(error: unknown, fallback: string): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
  ) {
    return error.message;
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export async function setupUsageResetGlance(
  api: PluginApi,
  runtime: UsageRuntime = globalThis as unknown as UsageRuntime,
): Promise<PluginTeardown> {
  const {
    components,
    format,
    inject,
    log,
    registerOptions,
    sidebarNav,
    storage,
    ui,
  } = api;
  const document = runtime.document;
  const http = createViewOnlyUsageHttp(api.http);

  await api.migrate([
    {
      id: "rename-keys-from-usage-reset-sidebar",
      run: ({ renameKey }) => {
        renameKey(LEGACY_SETTINGS_KEY, SETTINGS_KEY);
      },
    },
  ]);

  let settings: UsageSettings = normalizeUsageSettings(
    storage.persisted.get(SETTINGS_KEY, null),
  );
  let disposed = false;
  let pollTimer: number | null = null;
  let pendingRefreshAbort: AbortController | null = null;
  let popoverOpen = false;
  let showPercentLeft = true;
  let navButton: HTMLButtonElement | null = null;
  let stopSidebarObserver: (() => void) | null = null;
  let stopRateLimitEvents: (() => void) | null = null;
  let state: UsageViewState = {
    loading: true,
    error: null,
    usage: null,
    resets: null,
    updatedAt: null,
  };

  function saveSettings(): void {
    storage.persisted.set(SETTINGS_KEY, settings);
  }

  function loadSettings(): void {
    settings = normalizeUsageSettings(
      storage.persisted.get(SETTINGS_KEY, null),
    );
  }

  function row(
    label: string,
    value: string,
    options: { muted?: boolean; accent?: boolean } = {},
  ): HTMLDivElement {
    const element = document.createElement("div");
    element.style.cssText =
      "display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:12px;line-height:18px";
    const key = document.createElement("span");
    key.textContent = label;
    key.style.color = options.muted
      ? "var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent))"
      : "inherit";
    const valueElement = document.createElement("span");
    valueElement.textContent = value;
    valueElement.style.textAlign = "right";
    if (options.accent) valueElement.style.fontWeight = "600";
    element.append(key, valueElement);
    return element;
  }

  function windowSection(
    title: string,
    window: UsageWindow | null,
  ): HTMLDivElement {
    const block = document.createElement("div");
    block.style.cssText = "display:flex;flex-direction:column;gap:2px";
    if (!window) {
      block.appendChild(row(title, "—", { muted: true }));
      return block;
    }
    block.appendChild(
      row(
        title,
        formatPercentLabel(window.usedPercent, showPercentLeft),
        { accent: true },
      ),
    );
    block.appendChild(
      row("Resets", format.datetimeCountdown(window.resetAt), {
        muted: true,
      }),
    );
    return block;
  }

  function reopenPopover(): void {
    if (!popoverOpen || navButton === null) return;
    ui.popover({
      anchor: navButton,
      title: "Usage & Resets",
      width: 380,
      side: "right",
      onClose: () => {
        popoverOpen = false;
      },
      content: renderDetailPanel,
    });
  }

  function percentDisplayToggle(): HTMLDivElement {
    const element = document.createElement("div");
    element.style.cssText =
      "display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;line-height:18px";
    const label = document.createElement("span");
    label.textContent = "Usage display";
    const controls = document.createElement("div");
    controls.style.cssText =
      "display:inline-flex;gap:2px;border-radius:6px;padding:2px;background:color-mix(in srgb, currentColor 8%, transparent)";

    const makeOption = (text: string, active: boolean): HTMLButtonElement => {
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
        active
          ? "background:var(--color-bg-primary, color-mix(in srgb, currentColor 14%, transparent));font-weight:600"
          : "background:transparent;color:var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent))",
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

  function renderDetailPanel(): HTMLDivElement {
    const body = document.createElement("div");
    body.setAttribute("aria-readonly", "true");
    body.style.cssText =
      "display:flex;flex-direction:column;gap:8px;user-select:text";

    if (state.loading && state.usage === null) {
      body.appendChild(row("Status", "Loading…", { muted: true }));
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
        state.resets ? String(state.resets.availableCount) : "—",
        { accent: true },
      ),
    );
    if (state.resets?.credits.length) {
      const list = document.createElement("div");
      list.style.cssText =
        "display:flex;flex-direction:column;gap:4px;padding-left:4px;border-left:2px solid color-mix(in srgb, currentColor 12%, transparent)";
      for (const credit of state.resets.credits) {
        const detail = creditExpiryLabel(credit, format);
        list.appendChild(
          row(
            typeof credit.title === "string" && credit.title
              ? credit.title
              : "Reset",
            detail ?? "available",
            { muted: !detail },
          ),
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
      separator.style.cssText =
        "height:1px;background:color-mix(in srgb, currentColor 10%, transparent);margin:2px 0";
      body.appendChild(separator);
      body.appendChild(windowSection("Weekly", state.usage.secondary));
    }
    if (state.usage?.limitReached) {
      body.appendChild(row("Status", "Limit reached", { accent: true }));
    }
    if (state.updatedAt) {
      const stamp = new Intl.DateTimeFormat(undefined, {
        timeStyle: "short",
      }).format(state.updatedAt);
      body.appendChild(row("Updated", stamp, { muted: true }));
    }

    const note = document.createElement("div");
    note.textContent = "View only — use Codex settings to redeem resets";
    note.style.cssText =
      "font-size:11px;line-height:15px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 50%,transparent));margin-top:2px";
    body.appendChild(note);
    return body;
  }

  function compactLabel(): string {
    if (state.loading && state.usage === null) return "Usage: loading…";
    if (state.error !== null) return "Usage: error";
    return formatCompactUsage(
      state.usage,
      state.resets,
      settings.compactTemplate,
      format,
    );
  }

  function setNavButtonLabel(label: string): void {
    const labelNode = navButton?.querySelector("span:last-child");
    if (labelNode) {
      labelNode.textContent = label;
      return;
    }
    navButton?.replaceChildren(document.createTextNode(label));
  }

  function paintNav(): void {
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
            anchor: event.currentTarget as Element,
            title: "Usage & Resets",
            width: 380,
            side: "right",
            onClose: () => {
              popoverOpen = false;
            },
            content: renderDetailPanel,
          });
        },
      });
    }
    setNavButtonLabel(label);
    const mounted = sidebarNav.insertBefore(
      ["Settings", "Profile", "Account"],
      navButton,
      "usage-reset-glance",
    );
    if (mounted) log.debug("sidebar item mounted");
    else log.warn("sidebar mount deferred — profile footer anchor not found yet");
  }

  function renderOptionsPanel(container: HTMLElement): void {
    container.replaceChildren();
    let customRefreshHost: HTMLDivElement | null = null;
    const stack = components.fieldStack([
      components.textField({
        label: "Compact row format",
        value: settings.compactTemplate,
        monospace: true,
        onChange: (value) => {
          settings.compactTemplate = value.trim() || DEFAULT_TEMPLATE;
          saveSettings();
          paintNav();
        },
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
          { value: "custom", label: "Custom" },
        ],
        onChange: (value) => {
          settings.refreshPreset = normalizeUsageSettings({
            ...settings,
            refreshPreset: value,
          }).refreshPreset;
          if (value === "custom") {
            settings.refreshIntervalSec = Math.max(
              5,
              settings.refreshIntervalSec || 60,
            );
          } else {
            settings.refreshIntervalSec = Number(value);
          }
          saveSettings();
          startPolling();
          if (customRefreshHost) {
            customRefreshHost.style.display =
              settings.refreshPreset === "custom" ? "" : "none";
          }
        },
      }),
    ]);

    customRefreshHost = components.numberField({
      label: "Custom interval (seconds)",
      value: settings.refreshIntervalSec,
      min: 5,
      max: 3_600,
      onChange: (value) => {
        settings.refreshIntervalSec = Math.max(
          5,
          Math.min(3_600, value),
        );
        settings.refreshPreset = "custom";
        saveSettings();
        startPolling();
      },
    });
    customRefreshHost.style.display =
      settings.refreshPreset === "custom" ? "" : "none";
    stack.appendChild(customRefreshHost);
    container.appendChild(stack);
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    runtime.clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling(): void {
    if (disposed) return;
    stopPolling();
    const milliseconds = refreshIntervalMs(settings);
    if (milliseconds > 0) {
      pollTimer = runtime.setInterval(() => {
        void refresh();
      }, milliseconds);
    }
  }

  function abortRefresh(): void {
    pendingRefreshAbort?.abort();
    pendingRefreshAbort = null;
  }

  function refreshPopoverPosition(): void {
    if (!popoverOpen || navButton === null || !navButton.isConnected) return;
    ui.repositionPopover({
      anchor: navButton,
      width: 380,
      side: "right",
    });
  }

  function handleBeforeUnload(): void {
    stopPolling();
    abortRefresh();
    stopSidebarObserver?.();
    stopSidebarObserver = null;
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    abortRefresh();
    if (!http.isAvailable()) {
      log.warn("refresh skipped — HTTP bridge unavailable");
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
        http
          .get(PATH_USAGE, { signal: controller.signal })
          .catch((error: unknown) => {
            if (errorMessage(error, "").includes("401")) return null;
            throw error;
          }),
        http
          .get(PATH_RESET_CREDITS, { signal: controller.signal })
          .catch(() => null),
      ]);
      if (disposed || controller.signal.aborted) return;
      state = {
        loading: false,
        error: null,
        usage: usageBody ? parseUsage(usageBody) : null,
        resets: resetBody ? parseResetCredits(resetBody) : null,
        updatedAt: new Date(),
      };
    } catch (error: unknown) {
      if (disposed || controller.signal.aborted || isAbortError(error)) return;
      log.error("refresh failed", error);
      state = {
        ...state,
        loading: false,
        error: errorMessage(error, "Failed to load usage"),
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
          previousAnchor
            ? "sidebar zone changed — remounting nav item"
            : "sidebar zone ready — remounting nav item",
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
    { includeMutations: true },
  );
  stopRateLimitEvents = api.bridge.on("account/rateLimits/updated", () => {
    log.debug("rateLimits/updated — refreshing");
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

export default definePlugin({
  setup(api) {
    return setupUsageResetGlance(api);
  },
});
