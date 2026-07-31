import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROJECT_THREAD_SORT_KEY,
  applyProjectPinOrder,
  globalPinIdCandidates,
  normalizeConversationId,
  normalizeProjectPinsMap,
  pinScopeChoiceActions,
  projectIdFromAssignment,
  removeGlobalPinConflicts,
  resolveAssignedProject,
  shouldShowProjectPinIndicator,
} from "../src/model.ts";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";

describe("VAL-PLUG-011 Project Pins host-state model", () => {
  test("keeps global and project choices mutually exclusive in both directions", () => {
    expect(
      pinScopeChoiceActions({
        choice: "project",
        globallyPinned: true,
        projectPinned: false,
      }),
    ).toEqual(["unpin-global", "pin-project"]);
    expect(
      pinScopeChoiceActions({
        choice: "global",
        globallyPinned: false,
        projectPinned: true,
      }),
    ).toEqual(["unpin-project", "pin-global"]);
    expect(
      pinScopeChoiceActions({
        choice: "project",
        globallyPinned: false,
        projectPinned: true,
      }),
    ).toEqual(["unpin-project"]);
    expect(
      pinScopeChoiceActions({
        choice: "global",
        globallyPinned: true,
        projectPinned: true,
      }),
    ).toEqual(["unpin-project", "unpin-global"]);
    expect(
      pinScopeChoiceActions({
        choice: "project",
        globallyPinned: true,
        projectPinned: true,
      }),
    ).toEqual(["unpin-global", "unpin-project"]);
    expect(
      pinScopeChoiceActions({
        choice: "global",
        globallyPinned: false,
        projectPinned: false,
      }),
    ).toEqual(["pin-global"]);
    expect(
      pinScopeChoiceActions({
        choice: "project",
        globallyPinned: false,
        projectPinned: false,
      }),
    ).toEqual(["pin-project"]);
  });

  test("normalizes persisted pins, conversation ids, and assignment shapes", () => {
    expect(normalizeConversationId(ALPHA)).toBe(ALPHA);
    expect(normalizeConversationId(`local:${ALPHA}`)).toBe(ALPHA);
    expect(normalizeConversationId("not-a-thread")).toBeNull();
    expect(normalizeProjectPinsMap(null)).toEqual({});
    expect(normalizeProjectPinsMap({ [ALPHA]: "project-a" })).toEqual({
      [ALPHA]: "project-a",
    });
    expect(projectIdFromAssignment("project-a")).toBe("project-a");
    expect(projectIdFromAssignment({ projectId: "project-b" })).toBe(
      "project-b",
    );
    expect(projectIdFromAssignment({ project_id: "project-c" })).toBe(
      "project-c",
    );
  });

  test("uses shared assignments while preserving projectless and unresolved native fallback", () => {
    const assignments = {
      [`local:${ALPHA}`]: { projectId: "project-a" },
      [BETA]: "project-b",
    };
    expect(
      resolveAssignedProject({
        assignments,
        conversationId: ALPHA,
        projectlessIds: [],
        threadKey: `local:${ALPHA}`,
      }),
    ).toBe("project-a");
    expect(
      resolveAssignedProject({
        assignments,
        conversationId: BETA,
        projectlessIds: [BETA],
        threadKey: `local:${BETA}`,
      }),
    ).toBeNull();
    expect(
      resolveAssignedProject({
        assignments: {},
        conversationId: BETA,
        projectlessIds: [],
        threadKey: `local:${BETA}`,
      }),
    ).toBeNull();
  });

  test("removes project pins that conflict with any native global pin identity", () => {
    expect(globalPinIdCandidates(`local:${ALPHA}`)).toEqual([
      ALPHA,
      `local:${ALPHA}`,
    ]);
    const result = removeGlobalPinConflicts(
      {
        [ALPHA]: "project-a",
        [BETA]: "project-b",
      },
      new Set([`local:${ALPHA}`]),
    );
    expect(result.changed).toBe(true);
    expect(result.pins).toEqual({ [BETA]: "project-b" });
    expect(
      shouldShowProjectPinIndicator({
        globallyPinned: false,
        pinnedProjectId: "project-b",
        sidebarProjectId: "project-b",
      }),
    ).toBe(true);
    expect(
      shouldShowProjectPinIndicator({
        globallyPinned: true,
        pinnedProjectId: "project-b",
        sidebarProjectId: "project-b",
      }),
    ).toBe(false);
  });
});

describe("VAL-PLUG-011 Project Pins sidebar ordering", () => {
  test("keeps project pins first and sorts remaining visible threads by recency", () => {
    const result = applyProjectPinOrder(
      {
        "project-a": {
          sortKey: DEFAULT_PROJECT_THREAD_SORT_KEY,
          threadIds: [`local:${BETA}`],
        },
      },
      {
        [ALPHA]: "project-a",
        [BETA]: "project-a",
      },
      {
        projectThreadIds: {
          "project-a": [
            `local:${BETA}`,
            "local:recent",
            `local:${ALPHA}`,
            "local:older",
          ],
        },
        activityMs: {
          "local:recent": 10,
          "local:older": 5_000,
        },
      },
    );

    expect(result.changed).toBe(true);
    expect(result.orders).toEqual({
      "project-a": {
        threadIds: [
          `local:${ALPHA}`,
          `local:${BETA}`,
          "local:recent",
          "local:older",
        ],
      },
    });
  });

  test("treats active work as most recent and restores recency after the last project pin is removed", () => {
    const active = applyProjectPinOrder(
      {
        "project-a": {
          threadIds: ["local:older", "local:active"],
        },
      },
      { [ALPHA]: "project-a" },
      {
        projectThreadIds: {
          "project-a": [
            "local:older",
            "local:active",
            `local:${ALPHA}`,
          ],
        },
        activityMs: {
          "local:active": -1,
          "local:older": 20_000,
        },
      },
    );
    expect(active.orders["project-a"]?.threadIds).toEqual([
      `local:${ALPHA}`,
      "local:active",
      "local:older",
    ]);

    const restored = applyProjectPinOrder(active.orders, {}, {
      projectThreadIds: {},
      activityMs: {},
    });
    expect(restored.changed).toBe(true);
    expect(restored.orders).toEqual({
      "project-a": { sortKey: DEFAULT_PROJECT_THREAD_SORT_KEY },
    });
  });

  test("preserves malformed legacy order entries without crashing reconciliation", () => {
    const result = applyProjectPinOrder(
      {
        "removed-project": null as any,
        "project-a": null as any,
      },
      { [ALPHA]: "project-a" },
      {
        projectThreadIds: {
          "project-a": [`local:${ALPHA}`, "local:recent"],
        },
        activityMs: {
          "local:recent": 10,
        },
      },
    );

    expect(result.changed).toBe(true);
    expect(result.orders).toEqual({
      "removed-project": null,
      "project-a": {
        threadIds: [`local:${ALPHA}`, "local:recent"],
      },
    });
  });
});
