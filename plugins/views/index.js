// @ts-check
/// <reference path="../../sdk/explodex-sdk.d.ts" />

(function registerViewsPlugin(global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) return;

  const PLUGIN_ID = "views";
  const STORAGE_KEY = "explodex-views-v1";
  const SETTINGS_KEY = "explodex-views-settings";
  const ASSIGNMENTS_KEY = "thread-project-assignments";
  const LOCAL_THREAD_RE = /^(?:local:)?([0-9a-f-]{36})$/i;

  Explodex.plugins.register(
    {
      id: PLUGIN_ID,
      name: "Views",
      version: "1.0.0",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { bridge, components, storage, log, registerOptions } = api;

      function defaultPluginSettings() {
        return {
          showSidebar: true,
          projectViewThreadCount: 4,
          showProjectContextMenu: true,
        };
      }

      function normalizePluginSettings(raw) {
        const base = defaultPluginSettings();
        if (!raw || typeof raw !== "object") return base;
        return {
          showSidebar: raw.showSidebar !== false,
          projectViewThreadCount: Math.min(
            8,
            Math.max(1, Math.floor(Number(raw.projectViewThreadCount) || base.projectViewThreadCount)),
          ),
          showProjectContextMenu: raw.showProjectContextMenu !== false,
        };
      }

      let pluginSettings = normalizePluginSettings(storage.persisted.get(SETTINGS_KEY, null));

      function savePluginSettings() {
        storage.persisted.set(SETTINGS_KEY, pluginSettings);
      }

      function loadPluginSettings() {
        pluginSettings = normalizePluginSettings(storage.persisted.get(SETTINGS_KEY, null));
      }

      function renderOptionsPanel(container) {
        container.replaceChildren();
        container.appendChild(
          components.fieldStack([
            components.checkboxField({
              label: "Show Views section in sidebar",
              checked: pluginSettings.showSidebar,
              onChange: (value) => {
                pluginSettings.showSidebar = value;
                savePluginSettings();
                if (!value) document.querySelector("[data-explodex-views-sidebar]")?.remove();
                else scheduleSidebar();
              },
            }),
            components.checkboxField({
              label: '"Open project view" in project context menu',
              checked: pluginSettings.showProjectContextMenu,
              onChange: (value) => {
                pluginSettings.showProjectContextMenu = value;
                savePluginSettings();
              },
            }),
            components.numberField({
              label: "Threads in project view",
              value: pluginSettings.projectViewThreadCount,
              min: 1,
              max: 8,
              onChange: (value) => {
                pluginSettings.projectViewThreadCount = Math.min(8, Math.max(1, value));
                savePluginSettings();
              },
            }),
          ]),
        );
      }

      registerOptions({ render: renderOptionsPanel });
      loadPluginSettings();

      let disposed = false;
      let activeViewId = null;
      let root = null;
      let dock = null;
      let layoutSaveTimer = null;
      let sidebarFrame = null;
      let refreshFrame = null;
      let pendingProject = null;
      const terminalSessions = new Map();
      const stops = [];

      const uid = (prefix) => `${prefix}-${global.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const cleanId = (value) => String(value ?? "").match(LOCAL_THREAD_RE)?.[1] ?? null;
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const escapeSelector = (value) => global.CSS?.escape?.(value) ?? String(value).replace(/["\\]/g, "\\$&");
      const data = global.__explodexViewsData(cleanId, scheduleRefresh);

      function normalizePane(raw) {
        if (!raw || typeof raw !== "object") return null;
        const type = ["thread", "browser", "terminal"].includes(raw.type) ? raw.type : null;
        if (!type) return null;
        return {
          id: String(raw.id || uid("pane")),
          type,
          ...(type === "thread" ? { threadId: cleanId(raw.threadId) } : {}),
          ...(type === "browser" ? { url: String(raw.url || "about:blank") } : {}),
          ...(type === "terminal"
            ? { cwd: String(raw.cwd || "/"), hostId: String(raw.hostId || "local") }
            : {}),
        };
      }

      function normalizeState(raw) {
        const views = Array.isArray(raw?.views) ? raw.views : [];
        return {
          version: 1,
          views: views
            .filter((view) => view && typeof view === "object")
            .map((view) => ({
              id: String(view.id || uid("view")),
              name: String(view.name || "Untitled view").trim() || "Untitled view",
              columns: [1, 2, 3].includes(view.columns) ? view.columns : 2,
              projectId: view.projectId == null ? null : String(view.projectId),
              layout: view.layout && typeof view.layout === "object" ? view.layout : null,
              panes: (Array.isArray(view.panes) ? view.panes : []).map(normalizePane).filter(Boolean),
            })),
        };
      }

      let state = normalizeState(storage.persisted.get(STORAGE_KEY, { version: 1, views: [] }));
      const activeView = () => state.views.find((view) => view.id === activeViewId) ?? null;

      function saveState() {
        storage.persisted.set(STORAGE_KEY, state);
        renderSidebar();
      }

      function installStyle() {
        if (document.getElementById("explodex-views-style")) return;
        const style = document.createElement("style");
        style.id = "explodex-views-style";
        style.textContent = `
          .ex-views-sidebar{padding:2px var(--padding-row-x,10px) 6px;display:flex;flex-direction:column;gap:1px}.ex-views-sidebar-head{height:30px;display:flex;align-items:center;gap:6px;color:var(--color-text-tertiary);font-size:12px;font-weight:500}.ex-views-sidebar-head span{flex:1}.ex-views-sidebar button{font:inherit}.ex-views-sidebar-add,.ex-view-action{border:0;background:transparent;color:inherit;border-radius:7px;cursor:pointer}.ex-views-sidebar-add{width:24px;height:24px;font-size:18px}.ex-views-sidebar-add:hover,.ex-view-action:hover{background:var(--color-list-hover-background,color-mix(in srgb,currentColor 9%,transparent))}.ex-view-nav{width:100%;height:30px;border:0;background:transparent;color:inherit;border-radius:var(--radius-token-row,8px);padding:0 8px;display:flex;align-items:center;gap:8px;text-align:left;cursor:pointer;font-size:13px}.ex-view-nav:hover,.ex-view-nav[aria-current=page]{background:var(--color-list-hover-background,color-mix(in srgb,currentColor 9%,transparent))}.ex-view-nav-icon{opacity:.66}.ex-view-empty{padding:4px 8px 6px;color:var(--color-text-tertiary);font-size:12px}
          .ex-views-root{position:absolute;inset:0;z-index:26;display:flex;min-width:0;min-height:0;flex-direction:column;background:var(--color-main-surface-primary,var(--color-bg-primary,#111));color:var(--color-text-primary,inherit);font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.ex-views-toolbar{height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--color-border,color-mix(in srgb,currentColor 10%,transparent));flex:none}.ex-views-title{min-width:0;flex:1;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ex-view-toolbar-group{display:flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--color-background-secondary,color-mix(in srgb,currentColor 5%,transparent))}.ex-view-action{min-height:28px;padding:0 9px}.ex-view-action[aria-pressed=true]{background:var(--color-list-hover-background,color-mix(in srgb,currentColor 11%,transparent))}.ex-views-grid{--ex-view-columns:2;display:grid;grid-template-columns:repeat(var(--ex-view-columns),minmax(0,1fr));grid-auto-rows:minmax(260px,1fr);gap:1px;min-height:0;flex:1;background:var(--color-border,color-mix(in srgb,currentColor 12%,transparent));overflow:auto}.ex-views-grid[data-maximized=true]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.ex-view-pane{display:flex;min-width:0;min-height:0;flex-direction:column;background:var(--color-main-surface-primary,var(--color-bg-primary,#111));outline:1px solid transparent;transition:outline-color 160ms ease-out}.ex-view-pane[data-drag-over=true]{outline-color:var(--color-accent-foreground,#5e9eff);outline-offset:-2px}.ex-pane-head{height:38px;display:flex;align-items:center;gap:7px;padding:0 8px 0 10px;border-bottom:1px solid var(--color-border,color-mix(in srgb,currentColor 9%,transparent));cursor:grab;user-select:none;flex:none}.ex-pane-head:active{cursor:grabbing}.ex-pane-kind{width:18px;color:var(--color-text-tertiary);text-align:center}.ex-pane-title{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}.ex-pane-status{font-size:11px;color:var(--color-text-tertiary)}.ex-pane-body{min-width:0;min-height:0;flex:1;overflow:auto}.ex-thread-feed{display:flex;min-height:100%;flex-direction:column;padding:12px;gap:8px}.ex-thread-message{max-width:min(92%,68ch);padding:7px 9px;border-radius:10px;background:var(--color-background-secondary,color-mix(in srgb,currentColor 5%,transparent));white-space:pre-wrap;overflow-wrap:anywhere}.ex-thread-message[data-role=user]{align-self:flex-end;background:var(--color-list-hover-background,color-mix(in srgb,currentColor 10%,transparent))}.ex-thread-message[data-role=tool]{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--color-text-tertiary)}.ex-thread-empty{margin:auto;max-width:34ch;text-align:center;color:var(--color-text-tertiary)}.ex-thread-compose{display:flex;gap:6px;padding:8px;border-top:1px solid var(--color-border,color-mix(in srgb,currentColor 9%,transparent));flex:none}.ex-thread-compose input,.ex-browser-bar input,.ex-terminal-input,.ex-view-dialog input{min-width:0;flex:1;border:1px solid var(--color-border,color-mix(in srgb,currentColor 14%,transparent));border-radius:8px;background:var(--color-input-background,color-mix(in srgb,currentColor 4%,transparent));color:inherit;padding:6px 8px;font:inherit;outline:none}.ex-thread-compose input:focus,.ex-browser-bar input:focus,.ex-terminal-input:focus,.ex-view-dialog input:focus{border-color:var(--color-accent-foreground,#5e9eff)}.ex-browser{display:flex;height:100%;flex-direction:column}.ex-browser-bar{display:flex;gap:5px;padding:6px;border-bottom:1px solid var(--color-border,color-mix(in srgb,currentColor 9%,transparent))}.ex-browser webview{flex:1;min-height:0;background:#fff}.ex-terminal{display:flex;height:100%;min-height:0;flex-direction:column;background:#0d0f12;color:#e6e8eb}.ex-terminal-output{min-height:0;flex:1;overflow:auto;padding:10px;margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ex-terminal-form{display:flex;padding:7px;border-top:1px solid #2a2e35}.ex-terminal-input{border-color:#343a43;background:#14171c;color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.ex-view-add-empty{display:grid;place-items:center;min-height:100%;padding:24px;color:var(--color-text-tertiary)}.ex-view-add-empty button{margin-top:10px}.ex-view-dialog{border:1px solid var(--color-border,color-mix(in srgb,currentColor 14%,transparent));border-radius:12px;background:var(--color-main-surface-primary,#171717);color:inherit;padding:0;box-shadow:0 8px 24px rgb(0 0 0/.32);width:min(440px,calc(100vw - 32px))}.ex-view-dialog::backdrop{background:rgb(0 0 0/.45)}.ex-view-dialog-form{display:flex;flex-direction:column;gap:12px;padding:18px}.ex-view-dialog h2{font-size:16px;margin:0}.ex-view-dialog-actions{display:flex;justify-content:flex-end;gap:7px}.ex-thread-picker-list{max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:2px}.ex-thread-picker-item{border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;padding:8px;cursor:pointer}.ex-thread-picker-item:hover{background:var(--color-list-hover-background,color-mix(in srgb,currentColor 9%,transparent))}.ex-thread-picker-item small{display:block;color:var(--color-text-tertiary);overflow:hidden;text-overflow:ellipsis}.ex-pane-menu{position:fixed;z-index:1002;width:180px;padding:4px;border:1px solid var(--color-border,color-mix(in srgb,currentColor 14%,transparent));border-radius:10px;background:var(--color-dropdown-background,var(--color-bg-primary,#181818));box-shadow:0 8px 24px rgb(0 0 0/.28)}.ex-pane-menu button{width:100%;border:0;border-radius:7px;background:transparent;color:inherit;padding:8px;text-align:left;cursor:pointer}.ex-pane-menu button:hover{background:var(--color-list-hover-background,color-mix(in srgb,currentColor 9%,transparent))}@media(max-width:900px){.ex-views-grid{--ex-view-columns:1!important}}@media(prefers-reduced-motion:reduce){.ex-view-pane{transition:none}}
        `;
        style.textContent += `.ex-views-dock{min-width:0;min-height:0;flex:1;--dv-activegroup-visiblepanel-tab-background-color:var(--color-background-secondary,#252525);--dv-activegroup-hiddenpanel-tab-background-color:transparent;--dv-inactivegroup-visiblepanel-tab-background-color:var(--color-background-secondary,#252525);--dv-paneview-active-outline-color:var(--color-accent-foreground,#5e9eff);--dv-tabs-and-actions-container-background-color:var(--color-main-surface-secondary,#1b1b1b);--dv-group-view-background-color:var(--color-main-surface-primary,#111);--dv-separator-border:var(--color-border,#303030)}.ex-view-pane-content{height:100%;min-width:0;min-height:0;overflow:hidden}.ex-view-pane-content>.ex-browser,.ex-view-pane-content>.ex-terminal,.ex-view-pane-content>[data-thread-pane-body]{height:100%}`;
        document.head.appendChild(style);
      }

      function scheduleRefresh() {
        if (!root || refreshFrame != null) return;
        refreshFrame = requestAnimationFrame(() => {
          refreshFrame = null;
          refreshThreadTiles();
        });
      }

      function sidebarAnchor() {
        const nav = document.querySelector('nav[aria-label*="Scheduled task" i],nav[aria-label*="Automation folders" i],nav.sidebar-foreground-muted,nav');
        if (!nav) return null;
        const candidates = [...nav.querySelectorAll("[data-app-action-sidebar-section-heading],button,div")];
        const heading = candidates.find((node) => node.textContent?.trim() === "Pinned")
          ?? candidates.find((node) => node.textContent?.trim() === "Chats");
        const section = heading?.closest?.("[data-app-action-sidebar-section]") ?? heading?.closest?.('[role="listitem"]') ?? heading?.parentElement;
        return section?.parentElement ? { parent: section.parentElement, before: section } : { parent: nav, before: nav.firstChild };
      }

      function scheduleSidebar() {
        if (sidebarFrame != null) return;
        sidebarFrame = requestAnimationFrame(() => {
          sidebarFrame = null;
          renderSidebar();
        });
      }

      function renderSidebar() {
        if (disposed || !pluginSettings.showSidebar) {
          document.querySelector("[data-explodex-views-sidebar]")?.remove();
          return;
        }
        const anchor = sidebarAnchor();
        if (!anchor) return;
        let host = document.querySelector("[data-explodex-views-sidebar]");
        if (!host) {
          host = document.createElement("section");
          host.className = "ex-views-sidebar";
          host.setAttribute("data-explodex-views-sidebar", "true");
        }
        host.replaceChildren();
        const head = document.createElement("div");
        head.className = "ex-views-sidebar-head";
        const label = document.createElement("span");
        label.textContent = "Views";
        const add = document.createElement("button");
        add.className = "ex-views-sidebar-add";
        add.type = "button";
        add.setAttribute("aria-label", "Create view");
        add.textContent = "+";
        add.addEventListener("click", () => showNameDialog());
        head.append(label, add);
        host.append(head);
        if (state.views.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ex-view-empty";
          empty.textContent = "Create a tiled workspace";
          host.append(empty);
        }
        for (const view of state.views) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "ex-view-nav";
          button.dataset.viewId = view.id;
          if (view.id === activeViewId) button.setAttribute("aria-current", "page");
          const icon = document.createElement("span");
          icon.className = "ex-view-nav-icon";
          icon.textContent = "▦";
          const text = document.createElement("span");
          text.textContent = view.name;
          text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          button.append(icon, text);
          button.addEventListener("click", () => openView(view.id));
          host.append(button);
        }
        anchor.parent.insertBefore(host, anchor.before);
      }

      function actionButton(label, onClick, title = label) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ex-view-action";
        button.textContent = label;
        button.title = title;
        button.addEventListener("click", onClick);
        return button;
      }

      function showNameDialog(view = null) {
        const dialog = document.createElement("dialog");
        dialog.className = "ex-view-dialog";
        const form = document.createElement("form");
        form.className = "ex-view-dialog-form";
        form.method = "dialog";
        const title = document.createElement("h2");
        title.textContent = view ? "Rename view" : "Create view";
        const input = document.createElement("input");
        input.name = "name";
        input.required = true;
        input.maxLength = 80;
        input.placeholder = "View name";
        input.value = view?.name ?? "";
        const actions = document.createElement("div");
        actions.className = "ex-view-dialog-actions";
        actions.append(actionButton("Cancel", () => dialog.close()));
        const save = actionButton(view ? "Save" : "Create", () => {});
        save.type = "submit";
        actions.append(save);
        form.append(title, input, actions);
        dialog.append(form);
        document.body.append(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          if (view) view.name = name;
          else {
            const created = { id: uid("view"), name, columns: 2, projectId: null, layout: null, panes: [] };
            state.views.push(created);
            activeViewId = created.id;
          }
          saveState();
          dialog.close();
          renderView();
        });
        dialog.showModal();
        input.focus();
      }

      function showPaneMenu(anchor) {
        document.querySelector(".ex-pane-menu")?.remove();
        const menu = document.createElement("div");
        menu.className = "ex-pane-menu";
        menu.setAttribute("role", "menu");
        const rect = anchor.getBoundingClientRect();
        menu.style.left = `${Math.max(8, rect.right - 180)}px`;
        menu.style.top = `${Math.min(global.innerHeight - 130, rect.bottom + 5)}px`;
        const option = (label, run) => {
          const button = document.createElement("button");
          button.type = "button";
          button.role = "menuitem";
          button.textContent = label;
          button.addEventListener("click", () => {
            menu.remove();
            run();
          });
          menu.append(button);
        };
        option("Thread", () => showThreadPicker());
        option("Browser", () => addPane({ id: uid("pane"), type: "browser", url: "about:blank" }));
        option("Terminal", () => {
          const meta = data.byId(activeView()?.panes.find((pane) => pane.type === "thread")?.threadId);
          addPane({ id: uid("pane"), type: "terminal", cwd: meta?.cwd ?? activeView()?.projectId ?? "/", hostId: meta?.hostId ?? "local" });
        });
        document.body.append(menu);
        setTimeout(() => document.addEventListener("pointerdown", () => menu.remove(), { once: true }), 0);
      }

      function showThreadPicker() {
        const dialog = document.createElement("dialog");
        dialog.className = "ex-view-dialog";
        const form = document.createElement("div");
        form.className = "ex-view-dialog-form";
        const title = document.createElement("h2");
        title.textContent = "Add thread";
        const search = document.createElement("input");
        search.placeholder = "Search threads";
        const list = document.createElement("div");
        list.className = "ex-thread-picker-list";
        const render = () => {
          list.replaceChildren();
          const query = search.value.trim().toLowerCase();
          for (const meta of data.catalog().filter((item) => !query || String(item.title ?? "").toLowerCase().includes(query)).slice(0, 80)) {
            const id = cleanId(meta.id);
            if (!id) continue;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ex-thread-picker-item";
            button.innerHTML = `<span></span><small></small>`;
            button.querySelector("span").textContent = meta.title || "Untitled chat";
            button.querySelector("small").textContent = meta.cwd || meta.hostId || "";
            button.addEventListener("click", () => {
              addPane({ id: uid("pane"), type: "thread", threadId: id });
              dialog.close();
            });
            list.append(button);
          }
        };
        search.addEventListener("input", render);
        form.append(title, search, list, actionButton("Cancel", () => dialog.close()));
        dialog.append(form);
        document.body.append(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        render();
        dialog.showModal();
        search.focus();
      }

      function addPane(pane) {
        const view = activeView();
        const normalized = normalizePane(pane);
        if (!view || !normalized) return false;
        view.panes.push(normalized);
        if (dock) addDockPanel(dock, normalized);
        saveState();
        if (!dock) renderView();
        return true;
      }

      function renderThreadBody(pane, target) {
        const meta = data.byId(pane.threadId);
        const feed = document.createElement("div");
        feed.className = "ex-thread-feed";
        const messages = data.recentMessages(meta);
        if (messages.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ex-thread-empty";
          empty.textContent = meta ? "Open this thread once to load its transcript." : "Thread unavailable in the current host.";
          feed.append(empty);
        } else {
          for (const message of messages) {
            const item = document.createElement("div");
            item.className = "ex-thread-message";
            item.dataset.role = message.role;
            item.textContent = message.text.slice(0, 2400);
            feed.append(item);
          }
        }
        const compose = document.createElement("form");
        compose.className = "ex-thread-compose";
        const input = document.createElement("input");
        input.placeholder = "Quick prompt…";
        input.setAttribute("aria-label", `Prompt ${meta?.title ?? "thread"}`);
        const send = actionButton("Send", () => {});
        send.type = "submit";
        compose.append(input, send);
        compose.addEventListener("submit", async (event) => {
          event.preventDefault();
          const prompt = input.value.trim();
          if (!prompt || !pane.threadId) return;
          input.disabled = true;
          send.disabled = true;
          const result = await bridge.send("send-follow-up-message", {
            conversationId: pane.threadId,
            prompt,
            model: null,
            reasoningEffort: undefined,
            serviceTier: null,
          });
          input.disabled = false;
          send.disabled = false;
          if (result === null) components.statusToast("Could not send prompt");
          else input.value = "";
          input.focus();
        });
        target.replaceChildren(feed, compose);
        requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
      }

      function threadPane(pane) {
        const holder = document.createElement("div");
        holder.dataset.threadPaneBody = pane.id;
        holder.style.cssText = "height:100%;display:flex;min-height:0;flex-direction:column";
        renderThreadBody(pane, holder);
        const meta = data.byId(pane.threadId);
        return holder;
      }

      function browserPane(pane) {
        const browser = document.createElement("div");
        browser.className = "ex-browser";
        const bar = document.createElement("form");
        bar.className = "ex-browser-bar";
        const back = actionButton("←", () => webview.canGoBack?.() && webview.goBack(), "Back");
        const forward = actionButton("→", () => webview.canGoForward?.() && webview.goForward(), "Forward");
        const reload = actionButton("↻", () => webview.reload?.(), "Reload");
        const input = document.createElement("input");
        input.value = pane.url || "about:blank";
        input.setAttribute("aria-label", "Browser address");
        const webview = document.createElement("webview");
        webview.setAttribute("src", pane.url || "about:blank");
        webview.setAttribute("allowpopups", "");
        bar.append(back, forward, reload, input);
        bar.addEventListener("submit", (event) => {
          event.preventDefault();
          let url = input.value.trim();
          if (url !== "about:blank" && !/^https?:\/\//i.test(url)) url = `https://${url}`;
          pane.url = url || "about:blank";
          saveState();
          webview.loadURL?.(pane.url).catch(() => components.statusToast("Browser could not load that URL"));
        });
        webview.addEventListener("did-navigate", (event) => {
          pane.url = event.url;
          input.value = event.url;
          saveState();
        });
        browser.append(bar, webview);
        return browser;
      }

      function stripAnsi(value) {
        return String(value ?? "").replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "");
      }

      function closeTerminal(paneId) {
        const record = terminalSessions.get(paneId);
        if (!record) return;
        record.stops.forEach((stop) => stop());
        bridge.send("terminal-close", { sessionId: record.sessionId });
        terminalSessions.delete(paneId);
      }

      function startTerminal(pane, output) {
        if (terminalSessions.has(pane.id)) return;
        const sessionId = uid("views-terminal");
        const append = (text) => {
          output.textContent += stripAnsi(text);
          if (output.textContent.length > 120_000) output.textContent = output.textContent.slice(-80_000);
          output.scrollTop = output.scrollHeight;
        };
        const filter = (type, handler) => bridge.on(type, (event) => {
          if (event.sessionId === sessionId) handler(event);
        });
        const record = {
          sessionId,
          stops: [
            filter("terminal-data", (event) => append(event.data)),
            filter("terminal-init-log", (event) => { output.textContent = stripAnsi(event.log); }),
            filter("terminal-attached", (event) => append(`Connected · ${event.shell ?? "shell"} · ${event.cwd ?? pane.cwd}\n`)),
            filter("terminal-exit", (event) => append(`\nProcess exited (${event.code ?? "unknown"})\n`)),
            filter("terminal-error", (event) => append(`\nTerminal error: ${event.message ?? "unknown"}\n`)),
          ],
        };
        terminalSessions.set(pane.id, record);
        output.textContent = `Connecting to ${pane.cwd}…\n`;
        bridge.send("terminal-create", { sessionId, hostId: pane.hostId || "local", cwd: pane.cwd || "/" });
      }

      function terminalPane(pane) {
        const terminal = document.createElement("div");
        terminal.className = "ex-terminal";
        const output = document.createElement("pre");
        output.className = "ex-terminal-output";
        output.setAttribute("aria-live", "polite");
        const form = document.createElement("form");
        form.className = "ex-terminal-form";
        const input = document.createElement("input");
        input.className = "ex-terminal-input";
        input.placeholder = "Run a command…";
        input.setAttribute("aria-label", "Terminal command");
        form.append(input);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const command = input.value;
          const record = terminalSessions.get(pane.id);
          if (!command || !record) return;
          bridge.send("terminal-write", { sessionId: record.sessionId, data: `${command}\n` });
          input.value = "";
        });
        terminal.append(output, form);
        requestAnimationFrame(() => startTerminal(pane, output));
        return terminal;
      }

      function renderPane(pane) {
        if (pane.type === "thread") return threadPane(pane);
        if (pane.type === "browser") return browserPane(pane);
        return terminalPane(pane);
      }

      function paneTitle(pane) {
        if (pane.type === "thread") return data.byId(pane.threadId)?.title ?? "Thread";
        if (pane.type === "browser") return "Browser";
        return pane.cwd?.split("/").filter(Boolean).at(-1) || "Terminal";
      }

      function addDockPanel(instance, pane, position) {
        return instance.addPanel({
          id: pane.id,
          component: pane.type,
          title: paneTitle(pane),
          params: { paneId: pane.id },
          renderer: "always",
          ...(position ? { position } : {}),
        });
      }

      function saveDockLayout(view) {
        if (!dock || activeViewId !== view.id) return;
        view.layout = dock.toJSON();
        const liveIds = new Set(dock.panels.map((panel) => panel.id));
        for (const pane of view.panes.filter((item) => !liveIds.has(item.id))) closeTerminal(pane.id);
        view.panes = view.panes.filter((pane) => liveIds.has(pane.id));
        saveState();
      }

      function refreshThreadTiles() {
        const view = activeView();
        if (!root || !view) return;
        for (const pane of view.panes.filter((item) => item.type === "thread")) {
          const holder = root.querySelector(`[data-thread-pane-body="${escapeSelector(pane.id)}"]`);
          if (holder) renderThreadBody(pane, holder);
          const status = root.querySelector(`[data-pane-status="${escapeSelector(pane.id)}"]`);
          const meta = data.byId(pane.threadId);
          if (status) status.textContent = meta?.turns?.at(-1)?.status === "inProgress" ? "Running" : "";
        }
      }

      function renderView() {
        const view = activeView();
        if (!view) {
          closeView();
          return;
        }
        const main = document.querySelector("main");
        if (!main) return;
        for (const [paneId] of terminalSessions) if (!view.panes.some((pane) => pane.id === paneId)) closeTerminal(paneId);
        dock?.dispose();
        dock = null;
        root?.remove();
        root = document.createElement("div");
        root.className = "ex-views-root";
        root.dataset.viewId = view.id;
        const toolbar = document.createElement("header");
        toolbar.className = "ex-views-toolbar";
        const title = document.createElement("div");
        title.className = "ex-views-title";
        title.textContent = view.name;
        title.addEventListener("dblclick", () => showNameDialog(view));
        const add = actionButton("+ Pane", (event) => showPaneMenu(event.currentTarget));
        toolbar.append(title, add, actionButton("Reset layout", () => {
          view.layout = null;
          saveState();
          renderView();
        }), actionButton("Rename", () => showNameDialog(view)));
        toolbar.append(actionButton("Delete", () => {
          api.ui.confirm({
            title: `Delete ${view.name}?`,
            message: "The saved view will be removed. Threads and terminal history are not deleted.",
            confirmLabel: "Delete",
            onConfirm: () => deleteView(view.id),
          });
        }));
        toolbar.append(actionButton("Exit view", () => closeView()));
        const dockHost = document.createElement("div");
        dockHost.className = "ex-views-dock dockview-theme-dark";
        root.append(toolbar, dockHost);
        main.append(root);
        dock = new global.dockview.DockviewComponent(dockHost, {
          dndStrategy: "pointer",
          keyboardNavigation: {},
          disableFloatingGroups: true,
          getTabContextMenuItems: () => ["close", "closeOthers", "separator", "closeAll"],
          createComponent: ({ id }) => {
            const element = document.createElement("div");
            element.className = "ex-view-pane-content";
            return {
              element,
              init: () => {
                const pane = activeView()?.panes.find((item) => item.id === id);
                if (pane) element.replaceChildren(renderPane(pane));
              },
              dispose: () => closeTerminal(id),
            };
          },
        });
        if (view.layout) {
          try {
            dock.fromJSON(view.layout);
          } catch (error) {
            log.warn("could not restore view layout", error);
            view.layout = null;
          }
        }
        if (!view.layout) {
          const panels = [];
          view.panes.forEach((pane, index) => {
            if (index === 0) {
              panels.push(addDockPanel(dock, pane));
              return;
            }
            const reference = index === 3 ? panels[1] : panels[index % 2 === 0 ? 0 : index - 1];
            panels.push(addDockPanel(dock, pane, {
              referencePanel: reference,
              direction: index === 1 ? "right" : index <= 3 ? "below" : "within",
            }));
          });
        }
        dock.onDidLayoutChange(() => {
          if (layoutSaveTimer != null) clearTimeout(layoutSaveTimer);
          layoutSaveTimer = setTimeout(() => {
            layoutSaveTimer = null;
            saveDockLayout(view);
          }, 120);
        });
        data.subscribe();
        refreshThreadTiles();
        for (const pane of view.panes.filter((item) => item.type === "thread")) {
          bridge.send("ensure-conversation-history-loaded", { conversationId: pane.threadId, dependentConversationIds: [] });
        }
        scheduleSidebar();
      }

      function openView(id) {
        if (!state.views.some((view) => view.id === id)) return false;
        activeViewId = id;
        renderView();
        return true;
      }

      function closeView() {
        const view = activeView();
        if (view && dock) saveDockLayout(view);
        if (layoutSaveTimer != null) clearTimeout(layoutSaveTimer);
        layoutSaveTimer = null;
        for (const [paneId] of terminalSessions) closeTerminal(paneId);
        dock?.dispose();
        dock = null;
        root?.remove();
        root = null;
        activeViewId = null;
        scheduleSidebar();
      }

      function deleteView(id) {
        if (activeViewId === id) closeView();
        state.views = state.views.filter((view) => view.id !== id);
        saveState();
      }

      function projectIdFromAssignment(value) {
        if (typeof value === "string") return value;
        if (!value || typeof value !== "object") return null;
        return value.projectId ?? value.project_id ?? (value.kind != null ? value.id : null);
      }

      function projectThreadIdsFromDom(projectId) {
        const ids = [];
        let current = null;
        for (const node of document.querySelectorAll("[data-app-action-sidebar-project-id],[data-app-action-sidebar-thread-id]")) {
          if (node.hasAttribute("data-app-action-sidebar-project-id")) current = node.getAttribute("data-app-action-sidebar-project-id");
          else if (current === projectId) {
            const id = cleanId(node.getAttribute("data-app-action-sidebar-thread-id"));
            if (id) ids.push(id);
          }
        }
        return ids;
      }

      async function createProjectView(projectId, label) {
        const assignments = await storage.globalState.get(ASSIGNMENTS_KEY).catch(() => ({}));
        const domIds = new Set(projectThreadIdsFromDom(projectId));
        const recent = data.catalog()
          .filter((meta) => {
            const id = cleanId(meta.id);
            const assigned = projectIdFromAssignment(assignments?.[`local:${id}`] ?? assignments?.[id]);
            return id && (domIds.has(id) || assigned === projectId || meta.cwd === projectId);
          })
          .sort((a, b) => (b.recencyAt ?? b.updatedAt ?? 0) - (a.recencyAt ?? a.updatedAt ?? 0))
          .slice(0, pluginSettings.projectViewThreadCount);
        let view = state.views.find((item) => item.projectId === projectId);
        if (!view) {
          view = { id: uid("project-view"), name: `${label || projectId.split("/").at(-1) || "Project"} view`, columns: 2, projectId, layout: null, panes: [] };
          state.views.push(view);
        }
        view.name = `${label || projectId.split("/").at(-1) || "Project"} view`;
        view.layout = null;
        view.panes = recent.map((meta) => ({ id: uid("pane"), type: "thread", threadId: cleanId(meta.id) }));
        saveState();
        openView(view.id);
        if (recent.length < pluginSettings.projectViewThreadCount) {
          components.statusToast(
            `Opened ${recent.length} recent project thread${recent.length === 1 ? "" : "s"}`,
          );
        }
        return view.id;
      }

      function injectProjectMenuItem() {
        if (!pluginSettings.showProjectContextMenu) return;
        if (!pendingProject || Date.now() - pendingProject.at > 1800) return;
        const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) => {
          const rect = menu.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !menu.querySelector("[data-explodex-open-project-view]");
        });
        const menu = menus.at(-1);
        const first = menu?.querySelector('[role="menuitem"]');
        if (!menu || !first) return;
        const item = first.cloneNode(true);
        item.setAttribute("data-explodex-open-project-view", "true");
        item.querySelector("svg")?.remove();
        const span = item.querySelector("span") ?? item;
        span.textContent = "Open project view";
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const project = pendingProject;
          pendingProject = null;
          menu.remove();
          createProjectView(project.id, project.label).catch((error) => log.warn("project view failed", error));
        });
        first.insertAdjacentElement("afterend", item);
      }

      function onContextMenu(event) {
        const row = event.target?.closest?.("[data-app-action-sidebar-project-id]");
        if (!row) return;
        pendingProject = {
          id: row.getAttribute("data-app-action-sidebar-project-id"),
          label: row.getAttribute("data-app-action-sidebar-project-label") || row.getAttribute("aria-label") || "Project",
          at: Date.now(),
        };
        setTimeout(injectProjectMenuItem, 0);
        setTimeout(injectProjectMenuItem, 120);
      }

      function onNavigationClick(event) {
        if (!activeViewId || event.defaultPrevented) return;
        const row = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
        if (!row || row.closest("[data-explodex-views-sidebar]")) return;
        closeView();
      }

      function onKeyDown(event) {
        if (event.key !== "Escape" || !activeViewId || event.defaultPrevented) return;
        if (document.querySelector(".ex-view-dialog[open],.ex-pane-menu")) return;
        closeView();
      }

      function createView(name, panes = []) {
        const view = {
          id: uid("view"),
          name: String(name || "Untitled view").trim() || "Untitled view",
          columns: 2,
          projectId: null,
          layout: null,
          panes: panes.map(normalizePane).filter(Boolean),
        };
        state.views.push(view);
        saveState();
        return view.id;
      }

      installStyle();
      renderSidebar();
      const observer = new MutationObserver(() => {
        scheduleSidebar();
        injectProjectMenuItem();
        if (root && !root.isConnected) renderView();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener("contextmenu", onContextMenu, true);
      document.addEventListener("click", onNavigationClick, true);
      document.addEventListener("keydown", onKeyDown, true);
      stops.push(
        () => observer.disconnect(),
        () => document.removeEventListener("contextmenu", onContextMenu, true),
        () => document.removeEventListener("click", onNavigationClick, true),
        () => document.removeEventListener("keydown", onKeyDown, true),
      );

      const publicApi = {
        list: () => clone(state.views),
        create: (name, panes = []) => createView(name, panes),
        open: (id) => openView(id),
        close: () => closeView(),
        remove: (id) => deleteView(id),
        addPane: (viewId, pane) => {
          const previous = activeViewId;
          activeViewId = viewId;
          const result = addPane(pane);
          if (!result) activeViewId = previous;
          return result;
        },
        openProject: (projectId, label) => createProjectView(projectId, label),
      };
      Explodex.views = publicApi;
      log.info("views attached");

      return () => {
        disposed = true;
        closeView();
        stops.forEach((stop) => stop());
        data.dispose();
        if (sidebarFrame != null) cancelAnimationFrame(sidebarFrame);
        if (refreshFrame != null) cancelAnimationFrame(refreshFrame);
        document.querySelector("[data-explodex-views-sidebar]")?.remove();
        document.querySelector(".ex-pane-menu")?.remove();
        document.getElementById("explodex-views-style")?.remove();
        if (Explodex.views === publicApi) delete Explodex.views;
      };
    },
  );
})(window);
