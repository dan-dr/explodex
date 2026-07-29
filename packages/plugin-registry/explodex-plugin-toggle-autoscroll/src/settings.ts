export type ToggleAutoscrollSettings = {
  rememberAutoscroll: boolean;
  defaultAutoscroll: boolean;
  showText: boolean;
  showAlways: boolean;
  threadStates: Record<string, boolean>;
};

const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultToggleAutoscrollSettings(): ToggleAutoscrollSettings {
  return {
    rememberAutoscroll: true,
    defaultAutoscroll: true,
    showText: true,
    showAlways: true,
    threadStates: {},
  };
}

export function normalizeToggleAutoscrollSettings(
  raw: unknown,
): ToggleAutoscrollSettings {
  const defaults = defaultToggleAutoscrollSettings();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaults;
  }
  const record = raw as Record<string, unknown>;
  const threadStates: Record<string, boolean> = {};
  if (
    typeof record.threadStates === "object" &&
    record.threadStates !== null &&
    !Array.isArray(record.threadStates)
  ) {
    for (const [threadId, enabled] of Object.entries(record.threadStates)) {
      if (CONVERSATION_ID_RE.test(threadId) && typeof enabled === "boolean") {
        threadStates[threadId] = enabled;
      }
    }
  }
  return {
    rememberAutoscroll:
      typeof record.rememberAutoscroll === "boolean"
        ? record.rememberAutoscroll
        : defaults.rememberAutoscroll,
    defaultAutoscroll:
      typeof record.defaultAutoscroll === "boolean"
        ? record.defaultAutoscroll
        : defaults.defaultAutoscroll,
    showText:
      typeof record.showText === "boolean"
        ? record.showText
        : defaults.showText,
    showAlways:
      typeof record.showAlways === "boolean"
        ? record.showAlways
        : defaults.showAlways,
    threadStates,
  };
}

export function resolveAutoscrollEnabled(options: {
  conversationId: string | null;
  sessionStates: ReadonlyMap<string, boolean>;
  settings: ToggleAutoscrollSettings;
}): boolean {
  const { conversationId, sessionStates, settings } = options;
  if (conversationId !== null && sessionStates.has(conversationId)) {
    return sessionStates.get(conversationId) ?? settings.defaultAutoscroll;
  }
  if (
    conversationId !== null &&
    settings.rememberAutoscroll &&
    conversationId in settings.threadStates
  ) {
    return settings.threadStates[conversationId] ?? settings.defaultAutoscroll;
  }
  return settings.defaultAutoscroll;
}
