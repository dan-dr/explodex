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

  test("rejects unarchived dist and keeps target-unavailable installs disabled and pending", async () => {
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
      expect(target.exitCode).toBe(3);
      const targetEnvelope = assertSingleJsonValue(target.stdout) as {
        error: {
          code: string;
          details: {
            installed: boolean;
            enabled: boolean;
            pendingReview: boolean;
            target: string;
          };
        };
      };
      expect(targetEnvelope.error.code).toBe("plugin.review.unavailable");
      expect(targetEnvelope.error.details).toMatchObject({
        installed: true,
        enabled: false,
        pendingReview: true,
        target: "development",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("plugin status stays read-only while refresh reoffers pending metadata without source delivery", async () => {
    const { fixture, packaged } = await buildArchive();
    try {
      const home = join(fixture.root, "home");
      const installed = await captureCli(
        ["--json", "--home", home, "plugin", "install", packaged.outputPath],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(installed.exitCode).toBe(0);
      const statePath = join(home, "state", "plugins.json");
      const before = await readFile(statePath);
      const beforeMtime = (await stat(statePath)).mtimeMs;

      const status = await captureCli(
        ["--json", "--home", home, "plugin", "status"],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(status.exitCode).toBe(0);
      const statusEnvelope = assertSingleJsonValue(status.stdout) as {
        result: {
          discovered: boolean;
          stateChanged: boolean;
          plugins: Record<string, unknown>;
        };
      };
      expect(statusEnvelope.result.discovered).toBe(false);
      expect(statusEnvelope.result.stateChanged).toBe(false);
      expect(Object.keys(statusEnvelope.result.plugins)).toEqual([
        packaged.report.id,
      ]);
      expect(await readFile(statePath)).toEqual(before);
      expect((await stat(statePath)).mtimeMs).toBe(beforeMtime);

      const refresh = await captureCli(
        ["--json", "--home", home, "plugin", "refresh"],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(refresh.exitCode).toBe(0);
      const refreshEnvelope = assertSingleJsonValue(refresh.stdout) as {
        result: {
          pending: Array<Record<string, unknown>>;
          rendererRequested: boolean;
          sourceDelivered: boolean;
          review: { status: string; target: string };
        };
      };
      expect(refreshEnvelope.result.pending).toHaveLength(1);
      expect(Object.keys(refreshEnvelope.result.pending[0]!).sort()).toEqual([
        "description",
        "displayName",
        "id",
        "payloadSha256",
        "sdkRange",
        "sourceLabel",
        "version",
      ]);
      expect(refreshEnvelope.result.rendererRequested).toBe(false);
      expect(refreshEnvelope.result.sourceDelivered).toBe(false);
      expect(refreshEnvelope.result.review).toEqual({
        status: "required",
        target: "none",
      });

      const unavailable = await captureCli(
        [
          "--json",
          "--home",
          home,
          "plugin",
          "refresh",
          "--target",
          "development",
        ],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(unavailable.exitCode).toBe(3);
      const unavailableEnvelope = assertSingleJsonValue(unavailable.stdout) as {
        error: { code: string; details: { pending: unknown[] } };
      };
      expect(unavailableEnvelope.error.code).toBe("plugin.review.unavailable");
      expect(unavailableEnvelope.error.details.pending).toHaveLength(1);
      expect(await readFile(statePath)).toEqual(before);

      const review = await captureCli(
        ["--json", "--home", home, "plugin", "review", packaged.report.id],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(review.exitCode).toBe(3);
      const reviewEnvelope = assertSingleJsonValue(review.stdout) as {
        operation: string;
        error: {
          code: string;
          details: {
            reason: string;
            pending: Array<Record<string, unknown>>;
            sourceDelivered: boolean;
            authorityChanged: boolean;
          };
        };
      };
      expect(reviewEnvelope.operation).toBe("plugin.review");
      expect(reviewEnvelope.error.code).toBe("plugin.review.unavailable");
      expect(reviewEnvelope.error.details.reason).toBe("json-mode");
      expect(reviewEnvelope.error.details.pending).toHaveLength(1);
      expect(Object.keys(reviewEnvelope.error.details.pending[0]!).sort()).toEqual([
        "description",
        "displayName",
        "id",
        "payloadSha256",
        "sdkRange",
        "sourceLabel",
        "version",
      ]);
      expect(reviewEnvelope.error.details.sourceDelivered).toBe(false);
      expect(reviewEnvelope.error.details.authorityChanged).toBe(false);
      expect(await readFile(statePath)).toEqual(before);

      const updateCheck = await captureCli(
        ["--json", "--home", home, "plugin", "update", "check"],
        { ...process.env, HOME: home, PWD: fixture.root },
      );
      expect(updateCheck.exitCode).toBe(0);
      const updateEnvelope = assertSingleJsonValue(updateCheck.stdout) as {
        operation: string;
        result: {
          trigger: string;
          localDiscovery: {
            pending: unknown[];
            rendererRequested: boolean;
            sourceDelivered: boolean;
          };
          updates: unknown[];
          remoteRegistry: string;
        };
      };
      expect(updateEnvelope.operation).toBe("plugin.update.check");
      expect(updateEnvelope.result.trigger).toBe("update-check");
      expect(updateEnvelope.result.localDiscovery.pending).toHaveLength(1);
      expect(updateEnvelope.result.localDiscovery.rendererRequested).toBe(false);
      expect(updateEnvelope.result.localDiscovery.sourceDelivered).toBe(false);
      expect(updateEnvelope.result.updates).toEqual([]);
      expect(updateEnvelope.result.remoteRegistry).toBe("not-configured");
      expect(await readFile(statePath)).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
