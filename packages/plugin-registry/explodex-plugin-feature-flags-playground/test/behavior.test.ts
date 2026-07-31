import { describe, expect, test } from "bun:test";
import { CODEX_BUNDLE_GATE_HINTS, mergeGateHints } from "../src/model.ts";

describe("VAL-PLUG-014 Feature Flags Playground activation behavior", () => {
  test("keeps static gate hints available before a dynamic scan completes", () => {
    const hints = mergeGateHints(CODEX_BUNDLE_GATE_HINTS, {});
    expect(hints.browser_use).toEqual(["410262010"]);
    expect(hints.chronicle).toEqual(["2574306096"]);
  });

  test("merges dynamic and static mappings without dropping first-run gates", () => {
    const hints = mergeGateHints(CODEX_BUNDLE_GATE_HINTS, {
      browser_use: ["410262010", "410262011"],
      realtime_conversation: ["2380644311"],
    });
    expect(hints.browser_use).toEqual(["410262010", "410262011"]);
    expect(hints.realtime_conversation).toEqual(["2380644311"]);
  });
});
