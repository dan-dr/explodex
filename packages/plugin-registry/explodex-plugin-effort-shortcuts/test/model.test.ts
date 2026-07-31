import { describe, expect, test } from "bun:test";
import {
  LEVEL_CATALOG,
  conversationIdFromPath,
  defaultEffortShortcutSettings,
  hostIdFromPath,
  normalizeEffortShortcutSettings,
  normalizeModelsPayload,
  parseEffortPrefix,
  shouldShowEffortHint,
  supportedEffortsForModel,
} from "../src/model.ts";

describe("VAL-PLUG-012 Effort Shortcuts model", () => {
  test("normalizes settings while retaining at least one enabled prefix", () => {
    expect(defaultEffortShortcutSettings()).toEqual({
      enabledPrefixes: ["xh", "h", "m", "l", "max", "min"],
      showHint: true,
      stripOnSend: true,
      restoreAfterSend: true,
    });
    expect(
      normalizeEffortShortcutSettings({
        enabledPrefixes: ["m", "bogus", "xh"],
        showHint: false,
        stripOnSend: false,
        restoreAfterSend: false,
      }),
    ).toEqual({
      enabledPrefixes: ["xh", "m"],
      showHint: false,
      stripOnSend: false,
      restoreAfterSend: false,
    });
    expect(normalizeEffortShortcutSettings({ enabledPrefixes: [] }).enabledPrefixes).toEqual(
      LEVEL_CATALOG.map((level) => level.prefix),
    );
  });

  test("parses complete enabled prefixes and hints only while choosing a level", () => {
    const settings = defaultEffortShortcutSettings();
    expect(parseEffortPrefix("  !max solve it", settings)).toMatchObject({
      level: { prefix: "max", effort: "max" },
      prompt: "solve it",
    });
    expect(parseEffortPrefix("!m", settings)).toMatchObject({
      level: { effort: "medium" },
      prompt: "",
    });
    expect(parseEffortPrefix("!medium no", settings)).toBeNull();
    expect(
      parseEffortPrefix("!m no", { enabledPrefixes: ["h"] }),
    ).toBeNull();
    expect(shouldShowEffortHint("!", settings)).toBe(true);
    expect(shouldShowEffortHint("!ma", settings)).toBe(true);
    expect(shouldShowEffortHint("!max ", settings)).toBe(false);
    expect(shouldShowEffortHint("normal", settings)).toBe(false);
  });

  test("normalizes bridge model payload variants and supported efforts", () => {
    const nested = normalizeModelsPayload({
      data: {
        data: [
          {
            model: "gpt-test",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { effort: "high" },
            ],
          },
        ],
        defaultModel: {
          model: "gpt-test",
          defaultReasoningEffort: "high",
        },
      },
    });
    expect(nested.defaultModel).toEqual({
      model: "gpt-test",
      defaultReasoningEffort: "high",
    });
    expect(supportedEffortsForModel(nested.models, "gpt-test")).toEqual([
      "low",
      "high",
    ]);
    expect(supportedEffortsForModel([], "unknown")).toEqual(
      LEVEL_CATALOG.map((level) => level.effort),
    );
  });

  test("resolves local, thread, hotkey, and remote route identifiers", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(conversationIdFromPath(`/local/${id}`)).toBe(id);
    expect(conversationIdFromPath(`/thread/${id}`)).toBe(id);
    expect(conversationIdFromPath(`/hotkey-window/thread/${id}`)).toBe(id);
    expect(conversationIdFromPath("/thread/not-a-thread")).toBeNull();
    expect(hostIdFromPath("/remote/office%20mac/thread/example")).toBe("office mac");
    expect(hostIdFromPath("/local/example")).toBe("local");
  });
});
