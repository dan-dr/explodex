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

  // src/search.ts
  var SORT_LABELS = {
    pinned: "Pinned",
    match: "Best match",
    recent: "Recently active"
  };
  var DEFAULT_SORT_BY = [
    "pinned",
    "recent",
    "match"
  ];
  var NATIVE_STATE_OWNER_ATTR = "data-explodex-native-state-owner";
  var NATIVE_GROUP_ORDER_ATTR = "data-explodex-native-group-order";
  var NATIVE_HEADING_PRESENT_ATTR = "data-explodex-native-heading-present";
  var NATIVE_HEADING_TEXT_ATTR = "data-explodex-native-heading-text";
  var NATIVE_HEADING_STYLE_ATTR = "data-explodex-native-heading-style";
  function directCommandMenuGroups(list) {
    return [...list.querySelectorAll(":scope > [cmdk-group]")].filter(
      (group) => group.getAttribute("data-explodex-managed") !== "true"
    );
  }
  function rememberNativeCommandMenuState(list, ownerToken) {
    const priorOwner = list.getAttribute(NATIVE_STATE_OWNER_ATTR);
    if (priorOwner === ownerToken) return;
    const groups = directCommandMenuGroups(list);
    if (priorOwner === null) {
      groups.forEach((group, index) => {
        group.setAttribute(NATIVE_GROUP_ORDER_ATTR, String(index));
        const heading = group.querySelector("[cmdk-group-heading]");
        if (heading === null) {
          group.setAttribute(NATIVE_HEADING_PRESENT_ATTR, "false");
          return;
        }
        group.setAttribute(NATIVE_HEADING_PRESENT_ATTR, "true");
        group.setAttribute(
          NATIVE_HEADING_TEXT_ATTR,
          heading.textContent ?? ""
        );
        const style = heading.getAttribute("style");
        group.setAttribute(
          NATIVE_HEADING_STYLE_ATTR,
          style ?? "__absent__"
        );
      });
    }
    list.setAttribute(NATIVE_STATE_OWNER_ATTR, ownerToken);
  }
  function restoreNativeCommandMenuState(list, ownerToken) {
    if (list === null || list.getAttribute(NATIVE_STATE_OWNER_ATTR) !== ownerToken) {
      return false;
    }
    const tracked = directCommandMenuGroups(list).filter((group) => group.hasAttribute(NATIVE_GROUP_ORDER_ATTR)).sort(
      (left, right) => Number(left.getAttribute(NATIVE_GROUP_ORDER_ATTR)) - Number(right.getAttribute(NATIVE_GROUP_ORDER_ATTR))
    );
    for (const group of tracked) list.appendChild(group);
    for (const group of tracked) {
      if (group.getAttribute(NATIVE_HEADING_PRESENT_ATTR) === "true") {
        const heading = group.querySelector("[cmdk-group-heading]");
        if (heading !== null) {
          heading.textContent = group.getAttribute(NATIVE_HEADING_TEXT_ATTR) ?? "";
          const style = group.getAttribute(NATIVE_HEADING_STYLE_ATTR);
          if (style === "__absent__" || style === null) {
            heading.removeAttribute("style");
          } else {
            heading.setAttribute("style", style);
          }
        }
      }
      group.removeAttribute(NATIVE_GROUP_ORDER_ATTR);
      group.removeAttribute(NATIVE_HEADING_PRESENT_ATTR);
      group.removeAttribute(NATIVE_HEADING_TEXT_ATTR);
      group.removeAttribute(NATIVE_HEADING_STYLE_ATTR);
    }
    list.removeAttribute(NATIVE_STATE_OWNER_ATTR);
    return true;
  }
  function defaultCommandMenuThreadSettings() {
    return {
      maxThreads: 5,
      minChars: 2,
      sortBy: [...DEFAULT_SORT_BY],
      showRecentOnOpen: false
    };
  }
  function normalizeCommandMenuThreadSettings(raw) {
    const defaults = defaultCommandMenuThreadSettings();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return defaults;
    }
    const record = raw;
    const maxThreads = Math.min(
      10,
      Math.max(
        1,
        Math.floor(Number(record.maxThreads) || defaults.maxThreads)
      )
    );
    const minChars = Math.min(
      4,
      Math.max(1, Math.floor(Number(record.minChars) || defaults.minChars))
    );
    const requested = Array.isArray(record.sortBy) ? record.sortBy.filter(
      (key) => typeof key === "string" && key in SORT_LABELS
    ) : defaults.sortBy;
    const sortBy = [];
    for (const key of [...requested, ...DEFAULT_SORT_BY]) {
      if (!sortBy.includes(key)) sortBy.push(key);
    }
    return {
      maxThreads,
      minChars,
      sortBy,
      showRecentOnOpen: Boolean(record.showRecentOnOpen)
    };
  }
  function normalizeThreadQuery(value) {
    return String(value ?? "").trim().toLowerCase();
  }
  function scoreThreadTitle(title, query) {
    if (!query) return 0;
    let searchable;
    try {
      searchable = title.normalize("NFKD").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
    } catch {
      searchable = title.replace(/\s+/g, " ").trim().toLowerCase();
    }
    if (!searchable) return 0;
    if (searchable === query) return 100;
    if (searchable.startsWith(query)) return 80;
    if (searchable.includes(query)) return 60;
    return 0;
  }
  function filterThreads(threads, query, settings) {
    const normalized = normalizeThreadQuery(query);
    const compare = (left, right, hasQuery) => {
      for (const key of settings.sortBy) {
        if (key === "pinned" && left.thread.pinned !== right.thread.pinned) {
          return left.thread.pinned ? -1 : 1;
        }
        if (key === "recent" && left.thread.activityMs !== right.thread.activityMs) {
          return left.thread.activityMs - right.thread.activityMs;
        }
        if (key === "match" && hasQuery && left.score !== right.score) {
          return right.score - left.score;
        }
      }
      return left.thread.sidebarIndex - right.thread.sidebarIndex;
    };
    const deduplicate = (entries, hasQuery) => {
      const byConversation = /* @__PURE__ */ new Map();
      for (const entry of entries) {
        const prior = byConversation.get(entry.thread.conversationId);
        if (prior === void 0 || hasQuery && entry.score > prior.score || entry.score === prior.score && (entry.thread.pinned && !prior.thread.pinned || entry.thread.pinned === prior.thread.pinned && (entry.thread.activityMs < prior.thread.activityMs || entry.thread.activityMs === prior.thread.activityMs && entry.thread.sidebarIndex < prior.thread.sidebarIndex))) {
          byConversation.set(entry.thread.conversationId, entry);
        }
      }
      return [...byConversation.values()];
    };
    if (!normalized) {
      if (!settings.showRecentOnOpen) return [];
      return deduplicate(
        threads.map((thread) => ({ thread, score: 0 })),
        false
      ).sort((left, right) => compare(left, right, false)).slice(0, settings.maxThreads).map((entry) => entry.thread);
    }
    if (normalized.length < settings.minChars) return [];
    return deduplicate(
      threads.map((thread) => ({
        thread,
        score: scoreThreadTitle(thread.title, normalized)
      })),
      true
    ).filter((entry) => entry.score > 0).sort((left, right) => compare(left, right, true)).slice(0, settings.maxThreads).map((entry) => entry.thread);
  }
  function activateThreadSelection(options) {
    const row = (options.threadKey === null ? null : options.findRow(options.threadKey)) ?? options.findRow(`local:${options.conversationId}`);
    if (row !== null) {
      row.click();
    } else {
      options.navigate(`/local/${options.conversationId}`);
    }
    options.schedule(options.close);
    return row === null ? "route" : "row";
  }

  // src/index.ts
  var global = globalThis;
  var SETTINGS_KEY = "explodex-command-menu-threads";
  var INJECTED_GROUP_ID = "explodex-cmdk-threads-group";
  var THREADS_HEADING = "Threads";
  var INPUT_PLACEHOLDER = "Type command or search threads";
  var RELATIVE_ACTIVITY_RE = /^(\d+)(mo|w|d|h|m|s)$/i;
  var ACTIVITY_UNIT_MS = {
    s: 1e3,
    m: 6e4,
    h: 36e5,
    d: 864e5,
    w: 6048e5,
    mo: 2592e6
  };
  var THREAD_RESULT_HEADING_RE = /^(pinned chats|recent chats|recently viewed chats|threads)$/i;
  var LOCAL_THREAD_KEY_RE = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  var index_default = definePlugin({
    async setup(api) {
      const { bridge, flags, log, storage, components: c, registerOptions } = api;
      await api.migrate([
        {
          id: "rename-keys-from-command-menu-thread-search",
          run: ({ renameKey }) => {
            renameKey("explodex-cmdk-thread-search", SETTINGS_KEY);
          }
        }
      ]);
      let settings = normalizeCommandMenuThreadSettings(
        storage.persisted.get(SETTINGS_KEY, null)
      );
      function saveSettings() {
        storage.persisted.set(SETTINGS_KEY, settings);
      }
      function loadSettings() {
        settings = normalizeCommandMenuThreadSettings(
          storage.persisted.get(SETTINGS_KEY, null)
        );
      }
      let bodyObserver = null;
      let listObserver = null;
      let activeDialog = null;
      let activeMenuMode = "root";
      let rafId = null;
      let inputListener = null;
      let keydownListener = null;
      let enhancing = false;
      let observerPaused = false;
      let lastSelectedValue = null;
      let cachedQueryClient = null;
      let threadCatalog = null;
      let lastRenderedQuery = null;
      let lastRenderedThreadIds = null;
      let disposed = false;
      const pendingFrames = /* @__PURE__ */ new Set();
      const CMDK_ITEM_SELECT = "cmdk-item-select";
      function scheduleFrame(callback) {
        const frame = global.requestAnimationFrame(() => {
          pendingFrames.delete(frame);
          if (!disposed) callback();
        });
        pendingFrames.add(frame);
        return frame;
      }
      function cancelFrame(frame) {
        if (frame === null) return;
        pendingFrames.delete(frame);
        global.cancelAnimationFrame(frame);
      }
      function commandMenuDialog() {
        return document.querySelector(".global-command-menu-dialog [cmdk-root]") ?? document.querySelector(".command-menu-dialog [cmdk-root]") ?? document.querySelector(".global-command-menu-dialog [data-cmdk-root]") ?? document.querySelector(".command-menu-dialog [data-cmdk-root]");
      }
      function commandMenuList(root) {
        return root?.querySelector("[cmdk-list]") ?? null;
      }
      function commandMenuMount(root) {
        return root?.querySelector("[cmdk-list] [cmdk-list-sizer]") ?? root?.querySelector("[cmdk-list-sizer]") ?? commandMenuList(root);
      }
      function commandMenuInput(root) {
        return root?.querySelector("[cmdk-input]") ?? null;
      }
      function navigableItems(root) {
        return [
          ...commandMenuMount(root)?.querySelectorAll('[cmdk-item]:not([aria-disabled="true"])') ?? []
        ];
      }
      function selectCmdkItem(root, item) {
        if (!root || !item) return;
        const value = item.getAttribute("data-value");
        lastSelectedValue = value;
        for (const el of navigableItems(root)) {
          const selected = el === item;
          el.setAttribute("aria-selected", selected ? "true" : "false");
          if (selected) el.setAttribute("data-selected", "true");
          else el.removeAttribute("data-selected");
        }
        if (!item.id) {
          item.id = `explodex-thread-option-${item.getAttribute("data-explodex-thread-id") ?? "item"}`;
        }
        commandMenuInput(root)?.setAttribute("aria-activedescendant", item.id);
      }
      function focusFirstThreadItem(root) {
        const first = commandMenuMount(root)?.querySelector(
          `#${INJECTED_GROUP_ID} [data-explodex-thread-item]`
        );
        if (first) selectCmdkItem(root, first);
      }
      function normalizeQuery(value) {
        return normalizeThreadQuery(value);
      }
      function conversationIdFromThreadKey(threadKey) {
        if (!threadKey) return null;
        const match = String(threadKey).match(LOCAL_THREAD_KEY_RE);
        return match ? match[1] : null;
      }
      function getQueryClient() {
        if (cachedQueryClient) return cachedQueryClient;
        cachedQueryClient = flags.getQueryClient();
        return cachedQueryClient;
      }
      function findQueryEntry(prefix) {
        const queryClient = getQueryClient();
        if (!queryClient) return null;
        let best = null;
        for (const query of queryClient.getQueryCache().getAll()) {
          const key = query.queryKey;
          if (!Array.isArray(key) || key[0] !== prefix) continue;
          const data = query.state?.data;
          if (data == null) continue;
          if (!best || (query.state.dataUpdatedAt ?? 0) >= (best.updatedAt ?? 0)) {
            best = { data, updatedAt: query.state.dataUpdatedAt ?? 0 };
          }
        }
        return best;
      }
      function findQueryCacheData(prefix) {
        return findQueryEntry(prefix)?.data ?? null;
      }
      function resetThreadCatalog() {
        threadCatalog = null;
        lastRenderedQuery = null;
        lastRenderedThreadIds = null;
      }
      function localThreadKey(conversationId) {
        return conversationId ? `local:${conversationId}` : null;
      }
      function normalizeConversationId(value) {
        if (!value) return null;
        const text = String(value);
        return conversationIdFromThreadKey(text) ?? (/^[0-9a-f-]{36}$/i.test(text) ? text : null);
      }
      function readPinnedThreadKeys() {
        const pinnedData = findQueryCacheData("list-pinned-threads");
        const threadIds = pinnedData?.threadIds;
        if (!Array.isArray(threadIds)) return /* @__PURE__ */ new Set();
        return new Set(threadIds.map((id) => String(id)));
      }
      function isPinnedThread(threadKey, conversationId, pinnedKeys) {
        return pinnedKeys.has(threadKey) || pinnedKeys.has(conversationId) || pinnedKeys.has(`local:${conversationId}`);
      }
      function titleFromConversationMeta(meta, sidebar) {
        const title = meta?.title ?? meta?.name;
        if (typeof title === "string" && title.trim()) {
          return title.replace(/\s+/g, " ").trim();
        }
        if (sidebar?.title) return sidebar.title;
        return "Untitled chat";
      }
      function activityMsFromTimestamp(timestamp) {
        const updatedAt = Number(timestamp);
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) return Number.POSITIVE_INFINITY;
        const ageMs = Date.now() - updatedAt;
        return ageMs >= 0 ? ageMs : Number.POSITIVE_INFINITY;
      }
      function activityMsFromMeta(meta) {
        const timestamp = meta?.recencyAt ?? meta?.updatedAt ?? meta?.createdAt;
        return activityMsFromTimestamp(timestamp);
      }
      function rowTitle(row) {
        const attrTitle = row.getAttribute("data-app-action-sidebar-thread-title");
        if (attrTitle) return attrTitle.replace(/\s+/g, " ").trim();
        const titleEl = row.querySelector("[data-app-action-sidebar-thread-title]") ?? row.querySelector(".truncate") ?? row.querySelector("span");
        const text = titleEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        return text || "Untitled chat";
      }
      function rowActivityMs(row) {
        const label = row.querySelector(".tabular-nums")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const match = label.match(RELATIVE_ACTIVITY_RE);
        if (!match) return Number.POSITIVE_INFINITY;
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const unitMs = ACTIVITY_UNIT_MS[unit];
        if (unitMs == null) return Number.POSITIVE_INFINITY;
        return amount * unitMs;
      }
      function sidebarThreadIndex() {
        const byConversationId = /* @__PURE__ */ new Map();
        for (const [sidebarIndex, row] of document.querySelectorAll("[data-app-action-sidebar-thread-id]").entries()) {
          const threadKey = row.getAttribute("data-app-action-sidebar-thread-id");
          const conversationId = conversationIdFromThreadKey(threadKey);
          if (!conversationId || byConversationId.has(conversationId)) continue;
          byConversationId.set(conversationId, {
            title: rowTitle(row),
            pinned: row.getAttribute("data-app-action-sidebar-thread-pinned") === "true",
            activityMs: rowActivityMs(row),
            sidebarIndex,
            threadKey
          });
        }
        return byConversationId;
      }
      function buildThreadCatalog() {
        const conversationsMeta = findQueryCacheData("recent-conversations-meta");
        const pinnedKeys = readPinnedThreadKeys();
        const sidebarById = sidebarThreadIndex();
        if (Array.isArray(conversationsMeta) && conversationsMeta.length > 0) {
          const threads2 = [];
          for (const [listIndex, meta] of conversationsMeta.entries()) {
            const conversationId = normalizeConversationId(meta?.id);
            if (!conversationId) continue;
            const threadKey = localThreadKey(conversationId);
            const sidebar = sidebarById.get(conversationId);
            threads2.push({
              conversationId,
              threadKey,
              title: titleFromConversationMeta(meta, sidebar),
              pinned: isPinnedThread(threadKey, conversationId, pinnedKeys) || sidebar?.pinned === true,
              activityMs: Math.min(activityMsFromMeta(meta), sidebar?.activityMs ?? Infinity),
              sidebarIndex: sidebar?.sidebarIndex ?? listIndex
            });
          }
          return threads2;
        }
        const threads = [];
        for (const [sidebarIndex, row] of document.querySelectorAll("[data-app-action-sidebar-thread-id]").entries()) {
          const threadKey = row.getAttribute("data-app-action-sidebar-thread-id");
          const conversationId = conversationIdFromThreadKey(threadKey);
          if (!conversationId) continue;
          threads.push({
            conversationId,
            threadKey,
            title: rowTitle(row),
            pinned: row.getAttribute("data-app-action-sidebar-thread-pinned") === "true" || isPinnedThread(threadKey, conversationId, pinnedKeys),
            activityMs: rowActivityMs(row),
            sidebarIndex
          });
        }
        return threads;
      }
      function getThreadCatalog() {
        if (threadCatalog) return threadCatalog;
        threadCatalog = buildThreadCatalog();
        return threadCatalog;
      }
      function filterThreads2(threads, query) {
        return filterThreads(threads, query, settings);
      }
      function renderOptionsPanel(container) {
        container.replaceChildren();
        const sortItems = settings.sortBy.map((id) => ({ id, label: SORT_LABELS[id] ?? id }));
        container.appendChild(
          c.fieldStack([
            c.numberField({
              label: "Max threads",
              value: settings.maxThreads,
              min: 1,
              max: 10,
              onChange: (value) => {
                settings.maxThreads = Math.min(10, Math.max(1, value));
                saveSettings();
              }
            }),
            c.numberField({
              label: "Min characters before searching",
              value: settings.minChars,
              min: 1,
              max: 4,
              onChange: (value) => {
                settings.minChars = Math.min(4, Math.max(1, value));
                saveSettings();
              }
            }),
            c.sortableList({
              label: "Sort by",
              items: sortItems,
              onReorder: (ids) => {
                settings.sortBy = ids.filter(
                  (id) => id in SORT_LABELS
                );
                saveSettings();
              }
            }),
            c.checkboxField({
              label: "Show recent threads when palette opens",
              checked: settings.showRecentOnOpen,
              onChange: (value) => {
                settings.showRecentOnOpen = value;
                saveSettings();
              }
            })
          ])
        );
      }
      registerOptions({ render: renderOptionsPanel });
      function updateInputPlaceholder(root) {
        const input = commandMenuInput(root);
        if (!input) return;
        if (input.dataset.explodexOriginalPlaceholder === void 0) {
          input.dataset.explodexOriginalPlaceholder = input.getAttribute("placeholder") ?? "__absent__";
        }
        input.dataset.explodexPlaceholderOwner = api.token;
        if (input.getAttribute("placeholder") !== INPUT_PLACEHOLDER) {
          input.setAttribute("placeholder", INPUT_PLACEHOLDER);
        }
        if (input.placeholder !== INPUT_PLACEHOLDER) {
          input.placeholder = INPUT_PLACEHOLDER;
        }
      }
      function restoreInputPlaceholder(root) {
        const input = commandMenuInput(root);
        if (!input || input.dataset.explodexPlaceholderOwner !== api.token) {
          return;
        }
        const original = input.dataset.explodexOriginalPlaceholder;
        if (original === "__absent__") input.removeAttribute("placeholder");
        else if (original !== void 0) input.setAttribute("placeholder", original);
        delete input.dataset.explodexPlaceholderOwner;
        delete input.dataset.explodexOriginalPlaceholder;
      }
      function detectMenuMode(list, query) {
        if (query) return activeMenuMode;
        return hasNativeThreadResults(list) ? "chats" : "root";
      }
      function closeCommandMenu() {
        const input = commandMenuInput(activeDialog);
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      }
      function openThread(conversationId, threadKey) {
        if (!conversationId) return;
        activateThreadSelection({
          conversationId,
          threadKey,
          findRow(key) {
            return document.querySelector(
              `[data-app-action-sidebar-thread-id="${key}"]`
            );
          },
          navigate(path) {
            void bridge.navigate(path);
          },
          close: closeCommandMenu,
          schedule(callback) {
            scheduleFrame(callback);
          }
        });
      }
      function removeInjectedGroup(root, includeForeign = false) {
        const group = commandMenuMount(root)?.querySelector(
          `#${INJECTED_GROUP_ID}`
        );
        if (group && (includeForeign || group.dataset.explodexGenerationOwner === api.token)) {
          group.remove();
        }
      }
      function createThreadItem(root, thread) {
        const item = document.createElement("div");
        item.id = `explodex-thread-option-${thread.conversationId}`;
        item.setAttribute("cmdk-item", "");
        item.setAttribute("role", "option");
        item.setAttribute("data-value", thread.title);
        item.setAttribute("data-explodex-thread-id", thread.conversationId);
        item.setAttribute("data-explodex-thread-item", "true");
        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = thread.title;
        item.appendChild(label);
        item.addEventListener("pointermove", () => selectCmdkItem(root, item));
        item.addEventListener(CMDK_ITEM_SELECT, () => {
          openThread(thread.conversationId, thread.threadKey);
        });
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectCmdkItem(root, item);
          openThread(thread.conversationId, thread.threadKey);
        });
        return item;
      }
      function syncInjectedThreads(root, threads) {
        removeInjectedGroup(root, true);
        const mount = commandMenuMount(root);
        if (!mount || threads.length === 0) return;
        const group = document.createElement("div");
        group.id = INJECTED_GROUP_ID;
        group.setAttribute("cmdk-group", "");
        group.setAttribute("data-explodex-threads-group", "true");
        group.setAttribute("data-explodex-managed", "true");
        group.dataset.explodexGenerationOwner = api.token;
        const heading = document.createElement("div");
        heading.setAttribute("cmdk-group-heading", "");
        heading.setAttribute("aria-hidden", "true");
        heading.className = "block px-2 pt-2 text-sm text-token-description-foreground";
        heading.textContent = THREADS_HEADING;
        group.appendChild(heading);
        const itemsWrap = document.createElement("div");
        itemsWrap.setAttribute("cmdk-group-items", "");
        itemsWrap.setAttribute("role", "group");
        for (const thread of threads) {
          itemsWrap.appendChild(createThreadItem(root, thread));
        }
        group.appendChild(itemsWrap);
        mount.insertBefore(group, mount.firstChild ?? null);
      }
      function injectedThreadsMatch(root, threads) {
        const group = commandMenuMount(root)?.querySelector(`#${INJECTED_GROUP_ID}`);
        if (!group) return threads.length === 0;
        const items = [...group.querySelectorAll("[data-explodex-thread-item]")];
        if (items.length !== threads.length) return false;
        return threads.every(
          (thread, index) => items[index]?.getAttribute("data-explodex-thread-id") === thread.conversationId
        );
      }
      function renderInjectedThreads(root, threads) {
        if (injectedThreadsMatch(root, threads)) return;
        syncInjectedThreads(root, threads);
      }
      function groupHeadingText(group) {
        return group.querySelector("[cmdk-group-heading]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      }
      function hasNativeThreadResults(list) {
        if (!list) return false;
        for (const item of list.querySelectorAll("[cmdk-item]")) {
          const value = item.getAttribute("data-value") ?? item.getAttribute("value") ?? "";
          if (value.includes("command-menu-quick-chat-result:") || value === "command-menu-first-chat-item" || item.hasAttribute("data-command-menu-empty-state")) {
            return true;
          }
        }
        return false;
      }
      function isThreadResultGroup(group) {
        if (group.id === INJECTED_GROUP_ID) return true;
        if (group.getAttribute("data-explodex-threads-group") === "true") return true;
        const heading = groupHeadingText(group);
        if (THREAD_RESULT_HEADING_RE.test(heading)) return true;
        for (const item of group.querySelectorAll("[cmdk-item]")) {
          const value = item.getAttribute("data-value") ?? item.getAttribute("value") ?? item.textContent ?? "";
          if (value.includes("command-menu-quick-chat-result:") || value.includes("command-menu-first-chat-item") || item.hasAttribute("data-command-menu-empty-state")) {
            return true;
          }
        }
        return false;
      }
      function relabelThreadGroups(groups) {
        let labeled = false;
        for (const group of groups) {
          const headingEl = group.querySelector("[cmdk-group-heading]");
          if (!headingEl) continue;
          const heading = groupHeadingText(group);
          if (!THREAD_RESULT_HEADING_RE.test(heading) && heading !== THREADS_HEADING) continue;
          if (!labeled) {
            headingEl.textContent = THREADS_HEADING;
            labeled = true;
          } else {
            headingEl.textContent = "";
            headingEl.style.display = "none";
          }
        }
      }
      function reorderThreadGroups(list) {
        if (!list) return;
        const groups = [...list.querySelectorAll("[cmdk-group]")];
        const threadGroups = groups.filter(isThreadResultGroup);
        const otherGroups = groups.filter((group) => !isThreadResultGroup(group));
        if (threadGroups.length === 0) return;
        rememberNativeCommandMenuState(list, api.token);
        relabelThreadGroups(threadGroups);
        const desired = [...threadGroups, ...otherGroups];
        const needsReorder = desired.some((group, index) => groups[index] !== group);
        if (!needsReorder) return;
        const fragment = document.createDocumentFragment();
        for (const group of threadGroups) fragment.appendChild(group);
        for (const group of otherGroups) fragment.appendChild(group);
        list.appendChild(fragment);
      }
      function pauseListObserver() {
        listObserver?.disconnect();
        observerPaused = true;
      }
      function resumeListObserver() {
        if (!listObserver || !activeDialog) {
          observerPaused = false;
          return;
        }
        const list = commandMenuList(activeDialog);
        if (!list) {
          observerPaused = false;
          return;
        }
        listObserver.observe(list, { childList: true, subtree: true });
        observerPaused = false;
      }
      function mutateCommandMenuList(mutator) {
        pauseListObserver();
        try {
          mutator();
        } finally {
          resumeListObserver();
        }
      }
      function enhanceCommandMenu() {
        if (enhancing || observerPaused) return;
        const root = commandMenuDialog();
        if (!root) return;
        activeDialog = root;
        const list = commandMenuList(root);
        const mount = commandMenuMount(root);
        if (!list || !mount) return;
        enhancing = true;
        try {
          updateInputPlaceholder(root);
          const query = normalizeQuery(commandMenuInput(root)?.value);
          activeMenuMode = detectMenuMode(mount, query);
          if (!query) {
            if (settings.showRecentOnOpen && activeMenuMode === "root") {
              const recentThreads = filterThreads2(getThreadCatalog(), "");
              const renderedIds2 = recentThreads.map((thread) => thread.conversationId).join(",");
              if (renderedIds2 !== lastRenderedThreadIds) {
                lastRenderedQuery = "";
                lastRenderedThreadIds = renderedIds2;
                mutateCommandMenuList(() => {
                  renderInjectedThreads(root, recentThreads);
                });
                if (recentThreads.length > 0) {
                  scheduleFrame(() => focusFirstThreadItem(root));
                }
              }
              return;
            }
            lastRenderedQuery = null;
            lastRenderedThreadIds = null;
            mutateCommandMenuList(() => {
              removeInjectedGroup(root);
              lastSelectedValue = null;
              if (activeMenuMode === "chats") reorderThreadGroups(mount);
            });
            return;
          }
          if (activeMenuMode === "chats") {
            mutateCommandMenuList(() => {
              removeInjectedGroup(root);
              reorderThreadGroups(mount);
            });
            return;
          }
          const sidebarThreads = filterThreads2(getThreadCatalog(), query);
          const renderedIds = sidebarThreads.map((thread) => thread.conversationId).join(",");
          if (query === lastRenderedQuery && renderedIds === lastRenderedThreadIds) return;
          lastRenderedQuery = query;
          lastRenderedThreadIds = renderedIds;
          mutateCommandMenuList(() => {
            renderInjectedThreads(root, sidebarThreads);
          });
          if (sidebarThreads.length > 0) {
            scheduleFrame(() => {
              focusFirstThreadItem(root);
            });
          }
        } catch (err) {
          log.warn("command menu enhance failed", err);
          try {
            removeInjectedGroup(activeDialog);
          } catch {
          }
        } finally {
          enhancing = false;
        }
      }
      function scheduleEnhance() {
        if (disposed || observerPaused || enhancing) return;
        if (rafId != null) cancelFrame(rafId);
        rafId = scheduleFrame(() => {
          rafId = null;
          enhanceCommandMenu();
        });
      }
      function bindInputListener(root) {
        unbindInputListener();
        const input = commandMenuInput(root);
        if (!input) return;
        inputListener = () => scheduleEnhance();
        input.addEventListener("input", inputListener);
        input.addEventListener("change", inputListener);
      }
      function unbindInputListener() {
        if (!inputListener || !activeDialog) return;
        const input = commandMenuInput(activeDialog);
        input?.removeEventListener("input", inputListener);
        input?.removeEventListener("change", inputListener);
        inputListener = null;
      }
      function bindKeydownListener(root) {
        unbindKeydownListener();
        keydownListener = (event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          const items = navigableItems(root);
          if (items.length === 0) return;
          let index = items.findIndex(
            (item) => item.getAttribute("aria-selected") === "true" || item.getAttribute("data-value") === lastSelectedValue
          );
          if (index < 0) index = 0;
          if (event.key === "ArrowDown") index = Math.min(index + 1, items.length - 1);
          else if (event.key === "ArrowUp") index = Math.max(index - 1, 0);
          else if (event.key === "Home") index = 0;
          else if (event.key === "End") index = items.length - 1;
          const targetIndex = index;
          scheduleFrame(() => {
            const fresh = navigableItems(root);
            const target = fresh[targetIndex];
            if (target) selectCmdkItem(root, target);
          });
        };
        root.addEventListener("keydown", keydownListener);
      }
      function unbindKeydownListener() {
        if (!keydownListener || !activeDialog) return;
        activeDialog.removeEventListener("keydown", keydownListener);
        keydownListener = null;
      }
      function bindListObserver(root) {
        unbindListObserver();
        const list = commandMenuList(root);
        if (!list) return;
        listObserver = new MutationObserver((records) => {
          if (observerPaused || enhancing) return;
          if (records.every(
            (record) => record.target instanceof Element && record.target.closest(`#${INJECTED_GROUP_ID}`)
          )) {
            return;
          }
          scheduleEnhance();
        });
        listObserver.observe(list, { childList: true, subtree: true });
        bindInputListener(root);
        bindKeydownListener(root);
        scheduleEnhance();
      }
      function unbindListObserver() {
        listObserver?.disconnect();
        listObserver = null;
        unbindInputListener();
        unbindKeydownListener();
      }
      function onDialogOpened(root) {
        if (activeDialog === root) {
          scheduleEnhance();
          return;
        }
        unbindListObserver();
        activeDialog = root;
        resetThreadCatalog();
        bindListObserver(root);
        scheduleFrame(() => {
          if (activeDialog === root) getThreadCatalog();
        });
      }
      function onDialogClosed() {
        const root = activeDialog;
        restoreInputPlaceholder(activeDialog);
        unbindListObserver();
        restoreNativeCommandMenuState(commandMenuMount(root), api.token);
        if (rafId != null) {
          cancelFrame(rafId);
          rafId = null;
        }
        activeDialog = null;
        activeMenuMode = "root";
        lastSelectedValue = null;
        cachedQueryClient = null;
        resetThreadCatalog();
      }
      function scanForCommandMenu() {
        const root = commandMenuDialog();
        if (root) {
          onDialogOpened(root);
          return;
        }
        if (activeDialog) onDialogClosed();
      }
      bodyObserver = new MutationObserver(scanForCommandMenu);
      bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
      loadSettings();
      scanForCommandMenu();
      log.info("command menu thread search attached");
      return () => {
        log.info("teardown");
        disposed = true;
        const root = activeDialog ?? commandMenuDialog();
        onDialogClosed();
        bodyObserver?.disconnect();
        bodyObserver = null;
        removeInjectedGroup(root);
        for (const frame of pendingFrames) {
          global.cancelAnimationFrame(frame);
        }
        pendingFrames.clear();
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
    register("command-menu-threads", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
