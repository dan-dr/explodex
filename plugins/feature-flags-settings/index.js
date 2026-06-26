/**
 * Explodex plugin: Feature Flags (Settings)
 *
 * Surfaces experimental feature flags (list-experimental-features when AppServer
 * is captured; otherwise statsig snapshot + get-configuration). Toggles persist via
 * batch-write-config-value or set-configuration RPC fallback. Sidebar popover +
 * optional General Settings panel injection.
 */
(function registerFeatureFlagsSettings(global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) {
    console.warn("[feature-flags-settings] Explodex SDK not loaded");
    return;
  }

  const PLUGIN_ID = "feature-flags-settings";
  const PANEL_ID = "explodex-feature-flags-panel";
  const SETTINGS_ROUTE = "/settings/general-settings";
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 20;
  const ROUTE_POLL_MS = 500;
  const DEFAULT_HOST_ID = "local";

  const STATSIG_SNAPSHOT_KEY = "statsig_default_enable_features";
  const STATSIG_GATE_REFERRALS = "1823918333";
  const STATSIG_GATE_REFERRALS_ALT = "3502353992";
  const STATSIG_GATE_CHRONICLE_PERSONALIZATION = "2574306096";
  const CHRONICLE_GATE_PATCH_FLAG = "__explodexChronicleGatePatched";

  const EXPERIMENTAL_FEATURES_QUERY_KEY = "experimental-features";
  const CONFIG_USER_QUERY_KEY = "config";

  const KNOWN_FEATURE_NAMES = [
    "memories",
    "multi_agent",
    "plugins",
    "plugin",
    "remote_control",
    "realtime_conversation",
    "chronicle",
    "workspace_dependencies",
    "remote_connections",
    "apps_mcp_path_override",
    "auth_elicitation",
    "tool_suggest",
    "onboarding_interactive_tools",
    "request_permissions_tool",
    "ghost_commit",
    "unified_exec",
    "apply_patch_freeform",
    "skills",
    "shell_snapshot",
    "js_repl",
    "referrals",
    "referral_system",
  ];

  Explodex.plugins.register(
    {
      id: PLUGIN_ID,
      name: "Feature Flags",
      version: "1.0.5",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { bridge, components: c, inject, log, sidebarNav, ui } = api;

      let disposed = false;
      let navButton = null;
      let popoutOpen = false;
      let refreshTimer = null;
      let routePollTimer = null;
      let refreshInFlight = null;
      let lastSettingsStateKey = null;
      let lastPathname = global.location?.pathname ?? "";
      let toggling = new Set();
      let unsubscribeSidebar = null;

      let state = {
        loading: true,
        error: null,
        features: [],
        hostId: DEFAULT_HOST_ID,
        updatedAt: null,
      };

      function resolveHostId() {
        const hostConfig = global.electronBridge?.getSharedObjectSnapshotValue?.("host_config");
        return hostConfig?.id ?? DEFAULT_HOST_ID;
      }

      function hasAppServer() {
        return Boolean(global.__explodexAppServerSend || global.__bcAppServerSend);
      }

      function featureKeyPath(name) {
        return name?.startsWith("features.") ? name : `features.${name}`;
      }

      function readStatsigFeatures() {
        const snap = global.electronBridge?.getSharedObjectSnapshotValue?.(STATSIG_SNAPSHOT_KEY);
        if (!snap || typeof snap !== "object") return {};
        const out = {};
        for (const [name, value] of Object.entries(snap)) {
          if (typeof value === "boolean") out[name] = value;
        }
        return out;
      }

      function reactFiber(node) {
        if (!node || typeof node !== "object") return null;
        const key = Object.keys(node).find((name) => name.startsWith("__reactFiber"));
        return key ? node[key] : null;
      }

      function getQueryClient() {
        let fiber = reactFiber(document.querySelector("nav") ?? document.documentElement);
        for (let depth = 0; depth < 200 && fiber; depth += 1) {
          const client = fiber.memoizedProps?.value;
          if (client?.getQueryCache && client?.setQueryData) return client;
          fiber = fiber.return;
        }
        return null;
      }

      function readStatsigGate(gateId) {
        if (
          gateId === STATSIG_GATE_CHRONICLE_PERSONALIZATION &&
          global[CHRONICLE_GATE_PATCH_FLAG]
        ) {
          return true;
        }
        try {
          for (let i = 0; i < (global.localStorage?.length ?? 0); i += 1) {
            const storageKey = global.localStorage.key(i);
            if (!storageKey?.startsWith("statsig.cached.evaluations.")) continue;
            const raw = global.localStorage.getItem(storageKey);
            if (!raw) continue;
            const envelope = JSON.parse(raw);
            const data = JSON.parse(envelope.data);
            const gate = data.feature_gates?.[gateId];
            if (gate && typeof gate.value === "boolean") return gate.value;
          }
        } catch {
          // ignore parse errors
        }
        return null;
      }

      const statsigGatePatchStoreKey = "__explodexChronicleGatePatchStore";

      function restoreStatsigClientGate() {
        const client = global.__STATSIG__?.firstInstance;
        const store = client?.[statsigGatePatchStoreKey];
        if (!client || !store) return;

        if (store.checkGate) client.checkGate = store.checkGate;
        if (store.getFeatureGate) client.getFeatureGate = store.getFeatureGate;
        delete client[CHRONICLE_GATE_PATCH_FLAG];
        delete client[statsigGatePatchStoreKey];
        delete global[CHRONICLE_GATE_PATCH_FLAG];
      }

      function patchStatsigClientGate(gateId, value) {
        const client = global.__STATSIG__?.firstInstance;
        if (!client || client[CHRONICLE_GATE_PATCH_FLAG]) return false;

        const origCheckGate = client.checkGate?.bind(client);
        const origGetFeatureGate = client.getFeatureGate?.bind(client);
        if (!origCheckGate) return false;

        client[statsigGatePatchStoreKey] = {
          checkGate: client.checkGate,
          getFeatureGate: client.getFeatureGate,
        };

        client.checkGate = (gate, ...rest) =>
          gate === gateId ? value : origCheckGate(gate, ...rest);

        if (origGetFeatureGate) {
          client.getFeatureGate = (gate, ...rest) => {
            if (gate !== gateId) return origGetFeatureGate(gate, ...rest);
            return {
              name: gate,
              value,
              ruleID: "explodex-override",
              idType: "userID",
              details: { reason: "explodex-override" },
            };
          };
        }

        client[CHRONICLE_GATE_PATCH_FLAG] = true;
        global[CHRONICLE_GATE_PATCH_FLAG] = true;
        return true;
      }

      function experimentalFeaturesQueryKey(hostId) {
        return [EXPERIMENTAL_FEATURES_QUERY_KEY, "list", hostId];
      }

      function configUserQueryKey(hostId) {
        return [CONFIG_USER_QUERY_KEY, "user", hostId];
      }

      function loadFeaturesFromQueryCache(hostId) {
        const queryClient = getQueryClient();
        if (!queryClient) return null;
        const list = queryClient.getQueryData(experimentalFeaturesQueryKey(hostId));
        if (!Array.isArray(list) || list.length === 0) return null;
        return augmentReferralFeatures(mergeFeatures(list));
      }

      function augmentReferralFeatures(features) {
        const referralsPrimary = readStatsigGate(STATSIG_GATE_REFERRALS);
        const referralsAlt = readStatsigGate(STATSIG_GATE_REFERRALS_ALT);
        const referralsEnabled =
          referralsPrimary === true || referralsAlt === true
            ? true
            : referralsPrimary === false && referralsAlt === false
              ? false
              : referralsPrimary ?? referralsAlt;
        const byName = new Map(features.map((feature) => [feature.name, feature]));

        for (const name of ["referrals", "referral_system"]) {
          if (byName.has(name)) continue;
          if (referralsEnabled == null) continue;
          byName.set(name, {
            name,
            enabled: referralsEnabled,
            stage: "statsig",
            label: "Referral system",
            description:
              "Statsig-gated invite/referral UI (gates 1823918333 / 3502353992; not a config.toml feature).",
            source: "statsig-gate",
          });
        }

        return Array.from(byName.values()).sort((left, right) =>
          left.name.localeCompare(right.name),
        );
      }

      function updateFeatureInConfig(config, featureName, enabled) {
        const features = { ...(config?.features ?? {}), [featureName]: enabled };
        return { ...config, features };
      }

      async function invalidateCodexQueryCaches(hostId, featureName) {
        const electron = global.electronBridge;
        if (!electron?.sendMessageFromView) return;

        const invalidations = [
          { queryKey: experimentalFeaturesQueryKey(hostId) },
          { queryKey: configUserQueryKey(hostId) },
          { queryKey: ["user-saved-config"] },
        ];

        await Promise.all(
          invalidations.map((payload) =>
            electron.sendMessageFromView({ type: "query-cache-invalidate", ...payload }).catch(() => {}),
          ),
        );
      }

      async function syncCodexCaches(hostId, featureName, enabled) {
        const queryClient = getQueryClient();
        if (!queryClient) return;

        const expKey = experimentalFeaturesQueryKey(hostId);
        queryClient.setQueryData(expKey, (current) => {
          if (!Array.isArray(current)) return current;
          let found = false;
          const next = current.map((entry) => {
            if (entry?.name !== featureName) return entry;
            found = true;
            return { ...entry, enabled };
          });
          return found ? next : current;
        });

        const userKey = configUserQueryKey(hostId);
        queryClient.setQueryData(userKey, (current) => {
          if (!current?.config) return current;
          return {
            ...current,
            config: updateFeatureInConfig(current.config, featureName, enabled),
          };
        });

        await invalidateCodexQueryCaches(hostId, featureName);
      }

      function stateKey() {
        const flags = state.features.map((feature) => `${feature.name}:${feature.enabled ? 1 : 0}`).join("|");
        return `${state.hostId}|${state.loading ? 1 : 0}|${state.error ?? ""}|${flags}`;
      }

      function normalizeFeature(raw) {
        if (!raw || typeof raw !== "object") return null;
        const name = String(raw.name ?? raw.id ?? "").trim();
        if (!name) return null;
        return {
          name,
          enabled: Boolean(raw.enabled),
          stage: raw.stage == null ? null : String(raw.stage),
          label:
            raw.label == null && raw.displayName == null
              ? null
              : String(raw.label ?? raw.displayName ?? "").trim() || null,
          description:
            raw.description == null ? null : String(raw.description).trim() || null,
          source: "api",
        };
      }

      function mergeFeatures(apiFeatures) {
        const byName = new Map();
        for (const raw of apiFeatures) {
          const feature = normalizeFeature(raw);
          if (feature) byName.set(feature.name, feature);
        }
        for (const name of KNOWN_FEATURE_NAMES) {
          if (!byName.has(name)) {
            byName.set(name, {
              name,
              enabled: false,
              stage: null,
              label: null,
              description: null,
              source: "catalog",
            });
          }
        }
        return Array.from(byName.values()).sort((left, right) =>
          left.name.localeCompare(right.name),
        );
      }

      async function readConfigOverride(name) {
        const res = await bridge.rpc("get-configuration", { key: featureKeyPath(name) });
        if (res?.value == null || typeof res.value !== "boolean") return null;
        return res.value;
      }

      async function loadFeaturesFromFallback(hostId) {
        const fromCache = loadFeaturesFromQueryCache(hostId);
        if (fromCache?.length) return fromCache;

        const statsig = readStatsigFeatures();
        const names = new Set([...Object.keys(statsig), ...KNOWN_FEATURE_NAMES]);
        const features = [];
        for (const name of names) {
          const configOverride = await readConfigOverride(name);
          const enabled = configOverride ?? statsig[name] ?? false;
          const source =
            configOverride != null ? "config" : statsig[name] != null ? "statsig" : "catalog";
          features.push({
            name,
            enabled,
            stage: null,
            label: null,
            description: null,
            source,
          });
        }
        return augmentReferralFeatures(features);
      }

      async function listExperimentalFeatures(hostId) {
        if (!hasAppServer()) return null;

        const collected = [];
        let cursor = null;
        let pages = 0;
        do {
          const page = await bridge.send("list-experimental-features", {
            hostId,
            cursor,
            limit: PAGE_LIMIT,
          });
          if (!page?.data || !Array.isArray(page.data)) return collected.length ? collected : null;
          collected.push(...page.data);
          const nextCursor = page.nextCursor ?? null;
          if (nextCursor === cursor) break;
          cursor = nextCursor;
          pages += 1;
        } while (cursor != null && pages < MAX_PAGES);
        return collected;
      }

      async function applyRemoteControlSideEffects(hostId, enabled) {
        await bridge.send("set-remote-control-enabled-for-host", { hostId, enabled });
        if (hostId !== DEFAULT_HOST_ID) return;

        const electron = global.electronBridge;
        if (electron?.sendMessageFromView) {
          await electron.sendMessageFromView({
            type: "set-local-remote-control-enabled",
            enabled,
          });
        }
      }

      async function setFeatureEnabled(hostId, featureName, enabled) {
        if (!bridge.isAvailable()) throw new Error("Bridge unavailable");
        if (featureName === "referrals" || featureName === "referral_system") {
          throw new Error("Referral system is Statsig-gated (not a config.toml feature flag)");
        }

        let persisted = false;
        if (hasAppServer()) {
          const res = await bridge.send("batch-write-config-value", {
            hostId,
            edits: [
              {
                keyPath: featureKeyPath(featureName),
                value: enabled,
                mergeStrategy: "upsert",
              },
            ],
            filePath: null,
            expectedVersion: null,
          });
          persisted = res != null;
          if (persisted) await syncCodexCaches(hostId, featureName, enabled);
        }

        if (!persisted) {
          const res = await bridge.rpc("set-configuration", {
            key: featureKeyPath(featureName),
            value: enabled,
          });
          if (!res?.success) throw new Error("Failed to persist feature flag");
          await syncCodexCaches(hostId, featureName, enabled);
        }

        if (featureName === "chronicle" && enabled) {
          patchStatsigClientGate(STATSIG_GATE_CHRONICLE_PERSONALIZATION, true);
        }

        if (featureName === "remote_control") {
          await applyRemoteControlSideEffects(hostId, enabled);
        }
      }

      function enabledSummary() {
        const total = state.features.length;
        if (!total) return state.loading ? "Flags: …" : "Flags: 0";
        const enabled = state.features.filter((feature) => feature.enabled).length;
        return `Flags: ${enabled}/${total}`;
      }

      function stageLabel(feature) {
        if (feature.stage) return feature.stage;
        if (feature.source === "config") return "config";
        if (feature.source === "statsig-gate") return "statsig";
        if (feature.source === "statsig") return "default";
        if (feature.source === "catalog") return "catalog";
        return "unknown";
      }

      function chroniclePersonalizationHint(feature) {
        const gate = readStatsigGate(STATSIG_GATE_CHRONICLE_PERSONALIZATION);
        const parts = [];

        if (!feature?.enabled) {
          parts.push("Enable this flag first.");
        }
        if (gate === false || gate == null) {
          parts.push(
            "Personalization also requires Statsig gate 2574306096 (Chronicle rollout; not in your evaluations).",
          );
        }
        parts.push(
          "The row also needs a local Chronicle sidecar and macOS accessibility/screen-recording permissions after it appears.",
        );
        if (feature?.enabled && (gate === false || gate == null)) {
          parts.push(
            "Reload Codex after enabling Chronicle so Personalization can pick up the rollout gate.",
          );
        }
        return parts.join(" ");
      }

      function isToggleDisabled(feature) {
        return toggling.has(feature.name) || feature.source === "statsig-gate";
      }

      function makeToggle(feature, onChange) {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = feature.enabled;
        input.disabled = isToggleDisabled(feature);
        input.setAttribute("aria-label", `Toggle ${feature.name}`);
        input.style.cssText =
          "width:16px;height:16px;cursor:pointer;accent-color:var(--color-text-primary,#fff)";
        input.addEventListener("change", () => onChange(feature, input.checked));
        return input;
      }

      function featureRow(feature) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;" +
          "padding:10px 0;border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent)";

        const copy = document.createElement("div");
        copy.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:4px";

        const title = document.createElement("div");
        title.style.cssText =
          "display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:13px/1.35 system-ui,-apple-system,sans-serif";
        const name = document.createElement("code");
        name.textContent = feature.name;
        name.style.cssText =
          "font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;" +
          "padding:2px 6px;border-radius:6px;background:color-mix(in srgb, currentColor 8%, transparent)";
        title.appendChild(name);

        const badge = document.createElement("span");
        badge.textContent = stageLabel(feature);
        badge.style.cssText =
          "font:10px/1 ui-monospace,monospace;letter-spacing:0.04em;text-transform:uppercase;" +
          "padding:2px 6px;border-radius:999px;" +
          "border:1px solid color-mix(in srgb, currentColor 16%, transparent);" +
          "color:color-mix(in srgb, currentColor 70%, transparent)";
        title.appendChild(badge);

        copy.appendChild(title);

        if (feature.label) {
          const label = document.createElement("div");
          label.textContent = feature.label;
          label.style.cssText = "font:13px/1.35 system-ui,-apple-system,sans-serif";
          copy.appendChild(label);
        }

        if (feature.description) {
          const description = document.createElement("div");
          description.textContent = feature.description;
          description.style.cssText =
            "font:12px/1.45 system-ui,-apple-system,sans-serif;" +
            "color:color-mix(in srgb, currentColor 68%, transparent)";
          copy.appendChild(description);
        }

        if (feature.name === "chronicle") {
          const hint = chroniclePersonalizationHint(feature);
          if (hint) {
            const note = document.createElement("div");
            note.textContent = hint;
            note.style.cssText =
              "font:11px/1.45 system-ui,-apple-system,sans-serif;" +
              "color:color-mix(in srgb, currentColor 60%, transparent)";
            copy.appendChild(note);
          }
        }

        const status = document.createElement("div");
        status.textContent = feature.enabled ? "On" : "Off";
        status.style.cssText =
          `justify-self:end;font:11px/1.3 ui-monospace,monospace;margin-top:2px;` +
          (feature.enabled
            ? "color:var(--color-text-primary,#fff)"
            : "color:color-mix(in srgb, currentColor 55%, transparent)");

        const toggleWrap = document.createElement("div");
        toggleWrap.style.cssText = "display:flex;flex-direction:column;align-items:end;gap:6px";
        toggleWrap.appendChild(
          makeToggle(feature, async (target, enabled) => {
            if (toggling.has(target.name)) return;
            toggling.add(target.name);
            reopenPopover();
            try {
              await setFeatureEnabled(state.hostId, target.name, enabled);
              state = {
                ...state,
                features: state.features.map((entry) =>
                  entry.name === target.name
                    ? { ...entry, enabled, source: "config" }
                    : entry,
                ),
                updatedAt: new Date(),
              };
              c.statusToast(`${target.name} ${enabled ? "enabled" : "disabled"}`);
              paintNav();
              reopenPopover();
              maybeUpdateSettingsPanel(true);
            } catch (err) {
              log.error("feature toggle failed", err);
              c.statusToast(`Failed to update ${target.name}`);
              reopenPopover();
            } finally {
              toggling.delete(target.name);
            }
          }),
        );
        toggleWrap.appendChild(status);

        row.appendChild(copy);
        row.appendChild(toggleWrap);
        return row;
      }

      function renderPanelBody() {
        const body = document.createElement("div");
        body.style.cssText = "display:flex;flex-direction:column;gap:12px";

        const intro = document.createElement("div");
        intro.style.cssText =
          "font:12px/1.5 system-ui,-apple-system,sans-serif;" +
          "color:color-mix(in srgb, currentColor 72%, transparent)";
        intro.textContent = hasAppServer()
          ? "All experimental feature flags known to this Codex build. Toggles persist to config and use the same APIs as Settings → General."
          : "Feature flags from Codex defaults (statsig) and config overrides. Toggles use set-configuration when the in-renderer AppServer is unavailable.";
        body.appendChild(intro);

        if (state.loading && state.features.length === 0) {
          const loading = document.createElement("div");
          loading.textContent = "Loading feature flags…";
          loading.style.cssText = "font:13px system-ui,-apple-system,sans-serif;opacity:0.8";
          body.appendChild(loading);
          return body;
        }

        if (state.error) {
          const error = document.createElement("div");
          error.textContent = state.error;
          error.style.cssText =
            "font:13px system-ui,-apple-system,sans-serif;color:var(--color-text-danger,#f87171)";
          body.appendChild(error);
        }

        const meta = document.createElement("div");
        meta.style.cssText =
          "display:flex;flex-wrap:wrap;gap:8px;font:11px/1.3 ui-monospace,monospace;" +
          "color:color-mix(in srgb, currentColor 65%, transparent)";
        meta.textContent = `host=${state.hostId} · ${state.features.filter((f) => f.enabled).length} enabled · ${state.features.length} total`;
        body.appendChild(meta);

        const filter = document.createElement("input");
        filter.type = "search";
        filter.placeholder = "Filter flags…";
        filter.style.cssText =
          "width:100%;padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb, currentColor 14%, transparent);" +
          "background:color-mix(in srgb, currentColor 4%, transparent);color:inherit;font:13px system-ui,-apple-system,sans-serif";
        body.appendChild(filter);

        const list = document.createElement("div");
        list.style.cssText = "max-height:min(60vh,520px);overflow:auto;padding-right:4px";

        const paintRows = () => {
          const query = filter.value.trim().toLowerCase();
          list.replaceChildren();
          const rows = state.features.filter((feature) => {
            if (!query) return true;
            const haystack = [feature.name, feature.label, feature.description, feature.stage]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return haystack.includes(query);
          });
          if (!rows.length) {
            const empty = document.createElement("div");
            empty.textContent = query ? "No flags match your filter." : "No feature flags returned.";
            empty.style.cssText =
              "padding:12px 0;font:13px system-ui,-apple-system,sans-serif;opacity:0.75";
            list.appendChild(empty);
            return;
          }
          for (const feature of rows) list.appendChild(featureRow(feature));
        };

        filter.addEventListener("input", paintRows);
        paintRows();
        body.appendChild(list);

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between";

        const refreshBtn = c.button({
          label: state.loading ? "Refreshing…" : "Refresh",
          color: "outline",
          size: "composerSm",
          disabled: state.loading,
          onClick: () => {
            void refresh({ updatePopover: popoutOpen });
          },
        });
        actions.appendChild(refreshBtn);

        const openSettings = c.button({
          label: "Open General Settings",
          color: "ghost",
          size: "composerSm",
          onClick: () => {
            ui.closePopover();
            popoutOpen = false;
            bridge.navigate(SETTINGS_ROUTE);
            global.setTimeout(() => maybeUpdateSettingsPanel(true), 300);
          },
        });
        actions.appendChild(openSettings);
        body.appendChild(actions);

        if (state.updatedAt) {
          const stamp = document.createElement("div");
          stamp.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
            timeStyle: "short",
          }).format(state.updatedAt)}`;
          stamp.style.cssText =
            "font:11px/1.3 system-ui,-apple-system,sans-serif;" +
            "color:color-mix(in srgb, currentColor 55%, transparent)";
          body.appendChild(stamp);
        }

        const note = document.createElement("div");
        note.textContent =
          "Some flags may require a Codex restart to fully apply. Remote control also updates local host enablement.";
        note.style.cssText =
          "font:11px/1.45 system-ui,-apple-system,sans-serif;" +
          "color:color-mix(in srgb, currentColor 55%, transparent)";
        body.appendChild(note);

        return body;
      }

      function renderDetailPanel() {
        return renderPanelBody();
      }

      function settingsContentRoot() {
        return (
          document.querySelector("main.main-surface .scrollbar-stable") ??
          document.querySelector("main.main-surface")
        );
      }

      function settingsContentInner(root) {
        if (!root) return null;
        return root.querySelector(".mx-auto.flex.w-full.flex-col") ?? root;
      }

      function mountSettingsPanel() {
        const root = settingsContentRoot();
        const inner = settingsContentInner(root);
        if (!inner) return false;

        let panel = document.getElementById(PANEL_ID);
        if (!panel) {
          panel = document.createElement("section");
          panel.id = PANEL_ID;
          panel.setAttribute("data-explodex-plugin", PLUGIN_ID);
          panel.style.cssText = "scroll-margin-top:24px";
          inner.prepend(panel);
        }

        panel.replaceChildren(
          c.panel({
            title: "All feature flags",
            children: renderPanelBody,
            className: "explodex-feature-flags-settings-panel",
          }),
        );
        return true;
      }

      function unmountSettingsPanel() {
        document.getElementById(PANEL_ID)?.remove();
        lastSettingsStateKey = null;
      }

      function maybeUpdateSettingsPanel(force = false) {
        if (disposed) return;
        const onSettings = global.location?.pathname?.includes(SETTINGS_ROUTE);
        if (!onSettings) {
          unmountSettingsPanel();
          return;
        }

        const key = stateKey();
        if (!force && key === lastSettingsStateKey && document.getElementById(PANEL_ID)) return;

        if (mountSettingsPanel()) {
          lastSettingsStateKey = key;
        }
      }

      function setNavButtonLabel(label) {
        const labelNode = navButton?.querySelector("span:last-child");
        if (labelNode) {
          labelNode.textContent = label;
          return;
        }
        navButton?.replaceChildren(document.createTextNode(label));
      }

      function refreshPopoverPosition() {
        if (!popoutOpen || !navButton?.isConnected) return;
        ui.repositionPopover?.({
          anchor: navButton,
          width: 420,
          side: "right",
        });
      }

      function reopenPopover() {
        if (!popoutOpen || !navButton?.isConnected) return;
        ui.popover({
          anchor: navButton,
          title: "Feature Flags",
          width: 420,
          side: "right",
          onClose: () => {
            popoutOpen = false;
          },
          content: renderDetailPanel,
        });
      }

      function openPopover(anchor) {
        popoutOpen = true;
        ui.popover({
          anchor,
          title: "Feature Flags",
          width: 420,
          side: "right",
          onClose: () => {
            popoutOpen = false;
          },
          content: renderDetailPanel,
        });
        if (state.features.length === 0) {
          void refresh({ updatePopover: true });
        }
      }

      function paintNav() {
        const label = enabledSummary();
        const needsMount = !navButton?.isConnected;

        if (needsMount) {
          navButton = ui.navItem({
            label: "Feature Flags",
            compact: true,
            onClick: (event) => {
              if (popoutOpen) {
                popoutOpen = false;
                ui.closePopover();
                return;
              }
              openPopover(event.currentTarget);
            },
          });
        }

        setNavButtonLabel(label);

        if (needsMount) {
          const mounted = sidebarNav.insertBefore(
            ["Settings", "Profile", "Account"],
            navButton,
            PLUGIN_ID,
          );
          if (!mounted) log.warn("sidebar mount deferred — profile footer anchor not found yet");
        }
      }

      async function refresh({ quiet = false, updatePopover = false } = {}) {
        if (disposed) return;
        if (refreshInFlight) return refreshInFlight;

        const hostId = resolveHostId();
        refreshInFlight = (async () => {
          if (!bridge.isAvailable()) {
            state = {
              ...state,
              loading: false,
              error: "Bridge unavailable",
              hostId,
            };
            paintNav();
            if (updatePopover) reopenPopover();
            maybeUpdateSettingsPanel(true);
            return;
          }

          if (!quiet) {
            state = { ...state, loading: true, error: null, hostId };
            paintNav();
            if (updatePopover) reopenPopover();
          }

          try {
            const apiFeatures = await listExperimentalFeatures(hostId);
            if (disposed) return;
            const features =
              apiFeatures?.length
                ? augmentReferralFeatures(mergeFeatures(apiFeatures))
                : await loadFeaturesFromFallback(hostId);
            state = {
              loading: false,
              error: null,
              hostId,
              features,
              updatedAt: new Date(),
            };
          } catch (err) {
            if (disposed) return;
            log.error("feature refresh failed", err);
            state = {
              ...state,
              loading: false,
              error: err?.message || "Failed to load feature flags",
              hostId,
            };
          }

          paintNav();
          if (updatePopover) reopenPopover();
          maybeUpdateSettingsPanel(true);
        })().finally(() => {
          refreshInFlight = null;
        });

        return refreshInFlight;
      }

      function onRouteMaybeChanged() {
        const path = global.location?.pathname ?? "";
        if (path === lastPathname) return;
        lastPathname = path;
        maybeUpdateSettingsPanel();
      }

      function startRouteWatcher() {
        global.addEventListener("popstate", onRouteMaybeChanged);
        routePollTimer = global.setInterval(onRouteMaybeChanged, ROUTE_POLL_MS);
      }

      function stopRouteWatcher() {
        global.removeEventListener("popstate", onRouteMaybeChanged);
        if (routePollTimer != null) {
          global.clearInterval(routePollTimer);
          routePollTimer = null;
        }
      }

      paintNav();
      startRouteWatcher();
      maybeUpdateSettingsPanel();
      refresh().catch((err) => log.error("initial refresh failed", err));
      refreshTimer = global.setInterval(() => refresh({ quiet: true }), 60_000);

      global.addEventListener("resize", refreshPopoverPosition);
      global.addEventListener("scroll", refreshPopoverPosition, true);

      unsubscribeSidebar = inject.observeZone("sidebar", (_anchor, meta) => {
        if (meta?.previousAnchor && meta.previousAnchor === _anchor && navButton?.isConnected) {
          refreshPopoverPosition();
          return;
        }
        if (!navButton?.isConnected) {
          navButton = null;
          paintNav();
        }
        refreshPopoverPosition();
      });

      log.info("feature flags settings attached");

      return () => {
        disposed = true;
        log.info("teardown");
        restoreStatsigClientGate();
        if (refreshTimer != null) global.clearInterval(refreshTimer);
        stopRouteWatcher();
        unsubscribeSidebar?.();
        global.removeEventListener("resize", refreshPopoverPosition);
        global.removeEventListener("scroll", refreshPopoverPosition, true);
        ui.closePopover();
        sidebarNav.remove(PLUGIN_ID);
        unmountSettingsPanel();
        navButton = null;
      };
    },
  );
})(window);