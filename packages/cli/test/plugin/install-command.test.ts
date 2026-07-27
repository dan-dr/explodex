import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
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

describe("plugin install immutable command", () => {
  test("plugin install and add use the stable envelope and converge on one disabled identity", async () => {
    const { fixture, packaged } = await buildArchive();
    try {
      const home = join(fixture.root, "home");
      const outcomes: string[] = [];
      for (const command of ["install", "add"] as const) {
        const captured = await captureCli(
          ["--json", "--home", home, "plugin", command, packaged.outputPath],
          { ...process.env, HOME: home, PWD: fixture.root },
        );
        expect(captured.exitCode).toBe(0);
        expect(captured.stderr).toBe("");
        const envelope = assertSingleJsonValue(captured.stdout) as {
          schemaVersion: number;
          ok: boolean;
          operation: string;
          result: {
            payloadSha256: string;
            archiveSha256: string;
            installed: boolean;
            artifactCommitted: boolean;
            stateCommitted: boolean;
            enabled: boolean;
            pendingReview: boolean;
            outcome: string;
            artifactPath: string;
            source: { kind: string; archiveName: string };
            sourceLabel: string;
            transportTrust: string;
          };
          warnings: unknown[];
        };
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.ok).toBe(true);
        expect(envelope.operation).toBe("plugin.install");
        expect(envelope.warnings).toEqual([]);
        expect(envelope.result.payloadSha256).toBe(packaged.payloadSha256);
        expect(envelope.result.archiveSha256).toBe(packaged.archiveSha256);
        expect(envelope.result.installed).toBe(true);
        expect(envelope.result.artifactCommitted).toBe(true);
        expect(envelope.result.enabled).toBe(false);
        expect(envelope.result.pendingReview).toBe(true);
        expect(envelope.result.source).toEqual({
          kind: "local",
          archiveName: basename(packaged.outputPath),
        });
        expect(envelope.result.sourceLabel).toStartWith("Local archive: ");
        expect(envelope.result.transportTrust).toBe(
          "computed-local-archive-not-publisher-authenticated",
        );
        expect((await stat(envelope.result.artifactPath)).isDirectory()).toBe(true);
        outcomes.push(envelope.result.outcome);
      }
      expect(outcomes).toEqual(["installed", "already-installed"]);
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
