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
    GLOBAL_STATE_KEYS: () => GLOBAL_STATE_KEYS,
    LEGACY_PROJECT_PINS_KEY: () => LEGACY_PROJECT_PINS_KEY,
    PROJECT_PINS_KEY: () => PROJECT_PINS_KEY,
    default: () => index_default,
    setupProjectPins: () => setupProjectPins
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
  var DEFAULT_PROJECT_THREAD_SORT_KEY = "updated_at";
  var CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var LOCAL_THREAD_KEY_RE = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  function pinScopeChoiceActions(options) {
    if (options.choice === "global") {
      if (options.globallyPinned) {
        return options.projectPinned ? ["unpin-project", "unpin-global"] : ["unpin-global"];
      }
      return options.projectPinned ? ["unpin-project", "pin-global"] : ["pin-global"];
    }
    if (options.projectPinned) {
      return options.globallyPinned ? ["unpin-global", "unpin-project"] : ["unpin-project"];
    }
    return options.globallyPinned ? ["unpin-global", "pin-project"] : ["pin-project"];
  }
  function normalizeConversationId(value) {
    if (value === null || value === void 0) return null;
    const id = String(value).trim();
    if (!id || id === "undefined" || id === "null") return null;
    if (CONVERSATION_ID_RE.test(id)) return id;
    return id.match(LOCAL_THREAD_KEY_RE)?.[1] ?? null;
  }
  function localThreadKey(conversationId) {
    return `local:${conversationId}`;
  }
  function normalizeProjectId(value) {
    if (value === null || value === void 0) return null;
    const id = String(value).trim();
    return id && id !== "null" && id !== "undefined" ? id : null;
  }
  function normalizeProjectPinsMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const pins = {};
    for (const [conversationId, projectId] of Object.entries(value)) {
      const normalizedConversationId = normalizeConversationId(conversationId);
      const normalizedProjectId = normalizeProjectId(projectId);
      if (normalizedConversationId && normalizedProjectId) {
        pins[normalizedConversationId] = normalizedProjectId;
      }
    }
    return pins;
  }
  function projectIdFromAssignment(assignment) {
    if (assignment === null || assignment === void 0) return null;
    if (typeof assignment === "string") return normalizeProjectId(assignment);
    if (typeof assignment !== "object") return null;
    const record = assignment;
    if (record.projectId !== void 0) {
      return normalizeProjectId(record.projectId);
    }
    if (record.project_id !== void 0) {
      return normalizeProjectId(record.project_id);
    }
    if (record.id !== void 0 && record.kind !== void 0) {
      return normalizeProjectId(record.id);
    }
    return null;
  }
  function resolveAssignedProject(options) {
    const projectless = new Set(
      [...options.projectlessIds].map((value) => String(value))
    );
    if (projectless.has(options.threadKey) || projectless.has(options.conversationId)) {
      return null;
    }
    if (!options.assignments || typeof options.assignments !== "object" || Array.isArray(options.assignments)) {
      return null;
    }
    const assignments = options.assignments;
    return projectIdFromAssignment(assignments[options.threadKey]) ?? projectIdFromAssignment(assignments[options.conversationId]);
  }
  function globalPinIdCandidates(threadKey) {
    const conversationId = normalizeConversationId(threadKey);
    const candidates = [];
    if (conversationId) candidates.push(conversationId);
    if (threadKey) candidates.push(threadKey);
    if (conversationId) candidates.push(localThreadKey(conversationId));
    return [...new Set(candidates)];
  }
  function removeGlobalPinConflicts(pins, globallyPinnedIds) {
    const nextPins = { ...pins };
    let changed = false;
    for (const conversationId of Object.keys(pins)) {
      if (globalPinIdCandidates(localThreadKey(conversationId)).some(
        (id) => globallyPinnedIds.has(id)
      )) {
        delete nextPins[conversationId];
        changed = true;
      }
    }
    return { changed, pins: nextPins };
  }
  function shouldShowProjectPinIndicator(options) {
    if (options.globallyPinned || !options.pinnedProjectId) return false;
    if (!options.sidebarProjectId) return true;
    return options.pinnedProjectId === options.sidebarProjectId;
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
    const next = order ? { ...order } : {};
    delete next.sortKey;
    return next;
  }
  function restoreRecencySortForUnpinnedProjects(orders, groups) {
    let nextOrders = orders;
    let changed = false;
    for (const [projectId, order] of Object.entries(orders)) {
      if ((groups[projectId] ?? []).length > 0) continue;
      if (!order || typeof order !== "object") continue;
      if (order.sortKey === DEFAULT_PROJECT_THREAD_SORT_KEY && !Array.isArray(order.threadIds)) {
        continue;
      }
      const hadManualOrder = Array.isArray(order.threadIds) && order.threadIds.length > 0;
      const missingSortKey = order.sortKey === null || order.sortKey === void 0;
      if (!missingSortKey && !hadManualOrder) continue;
      if (nextOrders === orders) nextOrders = { ...orders };
      nextOrders[projectId] = {
        sortKey: DEFAULT_PROJECT_THREAD_SORT_KEY
      };
      changed = true;
    }
    return { changed, orders: nextOrders };
  }
  function sortThreadIdsByRecency(threadIds, activityMs) {
    return [...threadIds].sort((left, right) => {
      const leftMs = activityMs[left] ?? Number.POSITIVE_INFINITY;
      const rightMs = activityMs[right] ?? Number.POSITIVE_INFINITY;
      if (leftMs !== rightMs) return leftMs - rightMs;
      return threadIds.indexOf(left) - threadIds.indexOf(right);
    });
  }
  function unpinnedThreadIdsForProject(projectId, pinnedIds, existingIds, context) {
    const pinnedSet = new Set(pinnedIds);
    const sidebarIds = context.projectThreadIds[projectId] ?? [];
    const pool = sidebarIds.length > 0 ? [
      .../* @__PURE__ */ new Set([
        ...sidebarIds,
        ...existingIds.filter((id) => !pinnedSet.has(id))
      ])
    ] : existingIds.filter((id) => !pinnedSet.has(id));
    return sortThreadIdsByRecency(
      pool.filter((id) => !pinnedSet.has(id)),
      context.activityMs
    );
  }
  function applyProjectPinOrder(orders, pins, context) {
    const groups = groupedPinnedThreadKeys(pins);
    const pinnedThreadKeys = new Set(Object.values(groups).flat());
    let nextOrders = orders;
    let changed = false;
    const restored = restoreRecencySortForUnpinnedProjects(nextOrders, groups);
    if (restored.changed) {
      nextOrders = restored.orders;
      changed = true;
    }
    if (pinnedThreadKeys.size === 0) {
      return { changed, orders: nextOrders };
    }
    for (const [projectId, order] of Object.entries(nextOrders)) {
      const pinnedForProject = new Set(groups[projectId] ?? []);
      if (pinnedForProject.size === 0) continue;
      const validOrder = order && typeof order === "object" ? order : void 0;
      const existingIds = Array.isArray(validOrder?.threadIds) ? validOrder.threadIds : [];
      const filteredIds = existingIds.filter(
        (id) => !pinnedThreadKeys.has(id) || pinnedForProject.has(id)
      );
      if (!arraysEqual(existingIds, filteredIds)) {
        if (nextOrders === orders) nextOrders = { ...orders };
        nextOrders[projectId] = {
          ...orderWithoutSortKey(validOrder),
          threadIds: filteredIds
        };
        changed = true;
      }
    }
    for (const [projectId, pinnedIds] of Object.entries(groups)) {
      const current = nextOrders[projectId];
      const existingIds = Array.isArray(current?.threadIds) ? current.threadIds : [];
      const nextIds = [
        ...pinnedIds,
        ...unpinnedThreadIdsForProject(
          projectId,
          pinnedIds,
          existingIds,
          context
        )
      ];
      const hadSortKey = current && "sortKey" in current;
      if (!arraysEqual(existingIds, nextIds) || hadSortKey || !current) {
        if (nextOrders === orders) nextOrders = { ...orders };
        nextOrders[projectId] = {
          ...orderWithoutSortKey(current),
          threadIds: nextIds
        };
        changed = true;
      }
    }
    return { changed, orders: nextOrders };
  }

  // src/index.ts
  var PROJECT_PINS_KEY = "explodex-project-pins-pinned-threads";
  var LEGACY_PROJECT_PINS_KEY = "explodex-project-pinned-threads";
  var GLOBAL_STATE_KEYS = {
    assignments: "thread-project-assignments",
    projectOrders: "sidebar-project-thread-orders",
    projectPins: PROJECT_PINS_KEY,
    projectless: "projectless-thread-ids"
  };
  var RECONCILE_DEBOUNCE_MS = 250;
  var PIN_LABEL_RE = /^(pin|unpin)\s+(chat|conversation)/i;
  var SHOW_MORE_LESS_RE = /show\s+(more|less)/i;
  var RELATIVE_ACTIVITY_RE = /^(\d+)(mo|w|d|h|m|s)$/i;
  var IN_PROGRESS_LABEL_RE = /^(in progress|working|pending)$/i;
  var IN_PROGRESS_ACTIVITY_MS = -1;
  var ACTIVITY_UNIT_MS = {
    s: 1e3,
    m: 6e4,
    h: 36e5,
    d: 864e5,
    w: 6048e5,
    mo: 2592e6
  };
  async function setupProjectPins(api, runtime = globalThis) {
    const global = runtime;
    const document = runtime.document;
    const { bridge, storage, components: c, log, inject } = api;
    await api.migrate([
      {
        id: "rename-pins-key-from-pin-scope-menu",
        run: ({ renameKey }) => {
          renameKey(LEGACY_PROJECT_PINS_KEY, PROJECT_PINS_KEY);
        }
      }
    ]);
    let menuOpen = false;
    let activeMenu = null;
    let allowNativePin = false;
    let suppressNextPinClick = false;
    let reconcileTimer = null;
    let sidebarObserver = null;
    let unsubscribeSidebar = null;
    let reconcileInFlight = false;
    let pinStyleElement = null;
    let pinsCache = {};
    let pinsHydrated = false;
    let pinsHydratePromise = null;
    let disposed = false;
    const pendingTimeouts = /* @__PURE__ */ new Set();
    const pendingDelayResolvers = /* @__PURE__ */ new Map();
    function delay(milliseconds) {
      return new Promise((resolve) => {
        const timeoutId = global.setTimeout(() => {
          pendingTimeouts.delete(timeoutId);
          pendingDelayResolvers.delete(timeoutId);
          resolve();
        }, milliseconds);
        pendingTimeouts.add(timeoutId);
        pendingDelayResolvers.set(timeoutId, resolve);
      });
    }
    function scheduleTimeout(handler, milliseconds) {
      const timeoutId = global.setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        if (!disposed) handler();
      }, milliseconds);
      pendingTimeouts.add(timeoutId);
    }
    function normalizeConversationId2(value) {
      return normalizeConversationId(value);
    }
    function conversationIdFromPath(pathname) {
      const patterns = [
        /\/local\/([^/]+)/,
        /\/thread\/([^/]+)/,
        /\/hotkey-window\/thread\/([^/]+)/
      ];
      for (const pattern of patterns) {
        const match = pathname.match(pattern);
        const id = normalizeConversationId2(match?.[1] ? decodeURIComponent(match[1]) : null);
        if (id) return id;
      }
      return null;
    }
    function conversationIdFromPortals() {
      const portals = [
        ...document.querySelectorAll("[data-above-composer-portal]"),
        ...document.querySelectorAll("[data-above-composer-queue-portal]"),
        ...document.querySelectorAll("[data-above-composer-conversation-id]")
      ];
      for (const portal of portals) {
        const id = normalizeConversationId2(
          portal.getAttribute("data-above-composer-conversation-id")
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
    function localThreadKey2(conversationId) {
      return localThreadKey(conversationId);
    }
    function normalizeProjectPinsMap2(value) {
      return normalizeProjectPinsMap(value);
    }
    function readPersistedProjectPins() {
      const raw = storage.persisted.get(PROJECT_PINS_KEY, null);
      return normalizeProjectPinsMap2(raw);
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
          const fromGlobal = normalizeProjectPinsMap2(
            await storage.globalState.get(GLOBAL_STATE_KEYS.projectPins)
          );
          if (disposed) return pinsCache;
          if (Object.keys(fromGlobal).length > 0) {
            pinsCache = fromGlobal;
          } else if (Object.keys(pinsCache).length > 0) {
            await storage.globalState.set(GLOBAL_STATE_KEYS.projectPins, pinsCache);
            if (disposed) return pinsCache;
            storage.persisted.remove(PROJECT_PINS_KEY);
            log.debug("migrated project pins to global state");
          }
        } catch (err) {
          if (!disposed) log.warn("project pin hydrate failed", err);
        } finally {
          pinsHydrated = true;
          pinsHydratePromise = null;
        }
        return pinsCache;
      })();
      return pinsHydratePromise;
    }
    async function writeProjectPins(map) {
      if (disposed) return;
      pinsCache = normalizeProjectPinsMap2(map);
      pinsHydrated = true;
      if (!bridge.isAvailable()) {
        storage.persisted.set(PROJECT_PINS_KEY, pinsCache);
        return;
      }
      await storage.globalState.set(GLOBAL_STATE_KEYS.projectPins, pinsCache);
      if (disposed) return;
      storage.persisted.remove(PROJECT_PINS_KEY);
    }
    function isProjectPinned(conversationId) {
      return Object.prototype.hasOwnProperty.call(readProjectPins(), conversationId);
    }
    function projectIdForPinned(conversationId) {
      return readProjectPins()[conversationId] ?? null;
    }
    function normalizeProjectId2(value) {
      return normalizeProjectId(value);
    }
    function sidebarThreadRow(node) {
      return node?.closest?.("[data-app-action-sidebar-thread-id]") ?? null;
    }
    function conversationIdFromThreadRow(row) {
      if (!row) return null;
      return normalizeConversationId2(row.getAttribute("data-app-action-sidebar-thread-id"));
    }
    function sidebarNavRoot() {
      return document.querySelector('nav[aria-label*="Scheduled task" i]') ?? document.querySelector('nav[aria-label*="Automation folders" i]') ?? document.querySelector("nav.sidebar-foreground-muted") ?? document.querySelector("nav");
    }
    function projectIdFromDomScan(threadKey) {
      if (!threadKey) return null;
      const nav = sidebarNavRoot();
      if (!nav) return null;
      let currentProject = null;
      for (const el of nav.querySelectorAll(
        "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]"
      )) {
        if (el.hasAttribute("data-app-action-sidebar-project-id")) {
          currentProject = el.getAttribute("data-app-action-sidebar-project-id");
          continue;
        }
        if (el.getAttribute("data-app-action-sidebar-thread-id") === threadKey) {
          return normalizeProjectId2(currentProject);
        }
      }
      return null;
    }
    function findPinButton(target) {
      const btn = target?.closest?.("button");
      if (!btn || btn.disabled) return null;
      const label = btn.getAttribute("aria-label") ?? "";
      if (!PIN_LABEL_RE.test(label.trim())) return null;
      if (!btn.querySelector("svg")) return null;
      return btn;
    }
    function findProjectPinIndicator(target) {
      return target?.closest?.("[data-explodex-project-pin-indicator]") ?? null;
    }
    function findPinScopeAnchor(target) {
      return findPinButton(target) ?? findProjectPinIndicator(target);
    }
    function pinButtonForRow(row) {
      if (!row) return null;
      for (const btn of row.querySelectorAll("button")) {
        if (findPinButton(btn)) return btn;
      }
      return null;
    }
    function resolvePinContext(anchor) {
      const row = sidebarThreadRow(anchor) ?? anchor?.closest?.("[data-app-action-sidebar-thread-id]");
      const conversationId = row ? conversationIdFromThreadRow(row) : getActiveConversationId();
      if (!conversationId) return null;
      const threadKey = localThreadKey2(conversationId);
      const projectId = projectIdFromDomScan(threadKey);
      const globalPinned = row ? row.getAttribute("data-app-action-sidebar-thread-pinned") === "true" : null;
      const menuAnchor = findPinButton(anchor) ?? findProjectPinIndicator(anchor) ?? anchor;
      return {
        pinButton: menuAnchor,
        nativePinButton: pinButtonForRow(row),
        conversationId,
        threadKey,
        projectId,
        globalPinned,
        projectPinned: isProjectPinned(conversationId) && projectIdForPinned(conversationId) === projectId
      };
    }
    async function getProjectlessSet() {
      const ids = await storage.globalState.get(GLOBAL_STATE_KEYS.projectless);
      return Array.isArray(ids) ? new Set(ids) : /* @__PURE__ */ new Set();
    }
    async function getProjectIdForThread(threadKey, conversationId) {
      const projectless = await getProjectlessSet();
      if (disposed) return null;
      const assignments = await storage.globalState.get(
        GLOBAL_STATE_KEYS.assignments
      );
      if (disposed) return null;
      return resolveAssignedProject({
        assignments,
        conversationId,
        projectlessIds: projectless,
        threadKey
      });
    }
    async function listGloballyPinnedIds() {
      const res = await bridge.rpc(
        "list-pinned-threads",
        { params: {} }
      );
      const ids = res?.threadIds;
      return Array.isArray(ids) ? ids : [];
    }
    function globalPinIdCandidates2(threadKey) {
      return globalPinIdCandidates(threadKey);
    }
    async function isGloballyPinned(threadKey) {
      const ids = new Set(await listGloballyPinnedIds());
      return globalPinIdCandidates2(threadKey).some((id) => ids.has(id));
    }
    async function setGlobalPinState(threadKey, pinned, nativePinButton = null) {
      const currentlyPinned = await isGloballyPinned(threadKey);
      if (disposed) return;
      if (currentlyPinned === pinned) return;
      const row = document.querySelector(
        `[data-app-action-sidebar-thread-id="${threadKey}"]`
      );
      const pinButton = nativePinButton?.isConnected ? nativePinButton : pinButtonForRow(row);
      if (pinButton?.isConnected) {
        triggerNativePin(pinButton);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await delay(50);
          if (disposed) return;
          const nativePinned = await isGloballyPinned(threadKey);
          if (disposed) return;
          if (nativePinned === pinned) return;
        }
      }
      for (const id of globalPinIdCandidates2(threadKey)) {
        if (disposed) return;
        const res = await bridge.rpc(
          "set-thread-pinned",
          {
            params: { threadId: id, pinned }
          }
        );
        if (disposed) return;
        if (res?.success === false) continue;
        const rpcPinned = await isGloballyPinned(threadKey);
        if (disposed) return;
        if (rpcPinned === pinned) return;
      }
      if (disposed) return;
      throw new Error("set-thread-pinned failed");
    }
    async function readProjectOrders() {
      const value = await storage.globalState.get(
        GLOBAL_STATE_KEYS.projectOrders
      );
      return value && typeof value === "object" ? { ...value } : {};
    }
    async function writeProjectOrders(orders) {
      if (disposed) return;
      applySidebarDomReorder(orders);
      if (disposed) return;
      await storage.globalState.set(GLOBAL_STATE_KEYS.projectOrders, orders);
    }
    const PIN_INDICATOR_SVG_PATH = "M12.8636 3.26029C13.9444 1.74708 16.1254 1.56658 17.4403 2.88151L21.1185 6.55974C22.4335 7.87467 22.2529 10.0556 20.7397 11.1364L16.4786 14.1801C16.1638 14.405 16 14.7306 16 15V17.5C16 18.907 15.0409 19.9513 13.976 20.4105C12.9046 20.8724 11.4792 20.8468 10.4568 19.8244L8.02332 17.3909L3.70711 21.7071C3.31658 22.0977 2.68342 22.0977 2.29289 21.7071C1.90237 21.3166 1.90237 20.6835 2.29289 20.2929L6.60911 15.9767L4.17567 13.5433C3.1532 12.5208 3.12762 11.0955 3.58957 10.024C4.04871 8.95911 5.09306 8.00003 6.5 8.00003H9C9.26948 8.00003 9.59505 7.83624 9.81994 7.52139L12.8636 3.26029Z";
    const PIN_SCOPE_STYLE_TEXT = 'nav [data-explodex-project-pinned="true"] [data-explodex-project-pin-indicator]{display:inline-flex!important;margin-right:6px!important;vertical-align:middle;opacity:1!important;color:#fff!important;cursor:pointer}nav [data-explodex-project-pinned="true"] [class*="group-hover:opacity-100"] button[aria-label="Pin chat"],nav [data-explodex-project-pinned="true"] [class*="group-hover:opacity-100"] button[aria-label="Unpin chat"]{opacity:1!important;color:#fff!important}nav [data-explodex-project-pinned="true"] [class*="group-hover:opacity-100"] button[aria-label="Pin chat"] svg path,nav [data-explodex-project-pinned="true"] [class*="group-hover:opacity-100"] button[aria-label="Unpin chat"] svg path{fill:currentColor!important}';
    function ensurePinScopeStyles() {
      let style = document.getElementById("explodex-pin-scope-styles");
      if (!style) {
        style = document.createElement("style");
        style.id = "explodex-pin-scope-styles";
        document.head.appendChild(style);
      }
      pinStyleElement = style;
      if (style.textContent !== PIN_SCOPE_STYLE_TEXT) style.textContent = PIN_SCOPE_STYLE_TEXT;
    }
    function isThreadProjectPinned(threadKey) {
      const conversationId = normalizeConversationId2(
        threadKey?.startsWith("local:") ? threadKey.slice("local:".length) : threadKey
      );
      if (!conversationId || !isProjectPinned(conversationId)) return false;
      const assignedProject = normalizeProjectId2(projectIdForPinned(conversationId));
      const sidebarProject = projectIdFromDomScan(threadKey);
      if (!assignedProject || !sidebarProject) return true;
      return assignedProject === sidebarProject;
    }
    function projectPinStatusSlot(row) {
      const listItem = row?.closest?.('[role="listitem"]');
      if (!listItem) return null;
      for (const candidate of listItem.querySelectorAll("*")) {
        const className = candidate.className;
        if (typeof className !== "string" || !className.includes("group-hover:hidden")) {
          continue;
        }
        if (className.includes("group-hover:opacity-100")) continue;
        return candidate;
      }
      return null;
    }
    function createProjectPinIndicator() {
      const wrap = document.createElement("span");
      wrap.setAttribute("data-explodex-project-pin-indicator", "true");
      wrap.setAttribute("role", "button");
      wrap.setAttribute("tabindex", "-1");
      wrap.setAttribute("aria-label", "Pin chat");
      wrap.className = "inline-flex shrink-0 items-center justify-center cursor-pointer";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.classList.add("icon-2xs", "no-drag", "shrink-0");
      svg.style.color = "#fff";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", PIN_INDICATOR_SVG_PATH);
      path.setAttribute("fill", "currentColor");
      svg.appendChild(path);
      wrap.appendChild(svg);
      bindProjectPinIndicator(wrap);
      return wrap;
    }
    function bindProjectPinIndicator(wrap) {
      if (wrap.dataset.explodexPinScopeBound === "true") return;
      wrap.dataset.explodexPinScopeBound = "true";
      wrap.addEventListener(
        "pointerdown",
        (event) => {
          void activatePinScopeFromEvent(event);
        },
        true
      );
    }
    function ensureProjectPinIndicator(row) {
      const slot = projectPinStatusSlot(row);
      if (!slot) return false;
      const existing = slot.querySelector("[data-explodex-project-pin-indicator]");
      if (existing) {
        bindProjectPinIndicator(existing);
        return false;
      }
      slot.prepend(createProjectPinIndicator());
      return true;
    }
    function removeProjectPinIndicator(row) {
      const indicator = projectPinStatusSlot(row)?.querySelector(
        "[data-explodex-project-pin-indicator]"
      );
      if (!indicator) return false;
      indicator.remove();
      return true;
    }
    function shouldShowProjectPinIndicatorForRow(row, threadKey) {
      const conversationId = normalizeConversationId2(threadKey);
      return shouldShowProjectPinIndicator({
        globallyPinned: row.getAttribute("data-app-action-sidebar-thread-pinned") === "true",
        pinnedProjectId: conversationId ? normalizeProjectId2(projectIdForPinned(conversationId)) : null,
        sidebarProjectId: projectIdFromDomScan(threadKey)
      });
    }
    async function reconcileExclusivePins() {
      if (!bridge.isAvailable()) return false;
      const globalIds = new Set(await listGloballyPinnedIds());
      if (disposed) return false;
      const pins = readProjectPins();
      const next = removeGlobalPinConflicts(pins, globalIds);
      if (!next.changed) return false;
      await writeProjectPins(next.pins);
      if (disposed) return false;
      log.debug("cleared project pins that conflicted with global pins");
      return true;
    }
    function syncProjectPinVisuals() {
      ensurePinScopeStyles();
      let changed = false;
      for (const el of document.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
        const threadKey = el.getAttribute("data-app-action-sidebar-thread-id");
        if (!threadKey) continue;
        const shouldPin = shouldShowProjectPinIndicatorForRow(el, threadKey);
        const isMarked = el.getAttribute("data-explodex-project-pinned") === "true";
        if (shouldPin && !isMarked) {
          el.setAttribute("data-explodex-project-pinned", "true");
          if (ensureProjectPinIndicator(el)) changed = true;
          changed = true;
        } else if (!shouldPin && isMarked) {
          el.removeAttribute("data-explodex-project-pinned");
          if (removeProjectPinIndicator(el)) changed = true;
          changed = true;
        } else if (shouldPin && isMarked && ensureProjectPinIndicator(el)) {
          changed = true;
        } else if (!shouldPin && !isMarked && removeProjectPinIndicator(el)) {
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
        "[data-app-action-sidebar-project-id], [data-app-action-sidebar-thread-id]"
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
      const seen = /* @__PURE__ */ new Set();
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
      const desiredOrder = ordered.map(
        (row) => row.querySelector("[data-app-action-sidebar-thread-id]")?.getAttribute("data-app-action-sidebar-thread-id")
      ).filter(Boolean);
      const currentOrder = items.map((entry) => entry.threadId);
      if (arraysEqual2(currentOrder, desiredOrder)) return false;
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
    function arraysEqual2(left, right) {
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    function rowIsInProgressFromListItem(row) {
      if (!row) return false;
      if (row.querySelector(".animate-spin, .loading-shimmer-pure-text")) return true;
      const tabular = row.querySelector(".tabular-nums");
      if (tabular) {
        const label = tabular.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (IN_PROGRESS_LABEL_RE.test(label)) return true;
        if (tabular.classList.contains("loading-shimmer-pure-text")) return true;
        if (label) return false;
      }
      return !!row.querySelector(".icon-xs.relative.scale-50 .rounded-full[style]");
    }
    function rowActivityMsFromListItem(row) {
      if (rowIsInProgressFromListItem(row)) return IN_PROGRESS_ACTIVITY_MS;
      const label = row.querySelector(".tabular-nums")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const match = label.match(RELATIVE_ACTIVITY_RE);
      if (!match) return Number.POSITIVE_INFINITY;
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      const unitMs = ACTIVITY_UNIT_MS[unit];
      if (unitMs == null) return Number.POSITIVE_INFINITY;
      return amount * unitMs;
    }
    function applyProjectPinOrder2(orders, pins) {
      const projectThreadIds = {};
      const activityMs = {};
      for (const projectId of /* @__PURE__ */ new Set([
        ...Object.keys(orders),
        ...Object.values(pins)
      ])) {
        const entries = projectSidebarListItems(projectId);
        projectThreadIds[projectId] = entries.map((entry) => entry.threadId);
        for (const { threadId, el } of entries) {
          activityMs[threadId] = rowActivityMsFromListItem(el);
        }
      }
      return applyProjectPinOrder(orders, pins, {
        activityMs,
        projectThreadIds
      });
    }
    async function reconcileProjectPins() {
      if (disposed || reconcileInFlight || !bridge.isAvailable()) return;
      await hydrateProjectPins();
      if (disposed) return;
      await reconcileExclusivePins();
      if (disposed) return;
      const pins = readProjectPins();
      reconcileInFlight = true;
      try {
        const orders = await readProjectOrders();
        if (disposed) return;
        const next = applyProjectPinOrder2(orders, pins);
        if (Object.keys(pins).length === 0) {
          if (next.changed) {
            await storage.globalState.set(GLOBAL_STATE_KEYS.projectOrders, next.orders);
            if (disposed) return;
            log.debug("restored project thread recency sort");
          }
          if (disposed) return;
          syncProjectPinVisuals();
          return;
        }
        if (disposed) return;
        if (next.changed) {
          await writeProjectOrders(next.orders);
          if (disposed) return;
          log.debug("reconciled project pins");
        } else {
          if (disposed) return;
          applySidebarDomReorder(orders);
        }
      } catch (err) {
        if (!disposed) log.warn("project pin reconcile failed", err);
      } finally {
        reconcileInFlight = false;
      }
    }
    function scheduleProjectPinReconcile() {
      if (disposed) return;
      void hydrateProjectPins().then(() => {
        if (disposed) return;
        return reconcileExclusivePins();
      }).then(() => {
        if (disposed) return;
        syncProjectPinVisuals();
        const pins = readProjectPins();
        if (reconcileTimer != null) global.clearTimeout(reconcileTimer);
        reconcileTimer = global.setTimeout(() => {
          reconcileTimer = null;
          reconcileProjectPins();
        }, RECONCILE_DEBOUNCE_MS);
      }).catch((err) => {
        if (!disposed) log.warn("project pin schedule failed", err);
      });
    }
    function bindSidebarObserver() {
      sidebarObserver?.disconnect();
      sidebarObserver = null;
      const nav = sidebarNavRoot();
      if (!nav) return;
      sidebarObserver = new global.MutationObserver(
        scheduleProjectPinReconcile
      );
      sidebarObserver.observe(nav, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "data-app-action-sidebar-thread-pinned",
          "data-app-action-sidebar-thread-id",
          "data-explodex-project-pinned"
        ]
      });
    }
    async function flushProjectPinReorder() {
      if (!bridge.isAvailable()) return;
      await hydrateProjectPins();
      if (disposed) return;
      const pins = readProjectPins();
      const orders = await readProjectOrders();
      if (disposed) return;
      const next = applyProjectPinOrder2(orders, pins);
      if (disposed) return;
      if (Object.keys(pins).length === 0) {
        if (next.changed) {
          await storage.globalState.set(GLOBAL_STATE_KEYS.projectOrders, next.orders);
          if (disposed) return;
          log.debug("restored project thread recency sort");
        }
        if (disposed) return;
        syncProjectPinVisuals();
        return;
      }
      if (next.changed) {
        await writeProjectOrders(next.orders);
      } else {
        applySidebarDomReorder(orders);
        syncProjectPinVisuals();
      }
    }
    async function pinToProject(threadKey, conversationId, projectId, nativePinButton = null) {
      if (await isGloballyPinned(threadKey)) {
        if (disposed) return;
        await setGlobalPinState(threadKey, false, nativePinButton);
      }
      if (disposed) return;
      const pins = readProjectPins();
      pins[conversationId] = projectId;
      await writeProjectPins(pins);
      if (disposed) return;
      await flushProjectPinReorder();
    }
    async function unpinFromProject(conversationId) {
      const pins = readProjectPins();
      if (!Object.prototype.hasOwnProperty.call(pins, conversationId)) return;
      delete pins[conversationId];
      await writeProjectPins(pins);
      if (disposed) return;
      scheduleProjectPinReconcile();
    }
    function closeMenu() {
      menuOpen = false;
      activeMenu?.remove();
      activeMenu = null;
    }
    function menuItem({ label, active, onClick }) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = active ? `${label} \u2713` : label;
      btn.style.cssText = "display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:inherit;font:13px system-ui,-apple-system,sans-serif;cursor:pointer;border-radius:6px";
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
    function openMenu(anchor, { conversationId, threadKey, projectId, globalPinned, projectPinned, nativePinButton }) {
      closeMenu();
      menuOpen = true;
      const backdrop = document.createElement("div");
      backdrop.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:transparent";
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) closeMenu();
      });
      const panel = document.createElement("div");
      panel.setAttribute("role", "menu");
      panel.setAttribute("aria-label", "Pin scope");
      panel.style.cssText = "position:fixed;z-index:2147483647;min-width:148px;padding:4px;border-radius:10px;border:1px solid color-mix(in srgb, currentColor 14%, transparent);background:var(--color-bg-primary,#111);color:inherit;box-shadow:0 12px 32px color-mix(in srgb,#000 45%,transparent);font:13px/1.4 system-ui,-apple-system,sans-serif";
      panel.appendChild(
        menuItem({
          label: "Global",
          active: globalPinned,
          onClick: () => handleGlobalChoice(
            conversationId,
            threadKey,
            projectId,
            globalPinned,
            nativePinButton
          )
        })
      );
      panel.appendChild(
        menuItem({
          label: "Project",
          active: projectPinned,
          onClick: () => handleProjectChoice(
            conversationId,
            threadKey,
            projectId,
            projectPinned,
            nativePinButton
          )
        })
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
      suppressNextPinClick = true;
      pinButton.dispatchEvent(
        new global.PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          view: global
        })
      );
      pinButton.click();
      scheduleTimeout(() => {
        allowNativePin = false;
        suppressNextPinClick = false;
      }, 50);
    }
    async function handleGlobalChoice(conversationId, threadKey, _projectId, wasGlobalPinned, nativePinButton) {
      if (!bridge.isAvailable()) {
        c.statusToast("Bridge unavailable");
        return;
      }
      try {
        const actions = pinScopeChoiceActions({
          choice: "global",
          globallyPinned: wasGlobalPinned,
          projectPinned: isProjectPinned(conversationId)
        });
        for (const action of actions) {
          if (disposed) return;
          if (action === "unpin-project") {
            await unpinFromProject(conversationId);
            if (disposed) return;
            syncProjectPinVisuals();
          } else if (action === "unpin-global") {
            await setGlobalPinState(threadKey, false, nativePinButton);
          } else if (action === "pin-global") {
            await setGlobalPinState(threadKey, true, nativePinButton);
          }
          if (disposed) return;
        }
        if (disposed) return;
        c.statusToast(
          wasGlobalPinned ? "Unpinned globally" : "Pinned globally"
        );
        scheduleProjectPinReconcile();
      } catch (err) {
        if (disposed) return;
        log.error("global pin failed", err);
        c.statusToast("Failed to update global pin");
      }
    }
    async function handleProjectChoice(conversationId, threadKey, projectId, wasProjectPinned, nativePinButton) {
      if (!bridge.isAvailable()) {
        c.statusToast("Bridge unavailable");
        return;
      }
      try {
        const actions = pinScopeChoiceActions({
          choice: "project",
          globallyPinned: await isGloballyPinned(threadKey),
          projectPinned: wasProjectPinned
        });
        for (const action of actions) {
          if (disposed) return;
          if (action === "unpin-global") {
            await setGlobalPinState(threadKey, false, nativePinButton);
          } else if (action === "unpin-project") {
            await unpinFromProject(conversationId);
          } else if (action === "pin-project") {
            await pinToProject(
              threadKey,
              conversationId,
              projectId,
              nativePinButton
            );
          }
          if (disposed) return;
        }
        if (disposed) return;
        c.statusToast(
          wasProjectPinned ? "Unpinned from project" : "Pinned to project"
        );
        if (wasProjectPinned) scheduleProjectPinReconcile();
      } catch (err) {
        if (disposed) return;
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
        const assignmentProjectId = ctx.projectId ? null : await getProjectIdForThread(ctx.threadKey, ctx.conversationId);
        if (disposed) return false;
        const projectId = ctx.projectId ?? assignmentProjectId;
        if (!projectId) return false;
        const globalPinned = await isGloballyPinned(ctx.threadKey);
        if (disposed) return false;
        const projectPinned = !globalPinned && isProjectPinned(ctx.conversationId) && projectIdForPinned(ctx.conversationId) === projectId;
        openMenu(ctx.pinButton, {
          conversationId: ctx.conversationId,
          threadKey: ctx.threadKey,
          projectId,
          globalPinned,
          projectPinned,
          nativePinButton: ctx.nativePinButton
        });
        return true;
      } catch (err) {
        if (!disposed) log.warn("pin scope menu state lookup failed", err);
        return false;
      }
    }
    async function activatePinScopeFromEvent(event, { fromClick = false } = {}) {
      if (allowNativePin) return;
      if (!fromClick && event.button !== 0) return;
      if (menuOpen) return;
      const anchor = findPinScopeAnchor(event.target);
      if (!anchor) return;
      const ctx = resolvePinContext(anchor);
      if (!ctx) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (fromClick) {
        if (suppressNextPinClick) {
          suppressNextPinClick = false;
          return;
        }
      } else {
        suppressNextPinClick = true;
      }
      const opened = await openMenuWithFreshState(ctx);
      if (!opened) triggerNativePin(ctx.nativePinButton ?? ctx.pinButton);
    }
    function onPinPointerDown(event) {
      void activatePinScopeFromEvent(event);
    }
    function onPinClick(event) {
      void activatePinScopeFromEvent(event, { fromClick: true });
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
      void flushProjectPinReorder();
    });
    void hydrateProjectPins().then(() => {
      if (disposed) return;
      return reconcileExclusivePins();
    }).then(() => {
      if (disposed) return;
      return flushProjectPinReorder();
    }).catch((err) => {
      if (!disposed) log.warn("initial project pin hydrate failed", err);
    });
    log.info("pin scope menu attached");
    return () => {
      if (disposed) return;
      disposed = true;
      log.info("teardown");
      closeMenu();
      if (reconcileTimer != null) {
        global.clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      for (const timeoutId of pendingTimeouts) {
        global.clearTimeout(timeoutId);
        pendingDelayResolvers.get(timeoutId)?.();
      }
      pendingTimeouts.clear();
      pendingDelayResolvers.clear();
      sidebarObserver?.disconnect();
      sidebarObserver = null;
      unsubscribeSidebar?.();
      unsubscribeSidebar = null;
      global.removeEventListener("pointerdown", onPinPointerDown, true);
      global.removeEventListener("click", onPinClick, true);
      global.removeEventListener("keydown", onKeyDown, true);
      for (const indicator of document.querySelectorAll("[data-explodex-project-pin-indicator]")) {
        indicator.remove();
      }
      for (const row of document.querySelectorAll(
        '[data-explodex-project-pinned="true"]'
      )) {
        row.removeAttribute("data-explodex-project-pinned");
      }
      pinStyleElement?.remove();
      pinStyleElement = null;
    };
  }
  var index_default = definePlugin({
    setup(api) {
      return setupProjectPins(api);
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
    register("project-pins", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
