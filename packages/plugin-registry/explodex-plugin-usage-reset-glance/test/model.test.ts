import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TEMPLATE,
  PATH_RESET_CREDITS,
  PATH_USAGE,
  createViewOnlyUsageHttp,
  defaultUsageSettings,
  formatCompactUsage,
  normalizeUsageSettings,
  parseResetCredits,
  parseUsage,
  refreshIntervalMs,
} from "../src/model.ts";

const format = {
  template(template: string, context: any, options?: { fallback?: string }) {
    return template.replace(
      /\{([^}]+)\}/g,
      (_match, path: string) =>
        path
          .replace(/\[(\d+)\]/g, ".$1")
          .split(".")
          .reduce((value: any, key: string) => value?.[key], context) ??
        options?.fallback ??
        "—",
    );
  },
  countdown(value: number | null | undefined) {
    return value == null ? "—" : `in:${value}`;
  },
  datetimeCountdown(value: number | null | undefined) {
    return value == null ? "—" : `at:${value}`;
  },
};

describe("VAL-PLUG-010 Usage and Reset Glance model", () => {
  test("normalizes persisted templates and refresh presets without resetting compatible values", () => {
    expect(defaultUsageSettings()).toEqual({
      compactTemplate: DEFAULT_TEMPLATE,
      refreshIntervalSec: 60,
      refreshPreset: "60",
    });
    expect(
      normalizeUsageSettings({
        compactTemplate: "  {resets.count} resets  ",
        refreshIntervalSec: 17,
        refreshPreset: "custom",
      }),
    ).toEqual({
      compactTemplate: "{resets.count} resets",
      refreshIntervalSec: 17,
      refreshPreset: "custom",
    });
    expect(
      normalizeUsageSettings({
        compactTemplate: "",
        refreshIntervalSec: 300,
        refreshPreset: "unknown",
      }),
    ).toEqual({
      compactTemplate: DEFAULT_TEMPLATE,
      refreshIntervalSec: 300,
      refreshPreset: "300",
    });
    expect(refreshIntervalMs(normalizeUsageSettings({ refreshPreset: "0" }))).toBe(0);
    expect(
      refreshIntervalMs(
        normalizeUsageSettings({
          refreshPreset: "custom",
          refreshIntervalSec: 2,
        }),
      ),
    ).toBe(5_000);
  });

  test("parses usage windows, available reset credits, and compact template aliases", () => {
    const usage = parseUsage({
      plan_type: "pro",
      rate_limit: {
        limit_reached: true,
        primary_window: {
          used_percent: 25.4,
          reset_at: 1_700_000_000_000,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 90,
          reset_at: "2026-08-01T00:00:00Z",
          limit_window_seconds: 604_800,
        },
      },
    });
    const resets = parseResetCredits({
      available_count: 2,
      credits: [
        {
          status: "available",
          title: "Monthly reset",
          expires_at: 1_800_000_000,
        },
        { status: "used", title: "Consumed" },
      ],
    });

    expect(usage).toMatchObject({
      planType: "pro",
      limitReached: true,
      primary: {
        usedPercent: 25.4,
        resetAt: 1_700_000_000,
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 90,
        windowMinutes: 10_080,
      },
    });
    expect(resets).toEqual({
      availableCount: 2,
      credits: [
        {
          status: "available",
          title: "Monthly reset",
          expires_at: 1_800_000_000,
        },
      ],
    });
    expect(
      formatCompactUsage(
        usage,
        resets,
        "{usage.short.left.percent}|{usage.week.used.percent}|{resets.count}|{resets[0].expires}",
        format,
      ),
    ).toBe("75|90|2|at:1800000000");
  });

  test("exposes only the two documented view-only GET endpoints", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const http = createViewOnlyUsageHttp({
      isAvailable: () => true,
      async get(path: string) {
        calls.push({ method: "GET", path });
        return { path };
      },
    });

    await expect(http.get(PATH_USAGE)).resolves.toEqual({ path: PATH_USAGE });
    await expect(http.get(PATH_RESET_CREDITS)).resolves.toEqual({
      path: PATH_RESET_CREDITS,
    });
    await expect(http.get("/wham/consume")).rejects.toThrow(
      "view-only plugin: path not allowed",
    );
    await expect(http.get("/wham/other-status")).rejects.toThrow(
      "view-only plugin: path not allowed",
    );
    expect(Object.keys(http).sort()).toEqual(["get", "isAvailable"]);
    expect(calls).toEqual([
      { method: "GET", path: PATH_USAGE },
      { method: "GET", path: PATH_RESET_CREDITS },
    ]);
  });
});
