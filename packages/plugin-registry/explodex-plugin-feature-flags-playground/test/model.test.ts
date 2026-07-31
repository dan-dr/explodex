import { describe, expect, test } from "bun:test";
import {
  filterFeatures,
  groupFeaturesByStage,
  mergeFeatures,
  normalizeSettings,
  overlayConfigOverrides,
} from "../src/model.ts";

describe("VAL-PLUG-012 Feature Flags Playground model", () => {
  test("keeps opt-out settings explicit and defaults missing values on", () => {
    expect(normalizeSettings({ showSidebarShortcut: false })).toEqual({
      showSidebarShortcut: false,
      embedInGeneralSettings: true,
    });
  });

  test("adds fallback catalog flags, groups stages, and filters stage copy", () => {
    const features = mergeFeatures([
      { name: "experimental_voice", enabled: true, stage: "beta", label: "Voice" },
    ]);
    const filtered = filterFeatures(features, "wider rollout");
    expect(filtered).toEqual([{ ...features.find((feature) => feature.name === "experimental_voice")! }]);
    expect(groupFeaturesByStage(features).find((section) => section.key === "beta")?.features[0]?.name).toBe("experimental_voice");
  });

  test("overlays persisted config values without changing unknown catalog entries", () => {
    const features = mergeFeatures([{ name: "memories", enabled: false }]);
    expect(overlayConfigOverrides(features, { memories: true }).find((feature) => feature.name === "memories")?.enabled).toBe(true);
  });
});
