import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import {
  ingestLocalPluginArchive,
  ingestRemotePluginArchive,
  type PluginIngestionAdapters,
} from "../../src/plugin/installer.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function packagedFixture(name: string): Promise<{
  root: string;
  workspace: string;
  archivePath: string;
  archiveBytes: Buffer;
  id: string;
  version: string;
  payloadSha256: string;
  archiveSha256: string;
  cleanup(): Promise<void>;
}> {
  const fixture = await createValidWorkspace({ name });
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
  return {
    root: fixture.root,
    workspace: fixture.workspace,
    archivePath: packaged.outputPath,
    archiveBytes: await readFile(packaged.outputPath),
    id: packaged.report.id,
    version: packaged.report.version,
    payloadSha256: packaged.payloadSha256,
    archiveSha256: packaged.archiveSha256,
    cleanup: fixture.cleanup,
  };
}

function tracingAdapters(trace: string[]): PluginIngestionAdapters {
  return {
    async beforeExtract() {
      trace.push("extract");
    },
    async beforeCommit() {
      trace.push("commit");
    },
    async beforeStateMutation() {
      trace.push("state");
    },
    async beforeRendererEvaluation() {
      trace.push("renderer");
    },
    async beforeAssetDelivery() {
      trace.push("asset");
    },
  };
}

async function privateEntries(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

describe("VAL-SDK-035 prebuilt-archive-only ingestion", () => {
  test("rejects workspace, config, package, source tree, repository URL, and unarchived dist", async () => {
    const fixture = await packagedFixture("explodex-plugin-prebuilt-only");
    try {
      for (const input of [
        fixture.workspace,
        join(fixture.workspace, "explodex.config.ts"),
        join(fixture.workspace, "package.json"),
        join(fixture.workspace, "src"),
        join(fixture.workspace, "dist"),
        "https://github.com/example/repository",
      ]) {
        const trace: string[] = [];
        const result = await ingestLocalPluginArchive({
          archivePath: input,
          stagingParent: join(fixture.root, "staging"),
          adapters: tracingAdapters(trace),
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected non-archive rejection");
        expect(result.code).toBe("plugin.install.archive-required");
        expect(trace).toEqual([]);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("valid local archive uses only archive bytes and source-free validation", async () => {
    const fixture = await packagedFixture("explodex-plugin-local-ingest");
    try {
      await rm(fixture.workspace, { recursive: true, force: true });
      const trace: string[] = [];
      const result = await ingestLocalPluginArchive({
        archivePath: fixture.archivePath,
        stagingParent: join(fixture.root, "staging"),
        expectedIdentity: {
          id: fixture.id,
          version: fixture.version,
          payloadSha256: fixture.payloadSha256,
        },
        adapters: tracingAdapters(trace),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.archiveSha256).toBe(fixture.archiveSha256);
      expect(result.payloadSha256).toBe(fixture.payloadSha256);
      expect(trace).toEqual(["extract"]);
      await result.cleanup();
      expect(await privateEntries(join(fixture.root, "staging"))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});

describe("VAL-SDK-037 independent remote archive digests", () => {
  test("missing or wrong expected archiveSha256 fails before extraction", async () => {
    const fixture = await packagedFixture("explodex-plugin-remote-digest");
    try {
      const missingTrace: string[] = [];
      const missing = await ingestRemotePluginArchive({
        archiveBytes: fixture.archiveBytes,
        expectedArchiveSha256: null,
        stagingParent: join(fixture.root, "staging-missing"),
        adapters: tracingAdapters(missingTrace),
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) throw new Error("expected missing digest failure");
      expect(missing.code).toBe("plugin.install.archive-digest-required");
      expect(missingTrace).toEqual([]);

      const wrongTrace: string[] = [];
      const wrong = await ingestRemotePluginArchive({
        archiveBytes: fixture.archiveBytes,
        expectedArchiveSha256: "00".repeat(32),
        stagingParent: join(fixture.root, "staging-wrong"),
        adapters: tracingAdapters(wrongTrace),
      });
      expect(wrong.ok).toBe(false);
      if (wrong.ok) throw new Error("expected wrong digest failure");
      expect(wrong.code).toBe("plugin.install.archive-digest-mismatch");
      expect(wrong.details).toEqual({
        expectedArchiveSha256: "00".repeat(32),
        actualArchiveSha256: fixture.archiveSha256,
      });
      expect(wrongTrace).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("independent expected payloadSha256 is checked after extraction", async () => {
    const fixture = await packagedFixture("explodex-plugin-remote-payload-digest");
    try {
      const trace: string[] = [];
      const result = await ingestRemotePluginArchive({
        archiveBytes: fixture.archiveBytes,
        expectedArchiveSha256: fixture.archiveSha256,
        expectedIdentity: { payloadSha256: "11".repeat(32) },
        stagingParent: join(fixture.root, "staging-payload"),
        adapters: tracingAdapters(trace),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected payload mismatch failure");
      expect(result.code).toBe("plugin.artifact.invalid");
      expect(result.message).toMatch(/payloadSha256/i);
      expect(trace).toEqual(["extract"]);
      expect(await privateEntries(join(fixture.root, "staging-payload"))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});

describe("VAL-SDK-038 all validation completes before commit", () => {
  test("handled validation failures remove private extraction and never cross commit barriers", async () => {
    const fixture = await packagedFixture("explodex-plugin-precommit-failure");
    const temp = await mkdtemp(join(tmpdir(), "explodex-installer-precommit-"));
    try {
      const tampered = Buffer.from(fixture.archiveBytes);
      tampered[Math.floor(tampered.byteLength / 2)] ^= 0xff;
      const trace: string[] = [];
      const stagingParent = join(temp, "private-staging");
      const result = await ingestRemotePluginArchive({
        archiveBytes: tampered,
        expectedArchiveSha256: fixture.archiveSha256,
        stagingParent,
        adapters: tracingAdapters(trace),
      });
      expect(result.ok).toBe(false);
      expect(trace).toEqual([]);
      expect(await privateEntries(stagingParent)).toEqual([]);
    } finally {
      await fixture.cleanup();
      await rm(temp, { recursive: true, force: true });
    }
  }, 180_000);

  test("successful precommit returns a validated private payload without commit, state, renderer, or asset effects", async () => {
    const fixture = await packagedFixture("explodex-plugin-precommit-success");
    try {
      const trace: string[] = [];
      const stagingParent = join(fixture.root, "private-staging-success");
      const result = await ingestRemotePluginArchive({
        archiveBytes: fixture.archiveBytes,
        expectedArchiveSha256: fixture.archiveSha256,
        expectedIdentity: {
          id: fixture.id,
          version: fixture.version,
          payloadSha256: fixture.payloadSha256,
        },
        stagingParent,
        adapters: tracingAdapters(trace),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(trace).toEqual(["extract"]);
      expect(result.payloadDirectory.startsWith(stagingParent)).toBe(true);
      expect((await privateEntries(stagingParent)).length).toBe(1);
      await result.cleanup();
      expect(await privateEntries(stagingParent)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("staging setup failures return a structured precommit failure", async () => {
    const fixture = await packagedFixture("explodex-plugin-precommit-staging-fault");
    try {
      const stagingParent = join(fixture.root, "not-a-directory");
      await writeFile(stagingParent, "occupied");
      const result = await ingestLocalPluginArchive({
        archivePath: fixture.archivePath,
        stagingParent,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected staging failure");
      expect(result.code).toBe("plugin.install.precommit-failed");
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("handled interruption before materialization removes staging", async () => {
    const fixture = await packagedFixture("explodex-plugin-precommit-interrupt");
    try {
      const controller = new AbortController();
      controller.abort();
      const trace: string[] = [];
      const stagingParent = join(fixture.root, "private-staging-abort");
      const result = await ingestLocalPluginArchive({
        archivePath: fixture.archivePath,
        stagingParent,
        signal: controller.signal,
        adapters: tracingAdapters(trace),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected interrupted result");
      expect(result.code).toBe("operation.interrupted");
      expect(trace).toEqual([]);
      expect(await privateEntries(stagingParent)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
