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
  var MIN_PALETTE_SIZE = 5;
  var DEFAULT_PALETTE = [
    "#E06C75",
    "#E5C07B",
    "#98C379",
    "#61AFEF",
    "#C678DD",
    "#56B6C2",
    "#D19A66",
    "#BE5046",
    "#6796E6",
    "#C0CA33",
    "#F06292",
    "#4DB6AC"
  ];
  function defaultProjectColorSettings() {
    return {
      version: 2,
      palette: [...DEFAULT_PALETTE],
      autoAssignProjects: true,
      visuals: {
        style: "side",
        colorTarget: "projects"
      },
      projectOverrides: {},
      threadOverrides: {}
    };
  }
  function normalizeHexColor(value) {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return null;
    if (raw.length === 4) {
      const [, red, green, blue] = raw;
      return `#${red}${red}${green}${green}${blue}${blue}`.toUpperCase();
    }
    return raw.toUpperCase();
  }
  function normalizePalette(value) {
    if (!Array.isArray(value)) return [...DEFAULT_PALETTE];
    const colors = [];
    for (const entry of value) {
      const color = normalizeHexColor(entry);
      if (color !== null && !colors.includes(color)) colors.push(color);
    }
    return colors.length >= MIN_PALETTE_SIZE ? colors : [...DEFAULT_PALETTE];
  }
  function normalizeColorTarget(value) {
    return value === "projects" || value === "threads" || value === "both" ? value : "projects";
  }
  function recordOfStrings(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry) => typeof entry[1] === "string"
      )
    );
  }
  function migrateProjectColorSettings(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return defaultProjectColorSettings();
    }
    const record = raw;
    const visuals = typeof record.visuals === "object" && record.visuals !== null && !Array.isArray(record.visuals) ? record.visuals : {};
    let colorTarget = normalizeColorTarget(visuals.colorTarget);
    if (visuals.colorTarget === void 0 && (visuals.colorThreadsInProject === true || record.colorThreads === true)) {
      colorTarget = "both";
    }
    return {
      version: 2,
      palette: normalizePalette(record.palette),
      autoAssignProjects: record.autoAssignProjects !== void 0 ? record.autoAssignProjects !== false : record.autoAssign !== false,
      visuals: {
        style: visuals.style === "full" ? "full" : "side",
        colorTarget
      },
      projectOverrides: recordOfStrings(
        record.projectOverrides ?? record.overrides
      ),
      threadOverrides: recordOfStrings(record.threadOverrides)
    };
  }
  function autoColorForId(id, palette) {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
      hash = hash * 31 + id.charCodeAt(index) >>> 0;
    }
    return palette[hash % palette.length] ?? DEFAULT_PALETTE[0];
  }
  function projectColorValue(settings, projectId) {
    const override = settings.projectOverrides[projectId];
    if (override !== void 0) return override;
    if (!settings.autoAssignProjects) return null;
    return autoColorForId(projectId, normalizePalette(settings.palette));
  }

  // src/index.ts
  var global = globalThis;
  var STORAGE_KEY = "explodex-project-colors";
  var STYLE_ID = "explodex-project-colors-styles";
  var RECONCILE_DEBOUNCE_MS = 120;
  var index_default = definePlugin({
    setup(api) {
      const { storage, log, inject, components: c, registerOptions } = api;
      let settings = defaultProjectColorSettings();
      let disposed = false;
      let sidebarObserver = null;
      let unsubscribeSidebar = null;
      let reconcileTimer = null;
      let lastAppliedSignature = "";
      let activePicker = null;
      let styleElement = null;
      function colorTargetMode() {
        return settings.visuals.colorTarget;
      }
      function colorsProjects() {
        const mode = colorTargetMode();
        return mode === "projects" || mode === "both";
      }
      function colorsThreadsFromProject() {
        const mode = colorTargetMode();
        return mode === "threads" || mode === "both";
      }
      function usesProjectGroups() {
        return colorTargetMode() === "both";
      }
      function loadSettings() {
        settings = migrateProjectColorSettings(
          storage.persisted.get(STORAGE_KEY, null)
        );
      }
      function saveSettings() {
        settings.palette = normalizePalette(settings.palette);
        storage.persisted.set(STORAGE_KEY, settings);
      }
      function palette() {
        return normalizePalette(settings.palette);
      }
      function resolveProjectColorValue(projectId) {
        return projectColorValue(settings, projectId);
      }
      function resolveProjectColor(projectId) {
        if (!colorsProjects()) return null;
        return resolveProjectColorValue(projectId);
      }
      function manualThreadColor(threadId) {
        return settings.threadOverrides[threadId] ?? null;
      }
      function resolveInheritedThreadColor(threadId, projectId) {
        if (manualThreadColor(threadId)) return null;
        if (!colorsThreadsFromProject() || !projectId) return null;
        return resolveProjectColorValue(projectId);
      }
      function iterateSidebarEntries(nav) {
        const entries = [];
        let currentProjectId = null;
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]"
        )) {
          if (el.hasAttribute("data-app-action-sidebar-project-id")) {
            currentProjectId = el.getAttribute("data-app-action-sidebar-project-id");
            entries.push({
              type: "project",
              projectId: currentProjectId,
              threadId: null,
              el
            });
            continue;
          }
          entries.push({
            type: "thread",
            projectId: currentProjectId,
            threadId: el.getAttribute("data-app-action-sidebar-thread-id"),
            el
          });
        }
        return entries;
      }
      function projectGroupsFromEntries(entries) {
        const groups = [];
        let current = null;
        for (const entry of entries) {
          if (entry.type === "project" && entry.projectId) {
            if (current) groups.push(current);
            current = { projectId: entry.projectId, projectEl: entry.el, threads: [] };
            continue;
          }
          if (entry.type === "thread" && current && entry.projectId === current.projectId && entry.threadId) {
            current.threads.push({ threadId: entry.threadId, el: entry.el });
          }
        }
        if (current) groups.push(current);
        return groups;
      }
      function projectColorTarget(projectEl) {
        const projectRow = projectEl.closest?.("[data-app-action-sidebar-project-row]");
        if (projectRow) return projectRow;
        if (projectEl.hasAttribute("data-app-action-sidebar-project-id")) return projectEl;
        const listItem = sidebarListItem(projectEl);
        if (listItem && !listItem.querySelector("[data-app-action-sidebar-thread-id]")) {
          return listItem;
        }
        return projectEl;
      }
      function threadColorTarget(threadEl) {
        return threadEl.closest?.("[data-app-action-sidebar-thread-row]") ?? threadEl.closest?.("[data-app-action-sidebar-thread-id]") ?? sidebarListItem(threadEl) ?? threadEl;
      }
      function sidebarNavRoot() {
        return document.querySelector('nav[aria-label*="Scheduled task" i]') ?? document.querySelector('nav[aria-label*="Automation folders" i]') ?? document.querySelector("nav.sidebar-foreground-muted") ?? document.querySelector("nav");
      }
      function sidebarListItem(node) {
        return node?.closest?.('[role="listitem"]') ?? null;
      }
      function projectIdFromElement(el) {
        const id = el?.getAttribute?.("data-app-action-sidebar-project-id");
        return id ? String(id) : null;
      }
      function projectIdForThreadRow(threadEl) {
        const nav = sidebarNavRoot();
        if (!nav || !threadEl) return null;
        const threadId = threadEl.getAttribute("data-app-action-sidebar-thread-id");
        if (!threadId) return null;
        let currentProject = null;
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]"
        )) {
          if (el.hasAttribute("data-app-action-sidebar-project-id")) {
            currentProject = el.getAttribute("data-app-action-sidebar-project-id");
            continue;
          }
          if (el.getAttribute("data-app-action-sidebar-thread-id") === threadId) {
            return currentProject;
          }
        }
        return null;
      }
      function buildStyleText() {
        const pickerCss = `
nav [data-explodex-picker-host] {
  position: relative;
  padding-left: 18px;
}
nav [data-explodex-color-picker] {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: var(--color-text-tertiary, color-mix(in srgb, currentColor 55%, transparent));
  font: 11px/16px system-ui, -apple-system, sans-serif;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  z-index: 3;
}
nav [data-explodex-color-picker]:hover {
  background: color-mix(in srgb, currentColor 16%, transparent);
  color: inherit;
}
nav [data-explodex-picker-host]:hover [data-explodex-color-picker],
nav [data-explodex-picker-host]:focus-within [data-explodex-color-picker] {
  opacity: 1;
  pointer-events: auto;
}
`.trim();
        const styleMode = settings.visuals.style === "full" ? "full" : "side";
        const rowTint = "color-mix(in srgb, var(--explodex-row-color) 18%, transparent)";
        if (styleMode === "full") {
          return `
${pickerCss}
nav [data-explodex-colored] {
  position: relative;
}
nav [data-explodex-colored]:not([data-explodex-group-pos]) {
  border-radius: 6px;
  background: ${rowTint} !important;
}
nav [data-explodex-colored][data-explodex-group-pos] {
  background: ${rowTint} !important;
  border-radius: 0;
  margin-inline: 4px;
}
nav [data-explodex-colored][data-explodex-group-pos="first"],
nav [data-explodex-colored][data-explodex-group-pos="only"] {
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
  margin-top: 2px;
}
nav [data-explodex-colored][data-explodex-group-pos="last"],
nav [data-explodex-colored][data-explodex-group-pos="only"] {
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
  margin-bottom: 2px;
}
`.trim();
        }
        return `
${pickerCss}
nav [data-explodex-colored] {
  position: relative;
}
nav [data-explodex-colored]:not([data-explodex-group-pos])::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: 6px;
  width: 4px;
  border-radius: 2px;
  background: var(--explodex-row-color);
  pointer-events: none;
}
nav [data-explodex-colored][data-explodex-group-pos]::before {
  content: "";
  position: absolute;
  left: 4px;
  width: 4px;
  top: 0;
  bottom: 0;
  background: var(--explodex-row-color);
  pointer-events: none;
  border-radius: 0;
}
nav [data-explodex-colored][data-explodex-group-pos="first"]::before,
nav [data-explodex-colored][data-explodex-group-pos="only"]::before {
  top: 6px;
  border-top-left-radius: 2px;
  border-top-right-radius: 2px;
}
nav [data-explodex-colored][data-explodex-group-pos="last"]::before,
nav [data-explodex-colored][data-explodex-group-pos="only"]::before {
  bottom: 6px;
  border-bottom-left-radius: 2px;
  border-bottom-right-radius: 2px;
}
`.trim();
      }
      function ensureStyles() {
        if (styleElement === null || !styleElement.isConnected) {
          styleElement = document.createElement("style");
          styleElement.id = `${STYLE_ID}-${api.generation}`;
          document.head.appendChild(styleElement);
        }
        const next = buildStyleText();
        if (styleElement.textContent !== next) styleElement.textContent = next;
      }
      function clearColorDecorations() {
        for (const el of document.querySelectorAll(
          "[data-explodex-colored]"
        )) {
          if (el.dataset.explodexColorOwner !== api.token) continue;
          el.removeAttribute("data-explodex-colored");
          el.removeAttribute("data-explodex-kind");
          el.removeAttribute("data-explodex-group-pos");
          delete el.dataset.explodexColorOwner;
          el.style.removeProperty("--explodex-row-color");
        }
      }
      function clearPickerButtons() {
        for (const el of document.querySelectorAll(
          "[data-explodex-color-picker]"
        )) {
          if (el.dataset.explodexColorOwner !== api.token) continue;
          el.remove();
        }
        for (const el of document.querySelectorAll(
          "[data-explodex-picker-host]"
        )) {
          if (el.dataset.explodexColorOwner !== api.token) continue;
          el.removeAttribute("data-explodex-picker-host");
          delete el.dataset.explodexColorOwner;
        }
      }
      function applyColorToRow(row, color, kind, options = {}) {
        if (!row) return;
        if (!color) {
          row.removeAttribute("data-explodex-colored");
          row.removeAttribute("data-explodex-kind");
          row.removeAttribute("data-explodex-group-pos");
          delete row.dataset.explodexColorOwner;
          row.style.removeProperty("--explodex-row-color");
          return;
        }
        row.dataset.explodexColorOwner = api.token;
        row.style.setProperty("--explodex-row-color", color);
        row.setAttribute("data-explodex-colored", "true");
        row.setAttribute("data-explodex-kind", kind);
        if (options.groupPos) {
          row.setAttribute("data-explodex-group-pos", options.groupPos);
        } else {
          row.removeAttribute("data-explodex-group-pos");
        }
      }
      function ensurePickerButton(host, target) {
        if (!host?.isConnected) return;
        const existing = host.querySelector(
          "[data-explodex-color-picker]"
        );
        if (existing?.dataset.explodexColorOwner === api.token) return;
        existing?.remove();
        host.setAttribute("data-explodex-picker-host", "true");
        host.dataset.explodexColorOwner = api.token;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-explodex-color-picker", "true");
        btn.setAttribute("data-explodex-picker-kind", target.kind);
        btn.setAttribute("data-explodex-picker-id", target.id);
        btn.dataset.explodexColorOwner = api.token;
        btn.setAttribute("aria-label", target.label);
        btn.title = target.label;
        btn.textContent = "\u25CD";
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openColorPicker(btn, target);
        });
        host.insertBefore(btn, host.firstChild);
      }
      function syncPickerButtons(nav) {
        for (const projectEl of nav.querySelectorAll("[data-app-action-sidebar-project-id]")) {
          const projectId = projectIdFromElement(projectEl);
          if (!projectId) continue;
          ensurePickerButton(projectColorTarget(projectEl), {
            kind: "project",
            id: projectId,
            label: "Project color"
          });
        }
        for (const threadEl of nav.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
          const threadId = threadEl.getAttribute("data-app-action-sidebar-thread-id");
          if (!threadId) continue;
          ensurePickerButton(threadColorTarget(threadEl), {
            kind: "thread",
            id: String(threadId),
            label: "Thread color"
          });
        }
      }
      function buildDomSignature() {
        const nav = sidebarNavRoot();
        if (!nav) return "";
        const parts = [];
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]"
        )) {
          if (el.hasAttribute("data-app-action-sidebar-project-id")) {
            parts.push(`p:${el.getAttribute("data-app-action-sidebar-project-id")}`);
          } else {
            parts.push(`t:${el.getAttribute("data-app-action-sidebar-thread-id")}`);
          }
        }
        parts.push(`s:${JSON.stringify(settings)}`);
        return parts.join("|");
      }
      function applySidebarColors() {
        if (disposed) return false;
        ensureStyles();
        const nav = sidebarNavRoot();
        if (!nav) return false;
        const signature = buildDomSignature();
        if (signature === lastAppliedSignature) return false;
        lastAppliedSignature = signature;
        clearColorDecorations();
        for (const threadEl of nav.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
          const threadId = threadEl.getAttribute("data-app-action-sidebar-thread-id");
          if (!threadId) continue;
          const manual = manualThreadColor(threadId);
          if (manual) {
            applyColorToRow(threadColorTarget(threadEl), manual, "thread");
          }
        }
        const entries = iterateSidebarEntries(nav);
        const groups = projectGroupsFromEntries(entries);
        if (usesProjectGroups()) {
          for (const group of groups) {
            const color = resolveProjectColorValue(group.projectId);
            if (!color) continue;
            const groupRows = [];
            const projectTarget = projectColorTarget(group.projectEl);
            if (projectTarget) groupRows.push({ row: projectTarget, kind: "project" });
            for (const thread of group.threads) {
              if (manualThreadColor(thread.threadId)) continue;
              const row = threadColorTarget(thread.el);
              if (row) groupRows.push({ row, kind: "thread" });
            }
            if (groupRows.length === 0) continue;
            groupRows.forEach((item, index) => {
              const groupPos = groupRows.length === 1 ? "only" : index === 0 ? "first" : index === groupRows.length - 1 ? "last" : "middle";
              applyColorToRow(item.row, color, item.kind, { groupPos });
            });
          }
        } else {
          if (colorsProjects()) {
            for (const projectEl of nav.querySelectorAll("[data-app-action-sidebar-project-id]")) {
              const projectId = projectIdFromElement(projectEl);
              if (!projectId) continue;
              applyColorToRow(
                projectColorTarget(projectEl),
                resolveProjectColor(projectId),
                "project"
              );
            }
          }
          if (colorTargetMode() === "threads") {
            for (const threadEl of nav.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
              const threadId = threadEl.getAttribute("data-app-action-sidebar-thread-id");
              if (!threadId || manualThreadColor(threadId)) continue;
              const projectId = projectIdForThreadRow(threadEl);
              const color = resolveInheritedThreadColor(threadId, projectId);
              if (!color) continue;
              applyColorToRow(threadColorTarget(threadEl), color, "thread");
            }
          }
        }
        syncPickerButtons(nav);
        return true;
      }
      function scheduleReconcile() {
        if (disposed) return;
        if (reconcileTimer != null) global.clearTimeout(reconcileTimer);
        reconcileTimer = global.setTimeout(() => {
          reconcileTimer = null;
          applySidebarColors();
        }, RECONCILE_DEBOUNCE_MS);
      }
      function bindSidebarObserver() {
        sidebarObserver?.disconnect();
        sidebarObserver = null;
        const nav = sidebarNavRoot();
        if (!nav) return;
        sidebarObserver = new MutationObserver(() => {
          lastAppliedSignature = "";
          scheduleReconcile();
        });
        sidebarObserver.observe(nav, { childList: true, subtree: true });
      }
      function closePicker() {
        activePicker?.remove();
        activePicker = null;
      }
      function swatchButton(color, {
        active = false,
        label
      } = {}) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.title = label ?? color;
        btn.setAttribute("aria-label", label ?? color);
        btn.style.cssText = [
          "width:22px",
          "height:22px",
          "border-radius:6px",
          "border:2px solid",
          active ? "color-mix(in srgb, currentColor 55%, transparent)" : "transparent",
          `background:${color}`,
          "cursor:pointer",
          "padding:0"
        ].join(";");
        return btn;
      }
      function openColorPicker(anchor, target) {
        closePicker();
        const backdrop = document.createElement("div");
        backdrop.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:transparent";
        backdrop.addEventListener("pointerdown", (event) => {
          if (event.target === backdrop) closePicker();
        });
        const panel = document.createElement("div");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", `${target.label} color`);
        panel.style.cssText = "position:fixed;z-index:2147483647;min-width:180px;padding:10px;border-radius:10px;border:1px solid color-mix(in srgb, currentColor 14%, transparent);background:var(--color-bg-primary,#111);color:inherit;box-shadow:0 12px 32px color-mix(in srgb,#000 45%,transparent);font:12px/1.4 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:8px";
        const title = document.createElement("div");
        title.textContent = target.label;
        title.style.cssText = "font-weight:600;font-size:13px";
        panel.appendChild(title);
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(6,22px);gap:6px";
        const overrides = target.kind === "project" ? settings.projectOverrides : settings.threadOverrides;
        const manual = overrides[target.id] ?? null;
        const current = target.kind === "project" ? resolveProjectColorValue(target.id) : manualThreadColor(target.id);
        for (const color of palette()) {
          const btn = swatchButton(color, {
            active: manual === color,
            label: `Set color ${color}`
          });
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            overrides[target.id] = color;
            saveSettings();
            lastAppliedSignature = "";
            applySidebarColors();
            closePicker();
          });
          grid.appendChild(btn);
        }
        panel.appendChild(grid);
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
        if (target.kind === "project" && settings.autoAssignProjects) {
          const autoBtn = c.button({
            label: manual ? "Use auto" : "Use auto \u2713",
            color: "ghost",
            size: "composerSm",
            onClick: () => {
              delete settings.projectOverrides[target.id];
              saveSettings();
              lastAppliedSignature = "";
              applySidebarColors();
              closePicker();
            }
          });
          autoBtn.style.fontSize = "11px";
          actions.appendChild(autoBtn);
        }
        const clearBtn = c.button({
          label: "No color",
          color: "ghost",
          size: "composerSm",
          onClick: () => {
            delete overrides[target.id];
            saveSettings();
            lastAppliedSignature = "";
            applySidebarColors();
            closePicker();
          }
        });
        clearBtn.style.fontSize = "11px";
        actions.appendChild(clearBtn);
        panel.appendChild(actions);
        if (current) {
          const preview = document.createElement("div");
          preview.style.cssText = "display:flex;align-items:center;gap:8px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 55%,transparent))";
          const dot = document.createElement("span");
          dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${current}`;
          preview.appendChild(dot);
          const label = document.createElement("span");
          label.textContent = manual ? `Custom ${current}` : target.kind === "thread" ? current : `Auto ${current}`;
          preview.appendChild(label);
          panel.appendChild(preview);
        }
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        activePicker = backdrop;
        const rect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const margin = 8;
        let top = rect.bottom + 6;
        let left = rect.left;
        if (left + panelRect.width > global.innerWidth - margin) {
          left = global.innerWidth - panelRect.width - margin;
        }
        if (top + panelRect.height > global.innerHeight - margin) {
          top = rect.top - panelRect.height - 6;
        }
        panel.style.top = `${Math.max(margin, top)}px`;
        panel.style.left = `${Math.max(margin, left)}px`;
      }
      function onKeyDown(event) {
        if (event.key === "Escape" && activePicker) {
          event.preventDefault();
          closePicker();
        }
      }
      function targetHint() {
        switch (settings.visuals.colorTarget) {
          case "threads":
            return "Thread rows inherit their project color. Custom thread colors always show.";
          case "both":
            return "Project + threads as one grouped block. Custom thread colors always override.";
          default:
            return "Project folder headers only. Custom thread colors always show.";
        }
      }
      function renderOptionsPanel(container, { refresh }) {
        container.replaceChildren();
        const body = document.createElement("div");
        body.style.cssText = "display:flex;flex-direction:column;gap:12px";
        const styleGroup = c.section({
          title: "Visual style",
          hint: usesProjectGroups() ? "Both mode groups project + threads into one block." : "How the color appears on each sidebar row."
        });
        styleGroup.body.appendChild(
          c.radioField({
            label: "Side accent",
            name: "explodex-pfc-style",
            value: "side",
            checked: settings.visuals.style === "side",
            onChange: () => {
              settings.visuals.style = "side";
              saveSettings();
              lastAppliedSignature = "";
              applySidebarColors();
              refresh();
            }
          })
        );
        styleGroup.body.appendChild(
          c.radioField({
            label: "Full-width tint",
            name: "explodex-pfc-style",
            value: "full",
            checked: settings.visuals.style === "full",
            onChange: () => {
              settings.visuals.style = "full";
              saveSettings();
              lastAppliedSignature = "";
              applySidebarColors();
              refresh();
            }
          })
        );
        body.appendChild(styleGroup.el);
        const targetGroup = c.section({ title: "What to color", hint: targetHint() });
        for (const [label, value] of [
          ["Project folders", "projects"],
          ["Threads", "threads"],
          ["Both", "both"]
        ]) {
          targetGroup.body.appendChild(
            c.radioField({
              label,
              name: "explodex-pfc-target",
              value,
              checked: settings.visuals.colorTarget === value,
              onChange: () => {
                settings.visuals.colorTarget = value;
                saveSettings();
                lastAppliedSignature = "";
                applySidebarColors();
                refresh();
              }
            })
          );
        }
        body.appendChild(targetGroup.el);
        const colorsGroup = c.section({
          title: "Picker colors",
          hint: `Swatches in the hover picker (${MIN_PALETTE_SIZE} minimum).`
        });
        colorsGroup.body.appendChild(
          c.checkboxField({
            label: "Auto-assign project colors",
            checked: settings.autoAssignProjects,
            onChange: (value) => {
              settings.autoAssignProjects = value;
              saveSettings();
              lastAppliedSignature = "";
              applySidebarColors();
              refresh();
            }
          })
        );
        const swatches = document.createElement("div");
        swatches.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
        function paintPaletteEditor() {
          swatches.replaceChildren();
          for (const color of settings.palette) {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px";
            wrap.appendChild(swatchButton(color, { label: color }));
            if (settings.palette.length > MIN_PALETTE_SIZE) {
              const remove = c.button({
                label: "\xD7",
                color: "ghost",
                size: "iconSm",
                onClick: () => {
                  settings.palette = settings.palette.filter((entry) => entry !== color);
                  saveSettings();
                  paintPaletteEditor();
                  lastAppliedSignature = "";
                  applySidebarColors();
                }
              });
              wrap.appendChild(remove);
            }
            swatches.appendChild(wrap);
          }
        }
        paintPaletteEditor();
        colorsGroup.body.appendChild(swatches);
        const addRow = document.createElement("div");
        addRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.value = "#61AFEF";
        colorInput.style.cssText = "width:36px;height:28px;border:0;padding:0;background:transparent";
        const hexInput = document.createElement("input");
        hexInput.type = "text";
        hexInput.placeholder = "#61AFEF";
        hexInput.style.cssText = "width:88px;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit";
        addRow.appendChild(colorInput);
        addRow.appendChild(hexInput);
        addRow.appendChild(
          c.button({
            label: "Add color",
            color: "secondary",
            size: "composerSm",
            onClick: () => {
              const color = normalizeHexColor(hexInput.value || colorInput.value);
              if (!color) {
                c.statusToast("Enter a valid hex color");
                return;
              }
              if (!settings.palette.includes(color)) {
                settings.palette.push(color);
                saveSettings();
                paintPaletteEditor();
                lastAppliedSignature = "";
                applySidebarColors();
              }
            }
          })
        );
        colorsGroup.body.appendChild(addRow);
        body.appendChild(colorsGroup.el);
        const reset = c.button({
          label: "Reset all custom colors",
          color: "ghost",
          size: "composerSm",
          onClick: () => {
            settings.projectOverrides = {};
            settings.threadOverrides = {};
            saveSettings();
            lastAppliedSignature = "";
            applySidebarColors();
            refresh();
            c.statusToast("Custom colors cleared");
          }
        });
        body.appendChild(reset);
        container.appendChild(body);
      }
      registerOptions({
        render: renderOptionsPanel
      });
      loadSettings();
      ensureStyles();
      bindSidebarObserver();
      applySidebarColors();
      global.addEventListener("keydown", onKeyDown, true);
      unsubscribeSidebar = inject.observeZone("sidebar", () => {
        bindSidebarObserver();
        lastAppliedSignature = "";
        scheduleReconcile();
      });
      log.info("project folder colors attached");
      return () => {
        disposed = true;
        log.info("teardown");
        closePicker();
        if (reconcileTimer != null) global.clearTimeout(reconcileTimer);
        sidebarObserver?.disconnect();
        unsubscribeSidebar?.();
        global.removeEventListener("keydown", onKeyDown, true);
        clearColorDecorations();
        clearPickerButtons();
        styleElement?.remove();
        styleElement = null;
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
    register("project-colors", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
