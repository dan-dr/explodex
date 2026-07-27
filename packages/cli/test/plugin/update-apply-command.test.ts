import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSingleJsonValue,
  captureCli,
} from "../helpers/run-cli.ts";

describe("M4-F03 public update apply dispatch", () => {
  test("reports an unconfigured recommendation source without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "explodex-update-apply-"));
    try {
      const captured = await captureCli(
        [
          "--home",
          join(root, "home"),
          "plugin",
          "update",
          "apply",
          "--target",
          "development",
          "--json",
        ],
        { HOME: root, PATH: process.env.PATH },
      );
      expect(captured.exitCode).toBe(0);
      expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
        ok: true,
        operation: "plugin.update.apply",
        result: {
          status: "not-configured",
          target: "development",
          selected: [],
          downloaded: [],
          stateChanged: false,
          sourceDelivered: false,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("noninteractive mode refuses configured recommendations before download", async () => {
    const root = await mkdtemp(join(tmpdir(), "explodex-update-apply-"));
    try {
      const recommendations = join(root, "recommendations.json");
      await writeFile(recommendations, JSON.stringify({
        schemaVersion: 1,
        recommendations: [{}],
      }));
      const captured = await captureCli(
        [
          "plugin",
          "update",
          "apply",
          "--target",
          "development",
          "--json",
        ],
        {
          HOME: root,
          PATH: process.env.PATH,
          EXPLODEX_PLUGIN_UPDATE_RECOMMENDATIONS: recommendations,
        },
      );
      expect(captured.exitCode).toBe(3);
      expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
        ok: false,
        operation: "plugin.update.apply",
        error: {
          code: "plugin.update.unavailable",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("configured updates cannot target protected main without authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "explodex-update-apply-"));
    try {
      const recommendations = join(root, "recommendations.json");
      await writeFile(recommendations, JSON.stringify({
        schemaVersion: 1,
        recommendations: [],
      }));
      const captured = await captureCli(
        ["plugin", "update", "apply", "--json"],
        {
          HOME: root,
          PATH: process.env.PATH,
          EXPLODEX_PLUGIN_UPDATE_RECOMMENDATIONS: recommendations,
        },
      );
      expect(captured.exitCode).toBe(3);
      expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
        ok: false,
        operation: "plugin.update.apply",
        error: { code: "main.authorization-required" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
