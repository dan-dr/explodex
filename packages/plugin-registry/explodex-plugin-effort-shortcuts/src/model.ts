import type { ReasoningEffort } from "@explodex/sdk";

export const SETTINGS_KEY = "explodex-effort-shortcuts";
export const LEGACY_SETTINGS_KEY = "explodex-reasoning-effort-prefix";
export const DEFAULT_HOST_ID = "local";

export type EffortLevel = {
  prefix: string;
  effort: ReasoningEffort;
  label: string;
};

export const LEVEL_CATALOG: readonly EffortLevel[] = [
  { prefix: "xh", effort: "xhigh", label: "Extra High" },
  { prefix: "h", effort: "high", label: "High" },
  { prefix: "m", effort: "medium", label: "Medium" },
  { prefix: "l", effort: "low", label: "Low" },
  { prefix: "max", effort: "max", label: "Max" },
  { prefix: "min", effort: "minimal", label: "Minimal" },
];

export const ALL_PREFIXES = LEVEL_CATALOG.map((level) => level.prefix);
export const LEVEL_BY_EFFORT = new Map(
  LEVEL_CATALOG.map((level) => [level.effort, level] as const),
);
const PREFIX_ORDER = [...LEVEL_CATALOG].sort(
  (left, right) => right.prefix.length - left.prefix.length,
);

export type EffortShortcutSettings = {
  enabledPrefixes: string[];
  showHint: boolean;
  stripOnSend: boolean;
  restoreAfterSend: boolean;
};

export type ParsedPrefix = {
  level: EffortLevel;
  prompt: string;
};

export type ModelDescription = {
  model?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: ReasoningEffort;
    effort?: ReasoningEffort;
  }>;
};

export type DefaultModelDescription = {
  model?: string;
  defaultReasoningEffort?: ReasoningEffort;
};

export type ModelsPayload = {
  models: ModelDescription[];
  defaultModel: DefaultModelDescription | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function defaultEffortShortcutSettings(): EffortShortcutSettings {
  return {
    enabledPrefixes: [...ALL_PREFIXES],
    showHint: true,
    stripOnSend: true,
    restoreAfterSend: true,
  };
}

export function normalizeEffortShortcutSettings(
  raw: unknown,
): EffortShortcutSettings {
  const base = defaultEffortShortcutSettings();
  const value = record(raw);
  if (value === null) return base;
  const rawPrefixes = Array.isArray(value.enabledPrefixes)
    ? value.enabledPrefixes
    : null;
  const enabledPrefixes = rawPrefixes
    ? ALL_PREFIXES.filter((prefix) => rawPrefixes.includes(prefix))
    : base.enabledPrefixes;
  return {
    enabledPrefixes: enabledPrefixes.length
      ? enabledPrefixes
      : base.enabledPrefixes,
    showHint: value.showHint !== false,
    stripOnSend: value.stripOnSend !== false,
    restoreAfterSend: value.restoreAfterSend !== false,
  };
}

export function parseEffortPrefix(
  text: string,
  settings: Pick<EffortShortcutSettings, "enabledPrefixes">,
): ParsedPrefix | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return null;
  const body = trimmed.slice(1);
  for (const level of PREFIX_ORDER) {
    if (!settings.enabledPrefixes.includes(level.prefix)) continue;
    const pattern = new RegExp(`^${level.prefix}(?:\\s+|$)`, "i");
    if (!pattern.test(body)) continue;
    const consumed = 1 + level.prefix.length;
    return {
      level,
      prompt: trimmed.slice(consumed).replace(/^\s+/, ""),
    };
  }
  return null;
}

export function shouldShowEffortHint(
  text: string,
  settings: Pick<EffortShortcutSettings, "enabledPrefixes" | "showHint">,
): boolean {
  if (!settings.showHint) return false;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return false;
  if (trimmed === "!") return true;
  const partial = trimmed.slice(1);
  if (/\s/.test(partial)) return false;
  const normalized = partial.toLowerCase();
  return PREFIX_ORDER.some(
    (level) =>
      settings.enabledPrefixes.includes(level.prefix) &&
      level.prefix.startsWith(normalized),
  );
}

const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeConversationId(value: unknown): string | null {
  if (value == null) return null;
  const id = String(value).trim();
  if (!id || id === "undefined" || id === "null") return null;
  return CONVERSATION_ID_RE.test(id) ? id : null;
}

export function conversationIdFromPath(pathname: string): string | null {
  const patterns = [
    /\/local\/([^/]+)/,
    /\/thread\/([^/]+)/,
    /\/hotkey-window\/thread\/([^/]+)/,
  ];
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    const id = normalizeConversationId(
      match?.[1] ? decodeURIComponent(match[1]) : null,
    );
    if (id) return id;
  }
  return null;
}

function modelDescriptions(value: unknown): ModelDescription[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is ModelDescription =>
          entry !== null && typeof entry === "object",
      )
    : [];
}

function defaultModelDescription(value: unknown): DefaultModelDescription | null {
  return value !== null && typeof value === "object"
    ? (value as DefaultModelDescription)
    : null;
}

export function normalizeModelsPayload(body: unknown): ModelsPayload {
  const root = record(body);
  if (root === null) return { models: [], defaultModel: null };
  if (Array.isArray(root.models)) {
    return {
      models: modelDescriptions(root.models),
      defaultModel: defaultModelDescription(root.defaultModel),
    };
  }
  if (Array.isArray(root.data)) {
    return {
      models: modelDescriptions(root.data),
      defaultModel: defaultModelDescription(root.defaultModel),
    };
  }
  const nested = record(root.data);
  return {
    models: modelDescriptions(nested?.data),
    defaultModel: defaultModelDescription(nested?.defaultModel),
  };
}

export function supportedEffortsForModel(
  models: readonly ModelDescription[],
  modelId: string,
): ReasoningEffort[] {
  const entry = models.find((model) => model.model === modelId);
  if (!entry?.supportedReasoningEfforts?.length) {
    return LEVEL_CATALOG.map((level) => level.effort);
  }
  return entry.supportedReasoningEfforts.flatMap((supported) => {
    const effort = supported.reasoningEffort ?? supported.effort;
    return effort ? [effort] : [];
  });
}

export function hostIdFromPath(pathname: string): string {
  const remote = pathname.match(/\/remote\/([^/]+)/);
  return remote?.[1] ? decodeURIComponent(remote[1]) : DEFAULT_HOST_ID;
}
