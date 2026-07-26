import { describe, expect, test } from "bun:test";
import { access, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPluginWorkspace } from "../../src/plugin/create.ts";
import { captureCli, parseStdoutJson } from "../helpers/run-cli.ts";
import { tempDir } from "./helpers.ts";

describe("VAL-SDK-011 create emits one safe generated-only workspace", () => {
  test("creates only canonical authored files and optional empty dirs", async () => {
    const root = await tempDir();
    try {
      const result = await createPluginWorkspace({
        directory: join(root, "explodex-plugin-hello-world"),
        cwd: root,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.id).toBe("hello-world");
      expect(result.packageName).toBe("explodex-plugin-hello-world");

      const entries = await readdir(result.workspacePath, { withFileTypes: true });
      const names = entries.map((entry) => entry.name).sort();
      expect(names).toEqual(
        ["README.md", "assets", "explodex.config.ts", "package.json", "src", "test", "tsconfig.json"].sort(),
      );

      // No generated/legacy outputs.
      for (const forbidden of [
        "dist",
        "plugin.json",
        "index.js",
        "index.js.map",
        "checksums.json",
        "manifest.json",
      ]) {
        await expect(access(join(result.workspacePath, forbidden))).rejects.toBeDefined();
      }

      const packageJson = JSON.parse(
        await readFile(join(result.workspacePath, "package.json"), "utf8"),
      ) as { name: string; version: string; peerDependencies: Record<string, string> };
      expect(packageJson.name).toBe("explodex-plugin-hello-world");
      expect(packageJson.version).toBe("0.0.0");
      expect(packageJson.peerDependencies["@explodex/sdk"]).toMatch(/^\^/);

      const config = await readFile(join(result.workspacePath, "explodex.config.ts"), "utf8");
      expect(config).toContain("defineConfig");
      expect(config).toContain("Hello World");
      expect(config).not.toContain("id:");
      expect(config).not.toContain("sdkRange");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe names and nonempty destinations without partial creation", async () => {
    const root = await tempDir();
    try {
      const badName = await createPluginWorkspace({
        directory: join(root, "NotAPlugin"),
        cwd: root,
      });
      expect(badName.ok).toBe(false);

      const escape = await createPluginWorkspace({
        directory: join(root, "explodex-plugin-../escape"),
        cwd: root,
      });
      expect(escape.ok).toBe(false);

      const dest = join(root, "explodex-plugin-occupied");
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "package.json"), "{}\n");
      const before = await readdir(dest);
      const occupied = await createPluginWorkspace({ directory: dest, cwd: root });
      expect(occupied.ok).toBe(false);
      const after = await readdir(dest);
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("public CLI plugin create succeeds via JSON envelope", async () => {
    const root = await tempDir();
    try {
      const target = join(root, "explodex-plugin-cli-create");
      const captured = await captureCli(
        ["--json", "plugin", "create", target],
        { ...process.env, HOME: root, PWD: root },
      );
      expect(captured.exitCode).toBe(0);
      const envelope = parseStdoutJson(captured.stdout) as {
        ok: boolean;
        operation: string;
        result: { id: string; packageName: string };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.operation).toBe("plugin.create");
      expect(envelope.result.id).toBe("cli-create");
      expect(envelope.result.packageName).toBe("explodex-plugin-cli-create");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
