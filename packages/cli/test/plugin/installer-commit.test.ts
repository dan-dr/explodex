import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import {
  installLocalPluginArchive,
  type PluginInstallAdapters,
} from "../../src/plugin/install.ts";
import { loadPluginsState, savePluginsStateAtomic } from "../../src/plugin/install-state.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function packagedFixture(name: string, sourceMarker: string) {
  const fixture = await createValidWorkspace({ name });
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() { console.log(${JSON.stringify(sourceMarker)}); } });
`,
  );
  const built = await buildPluginWorkspace({ workspacePath: fixture.workspace, timeoutMs: 60_000 });
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

async function artifactDirectories(home: string, id: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "plugins", id))).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

describe("M3-F02 immutable local installation", () => {
  test("publishes immutable artifact before one private disabled state commit", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-install-atomic",
      "INSTALL_ATOMIC_SENTINEL",
    );
    try {
      const home = join(fixture.root, "home");
      const trace: string[] = [];
      const result = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
        now: () => "2026-07-27T00:00:00.000Z",
        adapters: {
          beforeCommit() {
            trace.push("artifact");
          },
          beforeStateMutation() {
            trace.push("state");
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(trace).toEqual(["artifact", "state"]);
      expect(result.outcome).toBe("installed");
      expect(result.enabled).toBe(false);
      expect(result.pendingReview).toBe(true);
      expect(result.source).toEqual({
        kind: "local",
        archiveName: basename(packaged.outputPath),
      });
      expect(result.sourceLabel).toBe(`Local archive: ${basename(packaged.outputPath)}`);
      expect(result.archiveSha256).toBe(packaged.archiveSha256);
      expect(result.payloadSha256).toBe(packaged.payloadSha256);

      const artifactStat = await stat(result.artifactPath);
      expect(artifactStat.isDirectory()).toBe(true);
      for (const relative of result.files) {
        expect(await readFile(join(result.artifactPath, relative))).toEqual(
          await readFile(join(fixture.workspace, "dist", relative)),
        );
      }

      const installedDirectoryName = basename(result.artifactPath);
      const provenance = JSON.parse(
        await readFile(join(home, "plugins", result.id, ".provenance", `${installedDirectoryName}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(provenance).toEqual({
        schemaVersion: 1,
        id: result.id,
        version: result.version,
        payloadSha256: result.payloadSha256,
        archiveSha256: result.archiveSha256,
        installedDirectoryName,
        source: result.source,
        installedAt: "2026-07-27T00:00:00.000Z",
      });

      const statePath = join(home, "state", "plugins.json");
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      const state = await loadPluginsState({ explodexHome: home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[result.id]).toEqual({
        installed: [
          {
            version: result.version,
            payloadSha256: result.payloadSha256,
            archiveSha256: result.archiveSha256,
            relativePath: result.relativePath,
            source: result.source,
            installedAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        enabled: null,
        pendingReview: [{ version: result.version, payloadSha256: result.payloadSha256 }],
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("exact reinstall is a no-op, alternate payload is distinct, and alternate archive bytes preserve provenance", async () => {
    const first = await packagedFixture("explodex-plugin-install-identity", "PAYLOAD_A");
    const second = await packagedFixture("explodex-plugin-install-identity", "PAYLOAD_B");
    try {
      const home = join(first.fixture.root, "home");
      const installed = await installLocalPluginArchive({
        archivePath: first.packaged.outputPath,
        explodexHome: home,
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) throw new Error(installed.message);

      const originalState = await readFile(join(home, "state", "plugins.json"));
      const originalArtifact = await readFile(join(installed.artifactPath, "index.js"));
      const exact = await installLocalPluginArchive({
        archivePath: first.packaged.outputPath,
        explodexHome: home,
      });
      expect(exact.ok).toBe(true);
      if (!exact.ok) throw new Error(exact.message);
      expect(exact.outcome).toBe("already-installed");
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(originalState);

      const alternateContainer = Buffer.from(await readFile(first.packaged.outputPath));
      alternateContainer[9] = alternateContainer[9] === 3 ? 0 : 3;
      const alternatePath = join(first.fixture.root, "same-payload-other-container.tar.gz");
      await writeFile(alternatePath, alternateContainer);
      const samePayload = await installLocalPluginArchive({
        archivePath: alternatePath,
        explodexHome: home,
      });
      expect(samePayload.ok).toBe(true);
      if (!samePayload.ok) throw new Error(samePayload.message);
      expect(samePayload.outcome).toBe("already-installed");
      expect(samePayload.archiveSha256).not.toBe(installed.archiveSha256);
      expect(samePayload.payloadSha256).toBe(installed.payloadSha256);
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(originalState);

      const distinct = await installLocalPluginArchive({
        archivePath: second.packaged.outputPath,
        explodexHome: home,
      });
      expect(distinct.ok).toBe(true);
      if (!distinct.ok) throw new Error(distinct.message);
      expect(distinct.outcome).toBe("installed");
      expect(distinct.version).toBe(installed.version);
      expect(distinct.payloadSha256).not.toBe(installed.payloadSha256);
      expect(distinct.artifactPath).not.toBe(installed.artifactPath);
      expect(await readFile(join(installed.artifactPath, "index.js"))).toEqual(originalArtifact);
      expect(await artifactDirectories(home, installed.id)).toHaveLength(2);

      const state = await loadPluginsState({ explodexHome: home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      const record = state.state.plugins[installed.id];
      expect(record?.installed).toHaveLength(2);
      expect(record?.pendingReview).toHaveLength(2);
      expect(record?.enabled).toBeNull();
    } finally {
      await first.fixture.cleanup();
      await second.fixture.cleanup();
    }
  }, 240_000);

  test("exact reinstall never changes pre-existing activation authority", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-install-authority",
      "AUTHORITY_SENTINEL",
    );
    try {
      const home = join(fixture.root, "home");
      const installed = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) throw new Error(installed.message);
      const stateResult = await loadPluginsState({ explodexHome: home });
      expect(stateResult.status).toBe("valid");
      if (stateResult.status !== "valid") throw new Error("expected valid state");
      const record = stateResult.state.plugins[installed.id];
      if (record === undefined) throw new Error("expected plugin record");
      record.enabled = { version: installed.version, payloadSha256: installed.payloadSha256 };
      record.pendingReview = [];
      await savePluginsStateAtomic({ explodexHome: home, state: stateResult.state });
      const before = await readFile(join(home, "state", "plugins.json"));

      const exact = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
      });
      expect(exact.ok).toBe(true);
      if (!exact.ok) throw new Error(exact.message);
      expect(exact.outcome).toBe("already-installed");
      expect(exact.activationChanged).toBe(false);
      expect(exact.enabled).toBe(true);
      expect(exact.pendingReview).toBe(false);
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("missing state rediscovers an existing exact artifact without trusting the incoming archive path", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-install-missing-state",
      "MISSING_STATE_SENTINEL",
    );
    try {
      const home = join(fixture.root, "home");
      const installed = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
        now: () => "2026-07-27T02:00:00.000Z",
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) throw new Error(installed.message);
      await rm(join(home, "state", "plugins.json"));
      const copiedPath = join(fixture.root, "copied-secret-token-name.tar.gz");
      await copyFile(packaged.outputPath, copiedPath);

      const recovered = await installLocalPluginArchive({
        archivePath: copiedPath,
        explodexHome: home,
        now: () => "2026-07-27T03:00:00.000Z",
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error(recovered.message);
      expect(recovered.outcome).toBe("rediscovered");
      expect(recovered.source).toEqual(installed.source);
      expect(recovered.archiveSha256).toBe(installed.archiveSha256);
      const state = await loadPluginsState({ explodexHome: home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[recovered.id]?.installed[0]?.source).toEqual(installed.source);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("provenance failure after artifact rename leaves a complete rediscoverable artifact", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-install-provenance-fault",
      "PROVENANCE_FAULT_SENTINEL",
    );
    try {
      const home = join(fixture.root, "home");
      const failed = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
        adapters: {
          async saveProvenance() {
            throw new Error("injected provenance fault");
          },
        },
      });
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("expected provenance failure");
      expect(failed.code).toBe("plugin.install.provenance-failed");
      expect(failed.artifactCommitted).toBe(true);
      expect(await artifactDirectories(home, packaged.report.id)).toHaveLength(1);
      await expect(readFile(join(home, "state", "plugins.json"))).rejects.toThrow();

      const recovered = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error(recovered.message);
      expect(recovered.outcome).toBe("rediscovered");
      expect(recovered.enabled).toBe(false);
      expect(recovered.pendingReview).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("post-rename state failure leaves a complete orphan that the next install rediscovers disabled", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-install-orphan",
      "ORPHAN_SENTINEL",
    );
    try {
      const home = join(fixture.root, "home");
      const adapters: PluginInstallAdapters = {
        async writeState() {
          throw new Error("injected state rename failure");
        },
      };
      const failed = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
        adapters,
      });
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("expected state failure");
      expect(failed.code).toBe("plugin.state.write-failed");
      expect(failed.artifactCommitted).toBe(true);
      expect(await artifactDirectories(home, packaged.report.id)).toHaveLength(1);
      await expect(readFile(join(home, "state", "plugins.json"))).rejects.toThrow();

      const recovered = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
        now: () => "2026-07-27T01:00:00.000Z",
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error(recovered.message);
      expect(recovered.outcome).toBe("rediscovered");
      expect(recovered.enabled).toBe(false);
      expect(recovered.pendingReview).toBe(true);
      expect(await artifactDirectories(home, recovered.id)).toHaveLength(1);

      const state = await loadPluginsState({ explodexHome: home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[recovered.id]?.enabled).toBeNull();
      expect(state.state.plugins[recovered.id]?.pendingReview).toEqual([
        { version: recovered.version, payloadSha256: recovered.payloadSha256 },
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
