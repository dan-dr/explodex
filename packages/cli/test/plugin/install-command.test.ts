import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import { captureCli, assertSingleJsonValue } from "../helpers/run-cli.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function buildArchive() {
  const fixture = await createValidWorkspace({ name: "explodex-plugin-install-command" });
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() {} });
`,
  );
  const built = await buildPluginWorkspace({
    workspacePath: fixture.workspace,
    timeoutMs: 60_000,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(built.message);
  const outputDir = join(fixture.root, "out");
  await mkdir(outputDir, { recursive: true });
  const packaged = await packagePluginWorkspace({
    workspacePath: fixture.workspace,
    outputDir,
    timeoutMs: 60_000,
  });
  expect(packaged.ok).toBe(true);
  if (!packaged.ok) throw new Error(packaged.message);
  return { fixture, packaged };
}

describe("plugin install precommit command", () => {
  test("plugin install and add accept only prebuilt archives and leave no committed state", async () => {
    const { fixture, packaged } = await buildArchive();
    try {
      const home = join(fixture.root, "home");
      for (const command of ["install", "add"] as const) {
        const captured = await captureCli(
          ["--json", "--home", home, "plugin", command, packaged.outputPath],
          { ...process.env, HOME: home, PWD: fixture.root },
        );
        expect(captured.exitCode).toBe(0);
        expect(captured.stderr).toBe("");
        const envelope = assertSingleJsonValue(captured.stdout) as {
          ok: boolean;
          operation: string;
          result: {
            payloadSha256: string;
            archiveSha256: string;
            committed: boolean;
            installed: boolean;
            validation: string;
          };
        };
        expect(envelope.ok).toBe(true);
        expect(envelope.operation).toBe("plugin.install");
        expect(envelope.result.payloadSha256).toBe(packaged.payloadSha256);
        expect(envelope.result.archiveSha256).toBe(packaged.archiveSha256);
        expect(envelope.result.committed).toBe(false);
        expect(envelope.result.installed).toBe(false);
        expect(envelope.result.validation).toBe("precommit-complete");
      }
      expect(await readFile(packaged.outputPath)).toBeInstanceOf(Buffer);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("rejects unarchived dist and target application before extraction", async () => {
    const { fixture, packaged } = await buildArchive();
    try {
      const home = join(fixture.root, "home");
      const directory = await captureCli(
        ["--json", "--home", home, "plugin", "install", join(fixture.workspace, "dist")],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(directory.exitCode).toBe(1);
      const directoryEnvelope = assertSingleJsonValue(directory.stdout) as {
        error: { code: string };
      };
      expect(directoryEnvelope.error.code).toBe("plugin.install.archive-required");

      const target = await captureCli(
        [
          "--json",
          "--home",
          home,
          "plugin",
          "install",
          packaged.outputPath,
          "--target",
          "development",
        ],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(target.exitCode).toBe(1);
      const targetEnvelope = assertSingleJsonValue(target.stdout) as {
        error: { code: string };
      };
      expect(targetEnvelope.error.code).toBe("plugin.install.target-unavailable");
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
