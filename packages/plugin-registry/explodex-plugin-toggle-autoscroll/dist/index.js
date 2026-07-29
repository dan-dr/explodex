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
    default: () => index_default
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

  // src/settings.ts
  var CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function defaultToggleAutoscrollSettings() {
    return {
      rememberAutoscroll: true,
      defaultAutoscroll: true,
      showText: true,
      showAlways: true,
      threadStates: {}
    };
  }
  function normalizeToggleAutoscrollSettings(raw) {
    const defaults = defaultToggleAutoscrollSettings();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return defaults;
    }
    const record = raw;
    const threadStates = {};
    if (typeof record.threadStates === "object" && record.threadStates !== null && !Array.isArray(record.threadStates)) {
      for (const [threadId, enabled] of Object.entries(record.threadStates)) {
        if (CONVERSATION_ID_RE.test(threadId) && typeof enabled === "boolean") {
          threadStates[threadId] = enabled;
        }
      }
    }
    return {
      rememberAutoscroll: typeof record.rememberAutoscroll === "boolean" ? record.rememberAutoscroll : defaults.rememberAutoscroll,
      defaultAutoscroll: typeof record.defaultAutoscroll === "boolean" ? record.defaultAutoscroll : defaults.defaultAutoscroll,
      showText: typeof record.showText === "boolean" ? record.showText : defaults.showText,
      showAlways: typeof record.showAlways === "boolean" ? record.showAlways : defaults.showAlways,
      threadStates
    };
  }
  function resolveAutoscrollEnabled(options) {
    const { conversationId, sessionStates, settings } = options;
    if (conversationId !== null && sessionStates.has(conversationId)) {
      return sessionStates.get(conversationId) ?? settings.defaultAutoscroll;
    }
    if (conversationId !== null && settings.rememberAutoscroll && conversationId in settings.threadStates) {
      return settings.threadStates[conversationId] ?? settings.defaultAutoscroll;
    }
    return settings.defaultAutoscroll;
  }

  // src/index.ts
  var global = globalThis;
  var STORAGE_KEY = "explodex-toggle-autoscroll";
  var CONVERSATION_ID_RE2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var index_default = definePlugin({
    setup(api) {
      const { components: c, inject, log, registerOptions, storage } = api;
      let settings = loadSettings();
      const sessionStates = /* @__PURE__ */ new Map();
      let scrollElement = null;
      let contentObserver = null;
      let anchor = null;
      let toggleButton = null;
      let toggleRoot = null;
      let toggleText = null;
      let styledPortal = null;
      let restoreFrame = 0;
      let userInteractionUntil = 0;
      let restoring = false;
      let disposed = false;
      const pendingFrames = /* @__PURE__ */ new Set();
      function scheduleFrame(callback) {
        const frame = global.requestAnimationFrame(() => {
          pendingFrames.delete(frame);
          if (!disposed) callback();
        });
        pendingFrames.add(frame);
        return frame;
      }
      function loadSettings() {
        return normalizeToggleAutoscrollSettings(
          storage.persisted.get(
            STORAGE_KEY,
            defaultToggleAutoscrollSettings()
          )
        );
      }
      function saveSettings() {
        storage.persisted.set(STORAGE_KEY, settings);
      }
      function normalizeConversationId(value) {
        if (value == null) return null;
        const id = String(value).trim();
        return CONVERSATION_ID_RE2.test(id) ? id : null;
      }
      function conversationId() {
        const focusedInput = api.composer.getInput();
        const portals = document.querySelectorAll(
          "[data-above-composer-conversation-id], [data-above-composer-portal]"
        );
        for (const portal of portals) {
          if (focusedInput && !portal.contains(focusedInput)) continue;
          const id = normalizeConversationId(
            portal.getAttribute("data-above-composer-conversation-id")
          );
          if (id) return id;
        }
        for (const portal of portals) {
          const id = normalizeConversationId(
            portal.getAttribute("data-above-composer-conversation-id")
          );
          if (id) return id;
        }
        const patterns = [
          /\/local\/([^/]+)/,
          /\/thread\/([^/]+)/,
          /\/hotkey-window\/thread\/([^/]+)/
        ];
        for (const pattern of patterns) {
          const match = global.location?.pathname?.match(pattern);
          const id = normalizeConversationId(
            match?.[1] ? decodeURIComponent(match[1]) : null
          );
          if (id) return id;
        }
        return null;
      }
      function autoscrollEnabled() {
        return resolveAutoscrollEnabled({
          conversationId: conversationId(),
          sessionStates,
          settings
        });
      }
      function setAutoscroll(enabled) {
        const id = conversationId();
        if (id) {
          sessionStates.set(id, enabled);
          if (settings.rememberAutoscroll) {
            settings.threadStates[id] = enabled;
            saveSettings();
          }
        }
        if (enabled) {
          anchor = null;
          restoring = true;
          scrollElement?.scrollTo({ top: 0, behavior: "smooth" });
          scheduleFrame(() => {
            restoring = false;
          });
        } else {
          captureAnchor();
        }
        paintButton();
      }
      function findScrollElement() {
        const footer = document.querySelector('[data-thread-scroll-footer="true"]');
        const direct = footer?.closest(".thread-scroll-container");
        return direct instanceof HTMLElement ? direct : null;
      }
      function captureAnchor() {
        if (!scrollElement) {
          anchor = null;
          return;
        }
        const bounds = scrollElement.getBoundingClientRect();
        const candidates = scrollElement.querySelectorAll("[data-content-search-unit-key]");
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement)) continue;
          const rect = candidate.getBoundingClientRect();
          if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
          const distance = Math.abs(rect.top - bounds.top);
          if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
        anchor = best ? { element: best, top: best.getBoundingClientRect().top } : { element: null, scrollTop: scrollElement.scrollTop };
      }
      function scheduleRestore() {
        if (disposed || autoscrollEnabled() || restoreFrame) return;
        restoreFrame = scheduleFrame(() => {
          restoreFrame = 0;
          restoreAnchor();
        });
      }
      function restoreAnchor() {
        if (!scrollElement || !anchor || autoscrollEnabled()) return;
        restoring = true;
        if (anchor.element?.isConnected) {
          const delta = anchor.element.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) > 0.5) scrollElement.scrollBy({ top: delta, behavior: "instant" });
        } else if (anchor.element === null) {
          scrollElement.scrollTop = anchor.scrollTop;
        } else {
          captureAnchor();
        }
        scheduleFrame(() => {
          restoring = false;
        });
      }
      function markUserInteraction() {
        userInteractionUntil = performance.now() + 250;
      }
      function onScroll() {
        updateVisibility();
        if (restoring || autoscrollEnabled()) return;
        if (performance.now() <= userInteractionUntil) {
          userInteractionUntil = performance.now() + 250;
          scheduleFrame(captureAnchor);
          return;
        }
        scheduleRestore();
      }
      function detachScrollGuard() {
        contentObserver?.disconnect();
        contentObserver = null;
        if (scrollElement) {
          scrollElement.removeEventListener("pointerdown", markUserInteraction);
          scrollElement.removeEventListener("touchstart", markUserInteraction);
          scrollElement.removeEventListener("wheel", markUserInteraction);
          scrollElement.removeEventListener("keydown", markUserInteraction);
          scrollElement.removeEventListener("scroll", onScroll);
        }
        scrollElement = null;
        anchor = null;
      }
      function attachScrollGuard() {
        const next = findScrollElement();
        if (next === scrollElement) return;
        detachScrollGuard();
        if (!next) {
          log.warn("Thread scroll container not found");
          return;
        }
        scrollElement = next;
        scrollElement.addEventListener("pointerdown", markUserInteraction, { passive: true });
        scrollElement.addEventListener("touchstart", markUserInteraction, { passive: true });
        scrollElement.addEventListener("wheel", markUserInteraction, { passive: true });
        scrollElement.addEventListener("keydown", markUserInteraction, { passive: true });
        scrollElement.addEventListener("scroll", onScroll, { passive: true });
        contentObserver = new MutationObserver(scheduleRestore);
        contentObserver.observe(scrollElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
        if (!autoscrollEnabled()) captureAnchor();
        updateVisibility();
      }
      function tooltipText(enabled) {
        return enabled ? "Autoscroll on" : "Autoscroll off";
      }
      function paintButton() {
        if (!toggleButton) return;
        const enabled = autoscrollEnabled();
        const label = tooltipText(enabled);
        toggleButton.setAttribute("aria-label", label);
        toggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
        toggleButton.dataset.autoscrollEnabled = enabled ? "true" : "false";
        toggleButton.style.opacity = enabled ? "1" : "0.55";
        toggleButton.style.background = enabled ? "color-mix(in srgb, currentColor 10%, transparent)" : "transparent";
        const slash = toggleButton.querySelector("[data-autoscroll-slash]");
        if (slash instanceof SVGElement) slash.style.display = enabled ? "none" : "";
        if (toggleText) toggleText.style.display = settings.showText ? "" : "none";
        const tooltip = toggleButton.parentElement?.querySelector("[role=tooltip]");
        if (tooltip) tooltip.textContent = label;
        updateVisibility();
      }
      function autoscrollIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        svg.setAttribute("aria-hidden", "true");
        svg.innerHTML = [
          '<path d="M10 3v9m0 0 3-3m-3 3L7 9M5 16h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
          '<path data-autoscroll-slash d="M4 4l12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
        ].join("");
        return svg;
      }
      function isScrolledUp() {
        return scrollElement ? Math.abs(scrollElement.scrollTop) > 24 : false;
      }
      function updateVisibility() {
        if (!toggleRoot) return;
        toggleRoot.style.display = settings.showAlways || isScrolledUp() ? "inline-flex" : "none";
      }
      function restorePortalStyle() {
        if (!styledPortal) return;
        if (styledPortal.dataset.explodexAutoscrollOwner === api.token) {
          const original = styledPortal.dataset.explodexAutoscrollOriginalStyle;
          if (original === "__absent__") styledPortal.removeAttribute("style");
          else if (original !== void 0) {
            styledPortal.setAttribute("style", original);
          }
          delete styledPortal.dataset.explodexAutoscrollOwner;
          delete styledPortal.dataset.explodexAutoscrollOriginalStyle;
        }
        styledPortal = null;
      }
      function stylePortal() {
        const portal = toggleRoot?.parentElement?.parentElement;
        if (!(portal instanceof HTMLElement) || !portal.matches("[data-above-composer-portal]")) {
          return;
        }
        if (portal === styledPortal) return;
        restorePortalStyle();
        styledPortal = portal;
        if (portal.dataset.explodexAutoscrollOriginalStyle === void 0) {
          portal.dataset.explodexAutoscrollOriginalStyle = portal.getAttribute("style") ?? "__absent__";
        }
        portal.dataset.explodexAutoscrollOwner = api.token;
        portal.style.display = "flex";
        portal.style.alignItems = "center";
        portal.style.justifyContent = "flex-end";
        portal.style.gap = "6px";
        portal.style.flexWrap = "wrap";
      }
      function buildToggle() {
        const root = document.createElement("div");
        root.style.cssText = "position:relative;flex:0 0 auto;display:none;align-items:center;pointer-events:auto";
        const tooltip = document.createElement("div");
        tooltip.setAttribute("role", "tooltip");
        tooltip.style.cssText = [
          "display:none",
          "position:absolute",
          "left:50%",
          "bottom:calc(100% + 6px)",
          "transform:translateX(-50%)",
          "z-index:30",
          "white-space:nowrap",
          "padding:4px 7px",
          "border-radius:6px",
          "font:12px/16px system-ui,-apple-system,sans-serif",
          "color:var(--color-token-foreground,inherit)",
          "background:var(--color-token-dropdown-background,var(--color-bg-primary,#111))",
          "box-shadow:0 4px 16px color-mix(in srgb,#000 35%,transparent)"
        ].join(";");
        const button = c.button({
          color: "ghost",
          size: "icon",
          icon: autoscrollIcon(),
          onClick: () => setAutoscroll(!autoscrollEnabled())
        });
        button.style.cssText += ";min-width:28px;height:28px;border-radius:999px;padding:0 7px;gap:5px;transition:opacity 120ms,background 120ms";
        const text = document.createElement("span");
        text.dataset.autoscrollText = "true";
        text.textContent = "Auto-scroll";
        text.style.cssText = "font:12px/16px system-ui,-apple-system,sans-serif;white-space:nowrap";
        button.appendChild(text);
        const showTooltip = () => {
          tooltip.style.display = "block";
        };
        const hideTooltip = () => {
          tooltip.style.display = "none";
        };
        button.addEventListener("mouseenter", showTooltip);
        button.addEventListener("mouseleave", hideTooltip);
        button.addEventListener("focus", showTooltip);
        button.addEventListener("blur", hideTooltip);
        root.append(button, tooltip);
        toggleRoot = root;
        toggleButton = button;
        toggleText = text;
        paintButton();
        return root;
      }
      function mountToggle() {
        attachScrollGuard();
        api.mount("aboveComposer", buildToggle, { position: "append", replace: true });
        const mount = toggleRoot?.parentElement;
        if (mount instanceof HTMLElement) {
          mount.style.width = "auto";
          mount.style.flex = "0 0 auto";
        }
        stylePortal();
        paintButton();
      }
      function toggleOption(label, hint, checked, onChange) {
        const field = document.createElement("div");
        field.style.cssText = "display:flex;flex-direction:column;gap:4px";
        field.append(
          c.checkboxField({ label, checked, onChange }),
          c.metaText(hint)
        );
        return field;
      }
      function renderOptions(container) {
        container.replaceChildren(
          c.fieldStack([
            toggleOption(
              "Remember autoscroll",
              "Remember each thread's autoscroll state.",
              settings.rememberAutoscroll,
              (checked) => {
                settings.rememberAutoscroll = checked;
                if (checked) {
                  for (const [threadId, enabled] of sessionStates) {
                    settings.threadStates[threadId] = enabled;
                  }
                }
                saveSettings();
                paintButton();
              }
            ),
            toggleOption(
              "Default autoscroll",
              "Enable or disable autoscroll for new threads or threads without saved state.",
              settings.defaultAutoscroll,
              (checked) => {
                settings.defaultAutoscroll = checked;
                saveSettings();
                paintButton();
              }
            ),
            toggleOption(
              "Show text",
              "Show \u2018Auto-scroll\u2019 next to the icon.",
              settings.showText,
              (checked) => {
                settings.showText = checked;
                saveSettings();
                paintButton();
              }
            ),
            toggleOption(
              "Show always",
              "Show the control at all times. When disabled, show it only after scrolling up.",
              settings.showAlways,
              (checked) => {
                settings.showAlways = checked;
                saveSettings();
                updateVisibility();
              }
            )
          ])
        );
      }
      registerOptions({ render: renderOptions });
      mountToggle();
      const stopObservingComposer = inject.observeZone("aboveComposer", mountToggle);
      const stopObservingFooter = inject.observeZone("threadFooter", attachScrollGuard);
      return () => {
        disposed = true;
        stopObservingComposer();
        stopObservingFooter();
        restorePortalStyle();
        detachScrollGuard();
        for (const frame of pendingFrames) {
          global.cancelAnimationFrame(frame);
        }
        pendingFrames.clear();
        restoreFrame = 0;
        toggleRoot = null;
        toggleButton = null;
        toggleText = null;
      };
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
    register("toggle-autoscroll", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
