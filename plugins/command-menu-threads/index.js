// @ts-check
/// <reference path="../../sdk/explodex-sdk.d.ts" />
/**
 * Merges Cmd+G-style thread search into the Cmd+K command palette.
 * Threads render first under a "Threads" header; commands follow unchanged.
 */
(function registerCommandMenuThreadSearch(global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) {
    console.warn("[command-menu-threads] Explodex SDK not loaded");
    return;
  }

  const PLUGIN_ID = "command-menu-threads";
  const SETTINGS_KEY = "explodex-command-menu-threads";
  const INJECTED_GROUP_ID = "explodex-cmdk-threads-group";
  const THREADS_HEADING = "Threads";
  const INPUT_PLACEHOLDER = "Type command or search threads";
  const SORT_LABELS = {
    pinned: "Pinned",
    match: "Best match",
    recent: "Recently active",
  };
  const DEFAULT_SORT_BY = ["pinned", "recent", "match"];

  const RELATIVE_ACTIVITY_RE = /^(\d+)(mo|w|d|h|m|s)$/i;
  const ACTIVITY_UNIT_MS = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
  };

  const THREAD_RESULT_HEADING_RE =
    /^(pinned chats|recent chats|recently viewed chats|threads)$/i;
  const LOCAL_THREAD_KEY_RE =
    /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

  Explodex.plugins.register(
    {
      id: PLUGIN_ID,
      name: "Threads in Command Menu",
      version: "1.1.0",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { bridge, log, storage, components: c, registerOptions } = api;

      api.migrate([
        {
          id: "rename-keys-from-command-menu-thread-search",
          run: ({ renameKey }) =>
            renameKey("explodex-cmdk-thread-search", SETTINGS_KEY),
        },
      ]);

      function defaultSettings() {
        return {
          maxThreads: 5,
          minChars: 2,
          sortBy: [...DEFAULT_SORT_BY],
          showRecentOnOpen: false,
        };
      }

      function normalizeSettings(raw) {
        const base = defaultSettings();
        if (!raw || typeof raw !== "object") return base;
        const maxThreads = Math.min(10, Math.max(1, Math.floor(Number(raw.maxThreads) || base.maxThreads)));
        const minChars = Math.min(4, Math.max(1, Math.floor(Number(raw.minChars) || base.minChars)));
        const sortBy = Array.isArray(raw.sortBy)
          ? raw.sortBy.filter((key) => key in SORT_LABELS)
          : base.sortBy;
        const ordered = [];
        for (const key of sortBy) {
          if (!ordered.includes(key)) ordered.push(key);
        }
        for (const key of DEFAULT_SORT_BY) {
          if (!ordered.includes(key)) ordered.push(key);
        }
        return {
          maxThreads,
          minChars,
          sortBy: ordered,
          showRecentOnOpen: Boolean(raw.showRecentOnOpen),
        };
      }

      let settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));

      function saveSettings() {
        storage.persisted.set(SETTINGS_KEY, settings);
      }

      function loadSettings() {
        settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));
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
      /** @type {ReturnType<typeof buildThreadCatalog> | null} */
      let threadCatalog = null;
      let lastRenderedQuery = null;
      let lastRenderedThreadIds = null;
      const CMDK_ITEM_SELECT = "cmdk-item-select";

      function commandMenuDialog() {
        return (
          document.querySelector(".global-command-menu-dialog [cmdk-root]") ??
          document.querySelector(".command-menu-dialog [cmdk-root]") ??
          document.querySelector(".global-command-menu-dialog [data-cmdk-root]") ??
          document.querySelector(".command-menu-dialog [data-cmdk-root]")
        );
      }

      function commandMenuList(root) {
        return root?.querySelector("[cmdk-list]") ?? null;
      }

      function commandMenuMount(root) {
        return (
          root?.querySelector("[cmdk-list] [cmdk-list-sizer]") ??
          root?.querySelector("[cmdk-list-sizer]") ??
          commandMenuList(root)
        );
      }

      function commandMenuInput(root) {
        return root?.querySelector("[cmdk-input]") ?? null;
      }

      function navigableItems(root) {
        return [
          ...commandMenuMount(root)?.querySelectorAll('[cmdk-item]:not([aria-disabled="true"])') ??
            [],
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
          `#${INJECTED_GROUP_ID} [data-explodex-thread-item]`,
        );
        if (first) selectCmdkItem(root, first);
      }

      function normalizeQuery(value) {
        return String(value ?? "").trim().toLowerCase();
      }

      function conversationIdFromThreadKey(threadKey) {
        if (!threadKey) return null;
        const match = String(threadKey).match(LOCAL_THREAD_KEY_RE);
        return match ? match[1] : null;
      }

      function reactFiber(host) {
        if (!host) return null;
        const key = Object.keys(host).find(
          (k) => k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"),
        );
        return key ? host[key] : null;
      }

      function getQueryClient() {
        if (cachedQueryClient) return cachedQueryClient;
        let fiber = reactFiber(document.querySelector("nav") ?? document.documentElement);
        for (let depth = 0; depth < 200 && fiber; depth += 1) {
          const client = fiber.memoizedProps?.value;
          if (client?.getQueryCache && client?.setQueryData) {
            cachedQueryClient = client;
            return client;
          }
          fiber = fiber.return;
        }
        return null;
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
        if (!Array.isArray(threadIds)) return new Set();
        return new Set(threadIds.map((id) => String(id)));
      }

      function isPinnedThread(threadKey, conversationId, pinnedKeys) {
        return (
          pinnedKeys.has(threadKey) ||
          pinnedKeys.has(conversationId) ||
          pinnedKeys.has(`local:${conversationId}`)
        );
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

        const titleEl =
          row.querySelector("[data-app-action-sidebar-thread-title]") ??
          row.querySelector(".truncate") ??
          row.querySelector("span");
        const text = titleEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        return text || "Untitled chat";
      }

      function rowActivityMs(row) {
        const label =
          row.querySelector(".tabular-nums")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const match = label.match(RELATIVE_ACTIVITY_RE);
        if (!match) return Number.POSITIVE_INFINITY;

        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const unitMs = ACTIVITY_UNIT_MS[unit];
        if (unitMs == null) return Number.POSITIVE_INFINITY;
        return amount * unitMs;
      }

      function sidebarThreadIndex() {
        const byConversationId = new Map();
        for (const [sidebarIndex, row] of document
          .querySelectorAll("[data-app-action-sidebar-thread-id]")
          .entries()) {
          const threadKey = row.getAttribute("data-app-action-sidebar-thread-id");
          const conversationId = conversationIdFromThreadKey(threadKey);
          if (!conversationId || byConversationId.has(conversationId)) continue;
          byConversationId.set(conversationId, {
            title: rowTitle(row),
            pinned: row.getAttribute("data-app-action-sidebar-thread-pinned") === "true",
            activityMs: rowActivityMs(row),
            sidebarIndex,
            threadKey,
          });
        }
        return byConversationId;
      }

      function buildThreadCatalog() {
        const conversationsMeta = findQueryCacheData("recent-conversations-meta");
        const pinnedKeys = readPinnedThreadKeys();
        const sidebarById = sidebarThreadIndex();

        if (Array.isArray(conversationsMeta) && conversationsMeta.length > 0) {
          const threads = [];
          for (const [listIndex, meta] of conversationsMeta.entries()) {
            const conversationId = normalizeConversationId(meta?.id);
            if (!conversationId) continue;

            const threadKey = localThreadKey(conversationId);
            const sidebar = sidebarById.get(conversationId);

            threads.push({
              conversationId,
              threadKey,
              title: titleFromConversationMeta(meta, sidebar),
              pinned:
                isPinnedThread(threadKey, conversationId, pinnedKeys) || sidebar?.pinned === true,
              activityMs: Math.min(activityMsFromMeta(meta), sidebar?.activityMs ?? Infinity),
              sidebarIndex: sidebar?.sidebarIndex ?? listIndex,
            });
          }
          return threads;
        }

        const threads = [];
        for (const [sidebarIndex, row] of document
          .querySelectorAll("[data-app-action-sidebar-thread-id]")
          .entries()) {
          const threadKey = row.getAttribute("data-app-action-sidebar-thread-id");
          const conversationId = conversationIdFromThreadKey(threadKey);
          if (!conversationId) continue;

          threads.push({
            conversationId,
            threadKey,
            title: rowTitle(row),
            pinned:
              row.getAttribute("data-app-action-sidebar-thread-pinned") === "true" ||
              isPinnedThread(threadKey, conversationId, pinnedKeys),
            activityMs: rowActivityMs(row),
            sidebarIndex,
          });
        }
        return threads;
      }

      function getThreadCatalog() {
        if (threadCatalog) return threadCatalog;
        threadCatalog = buildThreadCatalog();
        return threadCatalog;
      }

      function searchableTitle(title) {
        try {
          return String(title)
            .normalize("NFKD")
            .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        } catch {
          return String(title).replace(/\s+/g, " ").trim().toLowerCase();
        }
      }

      function scoreThread(title, query) {
        if (!query) return 0;
        const hay = searchableTitle(title);
        if (!hay) return 0;
        if (hay === query) return 100;
        if (hay.startsWith(query)) return 80;
        if (hay.includes(query)) return 60;
        return 0;
      }

      function compareThreadEntries(a, b, { hasQuery = true } = {}) {
        for (const key of settings.sortBy) {
          let cmp = 0;
          if (key === "pinned" && a.thread.pinned !== b.thread.pinned) {
            cmp = a.thread.pinned ? -1 : 1;
          } else if (key === "recent" && a.thread.activityMs !== b.thread.activityMs) {
            cmp = a.thread.activityMs - b.thread.activityMs;
          } else if (key === "match" && hasQuery && b.score !== a.score) {
            cmp = b.score - a.score;
          }
          if (cmp !== 0) return cmp;
        }
        return a.thread.sidebarIndex - b.thread.sidebarIndex;
      }

      function filterThreads(threads, query) {
        const normalized = normalizeQuery(query);
        if (!normalized) {
          if (!settings.showRecentOnOpen) return [];
          return threads
            .map((thread) => ({ thread, score: 0 }))
            .sort((a, b) => compareThreadEntries(a, b, { hasQuery: false }))
            .slice(0, settings.maxThreads)
            .map((entry) => entry.thread);
        }
        if (normalized.length < settings.minChars) return [];
        return threads
          .map((thread) => ({ thread, score: scoreThread(thread.title, normalized) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => compareThreadEntries(a, b, { hasQuery: true }))
          .slice(0, settings.maxThreads)
          .map((entry) => entry.thread);
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
              },
            }),
            c.numberField({
              label: "Min characters before searching",
              value: settings.minChars,
              min: 1,
              max: 4,
              onChange: (value) => {
                settings.minChars = Math.min(4, Math.max(1, value));
                saveSettings();
              },
            }),
            c.sortableList({
              label: "Sort by",
              items: sortItems,
              onReorder: (ids) => {
                settings.sortBy = ids.filter((id) => id in SORT_LABELS);
                saveSettings();
              },
            }),
            c.checkboxField({
              label: "Show recent threads when palette opens",
              checked: settings.showRecentOnOpen,
              onChange: (value) => {
                settings.showRecentOnOpen = value;
                saveSettings();
              },
            }),
          ]),
        );
      }

      registerOptions({ render: renderOptionsPanel });

      function updateInputPlaceholder(root) {
        const input = commandMenuInput(root);
        if (!input) return;
        if (input.getAttribute("placeholder") !== INPUT_PLACEHOLDER) {
          input.setAttribute("placeholder", INPUT_PLACEHOLDER);
        }
        if ("placeholder" in input && input.placeholder !== INPUT_PLACEHOLDER) {
          input.placeholder = INPUT_PLACEHOLDER;
        }
      }

      function detectMenuMode(list, query) {
        if (query) return activeMenuMode;
        return hasNativeThreadResults(list) ? "chats" : "root";
      }

      function closeCommandMenu() {
        const input = commandMenuInput(activeDialog);
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      }

      function openThread(conversationId, threadKey) {
        if (!conversationId) return;

        const row =
          (threadKey
            ? document.querySelector(`[data-app-action-sidebar-thread-id="${threadKey}"]`)
            : null) ??
          document.querySelector(`[data-app-action-sidebar-thread-id="local:${conversationId}"]`);

        if (row) {
          row.click();
        } else {
          void bridge.navigate(`/local/${conversationId}`);
        }

        global.requestAnimationFrame(() => closeCommandMenu());
      }

      function removeInjectedGroup(root) {
        commandMenuMount(root)?.querySelector(`#${INJECTED_GROUP_ID}`)?.remove();
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
        removeInjectedGroup(root);
        const mount = commandMenuMount(root);
        if (!mount || threads.length === 0) return;

        const group = document.createElement("div");
        group.id = INJECTED_GROUP_ID;
        group.setAttribute("cmdk-group", "");
        group.setAttribute("data-explodex-threads-group", "true");
        group.setAttribute("data-explodex-managed", "true");

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
          (thread, index) =>
            items[index]?.getAttribute("data-explodex-thread-id") === thread.conversationId,
        );
      }

      function renderInjectedThreads(root, threads) {
        if (injectedThreadsMatch(root, threads)) return;
        syncInjectedThreads(root, threads);
      }

      function groupHeadingText(group) {
        return (
          group.querySelector("[cmdk-group-heading]")?.textContent?.replace(/\s+/g, " ").trim() ??
          ""
        );
      }

      function hasNativeThreadResults(list) {
        if (!list) return false;
        for (const item of list.querySelectorAll("[cmdk-item]")) {
          const value =
            item.getAttribute("data-value") ??
            item.getAttribute("value") ??
            "";
          if (
            value.includes("command-menu-quick-chat-result:") ||
            value === "command-menu-first-chat-item" ||
            item.hasAttribute("data-command-menu-empty-state")
          ) {
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
          const value =
            item.getAttribute("data-value") ??
            item.getAttribute("value") ??
            item.textContent ??
            "";
          if (
            value.includes("command-menu-quick-chat-result:") ||
            value.includes("command-menu-first-chat-item") ||
            item.hasAttribute("data-command-menu-empty-state")
          ) {
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
              const recentThreads = filterThreads(getThreadCatalog(), "");
              const renderedIds = recentThreads.map((thread) => thread.conversationId).join(",");
              if (renderedIds !== lastRenderedThreadIds) {
                lastRenderedQuery = "";
                lastRenderedThreadIds = renderedIds;
                mutateCommandMenuList(() => {
                  renderInjectedThreads(root, recentThreads);
                });
                if (recentThreads.length > 0) {
                  global.requestAnimationFrame(() => focusFirstThreadItem(root));
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

          const sidebarThreads = filterThreads(getThreadCatalog(), query);
          const renderedIds = sidebarThreads.map((thread) => thread.conversationId).join(",");
          if (query === lastRenderedQuery && renderedIds === lastRenderedThreadIds) return;

          lastRenderedQuery = query;
          lastRenderedThreadIds = renderedIds;
          mutateCommandMenuList(() => {
            renderInjectedThreads(root, sidebarThreads);
          });
          if (sidebarThreads.length > 0) {
            global.requestAnimationFrame(() => {
              focusFirstThreadItem(root);
            });
          }
        } catch (err) {
          log.warn("command menu enhance failed", err);
          try {
            removeInjectedGroup(activeDialog);
          } catch {
            // ignore cleanup failures
          }
        } finally {
          enhancing = false;
        }
      }

      function scheduleEnhance() {
        if (observerPaused || enhancing) return;
        if (rafId != null) global.cancelAnimationFrame(rafId);
        rafId = global.requestAnimationFrame(() => {
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
            (item) =>
              item.getAttribute("aria-selected") === "true" ||
              item.getAttribute("data-value") === lastSelectedValue,
          );
          if (index < 0) index = 0;

          if (event.key === "ArrowDown") index = Math.min(index + 1, items.length - 1);
          else if (event.key === "ArrowUp") index = Math.max(index - 1, 0);
          else if (event.key === "Home") index = 0;
          else if (event.key === "End") index = items.length - 1;

          const targetIndex = index;
          global.requestAnimationFrame(() => {
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
          if (records.every((record) => record.target.closest?.(`#${INJECTED_GROUP_ID}`))) return;
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
        global.requestAnimationFrame(() => {
          if (activeDialog === root) getThreadCatalog();
        });
      }

      function onDialogClosed() {
        unbindListObserver();
        if (rafId != null) {
          global.cancelAnimationFrame(rafId);
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
        onDialogClosed();
        bodyObserver?.disconnect();
        bodyObserver = null;
        removeInjectedGroup(commandMenuDialog());
      };
    },
  );
})(window);