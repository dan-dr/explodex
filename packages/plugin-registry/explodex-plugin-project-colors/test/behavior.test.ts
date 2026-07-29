import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PALETTE,
  autoColorForId,
  inheritedThreadColor,
  migrateProjectColorSettings,
  normalizeHexColor,
  normalizePalette,
  projectColorValue,
} from "../src/settings.ts";

describe("VAL-PLUG-008 Project Colors behavior", () => {
  test("migrates legacy visual and override settings without resetting values", () => {
    const migrated = migrateProjectColorSettings({
      palette: [
        "#abc",
        "#112233",
        "#445566",
        "#778899",
        "#AABBCC",
        "#DDEEFF",
      ],
      autoAssign: false,
      colorThreads: true,
      visuals: { style: "full" },
      overrides: { projectA: "#112233" },
      threadOverrides: { threadA: "#445566" },
    });
    expect(migrated).toEqual({
      version: 2,
      palette: [
        "#AABBCC",
        "#112233",
        "#445566",
        "#778899",
        "#DDEEFF",
      ],
      autoAssignProjects: false,
      visuals: {
        style: "full",
        colorTarget: "both",
      },
      projectOverrides: { projectA: "#112233" },
      threadOverrides: { threadA: "#445566" },
    });
  });

  test("normalizes colors and restores the supported default palette when undersized", () => {
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(normalizeHexColor("#12zz99")).toBeNull();
    expect(normalizePalette(["#111", "#222"])).toEqual([
      ...DEFAULT_PALETTE,
    ]);
  });

  test("preserves override, inheritance, auto-assignment, and target modes", () => {
    const settings = migrateProjectColorSettings({
      palette: ["#111111", "#222222", "#333333", "#444444", "#555555"],
      autoAssignProjects: true,
      visuals: { colorTarget: "threads" },
      projectOverrides: { projectA: "#ABCDEF" },
      threadOverrides: { threadA: "#FEDCBA" },
    });
    expect(projectColorValue(settings, "projectA")).toBe("#ABCDEF");
    expect(inheritedThreadColor(settings, "threadA", "projectA")).toBe(
      "#FEDCBA",
    );
    expect(inheritedThreadColor(settings, "threadB", "projectA")).toBe(
      "#ABCDEF",
    );
    expect(projectColorValue(settings, "projectB")).toBe(
      autoColorForId("projectB", settings.palette),
    );

    settings.visuals.colorTarget = "projects";
    expect(inheritedThreadColor(settings, "threadB", "projectA")).toBeNull();
  });
});
