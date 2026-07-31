export const DEFAULT_PROJECT_THREAD_SORT_KEY = "updated_at";
export const IN_PROGRESS_ACTIVITY_MS = -1;

const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_THREAD_KEY_RE =
  /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type ProjectPinsMap = Record<string, string>;

export type ProjectOrder = {
  sortKey?: string;
  threadIds?: string[];
  [key: string]: unknown;
};

export type ProjectOrders = Record<string, ProjectOrder>;

export type ProjectPinOrderContext = {
  projectThreadIds: Record<string, string[]>;
  activityMs: Record<string, number>;
};

export type PinScopeAction =
  | "pin-global"
  | "pin-project"
  | "unpin-global"
  | "unpin-project";

export function pinScopeChoiceActions(options: {
  choice: "global" | "project";
  globallyPinned: boolean;
  projectPinned: boolean;
}): PinScopeAction[] {
  if (options.choice === "global") {
    if (options.globallyPinned) {
      return options.projectPinned
        ? ["unpin-project", "unpin-global"]
        : ["unpin-global"];
    }
    return options.projectPinned
      ? ["unpin-project", "pin-global"]
      : ["pin-global"];
  }
  if (options.projectPinned) {
    return options.globallyPinned
      ? ["unpin-global", "unpin-project"]
      : ["unpin-project"];
  }
  return options.globallyPinned
    ? ["unpin-global", "pin-project"]
    : ["pin-project"];
}

export function normalizeConversationId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  if (!id || id === "undefined" || id === "null") return null;
  if (CONVERSATION_ID_RE.test(id)) return id;
  return id.match(LOCAL_THREAD_KEY_RE)?.[1] ?? null;
}

export function localThreadKey(conversationId: string): string {
  return `local:${conversationId}`;
}

export function normalizeProjectId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id && id !== "null" && id !== "undefined" ? id : null;
}

export function normalizeProjectPinsMap(value: unknown): ProjectPinsMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const pins: ProjectPinsMap = {};
  for (const [conversationId, projectId] of Object.entries(value)) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedProjectId = normalizeProjectId(projectId);
    if (normalizedConversationId && normalizedProjectId) {
      pins[normalizedConversationId] = normalizedProjectId;
    }
  }
  return pins;
}

export function projectIdFromAssignment(assignment: unknown): string | null {
  if (assignment === null || assignment === undefined) return null;
  if (typeof assignment === "string") return normalizeProjectId(assignment);
  if (typeof assignment !== "object") return null;
  const record = assignment as Record<string, unknown>;
  if (record.projectId !== undefined) {
    return normalizeProjectId(record.projectId);
  }
  if (record.project_id !== undefined) {
    return normalizeProjectId(record.project_id);
  }
  if (record.id !== undefined && record.kind !== undefined) {
    return normalizeProjectId(record.id);
  }
  return null;
}

export function resolveAssignedProject(options: {
  assignments: unknown;
  conversationId: string;
  projectlessIds: Iterable<unknown>;
  threadKey: string;
}): string | null {
  const projectless = new Set(
    [...options.projectlessIds].map((value) => String(value)),
  );
  if (
    projectless.has(options.threadKey) ||
    projectless.has(options.conversationId)
  ) {
    return null;
  }
  if (
    !options.assignments ||
    typeof options.assignments !== "object" ||
    Array.isArray(options.assignments)
  ) {
    return null;
  }
  const assignments = options.assignments as Record<string, unknown>;
  return (
    projectIdFromAssignment(assignments[options.threadKey]) ??
    projectIdFromAssignment(assignments[options.conversationId])
  );
}

export function globalPinIdCandidates(threadKey: string): string[] {
  const conversationId = normalizeConversationId(threadKey);
  const candidates = [];
  if (conversationId) candidates.push(conversationId);
  if (threadKey) candidates.push(threadKey);
  if (conversationId) candidates.push(localThreadKey(conversationId));
  return [...new Set(candidates)];
}

export function removeGlobalPinConflicts(
  pins: ProjectPinsMap,
  globallyPinnedIds: ReadonlySet<string>,
): { changed: boolean; pins: ProjectPinsMap } {
  const nextPins = { ...pins };
  let changed = false;
  for (const conversationId of Object.keys(pins)) {
    if (
      globalPinIdCandidates(localThreadKey(conversationId)).some((id) =>
        globallyPinnedIds.has(id),
      )
    ) {
      delete nextPins[conversationId];
      changed = true;
    }
  }
  return { changed, pins: nextPins };
}

export function shouldShowProjectPinIndicator(options: {
  globallyPinned: boolean;
  pinnedProjectId: string | null;
  sidebarProjectId: string | null;
}): boolean {
  if (options.globallyPinned || !options.pinnedProjectId) return false;
  if (!options.sidebarProjectId) return true;
  return options.pinnedProjectId === options.sidebarProjectId;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function groupedPinnedThreadKeys(
  pins: ProjectPinsMap,
): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const [conversationId, projectId] of Object.entries(pins)) {
    const normalizedProjectId = normalizeProjectId(projectId);
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedProjectId || !normalizedConversationId) continue;
    const threadKey = localThreadKey(normalizedConversationId);
    groups[normalizedProjectId] ??= [];
    if (!groups[normalizedProjectId]!.includes(threadKey)) {
      groups[normalizedProjectId]!.push(threadKey);
    }
  }
  return groups;
}

function orderWithoutSortKey(order: ProjectOrder | undefined): ProjectOrder {
  const next = order ? { ...order } : {};
  delete next.sortKey;
  return next;
}

function restoreRecencySortForUnpinnedProjects(
  orders: ProjectOrders,
  groups: Record<string, string[]>,
): { changed: boolean; orders: ProjectOrders } {
  let nextOrders = orders;
  let changed = false;
  for (const [projectId, order] of Object.entries(orders)) {
    if ((groups[projectId] ?? []).length > 0) continue;
    if (!order || typeof order !== "object") continue;
    if (
      order.sortKey === DEFAULT_PROJECT_THREAD_SORT_KEY &&
      !Array.isArray(order.threadIds)
    ) {
      continue;
    }
    const hadManualOrder =
      Array.isArray(order.threadIds) && order.threadIds.length > 0;
    const missingSortKey = order.sortKey === null || order.sortKey === undefined;
    if (!missingSortKey && !hadManualOrder) continue;
    if (nextOrders === orders) nextOrders = { ...orders };
    nextOrders[projectId] = {
      sortKey: DEFAULT_PROJECT_THREAD_SORT_KEY,
    };
    changed = true;
  }
  return { changed, orders: nextOrders };
}

function sortThreadIdsByRecency(
  threadIds: readonly string[],
  activityMs: Record<string, number>,
): string[] {
  return [...threadIds].sort((left, right) => {
    const leftMs = activityMs[left] ?? Number.POSITIVE_INFINITY;
    const rightMs = activityMs[right] ?? Number.POSITIVE_INFINITY;
    if (leftMs !== rightMs) return leftMs - rightMs;
    return threadIds.indexOf(left) - threadIds.indexOf(right);
  });
}

function unpinnedThreadIdsForProject(
  projectId: string,
  pinnedIds: readonly string[],
  existingIds: readonly string[],
  context: ProjectPinOrderContext,
): string[] {
  const pinnedSet = new Set(pinnedIds);
  const sidebarIds = context.projectThreadIds[projectId] ?? [];
  const pool =
    sidebarIds.length > 0
      ? [
          ...new Set([
            ...sidebarIds,
            ...existingIds.filter((id) => !pinnedSet.has(id)),
          ]),
        ]
      : existingIds.filter((id) => !pinnedSet.has(id));
  return sortThreadIdsByRecency(
    pool.filter((id) => !pinnedSet.has(id)),
    context.activityMs,
  );
}

export function applyProjectPinOrder(
  orders: ProjectOrders,
  pins: ProjectPinsMap,
  context: ProjectPinOrderContext,
): { changed: boolean; orders: ProjectOrders } {
  const groups = groupedPinnedThreadKeys(pins);
  const pinnedThreadKeys = new Set(Object.values(groups).flat());
  let nextOrders = orders;
  let changed = false;

  const restored = restoreRecencySortForUnpinnedProjects(nextOrders, groups);
  if (restored.changed) {
    nextOrders = restored.orders;
    changed = true;
  }
  if (pinnedThreadKeys.size === 0) {
    return { changed, orders: nextOrders };
  }

  for (const [projectId, order] of Object.entries(nextOrders)) {
    const pinnedForProject = new Set(groups[projectId] ?? []);
    if (pinnedForProject.size === 0) continue;
    const validOrder =
      order && typeof order === "object" ? order : undefined;
    const existingIds = Array.isArray(validOrder?.threadIds)
      ? validOrder.threadIds
      : [];
    const filteredIds = existingIds.filter(
      (id) => !pinnedThreadKeys.has(id) || pinnedForProject.has(id),
    );
    if (!arraysEqual(existingIds, filteredIds)) {
      if (nextOrders === orders) nextOrders = { ...orders };
      nextOrders[projectId] = {
        ...orderWithoutSortKey(validOrder),
        threadIds: filteredIds,
      };
      changed = true;
    }
  }

  for (const [projectId, pinnedIds] of Object.entries(groups)) {
    const current = nextOrders[projectId];
    const existingIds = Array.isArray(current?.threadIds)
      ? current.threadIds
      : [];
    const nextIds = [
      ...pinnedIds,
      ...unpinnedThreadIdsForProject(
        projectId,
        pinnedIds,
        existingIds,
        context,
      ),
    ];
    const hadSortKey = current && "sortKey" in current;
    if (!arraysEqual(existingIds, nextIds) || hadSortKey || !current) {
      if (nextOrders === orders) nextOrders = { ...orders };
      nextOrders[projectId] = {
        ...orderWithoutSortKey(current),
        threadIds: nextIds,
      };
      changed = true;
    }
  }

  return { changed, orders: nextOrders };
}
