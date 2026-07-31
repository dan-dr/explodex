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
    default: () => index_default,
    setupFeatureFlagsPlayground: () => setupFeatureFlagsPlayground
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

  // src/bundle-gate-scan.ts
  var BUNDLE_GATE_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
  var GATE_ID_RE = /^\d{6,12}$/;
  var FEATURE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
  var PRIORITY_PATTERNS = [/app-server-manager-signals/i, /thread-context-inputs/i, /experimental-feature/i, /statsig/i, /general-settings/i, /realtime/i, /composer/i, /use-is-thread-realtime/i, /app-server-dynamic-tools/i];
  function emptyBundleGateCache() {
    return { scannedAt: 0, buildFingerprint: null, mappings: {}, chunksScanned: [] };
  }
  function chunkLabel(url) {
    return url.match(/\/([^/?#]+\.js)(?:\?|#|$)/)?.[1] ?? url;
  }
  function addMapping(mappings, featureName, gateId, source) {
    if (!FEATURE_NAME_RE.test(featureName) || !GATE_ID_RE.test(gateId)) return;
    const bucket = mappings[featureName] ?? (mappings[featureName] = []);
    if (!bucket.some((entry) => entry.gateId === gateId)) bucket.push({ gateId, source, confidence: source === "proximity" ? 2 : 3 });
  }
  function flattenMappings(mappings) {
    return Object.fromEntries(Object.entries(mappings).map(([name, values]) => [name, [...new Set(values.map((value) => value.gateId))]]).filter(([, ids]) => ids.length > 0));
  }
  function mergeMappingRecords(target, source) {
    for (const [featureName, entries] of Object.entries(source)) for (const entry of entries) addMapping(target, featureName, entry.gateId, entry.source);
    return target;
  }
  function extractConstAliases(source) {
    const aliases = /* @__PURE__ */ new Map();
    for (const match of source.matchAll(/(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*`([a-z][a-z0-9_]{1,63})`/g)) aliases.set(match[1], match[2]);
    return aliases;
  }
  function extractGateMappingsFromSource(source, chunkName = "unknown") {
    const mappings = {};
    const aliases = extractConstAliases(source);
    for (const match of source.matchAll(/gateName:\s*`(\d+)`\s*,\s*featureKey:\s*(?:`([^`]+)`|([A-Za-z_$][\w$]*))/g)) addMapping(mappings, match[2] ?? aliases.get(match[3]) ?? match[3], match[1], "ng-table");
    for (const match of source.matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:\s*ln\(\s*\w+\s*,\s*`(\d+)`/g)) addMapping(mappings, aliases.get(match[1]) ?? match[1], match[2], "hardcoded");
    for (const match of source.matchAll(/\[\s*`([a-z][a-z0-9_]{1,63})`\s*\]\s*:\s*ln\(\s*\w+\s*,\s*`(\d+)`/g)) addMapping(mappings, match[1], match[2], "hardcoded");
    const calls = [...source.matchAll(/(?:checkGate|useGateValue|useGate|getGateValue)\(\s*`(\d+)`\s*\)|\b[oc]\(\s*`(\d+)`\s*\)/g)].map((match) => ({ gateId: match[1] ?? match[2], index: match.index ?? 0 }));
    for (const match of source.matchAll(/`([a-z][a-z0-9_]{1,63})`/g)) for (const call of calls) if (Math.abs(call.index - (match.index ?? 0)) <= 180) addMapping(mappings, match[1], call.gateId, "proximity");
    for (const match of source.matchAll(/featureKeys:\s*\[([^\]]+)\][^}]{0,240}?layerName:\s*`(\d+)`/g)) for (const name of match[1].matchAll(/`([a-z][a-z0-9_]{1,63})`/g)) addMapping(mappings, name[1], match[2], "layer");
    return { mappings, chunkName };
  }
  function extractMapDepsPaths(source) {
    const match = source.match(/__vite__mapDeps[\s\S]*?\.f\s*=\s*\[([\s\S]*?)\]/);
    return match ? [...match[1].matchAll(/"(\.\/[^\"]+\.js)"/g)].map((entry) => entry[1]) : [];
  }
  function resolveAssetUrl(relativePath, baseHref) {
    try {
      return new URL(relativePath, baseHref).href;
    } catch {
      return null;
    }
  }
  function scoreMapDepSource(url) {
    const label = chunkLabel(url);
    if (/^index-/.test(label)) return 100;
    if (/^app-main-/.test(label)) return 90;
    if (/thread-context|app-server-manager/.test(label)) return 85;
    if (/composer|realtime|experimental-feature/.test(label)) return 75;
    return 1;
  }
  async function discoverChunkUrls(env, maxSources = 12) {
    const urls = new Set(env.loadedUrls());
    const candidates = [...urls].filter((url) => /\/[^/]+\.js(?:\?|#|$)/.test(url)).sort((left, right) => scoreMapDepSource(right) - scoreMapDepSource(left));
    for (const candidate of candidates.slice(0, maxSources)) {
      try {
        const response = await env.fetch(candidate);
        if (!response.ok) continue;
        const source = await response.text();
        if (!source.includes("__vite__mapDeps")) continue;
        for (const path of extractMapDepsPaths(source)) {
          const resolved = resolveAssetUrl(path, candidate);
          if (resolved) urls.add(resolved);
        }
      } catch {
      }
    }
    return [...urls];
  }
  function buildFingerprint(urls, locationHref, codexVersion = null) {
    const labels = urls.map(chunkLabel).sort();
    const anchors = labels.filter((label) => /^(index|app-main|app-server-manager)-/.test(label));
    let host = "";
    try {
      host = new URL(locationHref).host;
    } catch {
    }
    return [host, codexVersion ?? "", ...anchors.length ? anchors.slice(0, 6) : labels.slice(0, 8)].join("|");
  }
  function prioritizeChunkUrls(urls) {
    return urls.map((url) => ({ url, label: chunkLabel(url), score: PRIORITY_PATTERNS.reduce((score, pattern, index) => score + (pattern.test(chunkLabel(url)) ? PRIORITY_PATTERNS.length - index : 0), 0) })).sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
  }
  function isCacheFresh(cache, fingerprint, now = Date.now()) {
    return Boolean(cache.scannedAt && cache.buildFingerprint === fingerprint && now - cache.scannedAt < BUNDLE_GATE_CACHE_TTL_MS);
  }
  function mergeDiscoveredMappings(existing, discovered) {
    const result = { ...existing };
    for (const [name, ids] of Object.entries(discovered)) result[name] = [.../* @__PURE__ */ new Set([...result[name] ?? [], ...ids])];
    return result;
  }
  async function runBundleGateScan(options) {
    const urls = await discoverChunkUrls(options.env);
    const fingerprint = buildFingerprint(urls, options.env.locationHref, options.env.codexVersion());
    if (!options.force && isCacheFresh(options.cache, fingerprint)) return { cache: options.cache, fromCache: true, fingerprint, urlCount: urls.length };
    const merged = {};
    const chunksScanned = [];
    for (const item of prioritizeChunkUrls(urls).slice(0, options.maxChunks ?? 40)) {
      try {
        const response = await options.env.fetch(item.url);
        if (!response.ok) continue;
        const result = extractGateMappingsFromSource(await response.text(), item.label);
        mergeMappingRecords(merged, result.mappings);
        chunksScanned.push(result.chunkName);
      } catch {
      }
    }
    return { cache: { scannedAt: Date.now(), buildFingerprint: fingerprint, mappings: mergeDiscoveredMappings(options.cache.mappings, flattenMappings(merged)), chunksScanned: [.../* @__PURE__ */ new Set([...options.cache.chunksScanned, ...chunksScanned])] }, fromCache: false, fingerprint, urlCount: urls.length };
  }

  // src/model.ts
  var STAGE_SECTIONS = [
    { key: "stable", title: "Stable", description: "Generally available; intended for everyday use." },
    { key: "beta", title: "Beta", description: "Wider rollout with ongoing iteration." },
    { key: "underDevelopment", title: "Under development", description: "Experimental or internal; behavior may change abruptly." },
    { key: "removed", title: "Removed", description: "Deprecated or retired; toggles may no longer do anything." },
    { key: null, title: "Unclassified", description: "Not tagged by Codex list API (catalog fallback)." }
  ];
  var KNOWN_FEATURE_NAMES = [
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
    "js_repl"
  ];
  var CODEX_BUNDLE_GATE_HINTS = {
    browser_use: ["410262010"],
    browser_use_external: ["410065390"],
    chronicle: ["2574306096"],
    computer_use: ["1506311413"],
    in_app_browser: ["1834314516"]
  };
  var FEATURE_QUERY_KEY_HINTS = {
    chronicle: [["vscode", "chronicle-permissions"]],
    memories: [["vscode", "get-global-state", '{"key":"memories"}']]
  };
  function defaultSettings() {
    return { showSidebarShortcut: true, embedInGeneralSettings: true };
  }
  function normalizeSettings(raw) {
    const defaults = defaultSettings();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaults;
    const value = raw;
    return {
      showSidebarShortcut: value.showSidebarShortcut !== false,
      embedInGeneralSettings: value.embedInGeneralSettings !== false
    };
  }
  function featureKeyPath(name) {
    return name.startsWith("features.") ? name : `features.${name}`;
  }
  function normalizeBooleanMap(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter((entry) => typeof entry[1] === "boolean")
    );
  }
  function normalizeFeature(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw;
    const name = String(item.name ?? item.id ?? "").trim();
    if (!name) return null;
    const label = item.label ?? item.displayName;
    return {
      name,
      enabled: Boolean(item.enabled),
      stage: item.stage == null ? null : String(item.stage),
      label: label == null ? null : String(label).trim() || null,
      description: item.description == null ? null : String(item.description).trim() || null,
      source: "api"
    };
  }
  function mergeFeatures(rawFeatures) {
    const byName = /* @__PURE__ */ new Map();
    for (const raw of rawFeatures) {
      const feature = normalizeFeature(raw);
      if (feature) byName.set(feature.name, feature);
    }
    for (const name of KNOWN_FEATURE_NAMES) {
      if (!byName.has(name)) {
        byName.set(name, { name, enabled: false, stage: null, label: null, description: null, source: "catalog" });
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
  function overlayConfigOverrides(features, overrides) {
    return features.map((feature) => {
      const enabled = overrides[feature.name];
      return typeof enabled === "boolean" ? { ...feature, enabled, source: "config" } : feature;
    });
  }
  function groupFeaturesByStage(features) {
    const grouped = /* @__PURE__ */ new Map();
    for (const section of STAGE_SECTIONS) grouped.set(section.key, []);
    for (const feature of features) grouped.get(grouped.has(feature.stage) ? feature.stage : null)?.push(feature);
    return STAGE_SECTIONS.map((section) => ({
      ...section,
      features: [...grouped.get(section.key) ?? []].sort((left, right) => left.name.localeCompare(right.name))
    })).filter((section) => section.features.length > 0);
  }
  function filterFeatures(features, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...features];
    return features.filter((feature) => {
      const section = STAGE_SECTIONS.find((entry) => entry.key === feature.stage);
      return [feature.name, feature.label, feature.description, feature.stage, section?.title, section?.description].filter((value) => Boolean(value)).join(" ").toLowerCase().includes(needle);
    });
  }
  function stageAnchorId(stage) {
    return `explodex-ff-stage-${stage ?? "unclassified"}`;
  }
  function mergeGateHints(first, second) {
    const merged = {};
    for (const [name, ids] of [...Object.entries(first), ...Object.entries(second)]) {
      merged[name] = [.../* @__PURE__ */ new Set([...merged[name] ?? [], ...ids])];
    }
    return merged;
  }

  // src/panel.ts
  function summary(scan) {
    if (!scan.available) return "Bundle scan unavailable";
    if (scan.status === "scanning") return "Scanning Codex bundles\u2026";
    if (scan.error) return `Bundle scan error: ${scan.error}`;
    if (!scan.scannedAt) return "Bundle scan pending";
    const ageHours = Math.max(0, Math.round((Date.now() - scan.scannedAt.getTime()) / 36e5));
    return `Bundle gates: ${scan.mappingCount} features / ${scan.chunkCount} chunks (${scan.status === "cached" ? "cached" : "fresh"}, ${ageHours}h)`;
  }
  function style(element, css) {
    element.style.cssText = css;
    return element;
  }
  function stageHeader(section, first) {
    const header = style(document.createElement("div"), `display:flex;flex-direction:column;gap:3px;padding:${first ? "2px" : "14px"} 0 8px;${first ? "" : "border-top:1px solid color-mix(in srgb, currentColor 10%, transparent);margin-top:2px;"}`);
    header.id = stageAnchorId(section.key);
    const titleRow = style(document.createElement("div"), "display:flex;align-items:baseline;justify-content:space-between;gap:8px");
    const title = style(document.createElement("div"), "font:11px/1.3 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:color-mix(in srgb,currentColor 78%,transparent)");
    title.textContent = section.title;
    const count = style(document.createElement("div"), "font:10px/1.3 ui-monospace,monospace;color:color-mix(in srgb,currentColor 55%,transparent)");
    count.textContent = `${section.features.filter((feature) => feature.enabled).length}/${section.features.length}`;
    titleRow.append(title, count);
    const description = style(document.createElement("div"), "font:11px/1.4 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 58%,transparent)");
    description.textContent = section.description;
    header.append(titleRow, description);
    return header;
  }
  function featureRow(feature, actions) {
    const row = style(document.createElement("div"), "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;padding:10px 0;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)");
    const copy = style(document.createElement("div"), "min-width:0;display:flex;flex-direction:column;gap:4px");
    const title = style(document.createElement("div"), "display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:13px/1.35 system-ui,-apple-system,sans-serif");
    const name = style(document.createElement("code"), "font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 8%,transparent)");
    name.textContent = feature.name;
    title.appendChild(name);
    if (feature.statsigGateIds?.length) {
      const gates = style(document.createElement("span"), "font:10px/1 ui-monospace,monospace;padding:2px 6px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);color:color-mix(in srgb,currentColor 70%,transparent)");
      gates.textContent = feature.statsigGateIds.join(", ");
      title.appendChild(gates);
    }
    copy.appendChild(title);
    for (const [text, css] of [[feature.label, "font:13px/1.35 system-ui,-apple-system,sans-serif"], [feature.description, "font:12px/1.45 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 68%,transparent)"]]) {
      if (!text) continue;
      const node = style(document.createElement("div"), css);
      node.textContent = text;
      copy.appendChild(node);
    }
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = feature.enabled;
    input.disabled = actions.isToggling(feature.name);
    input.setAttribute("aria-label", `Toggle ${feature.name}`);
    input.style.cssText = "width:16px;height:16px;cursor:pointer;accent-color:var(--color-text-primary,#fff)";
    input.addEventListener("change", () => {
      void actions.toggle(feature, input.checked);
    });
    const toggle = style(document.createElement("div"), "display:flex;align-items:start;justify-content:end");
    toggle.appendChild(input);
    row.append(copy, toggle);
    return row;
  }
  function stageJumpNav(sections, scrollContainer) {
    const nav = style(document.createElement("div"), "display:flex;flex-wrap:wrap;gap:6px 10px;padding:2px 0 4px;font:11px/1.3 system-ui,-apple-system,sans-serif");
    for (const section of sections) {
      const link = style(document.createElement("button"), "background:none;border:none;padding:0;margin:0;cursor:pointer;font:inherit;color:color-mix(in srgb,currentColor 88%,transparent);text-decoration:underline;text-underline-offset:2px");
      link.type = "button";
      link.textContent = section.title;
      link.addEventListener("click", () => scrollContainer.querySelector(`#${CSS.escape(stageAnchorId(section.key))}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
      nav.appendChild(link);
    }
    return nav;
  }
  function renderFeatureFlagsPanel(actions) {
    const state = actions.getState();
    const scan = actions.getScan();
    const view = actions.getView();
    const body = style(document.createElement("div"), actions.isPopover() ? "display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:hidden" : "display:flex;flex-direction:column;gap:12px");
    const intro = style(document.createElement("div"), "font:12px/1.5 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 72%,transparent)");
    intro.textContent = actions.appServerAvailable() ? "Toggles persist to config.toml and override linked statsig gates (gate IDs shown per flag) so Codex UI hooks stay in sync." : "Toggles persist config overrides and apply discovered statsig gate overrides when needed.";
    body.appendChild(intro);
    const scanMeta = style(document.createElement("div"), "font:11px/1.4 ui-monospace,monospace;color:color-mix(in srgb,currentColor 62%,transparent)");
    scanMeta.textContent = summary(scan);
    body.appendChild(scanMeta);
    if (state.loading && state.features.length === 0) {
      const loading = style(document.createElement("div"), "font:13px system-ui,-apple-system,sans-serif;opacity:.8");
      loading.textContent = "Loading feature flags\u2026";
      body.appendChild(loading);
      return body;
    }
    if (state.error) {
      const error = style(document.createElement("div"), "font:13px system-ui,-apple-system,sans-serif;color:var(--color-text-danger,#f87171)");
      error.textContent = state.error;
      body.appendChild(error);
    }
    const meta = style(document.createElement("div"), "display:flex;flex-wrap:wrap;gap:8px;font:11px/1.3 ui-monospace,monospace;color:color-mix(in srgb,currentColor 65%,transparent)");
    meta.textContent = `host=${state.hostId} \xB7 ${state.features.filter((feature) => feature.enabled).length} enabled \xB7 ${state.features.length} total`;
    const filter = document.createElement("input");
    filter.type = "search";
    filter.placeholder = "Filter flags\u2026";
    filter.value = view.filter;
    filter.setAttribute("data-explodex-ff-filter", "");
    filter.style.cssText = "width:100%;padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:13px system-ui,-apple-system,sans-serif";
    const jumpWrap = style(document.createElement("div"), "flex-shrink:0");
    const list = style(document.createElement("div"), actions.isPopover() ? "flex:1;min-height:0;overflow:auto;padding-right:4px;scroll-padding-top:4px" : "max-height:min(60vh,520px);overflow:auto;padding-right:4px;scroll-padding-top:4px");
    list.setAttribute("data-explodex-ff-list", "");
    const paint = () => {
      list.replaceChildren();
      jumpWrap.replaceChildren();
      const rows = filterFeatures(actions.getState().features, filter.value);
      if (rows.length === 0) {
        const empty = style(document.createElement("div"), "padding:12px 0;font:13px system-ui,-apple-system,sans-serif;opacity:.75");
        empty.textContent = filter.value.trim() ? "No flags match your filter." : "No feature flags returned.";
        list.appendChild(empty);
        return;
      }
      const sections = groupFeaturesByStage(rows);
      if (sections.length > 1) jumpWrap.appendChild(stageJumpNav(sections, list));
      sections.forEach((section, index) => {
        list.appendChild(stageHeader(section, index === 0));
        for (const feature of section.features) list.appendChild(featureRow(feature, actions));
      });
    };
    filter.addEventListener("input", () => {
      actions.setFilter(filter.value);
      actions.setScrollTop(0);
      paint();
    });
    list.addEventListener("scroll", () => actions.setScrollTop(list.scrollTop), { passive: true });
    paint();
    if (view.scrollTop > 0) requestAnimationFrame(() => {
      list.scrollTop = view.scrollTop;
    });
    body.append(meta, filter, jumpWrap, list);
    const buttons = style(document.createElement("div"), "display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between");
    buttons.appendChild(actions.components.button({ label: state.loading ? "Refreshing\u2026" : "Refresh", color: "outline", size: "composerSm", disabled: state.loading, onClick: actions.refresh }));
    if (scan.available) buttons.appendChild(actions.components.button({ label: scan.status === "scanning" ? "Scanning\u2026" : "Rescan bundles", color: "ghost", size: "composerSm", disabled: scan.status === "scanning", onClick: actions.rescan }));
    buttons.appendChild(actions.components.button({ label: "Open General Settings", color: "ghost", size: "composerSm", onClick: actions.openSettings }));
    body.appendChild(buttons);
    if (state.updatedAt) {
      const stamp = style(document.createElement("div"), "font:11px/1.3 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 55%,transparent)");
      stamp.textContent = `Updated ${new Intl.DateTimeFormat(void 0, { timeStyle: "short" }).format(state.updatedAt)}`;
      body.appendChild(stamp);
    }
    const note = style(document.createElement("div"), "font:11px/1.45 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 55%,transparent)");
    note.textContent = "Some flags may require a Codex restart to fully apply. Remote control also updates local host enablement.";
    body.appendChild(note);
    return body;
  }

  // src/index.ts
  var PLUGIN_ID = "feature-flags-playground";
  var SETTINGS_KEY = "explodex-feature-flags-playground";
  var PANEL_ID = "explodex-feature-flags-panel";
  var SETTINGS_ROUTE = "/settings/general-settings";
  var DEFAULT_HOST_ID = "local";
  var PAGE_LIMIT = 100;
  var MAX_PAGES = 20;
  var PERSISTED_GATE_HINTS_KEY = "explodex-feature-flags-playground-gate-hints";
  var BUNDLE_SCAN_CACHE_KEY = "explodex-feature-flags-bundle-scan";
  var EXPERIMENTAL_FEATURES_QUERY_KEY = "experimental-features";
  var CONFIG_USER_QUERY_KEY = "config";
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  }
  function stringArray(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  }
  function readBundleCache(raw) {
    const value = record(raw);
    if (!value) return emptyBundleGateCache();
    const fallback = emptyBundleGateCache();
    const mappings = Object.fromEntries(
      Object.entries(record(value.mappings) ?? {}).map(([name, ids]) => [name, stringArray(ids)])
    );
    return {
      scannedAt: typeof value.scannedAt === "number" ? value.scannedAt : fallback.scannedAt,
      buildFingerprint: typeof value.buildFingerprint === "string" ? value.buildFingerprint : null,
      mappings,
      chunksScanned: stringArray(value.chunksScanned)
    };
  }
  function currentLocationHref() {
    return globalThis.location?.href ?? "app://-/index.html";
  }
  function runtimeScanEnvironment() {
    if (typeof globalThis.fetch !== "function") return null;
    return {
      fetch: globalThis.fetch.bind(globalThis),
      locationHref: currentLocationHref(),
      loadedUrls() {
        const urls = /* @__PURE__ */ new Set();
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
      }
    };
  }
  function queryKeyForFeatures(hostId) {
    return [EXPERIMENTAL_FEATURES_QUERY_KEY, "list", hostId];
  }
  function queryKeyForConfig(hostId) {
    return [CONFIG_USER_QUERY_KEY, "user", hostId];
  }
  function queryData(client, key) {
    return client?.getQueryData(key);
  }
  async function setupFeatureFlagsPlayground(api) {
    const { bridge, components, flags, inject, log, registerOptions, sidebarNav, storage, ui } = api;
    await api.migrate([{ id: "rename-keys-from-feature-flags-settings", run: ({ renameKey }) => {
      renameKey("explodex-feature-flags-settings", SETTINGS_KEY);
      renameKey("explodex-feature-gate-hints", PERSISTED_GATE_HINTS_KEY);
    } }]);
    let disposed = false;
    let settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));
    let state = { loading: true, error: null, features: [], hostId: DEFAULT_HOST_ID, updatedAt: null };
    let scan = { available: runtimeScanEnvironment() !== null, status: "idle", scannedAt: null, mappingCount: 0, chunkCount: 0, error: null };
    let navButton = null;
    let popoutOpen = false;
    let refreshing = null;
    let scanning = null;
    let lastSettingsKey = null;
    let lastPathname = "";
    let filter = "";
    let listScrollTop = 0;
    const toggling = /* @__PURE__ */ new Set();
    const timers = /* @__PURE__ */ new Set();
    const saveSettings = () => storage.persisted.set(SETTINGS_KEY, settings);
    const saveGateHints = (hints) => storage.persisted.set(PERSISTED_GATE_HINTS_KEY, hints);
    const readCache = () => readBundleCache(storage.persisted.get(BUNDLE_SCAN_CACHE_KEY, null));
    const saveCache = (cache) => storage.persisted.set(BUNDLE_SCAN_CACHE_KEY, cache);
    const hostId = () => state.hostId || DEFAULT_HOST_ID;
    const resolveHostId = () => {
      const queries = flags.getQueryClient()?.getQueryCache().getAll() ?? [];
      for (const query of queries) {
        const [scope, operation, candidate] = query.queryKey;
        if (scope === EXPERIMENTAL_FEATURES_QUERY_KEY && operation === "list" && typeof candidate === "string" && candidate.length > 0) return candidate;
      }
      return hostId();
    };
    const appServerAvailable = () => bridge.isAvailable();
    const path = () => globalThis.location?.pathname ?? "";
    function refreshScanFromCache(cache = readCache()) {
      scan = { ...scan, scannedAt: cache.scannedAt ? new Date(cache.scannedAt) : null, mappingCount: Object.keys(cache.mappings).length, chunkCount: cache.chunksScanned.length };
    }
    async function scanBundles(force = false, quiet = false) {
      const env = runtimeScanEnvironment();
      if (!env || disposed) return;
      if (scanning) return scanning;
      scanning = (async () => {
        if (!quiet) {
          scan = { ...scan, status: "scanning", error: null };
          paint();
          refreshPanels();
        }
        try {
          const result = await runBundleGateScan({ cache: readCache(), env, force, maxChunks: 64 });
          if (disposed) return;
          saveCache(result.cache);
          refreshScanFromCache(result.cache);
          scan = { ...scan, status: result.fromCache ? "cached" : "ready", error: null };
        } catch (error) {
          if (!disposed) {
            scan = { ...scan, status: "error", error: error instanceof Error ? error.message : "Bundle scan failed" };
            log.error("bundle gate scan failed", error);
          }
        } finally {
          scanning = null;
          if (!disposed) {
            paint();
            refreshPanels();
          }
        }
      })();
      return scanning;
    }
    function scheduleScan() {
      const env = runtimeScanEnvironment();
      if (!env) return;
      const cache = readCache();
      refreshScanFromCache(cache);
      const fingerprint = buildFingerprint(env.loadedUrls(), env.locationHref, env.codexVersion());
      if (isCacheFresh(cache, fingerprint)) {
        scan = { ...scan, status: "cached" };
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        void scanBundles(false, true);
      }, 1200);
      timers.add(timer);
    }
    async function ensureScanBeforeToggle() {
      const env = runtimeScanEnvironment();
      if (!env) return;
      const cache = readCache();
      const fingerprint = buildFingerprint(env.loadedUrls(), env.locationHref, env.codexVersion());
      if (!isCacheFresh(cache, fingerprint)) await scanBundles(false, true);
    }
    function gateIdsFor(featureName) {
      const hints = mergeGateHints(CODEX_BUNDLE_GATE_HINTS, readCache().mappings);
      const persisted = record(storage.persisted.get(PERSISTED_GATE_HINTS_KEY, {})) ?? {};
      const ids = /* @__PURE__ */ new Set([...hints[featureName] ?? [], ...stringArray(persisted[featureName])]);
      const result = [...ids];
      if (result.length > 0) {
        const next = Object.fromEntries(Object.entries(persisted).map(([name, values]) => [name, stringArray(values)]));
        next[featureName] = [.../* @__PURE__ */ new Set([...next[featureName] ?? [], ...result])];
        saveGateHints(next);
      }
      return result;
    }
    function activationPlan(name, enabled) {
      const gateIds = gateIdsFor(name);
      return {
        gates: Object.fromEntries(gateIds.map((id) => [id, enabled])),
        gateIds,
        queryKeys: [...FEATURE_QUERY_KEY_HINTS[name] ?? [], ["vscode", `${name}-permissions`]]
      };
    }
    function enrich(feature) {
      const plan = activationPlan(feature.name, feature.enabled);
      return { ...feature, statsigGateIds: plan.gateIds, usesGateOverride: plan.gateIds.length > 0 };
    }
    function updateCaches(overrides) {
      const client = flags.getQueryClient();
      if (!client) return;
      client.setQueryData(queryKeyForFeatures(hostId()), (current) => Array.isArray(current) ? current.map((entry) => {
        const value = record(entry);
        const name = value && typeof value.name === "string" ? value.name : null;
        return name && typeof overrides[name] === "boolean" ? { ...value, enabled: overrides[name] } : entry;
      }) : current);
      client.setQueryData(queryKeyForConfig(hostId()), (current) => {
        if (!current?.config) return current;
        return { ...current, config: { ...current.config, features: { ...normalizeBooleanMap(current.config.features), ...overrides } } };
      });
    }
    async function readConfigOverride(name) {
      const response = await bridge.rpc("get-configuration", { key: featureKeyPath(name) });
      return typeof response?.value === "boolean" ? response.value : null;
    }
    async function readOverrides(targetHostId) {
      const cached = queryData(flags.getQueryClient(), queryKeyForConfig(targetHostId))?.config?.features;
      if (cached) return normalizeBooleanMap(cached);
      const pairs = await Promise.all(KNOWN_FEATURE_NAMES.map(async (name) => [name, await readConfigOverride(name)]));
      const overrides = {};
      for (const [name, value] of pairs) if (typeof value === "boolean") overrides[name] = value;
      return overrides;
    }
    async function listFeatures(targetHostId) {
      const collected = [];
      let cursor = null;
      for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
        const page = await bridge.send("list-experimental-features", { hostId: targetHostId, cursor, limit: PAGE_LIMIT });
        if (!Array.isArray(page?.data)) return collected.length ? collected : null;
        collected.push(...page.data);
        const next = typeof page.nextCursor === "string" ? page.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
      return collected;
    }
    async function loadFallback(targetHostId, overrides) {
      const cached = queryData(flags.getQueryClient(), queryKeyForFeatures(targetHostId));
      if (Array.isArray(cached) && cached.length > 0) return overlayConfigOverrides(mergeFeatures(cached), overrides);
      const entries = await Promise.all(KNOWN_FEATURE_NAMES.map(async (name) => [name, await readConfigOverride(name)]));
      return entries.map(([name, enabled]) => ({ name, enabled: enabled ?? false, stage: null, label: null, description: null, source: enabled === null ? "catalog" : "config" }));
    }
    async function propagate(targetHostId, overrides) {
      const gates = {};
      const queryKeys = [];
      for (const [name, enabled] of Object.entries(overrides)) {
        const plan = activationPlan(name, enabled);
        Object.assign(gates, plan.gates);
        queryKeys.push(...plan.queryKeys);
      }
      await flags.propagate({ hostId: targetHostId, statsigGates: gates, queryKeys, pluginId: PLUGIN_ID });
      updateCaches(overrides);
    }
    async function writeFeature(name, enabled) {
      if (!bridge.isAvailable()) throw new Error("Bridge unavailable");
      await ensureScanBeforeToggle();
      const write = await bridge.send("batch-write-config-value", { hostId: hostId(), edits: [{ keyPath: featureKeyPath(name), value: enabled, mergeStrategy: "upsert" }], filePath: null, expectedVersion: null });
      if (write == null) {
        const fallback = await bridge.rpc("set-configuration", { key: featureKeyPath(name), value: enabled });
        if (fallback?.success !== true) throw new Error("Failed to persist feature flag");
      }
      await propagate(hostId(), { [name]: enabled });
      if (name === "remote_control") await bridge.send("set-remote-control-enabled-for-host", { hostId: hostId(), enabled });
    }
    async function refresh(quiet = false) {
      if (disposed || refreshing) return refreshing ?? void 0;
      refreshing = (async () => {
        if (!bridge.isAvailable()) {
          state = { ...state, loading: false, error: "Bridge unavailable" };
          paint();
          refreshPanels();
          return;
        }
        if (!quiet) {
          state = { ...state, loading: true, error: null };
          paint();
          refreshPanels();
        }
        try {
          const targetHostId = resolveHostId();
          const overrides = await readOverrides(targetHostId);
          const apiFeatures = await listFeatures(targetHostId);
          if (disposed) return;
          const features = overlayConfigOverrides(apiFeatures?.length ? mergeFeatures(apiFeatures) : await loadFallback(targetHostId, overrides), overrides).map(enrich);
          state = { loading: false, error: null, features, hostId: targetHostId, updatedAt: /* @__PURE__ */ new Date() };
          await propagate(targetHostId, overrides);
        } catch (error) {
          if (!disposed) {
            log.error("feature refresh failed", error);
            state = { ...state, loading: false, error: error instanceof Error ? error.message : "Failed to load feature flags" };
          }
        } finally {
          if (!disposed) {
            paint();
            refreshPanels();
          }
          refreshing = null;
        }
      })();
      return refreshing;
    }
    function viewState() {
      return { filter, scrollTop: listScrollTop };
    }
    function panel() {
      return renderFeatureFlagsPanel({ components, getState: () => state, getScan: () => scan, isPopover: () => popoutOpen, isToggling: (name) => toggling.has(name), getView: viewState, setFilter: (value) => {
        filter = value;
      }, setScrollTop: (value) => {
        listScrollTop = value;
      }, appServerAvailable, refresh: () => {
        void refresh(popoutOpen);
      }, rescan: () => {
        void scanBundles(true).then(() => refresh(true));
      }, openSettings: () => {
        ui.closePopover();
        popoutOpen = false;
        void bridge.navigate(SETTINGS_ROUTE);
        const timer = setTimeout(() => {
          timers.delete(timer);
          mountSettingsPanel(true);
        }, 300);
        timers.add(timer);
      }, toggle: async (feature, enabled) => {
        if (toggling.has(feature.name)) return;
        toggling.add(feature.name);
        try {
          await writeFeature(feature.name, enabled);
          state = { ...state, features: state.features.map((item) => item.name === feature.name ? enrich({ ...item, enabled, source: "config" }) : item), updatedAt: /* @__PURE__ */ new Date() };
          components.statusToast(`${feature.name} ${enabled ? "enabled" : "disabled"}`);
        } catch (error) {
          log.error("feature toggle failed", error);
          components.statusToast(`Failed to update ${feature.name}`);
        } finally {
          toggling.delete(feature.name);
          paint();
          refreshPanels();
        }
      } });
    }
    function captureView() {
      const root = popoutOpen ? Array.from(document.querySelectorAll(".ex-popover")).at(-1) : document.getElementById(PANEL_ID);
      const input = root?.querySelector("[data-explodex-ff-filter]");
      const list = root?.querySelector("[data-explodex-ff-list]");
      if (input instanceof HTMLInputElement) filter = input.value;
      if (list instanceof HTMLElement) listScrollTop = list.scrollTop;
    }
    function settingsRoot() {
      return document.querySelector(".main-surface .scrollbar-stable, .main-surface, main.main-surface .scrollbar-stable, main.main-surface");
    }
    function mountSettingsPanel(force = false) {
      if (disposed || !settings.embedInGeneralSettings || !path().includes(SETTINGS_ROUTE)) {
        document.getElementById(PANEL_ID)?.remove();
        lastSettingsKey = null;
        return;
      }
      const key = `${state.loading}:${state.error ?? ""}:${state.features.map((feature) => `${feature.name}:${feature.enabled}`).join("|")}`;
      if (!force && key === lastSettingsKey && document.getElementById(PANEL_ID)) return;
      const root = settingsRoot();
      if (!root) return;
      const inner = root.querySelector(".mx-auto.flex.w-full.flex-col") ?? root;
      const existing = document.getElementById(PANEL_ID);
      captureView();
      const container = existing ?? document.createElement("section");
      container.id = PANEL_ID;
      container.setAttribute("data-explodex-plugin", PLUGIN_ID);
      container.style.cssText = "scroll-margin-top:24px";
      container.replaceChildren(components.panel({ title: "All feature flags", children: panel, className: "explodex-feature-flags-settings-panel" }));
      if (!existing) inner.prepend(container);
      lastSettingsKey = key;
    }
    function refreshPanels() {
      if (popoutOpen && navButton?.isConnected) {
        captureView();
        openPopover(navButton);
      }
      mountSettingsPanel(true);
    }
    function openPopover(anchor) {
      popoutOpen = true;
      ui.popover({ anchor, title: "Feature Flags", width: 420, side: "right", onClose: () => {
        popoutOpen = false;
      }, content: panel });
      if (state.features.length === 0) void refresh(true);
    }
    function paint() {
      if (!settings.showSidebarShortcut) {
        sidebarNav.remove(PLUGIN_ID);
        navButton = null;
        return;
      }
      const label = state.features.length ? `Flags: ${state.features.filter((feature) => feature.enabled).length}/${state.features.length}` : state.loading ? "Flags: \u2026" : "Flags: 0";
      if (!navButton?.isConnected) navButton = ui.navItem({ label, compact: true, onClick: (event) => {
        if (popoutOpen) {
          popoutOpen = false;
          ui.closePopover();
        } else if (event.currentTarget instanceof Element) openPopover(event.currentTarget);
      } });
      const labelNode = navButton.querySelector("span:last-child");
      if (labelNode) labelNode.textContent = label;
      else navButton.replaceChildren(document.createTextNode(label));
      sidebarNav.insertBefore(["Settings", "Profile", "Account"], navButton, PLUGIN_ID);
    }
    const onRoute = () => {
      const next = path();
      if (next === lastPathname) return;
      lastPathname = next;
      mountSettingsPanel();
      scheduleScan();
    };
    const reposition = () => {
      if (popoutOpen && navButton?.isConnected) ui.repositionPopover({ anchor: navButton, width: 420, side: "right" });
    };
    registerOptions({ render(container, context) {
      container.replaceChildren(components.fieldStack([
        components.checkboxField({ label: "Sidebar shortcut", checked: settings.showSidebarShortcut, onChange(value) {
          settings = { ...settings, showSidebarShortcut: value };
          saveSettings();
          if (!value) {
            ui.closePopover();
            popoutOpen = false;
          }
          paint();
          context.refresh();
        } }),
        components.checkboxField({ label: "Embed panel in General Settings", checked: settings.embedInGeneralSettings, onChange(value) {
          settings = { ...settings, embedInGeneralSettings: value };
          saveSettings();
          mountSettingsPanel(true);
          context.refresh();
        } }),
        components.metaText("Toggle individual flags from the sidebar popover or General Settings panel.")
      ]));
    } });
    paint();
    lastPathname = path();
    globalThis.addEventListener("popstate", onRoute);
    globalThis.addEventListener("resize", reposition);
    globalThis.addEventListener("scroll", reposition, true);
    const refreshTimer = setInterval(() => {
      void refresh(true);
    }, 6e4);
    timers.add(refreshTimer);
    const stopSidebar = inject.observeZone("sidebar", () => {
      if (!navButton?.isConnected) {
        navButton = null;
        paint();
      }
      reposition();
    });
    mountSettingsPanel();
    scheduleScan();
    void refresh();
    return () => {
      disposed = true;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      stopSidebar();
      globalThis.removeEventListener("popstate", onRoute);
      globalThis.removeEventListener("resize", reposition);
      globalThis.removeEventListener("scroll", reposition, true);
      ui.closePopover();
      sidebarNav.remove(PLUGIN_ID);
      document.getElementById(PANEL_ID)?.remove();
      navButton = null;
    };
  }
  var index_default = definePlugin({ setup: setupFeatureFlagsPlayground });
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
    register("feature-flags-playground", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
