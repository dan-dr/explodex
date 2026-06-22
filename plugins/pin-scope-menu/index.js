/**
 * Explodex plugin: Pin scope menu (Global / Project)
 *
 * When a thread belongs to a project, intercept pin buttons and offer
 * "Global" (native pin) vs "Project" (pin within the project sidebar group).
 * Outside a project, pin behavior is unchanged.
 */
(function registerPinScopeMenu(global) {
  const BC = global.Explodex;
  if (!BC?.plugins?.register) {
    console.warn("[pin-scope-menu] Explodex SDK not loaded");
    return;
  }

  const PROJECT_PINS_KEY = "explodex-project-pinned-threads";
  const RECONCILE_DEBOUNCE_MS = 250;
  const GLOBAL_STATE_KEYS = {
    assignments: "thread-project-assignments",
    projectOrders: "sidebar-project-thread-orders",
    projectPins: PROJECT_PINS_KEY,
    projectless: "projectless-thread-ids",
  };

  const PIN_LABEL_RE = /^(pin|unpin)\s+(chat|conversation)/i;
  const SHOW_MORE_LESS_RE = /show\s+(more|less)/i;

  const CONVERSATION_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LOCAL_THREAD_KEY_RE =
    /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

  BC.plugins.register(
    {
      id: "pin-scope-menu",
      name: "Pin Scope Menu",
      version: "1.2.3",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { bridge, storage, components: c, log, inject } = api;

      let menuOpen = false;
      let activeMenu = null;
      let allowNativePin = false;
      let suppressNextPinClick = false;
      let reconcileTimer = null;
      let sidebarObserver = null;
      let unsubscribeSidebar = null;
      let reconcileInFlight = false;
      let pinStylesInstalled = false;
      let pinsCache = {};
      let pinsHydrated = false;
      let pinsHydratePromise = null;
      let disposed = false;

      function normalizeConversationId(value) {
        if (value == null) return null;
        const id = String(value).trim();
        if (!id || id === "undefined" || id === "null") return null;
        if (CONVERSATION_ID_RE.test(id)) return id;
        const localMatch = id.match(LOCAL_THREAD_KEY_RE);
        return localMatch ? localMatch[1] : null;
      }

      function conversationIdFromPath(pathname) {
        const patterns = [
          /\/local\/([^/]+)/,
          /\/thread\/([^/]+)/,
          /\/hotkey-window\/thread\/([^/]+)/,
        ];
        for (const pattern of patterns) {
          const match = pathname.match(pattern);
          const id = normalizeConversationId(match?.[1] ? decodeURIComponent(match[1]) : null);
          if (id) return id;
        }
        return null;
      }

      function conversationIdFromPortals() {
        const portals = [
          ...document.querySelectorAll("[data-above-composer-portal]"),
          ...document.querySelectorAll("[data-above-composer-queue-portal]"),
          ...document.querySelectorAll("[data-above-composer-conversation-id]"),
        ];
        for (const portal of portals) {
          const id = normalizeConversationId(
            portal.getAttribute("data-above-composer-conversation-id"),
          );
          if (id) return id;
        }
        return null;
      }

      function getActiveConversationId() {
        const fromPortal = conversationIdFromPortals();
        if (fromPortal) return fromPortal;
        return conversationIdFromPath(global.location?.pathname ?? "");
      }

      function localThreadKey(conversationId) {
        return `local:${conversationId}`;
      }

      function normalizeProjectPinsMap(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
      }

      function readPersistedProjectPins() {
        const raw = storage.persisted.get(PROJECT_PINS_KEY, null);
        return normalizeProjectPinsMap(raw);
      }

      function readProjectPins() {
        return { ...pinsCache };
      }

      async function hydrateProjectPins() {
        if (pinsHydrated) return pinsCache;
        if (pinsHydratePromise) return pinsHydratePromise;

        pinsHydratePromise = (async () => {
          if (Object.keys(pinsCache).length === 0) {
            pinsCache = readPersistedProjectPins();
          }

          if (!bridge.isAvailable()) return pinsCache;

          try {
            const fromGlobal = normalizeProjectPinsMap(
              await storage.globalState.get(GLOBAL_STATE_KEYS.projectPins),
            );
            if (Object.keys(fromGlobal).length > 0) {
              pinsCache = fromGlobal;
            } else if (Object.keys(pinsCache).length > 0) {
              await storage.globalState.set(GLOBAL_STATE_KEYS.projectPins, pinsCache);
              storage.persisted.remove(PROJECT_PINS_KEY);
              log.debug("migrated project pins to global state");
            }
          } catch (err) {
            log.warn("project pin hydrate failed", err);
          } finally {
            pinsHydrated = true;
            pinsHydratePromise = null;
          }

          return pinsCache;
        })();

        return pinsHydratePromise;
      }

      async function writeProjectPins(map) {
        pinsCache = normalizeProjectPinsMap(map);
        pinsHydrated = true;

        if (!bridge.isAvailable()) {
          storage.persisted.set(PROJECT_PINS_KEY, pinsCache);
          return;
        }

        await storage.globalState.set(GLOBAL_STATE_KEYS.projectPins, pinsCache);
        storage.persisted.remove(PROJECT_PINS_KEY);
      }

      function isProjectPinned(conversationId) {
        return Object.prototype.hasOwnProperty.call(readProjectPins(), conversationId);
      }

      function projectIdForPinned(conversationId) {
        return readProjectPins()[conversationId] ?? null;
      }

      function normalizeProjectId(value) {
        if (value == null) return null;
        const id = String(value).trim();
        return id && id !== "null" && id !== "undefined" ? id : null;
      }

      function reactFiber(node) {
        if (!node || typeof node !== "object") return null;
        const key = Object.keys(node).find((name) => name.startsWith("__reactFiber"));
        return key ? node[key] : null;
      }

      function projectIdFromFiber(node) {
        let fiber = reactFiber(node);
        for (let depth = 0; depth < 32 && fiber; depth += 1) {
          const props = fiber.memoizedProps;
          const projectId = normalizeProjectId(props?.hoverCardProjectId);
          if (projectId) return projectId;
          fiber = fiber.return;
        }
        return null;
      }

      function sidebarThreadRow(node) {
        return node?.closest?.("[data-app-action-sidebar-thread-id]") ?? null;
      }

      function conversationIdFromThreadRow(row) {
        if (!row) return null;
        return normalizeConversationId(row.getAttribute("data-app-action-sidebar-thread-id"));
      }

      function sidebarNavRoot() {
        return (
          document.querySelector('nav[aria-label="Automation folders"]') ??
          document.querySelector("nav")
        );
      }

      function projectIdFromDomScan(threadKey) {
        if (!threadKey) return null;
        const nav = sidebarNavRoot();
        if (!nav) return null;

        let currentProject = null;
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]",
        )) {
          if (el.hasAttribute("data-app-action-sidebar-project-id")) {
            currentProject = el.getAttribute("data-app-action-sidebar-project-id");
            continue;
          }
          if (el.getAttribute("data-app-action-sidebar-thread-id") === threadKey) {
            return normalizeProjectId(currentProject);
          }
        }
        return null;
      }

      function resolvePinContext(pinButton) {
        const row = sidebarThreadRow(pinButton);
        const conversationId = row
          ? conversationIdFromThreadRow(row)
          : getActiveConversationId();
        if (!conversationId) return null;

        const threadKey = localThreadKey(conversationId);
        const projectId =
          projectIdFromFiber(row ?? pinButton) ??
          projectIdFromDomScan(threadKey);

        const globalPinned = row
          ? row.getAttribute("data-app-action-sidebar-thread-pinned") === "true"
          : null;

        return {
          pinButton,
          conversationId,
          threadKey,
          projectId,
          globalPinned,
          projectPinned:
            isProjectPinned(conversationId) &&
            projectIdForPinned(conversationId) === projectId,
        };
      }

      function normalizeAssignments(value) {
        if (!value || typeof value !== "object") return {};
        return value;
      }

      function projectIdFromAssignment(assignment) {
        if (assignment == null) return null;
        if (typeof assignment === "string") return assignment.trim() || null;
        if (typeof assignment !== "object") return null;
        if (assignment.projectId != null) return String(assignment.projectId);
        if (assignment.project_id != null) return String(assignment.project_id);
        if (assignment.id != null && assignment.kind != null) return String(assignment.id);
        return null;
      }

      async function getProjectlessSet() {
        const res = await bridge.rpc("get-global-state", {
          params: { key: GLOBAL_STATE_KEYS.projectless },
        });
        const ids = res?.value;
        return Array.isArray(ids) ? new Set(ids) : new Set();
      }

      async function getProjectIdForThread(threadKey, conversationId) {
        const projectless = await getProjectlessSet();
        if (projectless.has(threadKey) || projectless.has(conversationId)) return null;

        const res = await bridge.rpc("get-global-state", {
          params: { key: GLOBAL_STATE_KEYS.assignments },
        });
        const assignments = normalizeAssignments(res?.value);
        return (
          projectIdFromAssignment(assignments[threadKey]) ??
          projectIdFromAssignment(assignments[conversationId])
        );
      }

      async function listGloballyPinnedIds() {
        const res = await bridge.rpc("list-pinned-threads", { params: {} });
        const ids = res?.threadIds;
        return Array.isArray(ids) ? ids : [];
      }

      async function isGloballyPinned(threadKey, knownPinned = null) {
        if (knownPinned != null) return knownPinned;
        const ids = await listGloballyPinnedIds();
        return ids.includes(threadKey);
      }

      async function setGlobalPin(threadKey, pinned) {
        await bridge.rpc("set-thread-pinned", {
          params: { threadId: threadKey, pinned },
        });
      }

      async function readProjectOrders() {
        const res = await bridge.rpc("get-global-state", {
          params: { key: GLOBAL_STATE_KEYS.projectOrders },
        });
        const value = res?.value;
        return value && typeof value === "object" ? { ...value } : {};
      }

      async function writeProjectOrders(orders) {
        await storage.globalState.set(GLOBAL_STATE_KEYS.projectOrders, orders);
        applySidebarDomReorder(orders);
      }

      const PIN_SCOPE_STYLE_TEXT =
        'nav [data-app-action-sidebar-thread-pinned="true"] button[aria-label="Unpin chat"],' +
        'nav [data-explodex-project-pinned="true"] button[aria-label="Pin chat"]{' +
        "opacity:1!important;color:var(--color-text-primary,#fff)!important}" +
        'nav [data-explodex-project-pinned="true"] button[aria-label="Pin chat"] svg path{' +
        "fill:currentColor!important}";

      function ensurePinScopeStyles() {
        pinStylesInstalled = true;
        let style = document.getElementById("explodex-pin-scope-styles");
        if (!style) {
          style = document.createElement("style");
          style.id = "explodex-pin-scope-styles";
          document.head.appendChild(style);
        }
        if (style.textContent !== PIN_SCOPE_STYLE_TEXT) style.textContent = PIN_SCOPE_STYLE_TEXT;
      }

      function isThreadProjectPinned(threadKey) {
        const conversationId = normalizeConversationId(
          threadKey?.startsWith("local:") ? threadKey.slice("local:".length) : threadKey,
        );
        if (!conversationId || !isProjectPinned(conversationId)) return false;
        const assignedProject = normalizeProjectId(projectIdForPinned(conversationId));
        const sidebarProject = projectIdFromDomScan(threadKey);
        if (!assignedProject || !sidebarProject) return true;
        return assignedProject === sidebarProject;
      }

      function syncProjectPinVisuals() {
        ensurePinScopeStyles();
        let changed = false;
        for (const el of document.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
          const threadKey = el.getAttribute("data-app-action-sidebar-thread-id");
          if (!threadKey) continue;

          const shouldPin = isThreadProjectPinned(threadKey);
          const isMarked = el.getAttribute("data-explodex-project-pinned") === "true";
          if (shouldPin && !isMarked) {
            el.setAttribute("data-explodex-project-pinned", "true");
            changed = true;
          } else if (!shouldPin && isMarked) {
            el.removeAttribute("data-explodex-project-pinned");
            changed = true;
          }
        }
        return changed;
      }

      function projectShowMoreLessToggle(projectId) {
        const nav = sidebarNavRoot();
        if (!nav) return null;

        let currentProject = null;
        for (const listItem of nav.querySelectorAll('[role="listitem"]')) {
          const projectEl = listItem.querySelector("[data-app-action-sidebar-project-id]");
          if (projectEl) {
            if (currentProject === projectId) break;
            currentProject = projectEl.getAttribute("data-app-action-sidebar-project-id");
            continue;
          }
          if (currentProject !== projectId) continue;
          const label = listItem.querySelector("button")?.textContent ?? "";
          if (SHOW_MORE_LESS_RE.test(label)) return listItem;
        }
        return null;
      }

      function projectSidebarListItems(projectId) {
        const nav = sidebarNavRoot();
        if (!nav) return [];

        let currentProject = null;
        const items = [];
        for (const el of nav.querySelectorAll(
          "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]",
        )) {
          if (el.hasAttribute("data-app-action-sidebar-project-id")) {
            if (currentProject === projectId && items.length > 0) break;
            currentProject = el.getAttribute("data-app-action-sidebar-project-id");
            continue;
          }
          if (currentProject !== projectId) continue;
          const listItem = el.closest('[role="listitem"]');
          const threadId = el.getAttribute("data-app-action-sidebar-thread-id");
          if (!listItem || !threadId || items.some((entry) => entry.el === listItem)) continue;
          items.push({ threadId, el: listItem });
        }
        return items;
      }

      function reorderProjectThreadsInSidebar(projectId, threadIds) {
        if (!projectId || !Array.isArray(threadIds) || threadIds.length === 0) return false;
        const items = projectSidebarListItems(projectId);
        const list = items[0]?.el?.parentElement;
        if (!list) return false;

        const toggle = projectShowMoreLessToggle(projectId);
        const byId = new Map(items.map((entry) => [entry.threadId, entry.el]));
        const seen = new Set();
        const ordered = [];

        for (const threadId of threadIds) {
          const row = byId.get(threadId);
          if (!row) continue;
          ordered.push(row);
          seen.add(threadId);
        }
        for (const { threadId, el } of items) {
          if (!seen.has(threadId)) ordered.push(el);
        }

        const desiredOrder = ordered
          .map((row) =>
            row
              .querySelector("[data-app-action-sidebar-thread-id]")
              ?.getAttribute("data-app-action-sidebar-thread-id"),
          )
          .filter(Boolean);
        const currentOrder = items.map((entry) => entry.threadId);
        if (arraysEqual(currentOrder, desiredOrder)) return false;

        if (toggle) {
          let insertBefore = toggle;
          for (let index = ordered.length - 1; index >= 0; index -= 1) {
            const row = ordered[index];
            list.insertBefore(row, insertBefore);
            insertBefore = row;
          }
        } else {
          for (const row of ordered) list.appendChild(row);
        }
        return true;
      }

      function applySidebarDomReorder(orders, { deferred = false } = {}) {
        if (!orders || typeof orders !== "object") return false;
        let changed = false;
        for (const [projectId, order] of Object.entries(orders)) {
          const threadIds = Array.isArray(order?.threadIds) ? order.threadIds : null;
          if (!threadIds?.length) continue;
          if (reorderProjectThreadsInSidebar(projectId, threadIds)) changed = true;
        }
        if (syncProjectPinVisuals()) changed = true;
        if (changed && !deferred) {
          global.requestAnimationFrame(() => {
            if (disposed) return;
            applySidebarDomReorder(orders, { deferred: true });
          });
        }
        return changed;
      }

      function arraysEqual(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
      }

      function groupedPinnedThreadKeys(pins) {
        const groups = {};
        for (const [conversationId, projectId] of Object.entries(pins)) {
          const normalizedProjectId = normalizeProjectId(projectId);
          const normalizedConversationId = normalizeConversationId(conversationId);
          if (!normalizedProjectId || !normalizedConversationId) continue;
          const threadKey = localThreadKey(normalizedConversationId);
          groups[normalizedProjectId] ??= [];
          if (!groups[normalizedProjectId].includes(threadKey)) {
            groups[normalizedProjectId].push(threadKey);
          }
        }
        return groups;
      }

      function orderWithoutSortKey(order) {
        const next = order && typeof order === "object" ? { ...order } : {};
        delete next.sortKey;
        return next;
      }

      function applyProjectPinOrder(orders, pins) {
        const groups = groupedPinnedThreadKeys(pins);
        const pinnedThreadKeys = new Set(Object.values(groups).flat());
        if (pinnedThreadKeys.size === 0) return { changed: false, orders };

        let nextOrders = orders;
        let changed = false;

        for (const [projectId, order] of Object.entries(orders)) {
          const pinnedForProject = new Set(groups[projectId] ?? []);
          const existingIds = Array.isArray(order?.threadIds) ? order.threadIds : [];
          const filteredIds = existingIds.filter(
            (id) => !pinnedThreadKeys.has(id) || pinnedForProject.has(id),
          );
          if (!arraysEqual(existingIds, filteredIds)) {
            if (nextOrders === orders) nextOrders = { ...orders };
            nextOrders[projectId] = { ...orderWithoutSortKey(order), threadIds: filteredIds };
            changed = true;
          }
        }

        for (const [projectId, pinnedIds] of Object.entries(groups)) {
          const current = nextOrders[projectId];
          const existingIds = Array.isArray(current?.threadIds) ? current.threadIds : [];
          const nextIds = [
            ...pinnedIds,
            ...existingIds.filter((id) => !pinnedIds.includes(id)),
          ];
          const hadSortKey = current && typeof current === "object" && "sortKey" in current;
          if (!arraysEqual(existingIds, nextIds) || hadSortKey || !current) {
            if (nextOrders === orders) nextOrders = { ...orders };
            nextOrders[projectId] = {
              ...orderWithoutSortKey(current),
              threadIds: nextIds,
            };
            changed = true;
          }
        }

        return { changed, orders: nextOrders };
      }

      async function reconcileProjectPins() {
        if (disposed || reconcileInFlight || !bridge.isAvailable()) return;
        await hydrateProjectPins();
        if (disposed) return;
        const pins = readProjectPins();
        if (Object.keys(pins).length === 0) return;

        reconcileInFlight = true;
        try {
          const orders = await readProjectOrders();
          if (disposed) return;
          const next = applyProjectPinOrder(orders, pins);
          if (disposed) return;
          if (next.changed) {
            await writeProjectOrders(next.orders);
            log.debug("reconciled project pins");
          } else {
            applySidebarDomReorder(orders);
          }
        } catch (err) {
          log.warn("project pin reconcile failed", err);
        } finally {
          reconcileInFlight = false;
        }
      }

      function scheduleProjectPinReconcile() {
        if (disposed) return;
        const pins = readProjectPins();
        if (Object.keys(pins).length === 0) {
          syncProjectPinVisuals();
          return;
        }
        if (reconcileTimer != null) global.clearTimeout(reconcileTimer);
        reconcileTimer = global.setTimeout(() => {
          reconcileTimer = null;
          reconcileProjectPins();
        }, RECONCILE_DEBOUNCE_MS);
      }

      function bindSidebarObserver() {
        sidebarObserver?.disconnect();
        sidebarObserver = null;
        const nav = sidebarNavRoot();
        if (!nav) return;
        sidebarObserver = new MutationObserver(scheduleProjectPinReconcile);
        sidebarObserver.observe(nav, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            "data-app-action-sidebar-thread-pinned",
            "data-app-action-sidebar-thread-id",
            "data-explodex-project-pinned",
          ],
        });
      }

      async function moveThreadToProjectTop(threadKey, conversationId, projectId) {
        const pins = readProjectPins();
        pins[conversationId] = projectId;
        const orders = await readProjectOrders();
        const next = applyProjectPinOrder(orders, pins);
        if (next.changed) await writeProjectOrders(next.orders);
      }

      async function pinToProject(threadKey, conversationId, projectId) {
        const pins = readProjectPins();
        if (await isGloballyPinned(threadKey)) {
          await setGlobalPin(threadKey, false);
        }
        pins[conversationId] = projectId;
        await writeProjectPins(pins);
        await moveThreadToProjectTop(threadKey, conversationId, projectId);
      }

      async function unpinFromProject(conversationId) {
        const pins = readProjectPins();
        if (!Object.prototype.hasOwnProperty.call(pins, conversationId)) return;
        delete pins[conversationId];
        await writeProjectPins(pins);
        scheduleProjectPinReconcile();
      }

      function findPinButton(target) {
        const btn = target?.closest?.("button");
        if (!btn || btn.disabled) return null;
        const label = btn.getAttribute("aria-label") ?? "";
        if (!PIN_LABEL_RE.test(label.trim())) return null;
        if (!btn.querySelector("svg")) return null;
        return btn;
      }

      function closeMenu() {
        menuOpen = false;
        activeMenu?.remove();
        activeMenu = null;
      }

      function menuItem({ label, active, onClick }) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = active ? `${label} ✓` : label;
        btn.style.cssText =
          "display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;" +
          "color:inherit;font:13px system-ui,-apple-system,sans-serif;cursor:pointer;border-radius:6px";
        btn.addEventListener("mouseenter", () => {
          btn.style.background = "color-mix(in srgb, currentColor 8%, transparent)";
        });
        btn.addEventListener("mouseleave", () => {
          btn.style.background = "transparent";
        });
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          onClick();
        });
        return btn;
      }

      function openMenu(anchor, { conversationId, threadKey, projectId, globalPinned, projectPinned }) {
        closeMenu();
        menuOpen = true;

        const backdrop = document.createElement("div");
        backdrop.style.cssText =
          "position:fixed;inset:0;z-index:2147483646;background:transparent";
        backdrop.addEventListener("pointerdown", (event) => {
          if (event.target === backdrop) closeMenu();
        });

        const panel = document.createElement("div");
        panel.setAttribute("role", "menu");
        panel.setAttribute("aria-label", "Pin scope");
        panel.style.cssText =
          "position:fixed;z-index:2147483647;min-width:148px;padding:4px;border-radius:10px;" +
          "border:1px solid color-mix(in srgb, currentColor 14%, transparent);" +
          "background:var(--color-bg-primary,#111);color:inherit;" +
          "box-shadow:0 12px 32px color-mix(in srgb,#000 45%,transparent);" +
          "font:13px/1.4 system-ui,-apple-system,sans-serif";

        panel.appendChild(
          menuItem({
            label: "Global",
            active: globalPinned,
            onClick: () =>
              handleGlobalChoice(conversationId, threadKey, projectId, globalPinned),
          }),
        );
        panel.appendChild(
          menuItem({
            label: "Project",
            active: projectPinned,
            onClick: () =>
              handleProjectChoice(conversationId, threadKey, projectId, projectPinned),
          }),
        );

        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        activeMenu = backdrop;

        const rect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const margin = 8;
        let top = rect.bottom + 6;
        let left = rect.right - panelRect.width;
        if (left < margin) left = margin;
        if (left + panelRect.width > global.innerWidth - margin) {
          left = global.innerWidth - panelRect.width - margin;
        }
        if (top + panelRect.height > global.innerHeight - margin) {
          top = rect.top - panelRect.height - 6;
        }
        panel.style.top = `${Math.max(margin, top)}px`;
        panel.style.left = `${Math.max(margin, left)}px`;
      }

      function triggerNativePin(pinButton) {
        if (disposed || !pinButton?.isConnected) return;
        allowNativePin = true;
        suppressNextPinClick = false;
        pinButton.click();
        global.setTimeout(() => {
          allowNativePin = false;
        }, 0);
      }

      async function handleGlobalChoice(conversationId, threadKey, projectId, wasGlobalPinned) {
        if (!bridge.isAvailable()) {
          c.statusToast("Bridge unavailable");
          return;
        }
        try {
          if (wasGlobalPinned) {
            await setGlobalPin(threadKey, false);
            c.statusToast("Unpinned globally");
            scheduleProjectPinReconcile();
            return;
          }
          await unpinFromProject(conversationId);
          await setGlobalPin(threadKey, true);
          c.statusToast("Pinned globally");
          scheduleProjectPinReconcile();
        } catch (err) {
          log.error("global pin failed", err);
          c.statusToast("Failed to update global pin");
        }
      }

      async function handleProjectChoice(conversationId, threadKey, projectId, wasProjectPinned) {
        if (!bridge.isAvailable()) {
          c.statusToast("Bridge unavailable");
          return;
        }
        try {
          if (wasProjectPinned) {
            await unpinFromProject(conversationId);
            c.statusToast("Unpinned from project");
            scheduleProjectPinReconcile();
            return;
          }
          await pinToProject(threadKey, conversationId, projectId);
          c.statusToast("Pinned to project");
          scheduleProjectPinReconcile();
        } catch (err) {
          log.error("project pin failed", err);
          c.statusToast("Failed to update project pin");
        }
      }

      async function openMenuWithFreshState(ctx) {
        if (!bridge.isAvailable()) {
          c.statusToast("Bridge unavailable");
          return false;
        }

        try {
          await hydrateProjectPins();
          if (disposed) return false;
          const assignmentProjectId = ctx.projectId
            ? null
            : await getProjectIdForThread(ctx.threadKey, ctx.conversationId);
          if (disposed) return false;
          const projectId = ctx.projectId ?? assignmentProjectId;
          if (!projectId) return false;

          const globalPinned = await isGloballyPinned(ctx.threadKey, ctx.globalPinned);
          if (disposed) return false;
          const projectPinned =
            isProjectPinned(ctx.conversationId) &&
            projectIdForPinned(ctx.conversationId) === projectId;

          openMenu(ctx.pinButton, {
            conversationId: ctx.conversationId,
            threadKey: ctx.threadKey,
            projectId,
            globalPinned,
            projectPinned,
          });
          return true;
        } catch (err) {
          log.warn("pin scope menu state lookup failed", err);
          return false;
        }
      }

      function onPinPointerDown(event) {
        if (allowNativePin) {
          allowNativePin = false;
          return;
        }
        if (event.button !== 0) return;
        if (menuOpen) return;

        const pinButton = findPinButton(event.target);
        if (!pinButton) return;

        const ctx = resolvePinContext(pinButton);
        if (!ctx) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        suppressNextPinClick = true;
        void openMenuWithFreshState(ctx).then((opened) => {
          if (!opened) triggerNativePin(pinButton);
        });
      }

      function onPinClick(event) {
        if (allowNativePin) {
          allowNativePin = false;
          return;
        }

        const pinButton = findPinButton(event.target);
        if (!pinButton) return;

        const ctx = resolvePinContext(pinButton);
        if (!ctx) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        if (suppressNextPinClick) {
          suppressNextPinClick = false;
          return;
        }

        void openMenuWithFreshState(ctx).then((opened) => {
          if (!opened) triggerNativePin(pinButton);
        });
      }

      function onKeyDown(event) {
        if (event.key === "Escape" && menuOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        }
      }

      global.addEventListener("pointerdown", onPinPointerDown, true);
      global.addEventListener("click", onPinClick, true);
      global.addEventListener("keydown", onKeyDown, true);
      bindSidebarObserver();
      unsubscribeSidebar = inject.observeZone("sidebar", () => {
        bindSidebarObserver();
        scheduleProjectPinReconcile();
      });
      void hydrateProjectPins()
        .then(() => {
          if (disposed) return;
          scheduleProjectPinReconcile();
        })
        .catch((err) => log.warn("initial project pin hydrate failed", err));

      log.info("pin scope menu attached");

      return () => {
        disposed = true;
        log.info("teardown");
        closeMenu();
        if (reconcileTimer != null) global.clearTimeout(reconcileTimer);
        sidebarObserver?.disconnect();
        unsubscribeSidebar?.();
        global.removeEventListener("pointerdown", onPinPointerDown, true);
        global.removeEventListener("click", onPinClick, true);
        global.removeEventListener("keydown", onKeyDown, true);
      };
    },
  );
})(window);
