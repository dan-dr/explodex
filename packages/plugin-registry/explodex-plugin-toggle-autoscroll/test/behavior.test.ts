import { describe, expect, test } from "bun:test";
import {
  defaultToggleAutoscrollSettings,
  normalizeToggleAutoscrollSettings,
  resolveAutoscrollEnabled,
} from "../src/settings.ts";

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";

describe("VAL-PLUG-007 Toggle Autoscroll behavior", () => {
  test("preserves supported visibility and persistence settings", () => {
    expect(
      normalizeToggleAutoscrollSettings({
        rememberAutoscroll: false,
        defaultAutoscroll: false,
        showText: false,
        showAlways: false,
        threadStates: {
          [THREAD_A]: true,
          invalid: true,
          [THREAD_B]: "no",
        },
      }),
    ).toEqual({
      rememberAutoscroll: false,
      defaultAutoscroll: false,
      showText: false,
      showAlways: false,
      threadStates: {
        [THREAD_A]: true,
      },
    });
  });

  test("uses session state before remembered state and then the default", () => {
    const settings = {
      ...defaultToggleAutoscrollSettings(),
      defaultAutoscroll: false,
      threadStates: {
        [THREAD_A]: true,
      },
    };
    expect(
      resolveAutoscrollEnabled({
        conversationId: THREAD_A,
        sessionStates: new Map([[THREAD_A, false]]),
        settings,
      }),
    ).toBe(false);
    expect(
      resolveAutoscrollEnabled({
        conversationId: THREAD_A,
        sessionStates: new Map(),
        settings,
      }),
    ).toBe(true);
    expect(
      resolveAutoscrollEnabled({
        conversationId: THREAD_B,
        sessionStates: new Map(),
        settings,
      }),
    ).toBe(false);
  });

  test("ignores remembered thread values when remembering is disabled", () => {
    const settings = {
      ...defaultToggleAutoscrollSettings(),
      rememberAutoscroll: false,
      defaultAutoscroll: false,
      threadStates: {
        [THREAD_A]: true,
      },
    };
    expect(
      resolveAutoscrollEnabled({
        conversationId: THREAD_A,
        sessionStates: new Map(),
        settings,
      }),
    ).toBe(false);
  });
});
