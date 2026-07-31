export type GateSource = "ng-table" | "hardcoded" | "proximity" | "layer";
export type GateMapping = { gateId: string; source: GateSource; confidence: number };
export type GateMappingRecords = Record<string, GateMapping[]>;
export type GateMappings = Record<string, string[]>;
export type BundleGateCache = { scannedAt: number; buildFingerprint: string | null; mappings: GateMappings; chunksScanned: string[] };
export type FetchResponse = { ok: boolean; text(): Promise<string> };
export type Fetcher = (url: string) => Promise<FetchResponse>;
export type BundleScanEnvironment = {
  fetch: Fetcher;
  locationHref: string;
  loadedUrls(): string[];
  codexVersion(): string | null;
};

export const BUNDLE_GATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GATE_ID_RE = /^\d{6,12}$/;
const FEATURE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const PRIORITY_PATTERNS = [/app-server-manager-signals/i, /thread-context-inputs/i, /experimental-feature/i, /statsig/i, /general-settings/i, /realtime/i, /composer/i, /use-is-thread-realtime/i, /app-server-dynamic-tools/i];

export function emptyBundleGateCache(): BundleGateCache {
  return { scannedAt: 0, buildFingerprint: null, mappings: {}, chunksScanned: [] };
}

export function chunkLabel(url: string): string {
  return url.match(/\/([^/?#]+\.js)(?:\?|#|$)/)?.[1] ?? url;
}

function addMapping(mappings: GateMappingRecords, featureName: string, gateId: string, source: GateSource): void {
  if (!FEATURE_NAME_RE.test(featureName) || !GATE_ID_RE.test(gateId)) return;
  const bucket = mappings[featureName] ?? (mappings[featureName] = []);
  if (!bucket.some((entry) => entry.gateId === gateId)) bucket.push({ gateId, source, confidence: source === "proximity" ? 2 : 3 });
}

export function flattenMappings(mappings: GateMappingRecords): GateMappings {
  return Object.fromEntries(Object.entries(mappings).map(([name, values]) => [name, [...new Set(values.map((value) => value.gateId))]]).filter(([, ids]) => ids.length > 0));
}

export function mergeMappingRecords(target: GateMappingRecords, source: GateMappingRecords): GateMappingRecords {
  for (const [featureName, entries] of Object.entries(source)) for (const entry of entries) addMapping(target, featureName, entry.gateId, entry.source);
  return target;
}

function extractConstAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of source.matchAll(/(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*`([a-z][a-z0-9_]{1,63})`/g)) aliases.set(match[1]!, match[2]!);
  return aliases;
}

export function extractGateMappingsFromSource(source: string, chunkName = "unknown"): { mappings: GateMappingRecords; chunkName: string } {
  const mappings: GateMappingRecords = {};
  const aliases = extractConstAliases(source);
  for (const match of source.matchAll(/gateName:\s*`(\d+)`\s*,\s*featureKey:\s*(?:`([^`]+)`|([A-Za-z_$][\w$]*))/g)) addMapping(mappings, match[2] ?? aliases.get(match[3]!) ?? match[3]!, match[1]!, "ng-table");
  for (const match of source.matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:\s*ln\(\s*\w+\s*,\s*`(\d+)`/g)) addMapping(mappings, aliases.get(match[1]!) ?? match[1]!, match[2]!, "hardcoded");
  for (const match of source.matchAll(/\[\s*`([a-z][a-z0-9_]{1,63})`\s*\]\s*:\s*ln\(\s*\w+\s*,\s*`(\d+)`/g)) addMapping(mappings, match[1]!, match[2]!, "hardcoded");
  const calls = [...source.matchAll(/(?:checkGate|useGateValue|useGate|getGateValue)\(\s*`(\d+)`\s*\)|\b[oc]\(\s*`(\d+)`\s*\)/g)].map((match) => ({ gateId: match[1] ?? match[2]!, index: match.index ?? 0 }));
  for (const match of source.matchAll(/`([a-z][a-z0-9_]{1,63})`/g)) for (const call of calls) if (Math.abs(call.index - (match.index ?? 0)) <= 180) addMapping(mappings, match[1]!, call.gateId, "proximity");
  for (const match of source.matchAll(/featureKeys:\s*\[([^\]]+)\][^}]{0,240}?layerName:\s*`(\d+)`/g)) for (const name of match[1]!.matchAll(/`([a-z][a-z0-9_]{1,63})`/g)) addMapping(mappings, name[1]!, match[2]!, "layer");
  return { mappings, chunkName };
}

export function extractMapDepsPaths(source: string): string[] {
  const match = source.match(/__vite__mapDeps[\s\S]*?\.f\s*=\s*\[([\s\S]*?)\]/);
  return match ? [...match[1]!.matchAll(/"(\.\/[^\"]+\.js)"/g)].map((entry) => entry[1]!) : [];
}

export function resolveAssetUrl(relativePath: string, baseHref: string): string | null {
  try { return new URL(relativePath, baseHref).href; } catch { return null; }
}

export function scoreMapDepSource(url: string): number {
  const label = chunkLabel(url);
  if (/^index-/.test(label)) return 100;
  if (/^app-main-/.test(label)) return 90;
  if (/thread-context|app-server-manager/.test(label)) return 85;
  if (/composer|realtime|experimental-feature/.test(label)) return 75;
  return 1;
}

export async function discoverChunkUrls(env: BundleScanEnvironment, maxSources = 12): Promise<string[]> {
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
    } catch { /* Optional source expansion. */ }
  }
  return [...urls];
}

export function buildFingerprint(urls: readonly string[], locationHref: string, codexVersion: string | null = null): string {
  const labels = urls.map(chunkLabel).sort();
  const anchors = labels.filter((label) => /^(index|app-main|app-server-manager)-/.test(label));
  let host = "";
  try { host = new URL(locationHref).host; } catch { /* Invalid app href. */ }
  return [host, codexVersion ?? "", ...(anchors.length ? anchors.slice(0, 6) : labels.slice(0, 8))].join("|");
}

export function prioritizeChunkUrls(urls: readonly string[]): { url: string; label: string; score: number }[] {
  return urls.map((url) => ({ url, label: chunkLabel(url), score: PRIORITY_PATTERNS.reduce((score, pattern, index) => score + (pattern.test(chunkLabel(url)) ? PRIORITY_PATTERNS.length - index : 0), 0) })).sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

export function isCacheFresh(cache: BundleGateCache, fingerprint: string, now = Date.now()): boolean {
  return Boolean(cache.scannedAt && cache.buildFingerprint === fingerprint && now - cache.scannedAt < BUNDLE_GATE_CACHE_TTL_MS);
}

export function mergeDiscoveredMappings(existing: GateMappings, discovered: GateMappings): GateMappings {
  const result: GateMappings = { ...existing };
  for (const [name, ids] of Object.entries(discovered)) result[name] = [...new Set([...(result[name] ?? []), ...ids])];
  return result;
}

export async function runBundleGateScan(options: { cache: BundleGateCache; env: BundleScanEnvironment; force?: boolean; maxChunks?: number }): Promise<{ cache: BundleGateCache; fromCache: boolean; fingerprint: string; urlCount: number }> {
  const urls = await discoverChunkUrls(options.env);
  const fingerprint = buildFingerprint(urls, options.env.locationHref, options.env.codexVersion());
  if (!options.force && isCacheFresh(options.cache, fingerprint)) return { cache: options.cache, fromCache: true, fingerprint, urlCount: urls.length };
  const merged: GateMappingRecords = {};
  const chunksScanned: string[] = [];
  for (const item of prioritizeChunkUrls(urls).slice(0, options.maxChunks ?? 40)) {
    try {
      const response = await options.env.fetch(item.url);
      if (!response.ok) continue;
      const result = extractGateMappingsFromSource(await response.text(), item.label);
      mergeMappingRecords(merged, result.mappings);
      chunksScanned.push(result.chunkName);
    } catch { /* Unreadable runtime chunks do not block the playground. */ }
  }
  return { cache: { scannedAt: Date.now(), buildFingerprint: fingerprint, mappings: mergeDiscoveredMappings(options.cache.mappings, flattenMappings(merged)), chunksScanned: [...new Set([...options.cache.chunksScanned, ...chunksScanned])]}, fromCache: false, fingerprint, urlCount: urls.length };
}
