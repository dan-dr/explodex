/**
 * Explodex plugin: Feature Flags Playground
 *
 * Surfaces experimental feature flags (list-experimental-features when AppServer
 * is captured; otherwise statsig snapshot + get-configuration). Toggles persist
 * via batch-write-config-value or set-configuration RPC fallback, then
 * Explodex.flags.propagate() refreshes Codex caches and Statsig hooks. Sidebar
 * popover + optional General Settings panel injection.
 */
(function registerFeatureFlagsPlayground(global) {
  const Explodex = global.Explodex;
  if (!Explodex?.plugins?.register) {
    console.warn("[feature-flags-playground] Explodex SDK not loaded");
    return;
  }

  const PLUGIN_ID = "feature-flags-playground";
  const SETTINGS_KEY = "explodex-feature-flags-playground";
  const PANEL_ID = "explodex-feature-flags-panel";
  const SETTINGS_ROUTE = "/settings/general-settings";
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 20;
  const ROUTE_POLL_MS = 500;
  const DEFAULT_HOST_ID = "local";

  const STATSIG_SNAPSHOT_KEY = "statsig_default_enable_features";

  const EXPERIMENTAL_FEATURES_QUERY_KEY = "experimental-features";
  const CONFIG_USER_QUERY_KEY = "config";

  const PERSISTED_GATE_HINTS_KEY = "explodex-feature-flags-playground-gate-hints";

  // Proximity-scanned from Codex webview bundles (featureName near checkGate(`<id>`)).
  const CODEX_BUNDLE_GATE_HINTS = {
    browser_use: ["410262010"],
    browser_use_external: ["410065390"],
    chronicle: ["2574306096"],
    computer_use: ["1506311413"],
    in_app_browser: ["1834314516"],
  };

  const FEATURE_QUERY_KEY_HINTS = {
    chronicle: [["vscode", "chronicle-permissions"]],
    memories: [["vscode", "get-global-state", JSON.stringify({ key: "memories" })]],
  };

  const STAGE_SECTIONS = [
    {
      key: "stable",
      title: "Stable",
      description: "Generally available; intended for everyday use.",
    },
    {
      key: "beta",
      title: "Beta",
      description: "Wider rollout with ongoing iteration.",
    },
    {
      key: "underDevelopment",
      title: "Under development",
      description: "Experimental or internal; behavior may change abruptly.",
    },
    {
      key: "removed",
      title: "Removed",
      description: "Deprecated or retired; toggles may no longer do anything.",
    },
    {
      key: null,
      title: "Unclassified",
      description: "Not tagged by Codex list API (catalog fallback).",
    },
  ];

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
  ];

  Explodex.plugins.register(
    {
      id: PLUGIN_ID,
      name: "Feature Flags Playground",
      version: "1.5.0",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { bridge, components: c, flags, inject, log, sidebarNav, storage, ui, registerOptions } =
        api;

      api.migrate([
        {
          id: "rename-keys-from-feature-flags-settings",
          run: ({ renameKey }) => {
            renameKey("explodex-feature-flags-settings", SETTINGS_KEY);
            renameKey("explodex-feature-gate-hints", PERSISTED_GATE_HINTS_KEY);
          },
        },
      ]);

      function defaultSettings() {
        return {
          showSidebarShortcut: true,
          embedInGeneralSettings: true,
        };
      }

      function normalizeSettings(raw) {
        const base = defaultSettings();
        if (!raw || typeof raw !== "object") return base;
        return {
          showSidebarShortcut: raw.showSidebarShortcut !== false,
          embedInGeneralSettings: raw.embedInGeneralSettings !== false,
        };
      }

      let settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));

      function saveSettings() {
        storage.persisted.set(SETTINGS_KEY, settings);
      }

      function loadSettings() {
        settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));
      }

      function renderOptionsPanel(container, { refresh }) {
        container.replaceChildren();
        container.appendChild(
          c.fieldStack([
            c.checkboxField({
              label: "Sidebar shortcut",
              checked: settings.showSidebarShortcut,
              onChange: (value) => {
                settings.showSidebarShortcut = value;
                saveSettings();
                if (!value) {
                  ui.closePopover();
                  popoutOpen = false;
                  sidebarNav.remove(PLUGIN_ID);
                  navButton = null;
                } else {
                  paintNav();
                }
                refresh();
              },
            }),
            c.checkboxField({
              label: "Embed panel in General Settings",
              checked: settings.embedInGeneralSettings,
              onChange: (value) => {
                settings.embedInGeneralSettings = value;
                saveSettings();
                if (!value) unmountSettingsPanel();
                else maybeUpdateSettingsPanel(true);
                refresh();
              },
            }),
            c.metaText("Toggle individual flags from the sidebar popover or General Settings panel."),
          ]),
        );
      }

      registerOptions({ render: renderOptionsPanel });
      loadSettings();

      let disposed = false;
      let navButton = null;
      let popoutOpen = false;
      let refreshTimer = null;
      let routePollTimer = null;
      let refreshInFlight = null;
      let lastSettingsStateKey = null;
      let lastPathname = "";
      let toggling = new Set();
      let unsubscribeSidebar = null;

      let state = {
        loading: true,
        error: null,
        features: [],
        hostId: DEFAULT_HOST_ID,
        updatedAt: null,
      };

      function reactFiber(node) {
        if (!node || typeof node !== "object") return null;
        const key = Object.keys(node).find((name) => name.startsWith("__reactFiber"));
        return key ? node[key] : null;
      }

      function getAppRoutePathname() {
        const start =
          document.querySelector('nav[aria-label="Settings"]') ??
          document.querySelector("nav") ??
          document.documentElement;
        let fiber = reactFiber(start);
        for (let depth = 0; depth < 200 && fiber; depth += 1) {
          const loc = fiber.memoizedProps?.location ?? fiber.memoizedProps?.value?.location;
          if (loc?.pathname) return loc.pathname;
          fiber = fiber.return;
        }
        return global.location?.pathname ?? "";
      }

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

      function readPersistedGateHints() {
        const raw = storage.persisted.get(PERSISTED_GATE_HINTS_KEY, {});
        return raw && typeof raw === "object" ? raw : {};
      }

      function rememberGateHints(featureName, gateIds) {
        if (!featureName || !gateIds?.length) return;
        const hints = readPersistedGateHints();
        const merged = new Set([...(hints[featureName] ?? []), ...gateIds]);
        hints[featureName] = [...merged];
        storage.persisted.set(PERSISTED_GATE_HINTS_KEY, hints);
      }

      function readStatsigGateCatalog() {
        const byId = new Map();
        const byName = new Map();

        try {
          for (let i = 0; i < (global.localStorage?.length ?? 0); i += 1) {
            const storageKey = global.localStorage.key(i);
            if (!storageKey?.startsWith("statsig.cached.evaluations.")) continue;
            const raw = global.localStorage.getItem(storageKey);
            if (!raw) continue;
            const envelope = JSON.parse(raw);
            const data = JSON.parse(envelope.data);
            for (const [gateId, gate] of Object.entries(data.feature_gates ?? {})) {
              const name = gate?.name == null ? null : String(gate.name);
              const value = typeof gate?.value === "boolean" ? gate.value : null;
              byId.set(gateId, { name, value });
              if (name) {
                const bucket = byName.get(name) ?? new Set();
                bucket.add(gateId);
                byName.set(name, bucket);
              }
            }
          }
        } catch {
          // ignore parse errors
        }

        return { byId, byName };
      }

      function discoverStatsigGatesForFeature(featureName) {
        const gateIds = new Set();
        const catalog = readStatsigGateCatalog();
        const statsigDefaults = readStatsigFeatures();
        const persistedHints = readPersistedGateHints();

        for (const gateId of catalog.byName.get(featureName) ?? []) gateIds.add(gateId);
        if (catalog.byId.has(featureName)) gateIds.add(featureName);

        if (featureName in statsigDefaults) gateIds.add(featureName);
        if (flags.readStatsigGate(featureName) != null) gateIds.add(featureName);

        for (const gateId of CODEX_BUNDLE_GATE_HINTS[featureName] ?? []) gateIds.add(gateId);
        for (const gateId of persistedHints[featureName] ?? []) gateIds.add(gateId);

        for (const [gateId, gate] of catalog.byId) {
          if (gate?.name === featureName) gateIds.add(gateId);
          if (gate?.name === gateId && gateId === featureName) gateIds.add(gateId);
        }

        const discovered = [...gateIds];
        rememberGateHints(featureName, discovered);
        return discovered;
      }

      function discoverQueryKeysForFeature(featureName) {
        const keys = [];
        const seen = new Set();

        const push = (queryKey) => {
          if (!Array.isArray(queryKey)) return;
          const signature = JSON.stringify(queryKey);
          if (seen.has(signature)) return;
          seen.add(signature);
          keys.push(queryKey);
        };

        for (const queryKey of FEATURE_QUERY_KEY_HINTS[featureName] ?? []) push(queryKey);

        const queryClient = flags.getQueryClient();
        const needle = featureName.toLowerCase();
        for (const query of queryClient?.getQueryCache?.().getAll?.() ?? []) {
          const queryKey = query?.queryKey;
          if (!Array.isArray(queryKey)) continue;
          const signature = JSON.stringify(queryKey).toLowerCase();
          if (signature.includes(needle)) push(queryKey);
        }

        push(["vscode", `${featureName}-permissions`]);
        return keys;
      }

      function buildActivationPlan(featureName, enabled) {
        const gateIds = discoverStatsigGatesForFeature(featureName);
        const statsigGates = {};
        for (const gateId of gateIds) statsigGates[gateId] = enabled;
        return {
          configKey: featureKeyPath(featureName),
          statsigGates,
          statsigGateIds: gateIds,
          queryKeys: discoverQueryKeysForFeature(featureName),
          usesStatsig: gateIds.length > 0,
        };
      }

      function enrichFeatureRequirements(feature) {
        const plan = buildActivationPlan(feature.name, feature.enabled);
        return {
          ...feature,
          statsigGateIds: plan.statsigGateIds,
          usesStatsig: plan.usesStatsig,
        };
      }

      async function applyFeatureActivation(hostId, featureName, enabled) {
        const plan = buildActivationPlan(featureName, enabled);
        await flags.propagate({
          hostId,
          statsigGates: plan.statsigGates,
          queryKeys: plan.queryKeys,
        });
        applyFeatureOverridesToCaches(hostId, { [featureName]: enabled });
        return plan;
      }

      function experimentalFeaturesQueryKey(hostId) {
        return [EXPERIMENTAL_FEATURES_QUERY_KEY, "list", hostId];
      }

      function configUserQueryKey(hostId) {
        return [CONFIG_USER_QUERY_KEY, "user", hostId];
      }

      function loadFeaturesFromQueryCache(hostId, overrides = null) {
        const queryClient = flags.getQueryClient();
        if (!queryClient) return null;
        const list = queryClient.getQueryData(experimentalFeaturesQueryKey(hostId));
        if (!Array.isArray(list) || list.length === 0) return null;
        const cachedOverrides =
          overrides ??
          queryClient.getQueryData(configUserQueryKey(hostId))?.config?.features ??
          null;
        return overlayConfigOverrides(mergeFeatures(list), cachedOverrides);
      }

      function updateFeatureInConfig(config, featureName, enabled) {
        const features = { ...(config?.features ?? {}), [featureName]: enabled };
        return { ...config, features };
      }

      function applyFeatureOverridesToCaches(hostId, overrides) {
        const queryClient = flags.getQueryClient();
        if (!queryClient || !overrides || typeof overrides !== "object") return;

        const entries = Object.entries(overrides).filter(
          ([, value]) => typeof value === "boolean",
        );
        if (!entries.length) return;

        const expKey = experimentalFeaturesQueryKey(hostId);
        queryClient.setQueryData(expKey, (current) => {
          if (!Array.isArray(current)) return current;
          return current.map((entry) => {
            const override = overrides[entry?.name];
            if (override == null) return entry;
            return { ...entry, enabled: override };
          });
        });

        const userKey = configUserQueryKey(hostId);
        queryClient.setQueryData(userKey, (current) => {
          if (!current?.config) return current;
          const nextFeatures = { ...(current.config.features ?? {}) };
          for (const [name, value] of entries) nextFeatures[name] = value;
          return {
            ...current,
            config: { ...current.config, features: nextFeatures },
          };
        });

        flags.notifyStatsigValuesUpdated();
      }

      async function readPersistedOverrides(hostId) {
        const queryClient = flags.getQueryClient();
        const fromCache = queryClient?.getQueryData(configUserQueryKey(hostId))?.config
          ?.features;
        if (fromCache && typeof fromCache === "object") {
          const overrides = {};
          for (const [name, value] of Object.entries(fromCache)) {
            if (typeof value === "boolean") overrides[name] = value;
          }
          if (Object.keys(overrides).length) return overrides;
        }

        const overrides = {};
        for (const name of KNOWN_FEATURE_NAMES) {
          const value = await readConfigOverride(name);
          if (value != null) overrides[name] = value;
        }
        return overrides;
      }

      function overlayConfigOverrides(features, overrides) {
        if (!overrides || typeof overrides !== "object") return features;
        return features.map((feature) => {
          const override = overrides[feature.name];
          if (override == null || typeof override !== "boolean") return feature;
          return { ...feature, enabled: override, source: "config" };
        });
      }

      async function rehydratePersistedFlags(hostId, { quiet = false } = {}) {
        const overrides = await readPersistedOverrides(hostId);
        const entries = Object.entries(overrides).filter(
          ([, value]) => typeof value === "boolean",
        );
        if (!entries.length) return overrides;

        const statsigGates = {};
        const queryKeys = [];
        for (const [name, enabled] of entries) {
          const plan = buildActivationPlan(name, enabled);
          Object.assign(statsigGates, plan.statsigGates);
          queryKeys.push(...plan.queryKeys);
        }

        await flags.propagate({ hostId, statsigGates, queryKeys });
        applyFeatureOverridesToCaches(hostId, Object.fromEntries(entries));

        if (!quiet && state.features.length) {
          state = {
            ...state,
            features: overlayConfigOverrides(state.features, overrides).map(enrichFeatureRequirements),
          };
        }

        return overrides;
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
        return features;
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
          if (persisted) await applyFeatureActivation(hostId, featureName, enabled);
        }

        if (!persisted) {
          const res = await bridge.rpc("set-configuration", {
            key: featureKeyPath(featureName),
            value: enabled,
          });
          if (!res?.success) throw new Error("Failed to persist feature flag");
          await applyFeatureActivation(hostId, featureName, enabled);
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

      function featureStageKey(feature) {
        return feature.stage ?? null;
      }

      function groupFeaturesByStage(features) {
        const groups = new Map(STAGE_SECTIONS.map((section) => [section.key, []]));
        for (const feature of features) {
          const key = featureStageKey(feature);
          const bucket = groups.has(key) ? key : null;
          groups.get(bucket).push(feature);
        }
        return STAGE_SECTIONS.map((section) => ({
          ...section,
          features: (groups.get(section.key) ?? []).sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        })).filter((section) => section.features.length > 0);
      }

      function stageAnchorId(sectionKey) {
        return `ex-ff-stage-${sectionKey ?? "unclassified"}`;
      }

      function stageJumpNav(sections, scrollContainer) {
        const nav = document.createElement("div");
        nav.style.cssText =
          "display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;" +
          "font:11px/1.35 system-ui,-apple-system,sans-serif;" +
          "color:color-mix(in srgb, currentColor 62%, transparent)";

        const label = document.createElement("span");
        label.textContent = "Jump to";
        nav.appendChild(label);

        sections.forEach((section, index) => {
          if (index > 0) {
            const sep = document.createElement("span");
            sep.textContent = "·";
            sep.setAttribute("aria-hidden", "true");
            sep.style.cssText = "color:color-mix(in srgb, currentColor 35%, transparent)";
            nav.appendChild(sep);
          }

          const link = document.createElement("button");
          link.type = "button";
          link.textContent = section.title;
          link.setAttribute("aria-label", `Jump to ${section.title} flags`);
          link.style.cssText =
            "background:none;border:none;padding:0;margin:0;cursor:pointer;font:inherit;" +
            "color:color-mix(in srgb, currentColor 88%, transparent);" +
            "text-decoration:underline;text-underline-offset:2px";
          link.addEventListener("click", () => {
            const target = scrollContainer.querySelector(`#${CSS.escape(stageAnchorId(section.key))}`);
            if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
          });
          nav.appendChild(link);
        });

        return nav;
      }

      function stageSectionHeader(section, { first = false } = {}) {
        const header = document.createElement("div");
        header.id = stageAnchorId(section.key);
        header.style.cssText =
          `display:flex;flex-direction:column;gap:3px;padding:${first ? "2px" : "14px"} 0 8px;` +
          (first ? "" : "border-top:1px solid color-mix(in srgb, currentColor 10%, transparent);margin-top:2px;");

        const titleRow = document.createElement("div");
        titleRow.style.cssText =
          "display:flex;align-items:baseline;justify-content:space-between;gap:8px";

        const title = document.createElement("div");
        title.textContent = section.title;
        title.style.cssText =
          "font:11px/1.3 ui-monospace,monospace;letter-spacing:0.06em;text-transform:uppercase;" +
          "color:color-mix(in srgb, currentColor 78%, transparent)";
        titleRow.appendChild(title);

        const count = document.createElement("div");
        const enabled = section.features.filter((feature) => feature.enabled).length;
        count.textContent = `${enabled}/${section.features.length}`;
        count.style.cssText =
          "font:10px/1.3 ui-monospace,monospace;color:color-mix(in srgb, currentColor 55%, transparent)";
        titleRow.appendChild(count);

        header.appendChild(titleRow);

        const blurb = document.createElement("div");
        blurb.textContent = section.description;
        blurb.style.cssText =
          "font:11px/1.4 system-ui,-apple-system,sans-serif;" +
          "color:color-mix(in srgb, currentColor 58%, transparent)";
        header.appendChild(blurb);

        return header;
      }

      function sourceBadgeLabel(feature) {
        if (feature.usesStatsig) return "config+statsig";
        if (feature.source === "config") return "config";
        if (feature.source === "statsig") return "default";
        if (feature.source === "catalog") return "catalog";
        return null;
      }

      function isToggleDisabled(feature) {
        return toggling.has(feature.name);
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

        const badgeLabel = sourceBadgeLabel(feature);
        if (badgeLabel) {
          const badge = document.createElement("span");
          badge.textContent = badgeLabel;
          badge.style.cssText =
            "font:10px/1 ui-monospace,monospace;letter-spacing:0.04em;text-transform:uppercase;" +
            "padding:2px 6px;border-radius:999px;" +
            "border:1px solid color-mix(in srgb, currentColor 16%, transparent);" +
            "color:color-mix(in srgb, currentColor 70%, transparent)";
          title.appendChild(badge);
        }

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

        if (feature.usesStatsig && feature.statsigGateIds?.length) {
          const gates = document.createElement("div");
          gates.textContent = `config + statsig (${feature.statsigGateIds.join(", ")})`;
          gates.style.cssText =
            "font:11px/1.35 ui-monospace,monospace;" +
            "color:color-mix(in srgb, currentColor 58%, transparent)";
          copy.appendChild(gates);
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
                    ? enrichFeatureRequirements({ ...entry, enabled, source: "config" })
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
        const isPopover = popoutOpen;
        body.style.cssText = isPopover
          ? "display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:hidden"
          : "display:flex;flex-direction:column;gap:12px";

        const intro = document.createElement("div");
        intro.style.cssText =
          "font:12px/1.5 system-ui,-apple-system,sans-serif;" +
          "color:color-mix(in srgb, currentColor 72%, transparent)";
        intro.textContent = hasAppServer()
          ? "Experimental flags persist to config.toml. Flags marked config+statsig also override discovered Statsig gates so Codex UI hooks stay in sync after restart."
          : "Feature flags from Codex defaults (statsig) and config overrides. Toggles persist config and apply discovered Statsig gate overrides when needed.";
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

        const jumpNavWrap = document.createElement("div");
        jumpNavWrap.style.cssText = "flex-shrink:0";

        const list = document.createElement("div");
        list.style.cssText = isPopover
          ? "flex:1;min-height:0;overflow:auto;padding-right:4px;scroll-padding-top:4px"
          : "max-height:min(60vh,520px);overflow:auto;padding-right:4px;scroll-padding-top:4px";

        const paintRows = () => {
          const query = filter.value.trim().toLowerCase();
          list.replaceChildren();
          jumpNavWrap.replaceChildren();
          const rows = state.features.filter((feature) => {
            if (!query) return true;
            const section = STAGE_SECTIONS.find((entry) => entry.key === featureStageKey(feature));
            const haystack = [
              feature.name,
              feature.label,
              feature.description,
              feature.stage,
              section?.title,
              section?.description,
            ]
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
          const sections = groupFeaturesByStage(rows);
          if (sections.length > 1) {
            jumpNavWrap.appendChild(stageJumpNav(sections, list));
          }
          sections.forEach((section, index) => {
            list.appendChild(stageSectionHeader(section, { first: index === 0 }));
            for (const feature of section.features) list.appendChild(featureRow(feature));
          });
        };

        filter.addEventListener("input", paintRows);
        paintRows();
        body.appendChild(jumpNavWrap);
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
          document.querySelector(".main-surface .scrollbar-stable") ??
          document.querySelector(".main-surface") ??
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
        if (!settings.embedInGeneralSettings) {
          unmountSettingsPanel();
          return;
        }
        const onSettings = getAppRoutePathname().includes(SETTINGS_ROUTE);
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
        if (!settings.showSidebarShortcut) {
          if (navButton?.isConnected) sidebarNav.remove(PLUGIN_ID);
          navButton = null;
          return;
        }
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
            const overrides = await readPersistedOverrides(hostId);
            const apiFeatures = await listExperimentalFeatures(hostId);
            if (disposed) return;
            let features =
              apiFeatures?.length
                ? mergeFeatures(apiFeatures)
                : await loadFeaturesFromFallback(hostId);
            features = overlayConfigOverrides(features, overrides).map(enrichFeatureRequirements);
            state = {
              loading: false,
              error: null,
              hostId,
              features,
              updatedAt: new Date(),
            };
            await rehydratePersistedFlags(hostId, { quiet: true });
            if (disposed) return;
            state = {
              ...state,
              features: overlayConfigOverrides(state.features, overrides).map(enrichFeatureRequirements),
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
        const path = getAppRoutePathname();
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
      lastPathname = getAppRoutePathname();
      startRouteWatcher();
      maybeUpdateSettingsPanel();
      void rehydratePersistedFlags(resolveHostId())
        .then(() => {
          if (!disposed) {
            paintNav();
            maybeUpdateSettingsPanel(true);
          }
        })
        .catch((err) => log.error("persisted flag rehydrate failed", err));
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
        flags.clearStatsigGateOverrides();
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