import { describe, expect, test } from "bun:test";
import {
  assertSingleJsonValue,
  captureCli,
} from "../helpers/run-cli.ts";

describe("development lifecycle CLI dispatch", () => {
  test("start, ensure, restart, and stop dispatch through their public operations", async () => {
    for (const kind of ["start", "ensure", "restart", "stop"] as const) {
      const captured = await captureCli(
        ["dev", kind, "--json"],
        { PATH: process.env.PATH },
      );
      expect(captured.exitCode).toBe(2);
      expect(captured.stderr).toContain("HOME is required");
      expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: `dev.${kind}`,
        error: {
          code: "config.invalid-environment",
        },
      });
    }
  });
});
