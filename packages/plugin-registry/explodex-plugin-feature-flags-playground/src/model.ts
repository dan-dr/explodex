export type FeatureSource = "api" | "catalog" | "config" | "statsig";

export type FeatureFlag = {
  name: string;
  enabled: boolean;
  stage: string | null;
  label: string | null;
  description: string | null;
  source: FeatureSource;
  statsigGateIds?: string[];
  usesGateOverride?: boolean;
};

export type FeatureStage = {
  key: string | null;
  title: string;
  description: string;
};

export const STAGE_SECTIONS: readonly FeatureStage[] = [
  { key: "stable", title: "Stable", description: "Generally available; intended for everyday use." },
  { key: "beta", title: "Beta", description: "Wider rollout with ongoing iteration." },
  { key: "underDevelopment", title: "Under development", description: "Experimental or internal; behavior may change abruptly." },
  { key: "removed", title: "Removed", description: "Deprecated or retired; toggles may no longer do anything." },
  { key: null, title: "Unclassified", description: "Not tagged by Codex list API (catalog fallback)." },
];

export const KNOWN_FEATURE_NAMES = [
  "memories", "multi_agent", "plugins", "plugin", "remote_control",
  "realtime_conversation", "chronicle", "workspace_dependencies",
  "remote_connections", "apps_mcp_path_override", "auth_elicitation",
  "tool_suggest", "onboarding_interactive_tools", "request_permissions_tool",
  "ghost_commit", "unified_exec", "apply_patch_freeform", "skills",
  "shell_snapshot", "js_repl",
] as const;

export const CODEX_BUNDLE_GATE_HINTS: Readonly<Record<string, readonly string[]>> = {
  browser_use: ["410262010"],
  browser_use_external: ["410065390"],
  chronicle: ["2574306096"],
  computer_use: ["1506311413"],
  in_app_browser: ["1834314516"],
};

export const FEATURE_QUERY_KEY_HINTS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  chronicle: [["vscode", "chronicle-permissions"]],
  memories: [["vscode", "get-global-state", '{"key":"memories"}']],
};

export type FeatureFlagsSettings = {
  showSidebarShortcut: boolean;
  embedInGeneralSettings: boolean;
};

export function defaultSettings(): FeatureFlagsSettings {
  return { showSidebarShortcut: true, embedInGeneralSettings: true };
}

export function normalizeSettings(raw: unknown): FeatureFlagsSettings {
  const defaults = defaultSettings();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const value = raw as Record<string, unknown>;
  return {
    showSidebarShortcut: value.showSidebarShortcut !== false,
    embedInGeneralSettings: value.embedInGeneralSettings !== false,
  };
}

export function featureKeyPath(name: string): string {
  return name.startsWith("features.") ? name : `features.${name}`;
}

export function normalizeBooleanMap(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
}

export function normalizeFeature(raw: unknown): FeatureFlag | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const name = String(item.name ?? item.id ?? "").trim();
  if (!name) return null;
  const label = item.label ?? item.displayName;
  return {
    name,
    enabled: Boolean(item.enabled),
    stage: item.stage == null ? null : String(item.stage),
    label: label == null ? null : String(label).trim() || null,
    description: item.description == null ? null : String(item.description).trim() || null,
    source: "api",
  };
}

export function mergeFeatures(rawFeatures: readonly unknown[]): FeatureFlag[] {
  const byName = new Map<string, FeatureFlag>();
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

export function overlayConfigOverrides(
  features: readonly FeatureFlag[],
  overrides: Readonly<Record<string, boolean>>,
): FeatureFlag[] {
  return features.map((feature) => {
    const enabled = overrides[feature.name];
    return typeof enabled === "boolean" ? { ...feature, enabled, source: "config" } : feature;
  });
}

export type FeatureSection = FeatureStage & { features: FeatureFlag[] };

export function groupFeaturesByStage(features: readonly FeatureFlag[]): FeatureSection[] {
  const grouped = new Map<string | null, FeatureFlag[]>();
  for (const section of STAGE_SECTIONS) grouped.set(section.key, []);
  for (const feature of features) grouped.get(grouped.has(feature.stage) ? feature.stage : null)?.push(feature);
  return STAGE_SECTIONS.map((section) => ({
    ...section,
    features: [...(grouped.get(section.key) ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
  })).filter((section) => section.features.length > 0);
}

export function filterFeatures(features: readonly FeatureFlag[], query: string): FeatureFlag[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...features];
  return features.filter((feature) => {
    const section = STAGE_SECTIONS.find((entry) => entry.key === feature.stage);
    return [feature.name, feature.label, feature.description, feature.stage, section?.title, section?.description]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

export function stageAnchorId(stage: string | null): string {
  return `explodex-ff-stage-${stage ?? "unclassified"}`;
}

export function mergeGateHints(
  first: Readonly<Record<string, readonly string[]>>,
  second: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const [name, ids] of [...Object.entries(first), ...Object.entries(second)]) {
    merged[name] = [...new Set([...(merged[name] ?? []), ...ids])];
  }
  return merged;
}
