/**
 * Explodex plugin: Usage & Reset compact sidebar item (VIEW ONLY)
 *
 * Shows a compact status line above Settings. Click opens a detail popover.
 * Never calls consume/redeem endpoints.
 */
(function registerUsageResetSidebar(global) {
  const BC = global.Explodex;
  if (!BC?.plugins?.register) {
    console.warn("[usage-reset-sidebar] Explodex SDK not loaded");
    return;
  }

  BC.log?.info?.("usage-reset-sidebar", "script evaluating");

  const POLL_MS = 60_000;
  const PATH_USAGE = "/wham/usage";
  const PATH_RESET_CREDITS = "/wham/rate-limit-reset-credits";

  function toFiniteNumber(value, fallback = 0) {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function clampPercent(value) {
    return Math.min(100, Math.max(0, toFiniteNumber(value)));
  }

  function formatTimeLeft(unixSeconds) {
    if (unixSeconds == null) return "—";
    const diffMs = unixSeconds * 1000 - Date.now();
    if (diffMs <= 0) return "0m";
    const mins = Math.ceil(diffMs / 60_000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
  }

  function formatDaysLeft(unixSeconds) {
    if (unixSeconds == null) return "—";
    const diffMs = unixSeconds * 1000 - Date.now();
    if (diffMs <= 0) return "0d";
    const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    return `${days}d`;
  }

  function normalizeUnixTimestamp(value) {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
      }
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    }
    return null;
  }

  function creditExpiryUnix(credit) {
    if (!credit || typeof credit !== "object") return null;
    const direct = [
      credit.expires_at,
      credit.expiration_at,
      credit.expiresAt,
      credit.valid_until,
      credit.valid_until_at,
      credit.redeem_by,
      credit.redeem_by_at,
    ];
    for (const candidate of direct) {
      const unix = normalizeUnixTimestamp(candidate);
      if (unix != null) return unix;
    }
    for (const [key, value] of Object.entries(credit)) {
      if (!/_at$|_until$|_by$/.test(key)) continue;
      const unix = normalizeUnixTimestamp(value);
      if (unix != null) return unix;
    }
    return null;
  }

  function creditExpiryLabel(credit) {
    const unix = creditExpiryUnix(credit);
    if (unix != null) return formatResetAt(unix);
    const description =
      typeof credit?.description === "string" ? credit.description.trim() : "";
    if (description) return description;
    return null;
  }

  function formatResetAt(unixSeconds) {
    if (unixSeconds == null) return "—";
    const date = new Date(unixSeconds * 1000);
    if (Number.isNaN(date.getTime())) return "—";
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
    const timePart = new Intl.DateTimeFormat(undefined, {
      timeStyle: "short",
    }).format(date);
    const diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return `${datePart} ${timePart} (passed)`;
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${datePart} ${timePart} · in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${datePart} ${timePart} · in ${hours}h`;
    const days = Math.floor(hours / 24);
    return `${datePart} ${timePart} · in ${days}d`;
  }

  function parseWindow(raw) {
    if (!raw) return null;
    const seconds =
      raw.limit_window_seconds == null ? null : toFiniteNumber(raw.limit_window_seconds, NaN);
    const minutes = Number.isFinite(seconds) ? seconds / 60 : null;
    return {
      usedPercent: clampPercent(raw.used_percent),
      resetAt: normalizeUnixTimestamp(raw.reset_at),
      windowMinutes: minutes,
    };
  }

  function parseUsage(body) {
    const rate = body?.rate_limit ?? null;
    return {
      planType: body?.plan_type ?? null,
      limitReached: Boolean(rate?.limit_reached || body?.rate_limit_reached_type),
      primary: parseWindow(rate?.primary_window),
      secondary: parseWindow(rate?.secondary_window),
      credits: body?.credits ?? null,
    };
  }

  function parseResetCredits(body) {
    const rawCredits = Array.isArray(body?.credits) ? body.credits : [];
    const credits = rawCredits.filter((c) => c && c.status === "available");
    const availableCount = toFiniteNumber(body?.available_count, credits.length);
    return {
      availableCount: Math.max(0, Math.floor(availableCount)),
      credits,
    };
  }

  function formatWindowLabel(minutes) {
    if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "—";
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
    if (showLeft) return `${percentLeft(usedPercent)}% left`;
    return `${Math.round(clampPercent(usedPercent))}% used`;
  }

  function formatCompact(usage, resets) {
    if (!usage && !resets) return "Usage: unavailable";
    const primary = usage?.primary;
    const secondary = usage?.secondary;
    const shortLabel = formatWindowLabel(primary?.windowMinutes);
    const shortPct = percentLeft(primary?.usedPercent ?? 0);
    const shortLeft = formatTimeLeft(primary?.resetAt);
    const weekPct = percentLeft(secondary?.usedPercent ?? 0);
    const weekLeft = formatDaysLeft(secondary?.resetAt);
    const resetCount = resets?.availableCount ?? 0;
    return `${shortLabel}: ${shortPct}% ${shortLeft} • Weekly: ${weekPct}% ${weekLeft} • Reset: ${resetCount}`;
  }

  function readOnlyHttp(http) {
    return {
      isAvailable: () => http.isAvailable(),
      get: (path, options) => {
        const lowerPath = typeof path === "string" ? path.toLowerCase() : "";
        if (
          typeof path !== "string" ||
          !path.startsWith("/wham/") ||
          path.includes("..") ||
          lowerPath.includes("consume")
        ) {
          return Promise.reject(new Error("view-only plugin: path not allowed"));
        }
        return http.get(path, options);
      },
    };
  }

  BC.plugins.register(
    {
      id: "usage-reset-sidebar",
      name: "Usage & Resets",
      version: "1.2.4",
      viewOnly: true,
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { observeZone, sidebarNav: nav, ui, log } = api;
      const h = readOnlyHttp(api.http);
      log.info("setup start");
      let disposed = false;
      let pollTimer = null;
      let pendingRefreshAbort = null;
      let popoutOpen = false;
      let showPercentLeft = true;
      let navButton = null;
      let mountObserver = null;
      let mountFrame = null;
      let unsubscribeSidebar = null;
      let unsubscribeRateLimits = null;
      let state = {
        loading: true,
        error: null,
        usage: null,
        resets: null,
        updatedAt: null,
      };

      function row(label, value, { muted = false, accent = false } = {}) {
        const el = document.createElement("div");
        el.style.cssText =
          "display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:12px;line-height:18px";
        const k = document.createElement("span");
        k.textContent = label;
        k.style.color = muted
          ? "var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent))"
          : "inherit";
        const v = document.createElement("span");
        v.textContent = value;
        v.style.textAlign = "right";
        if (accent) v.style.fontWeight = "600";
        el.appendChild(k);
        el.appendChild(v);
        return el;
      }

      function windowSection(title, win) {
        const block = document.createElement("div");
        block.style.cssText = "display:flex;flex-direction:column;gap:2px";
        if (!win) {
          block.appendChild(row(title, "—", { muted: true }));
          return block;
        }
        block.appendChild(
          row(title, formatPercentLabel(win.usedPercent, showPercentLeft), { accent: true }),
        );
        block.appendChild(row("Resets", formatResetAt(win.resetAt), { muted: true }));
        return block;
      }

      function percentDisplayToggle() {
        const el = document.createElement("div");
        el.style.cssText =
          "display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;line-height:18px";
        const label = document.createElement("span");
        label.textContent = "Usage display";
        const controls = document.createElement("div");
        controls.style.cssText = "display:inline-flex;gap:2px;border-radius:6px;padding:2px;background:color-mix(in srgb, currentColor 8%, transparent)";

        function makeOption(text, active) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = text;
          btn.setAttribute("aria-pressed", active ? "true" : "false");
          btn.style.cssText = [
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
          return btn;
        }

        const leftBtn = makeOption("% left", showPercentLeft);
        const usedBtn = makeOption("% used", !showPercentLeft);
        leftBtn.addEventListener("click", () => {
          if (showPercentLeft) return;
          showPercentLeft = true;
          reopenPopover();
        });
        usedBtn.addEventListener("click", () => {
          if (!showPercentLeft) return;
          showPercentLeft = false;
          reopenPopover();
        });
        controls.appendChild(leftBtn);
        controls.appendChild(usedBtn);
        el.appendChild(label);
        el.appendChild(controls);
        return el;
      }

      function reopenPopover() {
        if (!popoutOpen || !navButton) return;
        ui.popover({
          anchor: navButton,
          title: "Usage & Resets",
          width: 380,
          side: "right",
          onClose: () => {
            popoutOpen = false;
          },
          content: renderDetailPanel,
        });
      }

      function renderDetailPanel() {
        const body = document.createElement("div");
        body.setAttribute("aria-readonly", "true");
        body.style.cssText = "display:flex;flex-direction:column;gap:8px;user-select:text";

        if (state.loading && !state.usage) {
          body.appendChild(row("Status", "Loading…", { muted: true }));
          return body;
        }
        if (state.error) {
          body.appendChild(row("Error", state.error, { muted: true }));
          return body;
        }
        if (!state.usage && !state.resets) {
          body.appendChild(row("Status", "Unavailable", { muted: true }));
          return body;
        }

        const resets = state.resets;
        body.appendChild(
          row("Reset credits", resets ? String(resets.availableCount) : "—", { accent: true }),
        );

        if (resets?.credits?.length) {
          const list = document.createElement("div");
          list.style.cssText =
            "display:flex;flex-direction:column;gap:4px;padding-left:4px;border-left:2px solid color-mix(in srgb, currentColor 12%, transparent)";
          for (const credit of resets.credits) {
            const detail = creditExpiryLabel(credit);
            list.appendChild(
              row(
                credit.title || "Reset",
                detail ?? "available",
                { muted: !detail },
              ),
            );
          }
          body.appendChild(list);
        }

        const usage = state.usage;
        if (usage?.primary || usage?.secondary) {
          body.appendChild(percentDisplayToggle());
        }
        if (usage?.primary) {
          body.appendChild(windowSection("Short window", usage.primary));
        }
        if (usage?.secondary) {
          const sep = document.createElement("div");
          sep.style.cssText =
            "height:1px;background:color-mix(in srgb, currentColor 10%, transparent);margin:2px 0";
          body.appendChild(sep);
          body.appendChild(windowSection("Weekly", usage.secondary));
        }

        if (usage?.limitReached) {
          body.appendChild(row("Status", "Limit reached", { accent: true }));
        }

        if (state.updatedAt) {
          const stamp = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
            state.updatedAt,
          );
          body.appendChild(row("Updated", stamp, { muted: true }));
        }

        const note = document.createElement("div");
        note.textContent = "View only — use Codex settings to redeem resets";
        note.style.cssText =
          "font-size:11px;line-height:15px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 50%,transparent));margin-top:2px";
        body.appendChild(note);
        return body;
      }

      function compactLabel() {
        if (state.loading && !state.usage) return "Usage: loading…";
        if (state.error) return "Usage: error";
        return formatCompact(state.usage, state.resets);
      }

      function refreshPopoverPosition() {
        if (!popoutOpen || !navButton?.isConnected) return;
        ui.repositionPopover?.({
          anchor: navButton,
          width: 380,
          side: "right",
        });
      }

      function setNavButtonLabel(label) {
        const labelNode = navButton?.querySelector("span:last-child");
        if (labelNode) {
          labelNode.textContent = label;
          return;
        }
        navButton?.replaceChildren(document.createTextNode(label));
      }

      function isNavMounted() {
        return Boolean(
          navButton?.isConnected &&
            document.querySelector('[data-explodex-nav="usage-reset-sidebar"]')?.isConnected,
        );
      }

      function scheduleMountCheck() {
        if (disposed || mountFrame != null) return;
        mountFrame = global.requestAnimationFrame(() => {
          mountFrame = null;
          if (!isNavMounted()) {
            navButton = null;
            paintNav();
          }
          refreshPopoverPosition();
        });
      }

      function paintNav() {
        const label = compactLabel();
        if (!navButton) {
          navButton = ui.navItem({
            label: "Usage & Resets",
            compact: true,
            onClick: (event) => {
              popoutOpen = !popoutOpen;
              if (!popoutOpen) {
                ui.closePopover();
                return;
              }
              ui.popover({
                anchor: event.currentTarget,
                title: "Usage & Resets",
                width: 380,
                side: "right",
                onClose: () => {
                  popoutOpen = false;
                },
                content: renderDetailPanel,
              });
            },
          });
          setNavButtonLabel(label);
        } else {
          setNavButtonLabel(label);
        }
        const mounted = nav.insertBefore(["Settings"], navButton, "usage-reset-sidebar");
        if (!mounted) {
          log.warn("sidebar mount deferred — Settings anchor not found yet");
        } else {
          log.debug("sidebar item mounted");
        }
      }

      async function refresh() {
        if (disposed) return;
        if (!h.isAvailable()) {
          log.warn("refresh skipped — HTTP bridge unavailable");
          state = { ...state, loading: false, error: "Bridge unavailable" };
          paintNav();
          return;
        }
        log.debug("refreshing usage data");
        pendingRefreshAbort?.abort();
        const controller = new AbortController();
        pendingRefreshAbort = controller;
        try {
          const [usageBody, resetBody] = await Promise.all([
            h.get(PATH_USAGE, { signal: controller.signal }).catch((err) => {
              if (String(err?.message || err).includes("401")) return null;
              throw err;
            }),
            h.get(PATH_RESET_CREDITS, { signal: controller.signal }).catch(() => null),
          ]);
          if (disposed || controller.signal.aborted) return;
          state = {
            loading: false,
            error: null,
            usage: usageBody ? parseUsage(usageBody) : null,
            resets: resetBody ? parseResetCredits(resetBody) : null,
            updatedAt: new Date(),
          };
        } catch (err) {
          if (disposed || err?.name === "AbortError") return;
          log.error("refresh failed", err);
          state = {
            ...state,
            loading: false,
            error: err?.message || "Failed to load usage",
          };
        }
        paintNav();
        reopenPopover();
        if (pendingRefreshAbort === controller) pendingRefreshAbort = null;
      }

      function startPolling() {
        if (disposed) return;
        stopPolling();
        pollTimer = global.setInterval(refresh, POLL_MS);
      }

      function stopPolling() {
        if (pollTimer != null) {
          global.clearInterval(pollTimer);
          pollTimer = null;
        }
      }

      function abortRefresh() {
        pendingRefreshAbort?.abort();
        pendingRefreshAbort = null;
      }

      function startMountObserver() {
        if (mountObserver) return;
        mountObserver = new MutationObserver(scheduleMountCheck);
        mountObserver.observe(document.documentElement, { childList: true, subtree: true });
        global.addEventListener("resize", refreshPopoverPosition);
        global.addEventListener("scroll", refreshPopoverPosition, true);
      }

      function stopMountObserver() {
        mountObserver?.disconnect();
        mountObserver = null;
        if (mountFrame != null) {
          global.cancelAnimationFrame(mountFrame);
          mountFrame = null;
        }
        global.removeEventListener("resize", refreshPopoverPosition);
        global.removeEventListener("scroll", refreshPopoverPosition, true);
      }

      function handleBeforeUnload() {
        stopPolling();
        abortRefresh();
        stopMountObserver();
      }

      paintNav();
      startMountObserver();
      refresh()
        .then(() => {
          if (disposed) return;
          startPolling();
          log.info("initial refresh complete");
        })
        .catch((err) => log.error("initial refresh failed", err));

      unsubscribeSidebar = observeZone("sidebar", (_anchor, { previousAnchor } = {}) => {
        log.debug(previousAnchor ? "sidebar zone changed — remounting nav item" : "sidebar zone ready — remounting nav item");
        navButton = null;
        paintNav();
        refresh();
      });

      unsubscribeRateLimits = api.bridge.on("account/rateLimits/updated", () => {
        log.debug("rateLimits/updated — refreshing");
        refresh();
      });
      global.addEventListener("beforeunload", handleBeforeUnload, { once: true });

      log.info("setup complete");
      return () => {
        log.info("teardown");
        disposed = true;
        stopPolling();
        abortRefresh();
        stopMountObserver();
        unsubscribeSidebar?.();
        unsubscribeRateLimits?.();
        global.removeEventListener("beforeunload", handleBeforeUnload);
        ui.closePopover();
        nav.remove("usage-reset-sidebar");
        navButton = null;
      };
    },
  );
})(window);
