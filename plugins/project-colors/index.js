// @ts-check
/// <reference path="../../sdk/explodex-sdk.d.ts" />
/**
 * Explodex plugin: Project Colors
 *
 * Color-code project folders and threads in the sidebar. Hover a row to reveal
 * the color picker on the left. Options live on the Explodex settings page.
 */
(function registerProjectColors(global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) {
    console.warn("[project-colors] Explodex SDK not loaded");
    return;
  }

  const PLUGIN_ID = "project-colors";
  const STORAGE_KEY = "explodex-project-colors";
  const STYLE_ID = "explodex-project-colors-styles";
  const RECONCILE_DEBOUNCE_MS = 120;
  const MIN_PALETTE_SIZE = 5;

  /** @type {readonly string[]} */
  const DEFAULT_PALETTE = [
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
    "#4DB6AC",
  ];

  /** @typedef {'projects' | 'threads' | 'both'} ColorTarget */
  /** @typedef {{ version: number, palette: string[], autoAssignProjects: boolean, visuals: { style: 'side' | 'full', colorTarget: ColorTarget }, projectOverrides: Record<string, string>, threadOverrides: Record<string, string> }} ColorSettings */

  Explodex.plugins.register(
    {
      id: PLUGIN_ID,
      name: "Project Colors",
      version: "1.5.0",
      description:
        "Color-code project folders and threads in the sidebar. Hover rows for the color picker.",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { storage, log, inject, components: c, registerOptions } = api;

      /** @type {ColorSettings} */
      let settings = defaultSettings();

      let disposed = false;
      let sidebarObserver = null;
      let unsubscribeSidebar = null;
      let reconcileTimer = null;
      let lastAppliedSignature = "";
      /** @type {HTMLElement | null} */
      let activePicker = null;

      function defaultSettings() {
        return {
          version: 2,
          palette: [...DEFAULT_PALETTE],
          autoAssignProjects: true,
          visuals: {
            style: "side",
            colorTarget: "projects",
          },
          projectOverrides: {},
          threadOverrides: {},
        };
      }

      function normalizeHexColor(value) {
        if (typeof value !== "string") return null;
        const raw = value.trim();
        if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return null;
        if (raw.length === 4) {
          const [, r, g, b] = raw;
          return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
        }
        return raw.toUpperCase();
      }

      function normalizePalette(values) {
        if (!Array.isArray(values)) return [...DEFAULT_PALETTE];
        const out = [];
        for (const entry of values) {
          const color = normalizeHexColor(entry);
          if (color && !out.includes(color)) out.push(color);
        }
        return out.length >= MIN_PALETTE_SIZE ? out : [...DEFAULT_PALETTE];
      }

      function normalizeColorTarget(value) {
        if (value === "projects" || value === "threads" || value === "both") return value;
        return "projects";
      }

      function migrateSettings(raw) {
        if (!raw || typeof raw !== "object") return defaultSettings();

        const projectOverrides =
          raw.projectOverrides && typeof raw.projectOverrides === "object"
            ? { ...raw.projectOverrides }
            : raw.overrides && typeof raw.overrides === "object"
              ? { ...raw.overrides }
              : {};

        const threadOverrides =
          raw.threadOverrides && typeof raw.threadOverrides === "object"
            ? { ...raw.threadOverrides }
            : {};

        const visuals = raw.visuals && typeof raw.visuals === "object" ? raw.visuals : {};
        let colorTarget = normalizeColorTarget(visuals.colorTarget);
        if (visuals.colorTarget == null) {
          if (visuals.colorThreadsInProject === true || raw.colorThreads === true) {
            colorTarget = "both";
          }
        }

        return {
          version: 2,
          palette: normalizePalette(raw.palette),
          autoAssignProjects:
            raw.autoAssignProjects != null
              ? raw.autoAssignProjects !== false
              : raw.autoAssign !== false,
          visuals: {
            style: visuals.style === "full" ? "full" : "side",
            colorTarget,
          },
          projectOverrides,
          threadOverrides,
        };
      }

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
        settings = migrateSettings(storage.persisted.get(STORAGE_KEY, null));
      }

      function saveSettings() {
        settings.palette = normalizePalette(settings.palette);
        storage.persisted.set(STORAGE_KEY, settings);
      }

      function palette() {
        return normalizePalette(settings.palette);
      }

      function hashString(value) {
        let hash = 0;
        for (let i = 0; i < value.length; i += 1) {
          hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
        }
        return hash;
      }

      function autoColorForId(id) {
        const colors = palette();
        return colors[hashString(id) % colors.length];
      }

      function autoColorForProject(projectId) {
        return autoColorForId(projectId);
      }

      function resolveProjectColorValue(projectId) {
        const override = settings.projectOverrides[projectId];
        if (override) return override;
        if (!settings.autoAssignProjects) return null;
        return autoColorForProject(projectId);
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

      /** @returns {Array<{ type: 'project' | 'thread', projectId: string | null, threadId: string | null, el: Element }>} */
      function iterateSidebarEntries(nav) {
        /** @type {Array<{ type: 'project' | 'thread', projectId: string | null, threadId: string | null, el: Element }>} */
        const entries = [];
        let currentProjectId = null;
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]",
        )) {
          if (el.hasAttribute("data-app-action-sidebar-project-id")) {
            currentProjectId = el.getAttribute("data-app-action-sidebar-project-id");
            entries.push({
              type: "project",
              projectId: currentProjectId,
              threadId: null,
              el,
            });
            continue;
          }
          entries.push({
            type: "thread",
            projectId: currentProjectId,
            threadId: el.getAttribute("data-app-action-sidebar-thread-id"),
            el,
          });
        }
        return entries;
      }

      /** @param {ReturnType<typeof iterateSidebarEntries>} entries */
      function projectGroupsFromEntries(entries) {
        /** @type {Array<{ projectId: string, projectEl: Element, threads: Array<{ threadId: string, el: Element }> }>} */
        const groups = [];
        /** @type {{ projectId: string, projectEl: Element, threads: Array<{ threadId: string, el: Element }> } | null} */
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
        return (
          threadEl.closest?.("[data-app-action-sidebar-thread-row]") ??
          threadEl.closest?.("[data-app-action-sidebar-thread-id]") ??
          sidebarListItem(threadEl) ??
          threadEl
        );
      }

      function sidebarNavRoot() {
        return (
          document.querySelector('nav[aria-label*="Scheduled task" i]') ??
          document.querySelector('nav[aria-label*="Automation folders" i]') ??
          document.querySelector("nav.sidebar-foreground-muted") ??
          document.querySelector("nav")
        );
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
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]",
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
        let style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement("style");
          style.id = STYLE_ID;
          document.head.appendChild(style);
        }
        const next = buildStyleText();
        if (style.textContent !== next) style.textContent = next;
      }

      function clearColorDecorations() {
        for (const el of document.querySelectorAll("[data-explodex-colored]")) {
          el.removeAttribute("data-explodex-colored");
          el.removeAttribute("data-explodex-kind");
          el.removeAttribute("data-explodex-group-pos");
          el.style.removeProperty("--explodex-row-color");
        }
      }

      function clearPickerButtons() {
        for (const el of document.querySelectorAll("[data-explodex-color-picker]")) {
          el.remove();
        }
        for (const el of document.querySelectorAll("[data-explodex-picker-host]")) {
          el.removeAttribute("data-explodex-picker-host");
        }
      }

      /**
       * @param {HTMLElement | null} row
       * @param {string | null} color
       * @param {'project' | 'thread'} kind
       * @param {{ groupPos?: 'first' | 'middle' | 'last' | 'only' }} [options]
       */
      function applyColorToRow(row, color, kind, options = {}) {
        if (!row) return;
        if (!color) {
          row.removeAttribute("data-explodex-colored");
          row.removeAttribute("data-explodex-kind");
          row.removeAttribute("data-explodex-group-pos");
          row.style.removeProperty("--explodex-row-color");
          return;
        }
        row.style.setProperty("--explodex-row-color", color);
        row.setAttribute("data-explodex-colored", "true");
        row.setAttribute("data-explodex-kind", kind);
        if (options.groupPos) {
          row.setAttribute("data-explodex-group-pos", options.groupPos);
        } else {
          row.removeAttribute("data-explodex-group-pos");
        }
      }

      /**
       * @param {HTMLElement} host
       * @param {{ kind: 'project' | 'thread', id: string, label: string }} target
       */
      function ensurePickerButton(host, target) {
        if (!host?.isConnected) return;
        if (host.querySelector("[data-explodex-color-picker]")) return;

        host.setAttribute("data-explodex-picker-host", "true");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-explodex-color-picker", "true");
        btn.setAttribute("data-explodex-picker-kind", target.kind);
        btn.setAttribute("data-explodex-picker-id", target.id);
        btn.setAttribute("aria-label", target.label);
        btn.title = target.label;
        btn.textContent = "◍";
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
            label: "Project color",
          });
        }
        for (const threadEl of nav.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
          const threadId = threadEl.getAttribute("data-app-action-sidebar-thread-id");
          if (!threadId) continue;
          ensurePickerButton(threadColorTarget(threadEl), {
            kind: "thread",
            id: String(threadId),
            label: "Thread color",
          });
        }
      }

      function buildDomSignature() {
        const nav = sidebarNavRoot();
        if (!nav) return "";
        const parts = [];
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]",
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

            /** @type {Array<{ row: HTMLElement, kind: 'project' | 'thread' }>} */
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
              const groupPos =
                groupRows.length === 1
                  ? "only"
                  : index === 0
                    ? "first"
                    : index === groupRows.length - 1
                      ? "last"
                      : "middle";
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
                "project",
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

      function swatchButton(color, { active = false, label } = {}) {
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
          "padding:0",
        ].join(";");
        return btn;
      }

      /**
       * @param {HTMLElement} anchor
       * @param {{ kind: 'project' | 'thread', id: string, label: string }} target
       */
      function openColorPicker(anchor, target) {
        closePicker();
        const backdrop = document.createElement("div");
        backdrop.style.cssText =
          "position:fixed;inset:0;z-index:2147483646;background:transparent";
        backdrop.addEventListener("pointerdown", (event) => {
          if (event.target === backdrop) closePicker();
        });

        const panel = document.createElement("div");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", `${target.label} color`);
        panel.style.cssText =
          "position:fixed;z-index:2147483647;min-width:180px;padding:10px;border-radius:10px;" +
          "border:1px solid color-mix(in srgb, currentColor 14%, transparent);" +
          "background:var(--color-bg-primary,#111);color:inherit;" +
          "box-shadow:0 12px 32px color-mix(in srgb,#000 45%,transparent);" +
          "font:12px/1.4 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:8px";

        const title = document.createElement("div");
        title.textContent = target.label;
        title.style.cssText = "font-weight:600;font-size:13px";
        panel.appendChild(title);

        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(6,22px);gap:6px";

        const overrides =
          target.kind === "project" ? settings.projectOverrides : settings.threadOverrides;
        const manual = overrides[target.id] ?? null;
        const current =
          target.kind === "project"
            ? resolveProjectColorValue(target.id)
            : manualThreadColor(target.id);

        for (const color of palette()) {
          const btn = swatchButton(color, {
            active: manual === color,
            label: `Set color ${color}`,
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
            label: manual ? "Use auto" : "Use auto ✓",
            color: "ghost",
            size: "composerSm",
            onClick: () => {
              delete settings.projectOverrides[target.id];
              saveSettings();
              lastAppliedSignature = "";
              applySidebarColors();
              closePicker();
            },
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
          },
        });
        clearBtn.style.fontSize = "11px";
        actions.appendChild(clearBtn);
        panel.appendChild(actions);

        if (current) {
          const preview = document.createElement("div");
          preview.style.cssText =
            "display:flex;align-items:center;gap:8px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 55%,transparent))";
          const dot = document.createElement("span");
          dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${current}`;
          preview.appendChild(dot);
          const label = document.createElement("span");
          label.textContent = manual
            ? `Custom ${current}`
            : target.kind === "thread"
              ? current
              : `Auto ${current}`;
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
          hint: usesProjectGroups()
            ? "Both mode groups project + threads into one block."
            : "How the color appears on each sidebar row.",
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
            },
          }),
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
            },
          }),
        );
        body.appendChild(styleGroup.el);

        const targetGroup = c.section({ title: "What to color", hint: targetHint() });
        for (const [label, value] of [
          ["Project folders", "projects"],
          ["Threads", "threads"],
          ["Both", "both"],
        ]) {
          targetGroup.body.appendChild(
            c.radioField({
              label,
              name: "explodex-pfc-target",
              value,
              checked: settings.visuals.colorTarget === value,
              onChange: () => {
                settings.visuals.colorTarget = /** @type {ColorTarget} */ (value);
                saveSettings();
                lastAppliedSignature = "";
                applySidebarColors();
                refresh();
              },
            }),
          );
        }
        body.appendChild(targetGroup.el);

        const colorsGroup = c.section({
          title: "Picker colors",
          hint: `Swatches in the hover picker (${MIN_PALETTE_SIZE} minimum).`,
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
            },
          }),
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
                label: "×",
                color: "ghost",
                size: "iconSm",
                onClick: () => {
                  settings.palette = settings.palette.filter((entry) => entry !== color);
                  saveSettings();
                  paintPaletteEditor();
                  lastAppliedSignature = "";
                  applySidebarColors();
                },
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
        hexInput.style.cssText =
          "width:88px;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit";
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
            },
          }),
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
          },
        });
        body.appendChild(reset);

        container.appendChild(body);
      }

      registerOptions({
        render: renderOptionsPanel,
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
        document.getElementById(STYLE_ID)?.remove();
      };
    },
  );
})(window);