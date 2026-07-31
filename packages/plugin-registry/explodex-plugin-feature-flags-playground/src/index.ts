import { definePlugin, type PluginApi, type QueryClientApi } from "@explodex/sdk";
import {
  buildFingerprint,
  emptyBundleGateCache,
  isCacheFresh,
  runBundleGateScan,
  type BundleGateCache,
  type BundleScanEnvironment,
} from "./bundle-gate-scan";
import {
  CODEX_BUNDLE_GATE_HINTS,
  FEATURE_QUERY_KEY_HINTS,
  KNOWN_FEATURE_NAMES,
  featureKeyPath,
  mergeFeatures,
  mergeGateHints,
  normalizeBooleanMap,
  normalizeSettings,
  overlayConfigOverrides,
  type FeatureFlag,
  type FeatureFlagsSettings,
} from "./model";
import {
  renderFeatureFlagsPanel,
  type BundleScanView,
  type PanelState,
} from "./panel";

const PLUGIN_ID = "feature-flags-playground";
const SETTINGS_KEY = "explodex-feature-flags-playground";
const PANEL_ID = "explodex-feature-flags-panel";
const SETTINGS_ROUTE = "/settings/general-settings";
const DEFAULT_HOST_ID = "local";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const PERSISTED_GATE_HINTS_KEY = "explodex-feature-flags-playground-gate-hints";
const BUNDLE_SCAN_CACHE_KEY = "explodex-feature-flags-bundle-scan";
const EXPERIMENTAL_FEATURES_QUERY_KEY = "experimental-features";
const CONFIG_USER_QUERY_KEY = "config";

type AppServerFeaturePage = { data?: unknown; nextCursor?: unknown };
type ConfigResponse = { value?: unknown; success?: unknown };
type ConfigQueryData = { config?: { features?: unknown } };
type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readBundleCache(raw: unknown): BundleGateCache {
  const value = record(raw);
  if (!value) return emptyBundleGateCache();
  const fallback = emptyBundleGateCache();
  const mappings = Object.fromEntries(
    Object.entries(record(value.mappings) ?? {}).map(([name, ids]) => [name, stringArray(ids)]),
  );
  return {
    scannedAt: typeof value.scannedAt === "number" ? value.scannedAt : fallback.scannedAt,
    buildFingerprint: typeof value.buildFingerprint === "string" ? value.buildFingerprint : null,
    mappings,
    chunksScanned: stringArray(value.chunksScanned),
  };
}

function currentLocationHref(): string {
  return globalThis.location?.href ?? "app://-/index.html";
}

function runtimeScanEnvironment(): BundleScanEnvironment | null {
  if (typeof globalThis.fetch !== "function") return null;
  return {
    fetch: globalThis.fetch.bind(globalThis),
    locationHref: currentLocationHref(),
    loadedUrls() {
      const urls = new Set<string>();
      for (const entry of globalThis.performance?.getEntriesByType("resource") ?? []) {
        if (entry.name.includes(".js")) urls.add(entry.name);
      }
      for (const node of Array.from(document.querySelectorAll('link[rel="modulepreload"], script[type="module"]'))) {
        if (node instanceof HTMLLinkElement && node.href) urls.add(node.href);
        if (node instanceof HTMLScriptElement && node.src) urls.add(node.src);
      }
      return [...urls];
    },
    codexVersion() {
      return document.querySelector("meta[name='codex-version']")?.getAttribute("content") ?? null;
    },
  };
}

function queryKeyForFeatures(hostId: string): readonly unknown[] {
  return [EXPERIMENTAL_FEATURES_QUERY_KEY, "list", hostId];
}

function queryKeyForConfig(hostId: string): readonly unknown[] {
  return [CONFIG_USER_QUERY_KEY, "user", hostId];
}

function queryData<T>(client: QueryClientApi | null, key: readonly unknown[]): T | undefined {
  return client?.getQueryData<T>(key);
}

export async function setupFeatureFlagsPlayground(api: PluginApi): Promise<() => void> {
  const { bridge, components, flags, inject, log, registerOptions, sidebarNav, storage, ui } = api;
  await api.migrate([{ id: "rename-keys-from-feature-flags-settings", run: ({ renameKey }) => {
    renameKey("explodex-feature-flags-settings", SETTINGS_KEY);
    renameKey("explodex-feature-gate-hints", PERSISTED_GATE_HINTS_KEY);
  }}]);

  let disposed = false;
  let settings: FeatureFlagsSettings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));
  let state: PanelState = { loading: true, error: null, features: [], hostId: DEFAULT_HOST_ID, updatedAt: null };
  let scan: BundleScanView = { available: runtimeScanEnvironment() !== null, status: "idle", scannedAt: null, mappingCount: 0, chunkCount: 0, error: null };
  let navButton: HTMLButtonElement | null = null;
  let popoutOpen = false;
  let refreshing: Promise<void> | null = null;
  let scanning: Promise<void> | null = null;
  let lastSettingsKey: string | null = null;
  let lastPathname = "";
  let filter = "";
  let listScrollTop = 0;
  const toggling = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

  const saveSettings = (): void => storage.persisted.set(SETTINGS_KEY, settings);
  const saveGateHints = (hints: Record<string, string[]>): void => storage.persisted.set(PERSISTED_GATE_HINTS_KEY, hints);
  const readCache = (): BundleGateCache => readBundleCache(storage.persisted.get(BUNDLE_SCAN_CACHE_KEY, null));
  const saveCache = (cache: BundleGateCache): void => storage.persisted.set(BUNDLE_SCAN_CACHE_KEY, cache);
  const hostId = (): string => state.hostId || DEFAULT_HOST_ID;
  const resolveHostId = (): string => {
    const queries = flags.getQueryClient()?.getQueryCache().getAll() ?? [];
    for (const query of queries) {
      const [scope, operation, candidate] = query.queryKey;
      if (
        scope === EXPERIMENTAL_FEATURES_QUERY_KEY &&
        operation === "list" &&
        typeof candidate === "string" &&
        candidate.length > 0
      ) return candidate;
    }
    return hostId();
  };
  const appServerAvailable = (): boolean => bridge.isAvailable();
  const path = (): string => globalThis.location?.pathname ?? "";

  function refreshScanFromCache(cache = readCache()): void {
    scan = { ...scan, scannedAt: cache.scannedAt ? new Date(cache.scannedAt) : null, mappingCount: Object.keys(cache.mappings).length, chunkCount: cache.chunksScanned.length };
  }

  async function scanBundles(force = false, quiet = false): Promise<void> {
    const env = runtimeScanEnvironment();
    if (!env || disposed) return;
    if (scanning) return scanning;
    scanning = (async () => {
      if (!quiet) { scan = { ...scan, status: "scanning", error: null }; paint(); refreshPanels(); }
      try {
        const result = await runBundleGateScan({ cache: readCache(), env, force, maxChunks: 64 });
        if (disposed) return;
        saveCache(result.cache); refreshScanFromCache(result.cache);
        scan = { ...scan, status: result.fromCache ? "cached" : "ready", error: null };
      } catch (error) {
        if (!disposed) { scan = { ...scan, status: "error", error: error instanceof Error ? error.message : "Bundle scan failed" }; log.error("bundle gate scan failed", error); }
      } finally {
        scanning = null;
        if (!disposed) { paint(); refreshPanels(); }
      }
    })();
    return scanning;
  }

  function scheduleScan(): void {
    const env = runtimeScanEnvironment();
    if (!env) return;
    const cache = readCache();
    refreshScanFromCache(cache);
    const fingerprint = buildFingerprint(env.loadedUrls(), env.locationHref, env.codexVersion());
    if (isCacheFresh(cache, fingerprint)) { scan = { ...scan, status: "cached" }; return; }
    const timer = setTimeout(() => { timers.delete(timer); void scanBundles(false, true); }, 1_200);
    timers.add(timer);
  }

  async function ensureScanBeforeToggle(): Promise<void> {
    const env = runtimeScanEnvironment();
    if (!env) return;
    const cache = readCache();
    const fingerprint = buildFingerprint(env.loadedUrls(), env.locationHref, env.codexVersion());
    if (!isCacheFresh(cache, fingerprint)) await scanBundles(false, true);
  }

  function gateIdsFor(featureName: string): string[] {
    const hints = mergeGateHints(CODEX_BUNDLE_GATE_HINTS, readCache().mappings);
    const persisted = record(storage.persisted.get(PERSISTED_GATE_HINTS_KEY, {})) ?? {};
    const ids = new Set<string>([...(hints[featureName] ?? []), ...stringArray(persisted[featureName])]);
    const result = [...ids];
    if (result.length > 0) {
      const next = Object.fromEntries(Object.entries(persisted).map(([name, values]) => [name, stringArray(values)]));
      next[featureName] = [...new Set([...(next[featureName] ?? []), ...result])];
      saveGateHints(next);
    }
    return result;
  }

  function activationPlan(name: string, enabled: boolean): { gates: Record<string, boolean>; gateIds: string[]; queryKeys: readonly (readonly unknown[])[] } {
    const gateIds = gateIdsFor(name);
    return {
      gates: Object.fromEntries(gateIds.map((id) => [id, enabled])),
      gateIds,
      queryKeys: [...(FEATURE_QUERY_KEY_HINTS[name] ?? []), ["vscode", `${name}-permissions`]],
    };
  }

  function enrich(feature: FeatureFlag): FeatureFlag {
    const plan = activationPlan(feature.name, feature.enabled);
    return { ...feature, statsigGateIds: plan.gateIds, usesGateOverride: plan.gateIds.length > 0 };
  }

  function updateCaches(overrides: Readonly<Record<string, boolean>>): void {
    const client = flags.getQueryClient();
    if (!client) return;
    client.setQueryData<unknown>(queryKeyForFeatures(hostId()), (current) => Array.isArray(current) ? current.map((entry) => {
      const value = record(entry); const name = value && typeof value.name === "string" ? value.name : null;
      return name && typeof overrides[name] === "boolean" ? { ...value, enabled: overrides[name] } : entry;
    }) : current);
    client.setQueryData<ConfigQueryData>(queryKeyForConfig(hostId()), (current) => {
      if (!current?.config) return current;
      return { ...current, config: { ...current.config, features: { ...normalizeBooleanMap(current.config.features), ...overrides } } };
    });
  }

  async function readConfigOverride(name: string): Promise<boolean | null> {
    const response = await bridge.rpc<ConfigResponse>("get-configuration", { key: featureKeyPath(name) });
    return typeof response?.value === "boolean" ? response.value : null;
  }

  async function readOverrides(targetHostId: string): Promise<Record<string, boolean>> {
    const cached = queryData<ConfigQueryData>(flags.getQueryClient(), queryKeyForConfig(targetHostId))?.config?.features;
    if (cached) return normalizeBooleanMap(cached);
    const pairs = await Promise.all(KNOWN_FEATURE_NAMES.map(async (name) => [name, await readConfigOverride(name)] as const));
    const overrides: Record<string, boolean> = {};
    for (const [name, value] of pairs) if (typeof value === "boolean") overrides[name] = value;
    return overrides;
  }

  async function listFeatures(targetHostId: string): Promise<unknown[] | null> {
    const collected: unknown[] = [];
    let cursor: string | null = null;
    for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
      const page = await bridge.send<AppServerFeaturePage>("list-experimental-features", { hostId: targetHostId, cursor, limit: PAGE_LIMIT });
      if (!Array.isArray(page?.data)) return collected.length ? collected : null;
      collected.push(...page.data);
      const next = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return collected;
  }

  async function loadFallback(targetHostId: string, overrides: Record<string, boolean>): Promise<FeatureFlag[]> {
    const cached = queryData<unknown>(flags.getQueryClient(), queryKeyForFeatures(targetHostId));
    if (Array.isArray(cached) && cached.length > 0) return overlayConfigOverrides(mergeFeatures(cached), overrides);
    const entries = await Promise.all(KNOWN_FEATURE_NAMES.map(async (name) => [name, await readConfigOverride(name)] as const));
    return entries.map(([name, enabled]) => ({ name, enabled: enabled ?? false, stage: null, label: null, description: null, source: enabled === null ? "catalog" : "config" }));
  }

  async function propagate(targetHostId: string, overrides: Readonly<Record<string, boolean>>): Promise<void> {
    const gates: Record<string, boolean> = {}; const queryKeys: (readonly unknown[])[] = [];
    for (const [name, enabled] of Object.entries(overrides)) { const plan = activationPlan(name, enabled); Object.assign(gates, plan.gates); queryKeys.push(...plan.queryKeys); }
    await flags.propagate({ hostId: targetHostId, statsigGates: gates, queryKeys, pluginId: PLUGIN_ID });
    updateCaches(overrides);
  }

  async function writeFeature(name: string, enabled: boolean): Promise<void> {
    if (!bridge.isAvailable()) throw new Error("Bridge unavailable");
    await ensureScanBeforeToggle();
    const write = await bridge.send<unknown>("batch-write-config-value", { hostId: hostId(), edits: [{ keyPath: featureKeyPath(name), value: enabled, mergeStrategy: "upsert" }], filePath: null, expectedVersion: null });
    if (write == null) {
      const fallback = await bridge.rpc<ConfigResponse>("set-configuration", { key: featureKeyPath(name), value: enabled });
      if (fallback?.success !== true) throw new Error("Failed to persist feature flag");
    }
    await propagate(hostId(), { [name]: enabled });
    if (name === "remote_control") await bridge.send("set-remote-control-enabled-for-host", { hostId: hostId(), enabled });
  }

  async function refresh(quiet = false): Promise<void> {
    if (disposed || refreshing) return refreshing ?? undefined;
    refreshing = (async () => {
      if (!bridge.isAvailable()) { state = { ...state, loading: false, error: "Bridge unavailable" }; paint(); refreshPanels(); return; }
      if (!quiet) { state = { ...state, loading: true, error: null }; paint(); refreshPanels(); }
      try {
        const targetHostId = resolveHostId();
        const overrides = await readOverrides(targetHostId);
        const apiFeatures = await listFeatures(targetHostId);
        if (disposed) return;
        const features = overlayConfigOverrides(apiFeatures?.length ? mergeFeatures(apiFeatures) : await loadFallback(targetHostId, overrides), overrides).map(enrich);
        state = { loading: false, error: null, features, hostId: targetHostId, updatedAt: new Date() };
        await propagate(targetHostId, overrides);
      } catch (error) {
        if (!disposed) { log.error("feature refresh failed", error); state = { ...state, loading: false, error: error instanceof Error ? error.message : "Failed to load feature flags" }; }
      } finally { if (!disposed) { paint(); refreshPanels(); } refreshing = null; }
    })();
    return refreshing;
  }

  function viewState(): { filter: string; scrollTop: number } { return { filter, scrollTop: listScrollTop }; }
  function panel(): HTMLDivElement { return renderFeatureFlagsPanel({ components, getState: () => state, getScan: () => scan, isPopover: () => popoutOpen, isToggling: (name) => toggling.has(name), getView: viewState, setFilter: (value) => { filter = value; }, setScrollTop: (value) => { listScrollTop = value; }, appServerAvailable, refresh: () => { void refresh(popoutOpen); }, rescan: () => { void scanBundles(true).then(() => refresh(true)); }, openSettings: () => { ui.closePopover(); popoutOpen = false; void bridge.navigate(SETTINGS_ROUTE); const timer = setTimeout(() => { timers.delete(timer); mountSettingsPanel(true); }, 300); timers.add(timer); }, toggle: async (feature, enabled) => { if (toggling.has(feature.name)) return; toggling.add(feature.name); try { await writeFeature(feature.name, enabled); state = { ...state, features: state.features.map((item) => item.name === feature.name ? enrich({ ...item, enabled, source: "config" }) : item), updatedAt: new Date() }; components.statusToast(`${feature.name} ${enabled ? "enabled" : "disabled"}`); } catch (error) { log.error("feature toggle failed", error); components.statusToast(`Failed to update ${feature.name}`); } finally { toggling.delete(feature.name); paint(); refreshPanels(); } } }); }

  function captureView(): void {
    const root = popoutOpen ? Array.from(document.querySelectorAll(".ex-popover")).at(-1) : document.getElementById(PANEL_ID);
    const input = root?.querySelector("[data-explodex-ff-filter]"); const list = root?.querySelector("[data-explodex-ff-list]");
    if (input instanceof HTMLInputElement) filter = input.value;
    if (list instanceof HTMLElement) listScrollTop = list.scrollTop;
  }
  function settingsRoot(): HTMLElement | null { return document.querySelector<HTMLElement>(".main-surface .scrollbar-stable, .main-surface, main.main-surface .scrollbar-stable, main.main-surface"); }
  function mountSettingsPanel(force = false): void {
    if (disposed || !settings.embedInGeneralSettings || !path().includes(SETTINGS_ROUTE)) { document.getElementById(PANEL_ID)?.remove(); lastSettingsKey = null; return; }
    const key = `${state.loading}:${state.error ?? ""}:${state.features.map((feature) => `${feature.name}:${feature.enabled}`).join("|")}`;
    if (!force && key === lastSettingsKey && document.getElementById(PANEL_ID)) return;
    const root = settingsRoot(); if (!root) return;
    const inner = root.querySelector<HTMLElement>(".mx-auto.flex.w-full.flex-col") ?? root;
    const existing = document.getElementById(PANEL_ID); captureView();
    const container = existing ?? document.createElement("section");
    container.id = PANEL_ID; container.setAttribute("data-explodex-plugin", PLUGIN_ID); container.style.cssText = "scroll-margin-top:24px";
    container.replaceChildren(components.panel({ title: "All feature flags", children: panel, className: "explodex-feature-flags-settings-panel" }));
    if (!existing) inner.prepend(container); lastSettingsKey = key;
  }
  function refreshPanels(): void { if (popoutOpen && navButton?.isConnected) { captureView(); openPopover(navButton); } mountSettingsPanel(true); }
  function openPopover(anchor: Element): void { popoutOpen = true; ui.popover({ anchor, title: "Feature Flags", width: 420, side: "right", onClose: () => { popoutOpen = false; }, content: panel }); if (state.features.length === 0) void refresh(true); }
  function paint(): void {
    if (!settings.showSidebarShortcut) { sidebarNav.remove(PLUGIN_ID); navButton = null; return; }
    const label = state.features.length ? `Flags: ${state.features.filter((feature) => feature.enabled).length}/${state.features.length}` : state.loading ? "Flags: …" : "Flags: 0";
    if (!navButton?.isConnected) navButton = ui.navItem({ label, compact: true, onClick: (event) => { if (popoutOpen) { popoutOpen = false; ui.closePopover(); } else if (event.currentTarget instanceof Element) openPopover(event.currentTarget); } });
    const labelNode = navButton.querySelector("span:last-child"); if (labelNode) labelNode.textContent = label; else navButton.replaceChildren(document.createTextNode(label));
    sidebarNav.insertBefore(["Settings", "Profile", "Account"], navButton, PLUGIN_ID);
  }
  const onRoute = (): void => { const next = path(); if (next === lastPathname) return; lastPathname = next; mountSettingsPanel(); scheduleScan(); };
  const reposition = (): void => { if (popoutOpen && navButton?.isConnected) ui.repositionPopover({ anchor: navButton, width: 420, side: "right" }); };

  registerOptions({ render(container, context) { container.replaceChildren(components.fieldStack([
    components.checkboxField({ label: "Sidebar shortcut", checked: settings.showSidebarShortcut, onChange(value) { settings = { ...settings, showSidebarShortcut: value }; saveSettings(); if (!value) { ui.closePopover(); popoutOpen = false; } paint(); context.refresh(); } }),
    components.checkboxField({ label: "Embed panel in General Settings", checked: settings.embedInGeneralSettings, onChange(value) { settings = { ...settings, embedInGeneralSettings: value }; saveSettings(); mountSettingsPanel(true); context.refresh(); } }),
    components.metaText("Toggle individual flags from the sidebar popover or General Settings panel."),
  ])); }});
  paint(); lastPathname = path();
  globalThis.addEventListener("popstate", onRoute); globalThis.addEventListener("resize", reposition); globalThis.addEventListener("scroll", reposition, true);
  const refreshTimer = setInterval(() => { void refresh(true); }, 60_000); timers.add(refreshTimer);
  const stopSidebar = inject.observeZone("sidebar", () => { if (!navButton?.isConnected) { navButton = null; paint(); } reposition(); });
  mountSettingsPanel(); scheduleScan(); void refresh();
  return () => { disposed = true; for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers.clear(); stopSidebar(); globalThis.removeEventListener("popstate", onRoute); globalThis.removeEventListener("resize", reposition); globalThis.removeEventListener("scroll", reposition, true); ui.closePopover(); sidebarNav.remove(PLUGIN_ID); document.getElementById(PANEL_ID)?.remove(); navButton = null; };
}

export default definePlugin({ setup: setupFeatureFlagsPlayground });
