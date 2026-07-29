export const SORT_LABELS = {
  pinned: "Pinned",
  match: "Best match",
  recent: "Recently active",
} as const;

export type ThreadSortKey = keyof typeof SORT_LABELS;

export const DEFAULT_SORT_BY: readonly ThreadSortKey[] = [
  "pinned",
  "recent",
  "match",
];

export type CommandMenuThreadSettings = {
  maxThreads: number;
  minChars: number;
  sortBy: ThreadSortKey[];
  showRecentOnOpen: boolean;
};

export type CommandMenuThread = {
  conversationId: string;
  threadKey: string | null;
  title: string;
  pinned: boolean;
  activityMs: number;
  sidebarIndex: number;
};

const NATIVE_STATE_OWNER_ATTR = "data-explodex-native-state-owner";
const NATIVE_GROUP_ORDER_ATTR = "data-explodex-native-group-order";
const NATIVE_HEADING_PRESENT_ATTR =
  "data-explodex-native-heading-present";
const NATIVE_HEADING_TEXT_ATTR = "data-explodex-native-heading-text";
const NATIVE_HEADING_STYLE_ATTR = "data-explodex-native-heading-style";

function directCommandMenuGroups(list: Element): Element[] {
  return [...list.querySelectorAll(":scope > [cmdk-group]")].filter(
    (group) => group.getAttribute("data-explodex-managed") !== "true",
  );
}

export function rememberNativeCommandMenuState(
  list: Element,
  ownerToken: string,
): void {
  const priorOwner = list.getAttribute(NATIVE_STATE_OWNER_ATTR);
  if (priorOwner === ownerToken) return;
  const groups = directCommandMenuGroups(list);
  if (priorOwner === null) {
    groups.forEach((group, index) => {
      group.setAttribute(NATIVE_GROUP_ORDER_ATTR, String(index));
      const heading = group.querySelector("[cmdk-group-heading]");
      if (heading === null) {
        group.setAttribute(NATIVE_HEADING_PRESENT_ATTR, "false");
        return;
      }
      group.setAttribute(NATIVE_HEADING_PRESENT_ATTR, "true");
      group.setAttribute(
        NATIVE_HEADING_TEXT_ATTR,
        heading.textContent ?? "",
      );
      const style = heading.getAttribute("style");
      group.setAttribute(
        NATIVE_HEADING_STYLE_ATTR,
        style ?? "__absent__",
      );
    });
  }
  list.setAttribute(NATIVE_STATE_OWNER_ATTR, ownerToken);
}

export function restoreNativeCommandMenuState(
  list: Element | null,
  ownerToken: string,
): boolean {
  if (
    list === null ||
    list.getAttribute(NATIVE_STATE_OWNER_ATTR) !== ownerToken
  ) {
    return false;
  }
  const tracked = directCommandMenuGroups(list)
    .filter((group) => group.hasAttribute(NATIVE_GROUP_ORDER_ATTR))
    .sort(
      (left, right) =>
        Number(left.getAttribute(NATIVE_GROUP_ORDER_ATTR)) -
        Number(right.getAttribute(NATIVE_GROUP_ORDER_ATTR)),
    );
  for (const group of tracked) list.appendChild(group);
  for (const group of tracked) {
    if (group.getAttribute(NATIVE_HEADING_PRESENT_ATTR) === "true") {
      const heading = group.querySelector("[cmdk-group-heading]");
      if (heading !== null) {
        heading.textContent =
          group.getAttribute(NATIVE_HEADING_TEXT_ATTR) ?? "";
        const style = group.getAttribute(NATIVE_HEADING_STYLE_ATTR);
        if (style === "__absent__" || style === null) {
          heading.removeAttribute("style");
        } else {
          heading.setAttribute("style", style);
        }
      }
    }
    group.removeAttribute(NATIVE_GROUP_ORDER_ATTR);
    group.removeAttribute(NATIVE_HEADING_PRESENT_ATTR);
    group.removeAttribute(NATIVE_HEADING_TEXT_ATTR);
    group.removeAttribute(NATIVE_HEADING_STYLE_ATTR);
  }
  list.removeAttribute(NATIVE_STATE_OWNER_ATTR);
  return true;
}

export function defaultCommandMenuThreadSettings(): CommandMenuThreadSettings {
  return {
    maxThreads: 5,
    minChars: 2,
    sortBy: [...DEFAULT_SORT_BY],
    showRecentOnOpen: false,
  };
}

export function normalizeCommandMenuThreadSettings(
  raw: unknown,
): CommandMenuThreadSettings {
  const defaults = defaultCommandMenuThreadSettings();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaults;
  }
  const record = raw as Record<string, unknown>;
  const maxThreads = Math.min(
    10,
    Math.max(
      1,
      Math.floor(Number(record.maxThreads) || defaults.maxThreads),
    ),
  );
  const minChars = Math.min(
    4,
    Math.max(1, Math.floor(Number(record.minChars) || defaults.minChars)),
  );
  const requested = Array.isArray(record.sortBy)
    ? record.sortBy.filter(
        (key): key is ThreadSortKey =>
          typeof key === "string" && key in SORT_LABELS,
      )
    : defaults.sortBy;
  const sortBy: ThreadSortKey[] = [];
  for (const key of [...requested, ...DEFAULT_SORT_BY]) {
    if (!sortBy.includes(key)) sortBy.push(key);
  }
  return {
    maxThreads,
    minChars,
    sortBy,
    showRecentOnOpen: Boolean(record.showRecentOnOpen),
  };
}

export function normalizeThreadQuery(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function scoreThreadTitle(title: string, query: string): number {
  if (!query) return 0;
  let searchable: string;
  try {
    searchable = title
      .normalize("NFKD")
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  } catch {
    searchable = title.replace(/\s+/g, " ").trim().toLowerCase();
  }
  if (!searchable) return 0;
  if (searchable === query) return 100;
  if (searchable.startsWith(query)) return 80;
  if (searchable.includes(query)) return 60;
  return 0;
}

export function filterThreads(
  threads: readonly CommandMenuThread[],
  query: unknown,
  settings: CommandMenuThreadSettings,
): CommandMenuThread[] {
  const normalized = normalizeThreadQuery(query);
  const compare = (
    left: { thread: CommandMenuThread; score: number },
    right: { thread: CommandMenuThread; score: number },
    hasQuery: boolean,
  ): number => {
    for (const key of settings.sortBy) {
      if (
        key === "pinned" &&
        left.thread.pinned !== right.thread.pinned
      ) {
        return left.thread.pinned ? -1 : 1;
      }
      if (
        key === "recent" &&
        left.thread.activityMs !== right.thread.activityMs
      ) {
        return left.thread.activityMs - right.thread.activityMs;
      }
      if (key === "match" && hasQuery && left.score !== right.score) {
        return right.score - left.score;
      }
    }
    return left.thread.sidebarIndex - right.thread.sidebarIndex;
  };
  const deduplicate = (
    entries: Array<{ thread: CommandMenuThread; score: number }>,
    hasQuery: boolean,
  ): Array<{ thread: CommandMenuThread; score: number }> => {
    const byConversation = new Map<
      string,
      { thread: CommandMenuThread; score: number }
    >();
    for (const entry of entries) {
      const prior = byConversation.get(entry.thread.conversationId);
      if (
        prior === undefined ||
        (hasQuery && entry.score > prior.score) ||
        (
          entry.score === prior.score &&
          (
            (entry.thread.pinned && !prior.thread.pinned) ||
            (
              entry.thread.pinned === prior.thread.pinned &&
              (
                entry.thread.activityMs < prior.thread.activityMs ||
                (
                  entry.thread.activityMs === prior.thread.activityMs &&
                  entry.thread.sidebarIndex < prior.thread.sidebarIndex
                )
              )
            )
          )
        )
      ) {
        byConversation.set(entry.thread.conversationId, entry);
      }
    }
    return [...byConversation.values()];
  };

  if (!normalized) {
    if (!settings.showRecentOnOpen) return [];
    return deduplicate(
      threads.map((thread) => ({ thread, score: 0 })),
      false,
    )
      .sort((left, right) => compare(left, right, false))
      .slice(0, settings.maxThreads)
      .map((entry) => entry.thread);
  }
  if (normalized.length < settings.minChars) return [];
  return deduplicate(
    threads.map((thread) => ({
      thread,
      score: scoreThreadTitle(thread.title, normalized),
    })),
    true,
  )
    .filter((entry) => entry.score > 0)
    .sort((left, right) => compare(left, right, true))
    .slice(0, settings.maxThreads)
    .map((entry) => entry.thread);
}

export function activateThreadSelection(options: {
  conversationId: string;
  threadKey: string | null;
  findRow(threadKey: string): { click(): void } | null;
  navigate(path: string): void;
  close(): void;
  schedule(callback: () => void): void;
}): "row" | "route" {
  const row =
    (options.threadKey === null
      ? null
      : options.findRow(options.threadKey)) ??
    options.findRow(`local:${options.conversationId}`);
  if (row !== null) {
    row.click();
  } else {
    options.navigate(`/local/${options.conversationId}`);
  }
  options.schedule(options.close);
  return row === null ? "route" : "row";
}
