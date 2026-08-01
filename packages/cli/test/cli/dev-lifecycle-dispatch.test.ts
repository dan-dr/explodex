import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSingleJsonValue,
  captureCli,
} from "../helpers/run-cli.ts";

describe("development lifecycle CLI dispatch", () => {
  test("prove dispatches through its public operation", async () => {
    const captured = await captureCli(
      ["dev", "prove", "--json"],
      { PATH: process.env.PATH },
    );
    expect(captured.exitCode).toBe(2);
    expect(captured.stderr).toContain("HOME is required");
    expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      operation: "dev.prove",
      error: {
        code: "config.invalid-environment",
      },
    });
  });

  test("prove rejects a nonempty unowned explicit root before creating layout", async () => {
    const osHome = await mkdtemp(join("/private/tmp", "explodex-prove-home-"));
    const root = join(osHome, "requested-root");
    await mkdir(root);
    await writeFile(join(root, "sentinel.txt"), "owned elsewhere\n");
    try {
      const captured = await captureCli(
        ["--dev-root", root, "dev", "prove", "--json"],
        { HOME: osHome, PATH: process.env.PATH },
      );
      expect(captured.exitCode).toBe(1);
      expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: "dev.prove",
        error: {
          code: "dev.root-invalid",
          details: {
            rootCode: "nonempty_unowned_root",
            rootPath: root,
            fallbackUsed: false,
          },
        },
      });
      expect(await Bun.file(join(root, "sentinel.txt")).text()).toBe("owned elsewhere\n");
      expect(await Bun.file(join(root, "state.json")).exists()).toBe(false);
      expect(await Bun.file(join(root, "electron-user-data")).exists()).toBe(false);
    } finally {
      await rm(osHome, { recursive: true, force: true });
    }
  });

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

  test("inject and focus dispatch through public operations", async () => {
    for (const [tokens, operation] of [
      [["dev", "inject", "/tmp/plugin.tgz", "--json"], "dev.inject"],
      [["dev", "focus", "--json"], "dev.focus"],
    ] as const) {
      const captured = await captureCli(tokens, { PATH: process.env.PATH });
      expect(captured.exitCode).toBe(2);
      expect(captured.stderr).toContain("HOME is required");
      expect(assertSingleJsonValue(captured.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation,
        error: {
          code: "config.invalid-environment",
        },
      });
    }
  });
});
