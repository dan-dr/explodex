import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import {
  captureEphemeralPluginArtifact,
} from "../../src/dev/index.ts";
import {
  createValidWorkspace,
  writeWorkspaceFile,
} from "../plugin/helpers.ts";

describe("M4-F03 ephemeral artifact capture", () => {
  test("rereads one exact archive into an immutable source-and-asset snapshot", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-dev-inject",
    });
    try {
      await writeWorkspaceFile(
        fixture.workspace,
        "explodex.config.ts",
        `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: "dev-opaque",
  displayName: "Dev inject",
  description: "Ephemeral development injection fixture",
  lifecycle: "dynamic",
  assets: ["sentinel.txt"],
});
`,
      );
      await writeWorkspaceFile(
        fixture.workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup() {
    (globalThis as unknown as Record<string, unknown>).__DEV_INJECT_SOURCE__ = true;
  },
});
`,
      );
      await writeWorkspaceFile(
        fixture.workspace,
        "assets/sentinel.txt",
        "DEV_INJECT_ASSET",
      );
      const built = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);
      const outputDir = join(fixture.root, "out");
      await mkdir(outputDir, { recursive: true });
      const packaged = await packagePluginWorkspace({
        workspacePath: fixture.workspace,
        outputDir,
        timeoutMs: 60_000,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) throw new Error(packaged.message);

      const captured = await captureEphemeralPluginArtifact({
        artifactPath: packaged.outputPath,
      });
      expect(captured.ok).toBe(true);
      if (!captured.ok) throw new Error(captured.message);
      expect(captured.validation).toMatchObject({
        id: "dev-inject",
        version: "dev-opaque",
        lifecycle: "dynamic",
        payloadSha256: packaged.payloadSha256,
        archiveSha256: packaged.archiveSha256,
        source: "archive",
      });
      expect(
        new TextDecoder().decode(
          captured.snapshot.read("assets/sentinel.txt"),
        ),
      ).toBe("DEV_INJECT_ASSET");

      await rm(packaged.outputPath);
      expect(
        new TextDecoder().decode(captured.snapshot.read("index.js")),
      ).toContain("__DEV_INJECT_SOURCE__");
      expect(
        new TextDecoder().decode(
          captured.snapshot.read("assets/sentinel.txt"),
        ),
      ).toBe("DEV_INJECT_ASSET");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a changed archive before any target action can receive bytes", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-dev-invalid",
    });
    try {
      const built = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);
      const outputDir = join(fixture.root, "out");
      await mkdir(outputDir, { recursive: true });
      const packaged = await packagePluginWorkspace({
        workspacePath: fixture.workspace,
        outputDir,
        timeoutMs: 60_000,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) throw new Error(packaged.message);
      const bytes = await readFile(packaged.outputPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      await Bun.write(packaged.outputPath, bytes);
      const captured = await captureEphemeralPluginArtifact({
        artifactPath: packaged.outputPath,
      });
      expect(captured.ok).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
