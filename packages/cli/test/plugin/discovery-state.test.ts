import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import {
  discoverInstalledPlugins,
  type PluginDiscoveryTrigger,
} from "../../src/plugin/discovery.ts";
import { installLocalPluginArchive } from "../../src/plugin/install.ts";
import {
  loadPluginsState,
  savePluginsStateAtomic,
} from "../../src/plugin/install-state.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function packagedFixture(name: string, marker: string) {
  const fixture = await createValidWorkspace({ name });
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() { console.log(${JSON.stringify(marker)}); } });
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

const TRIGGERS: readonly PluginDiscoveryTrigger[] = [
  "launch",
  "install",
  "refresh",
  "update-check",
];

describe("M3-F03 authoritative discovery and activation state", () => {
  test("missing and malformed state reconstruct valid artifacts disabled and pending", async () => {
    const first = await packagedFixture("explodex-plugin-discovery-first", "FIRST");
    const second = await packagedFixture("explodex-plugin-discovery-second", "SECOND");
    try {
      const home = join(first.fixture.root, "home");
      const installedFirst = await installLocalPluginArchive({
        archivePath: first.packaged.outputPath,
        explodexHome: home,
        now: () => "2026-07-27T04:00:00.000Z",
      });
      const installedSecond = await installLocalPluginArchive({
        archivePath: second.packaged.outputPath,
        explodexHome: home,
        now: () => "2026-07-27T04:01:00.000Z",
      });
      expect(installedFirst.ok).toBe(true);
      expect(installedSecond.ok).toBe(true);
      if (!installedFirst.ok || !installedSecond.ok) throw new Error("install failed");

      await rm(join(home, "state", "plugins.json"));
      const missing = await discoverInstalledPlugins({
        explodexHome: home,
        trigger: "refresh",
        now: () => "2026-07-27T04:02:00.000Z",
      });
      expect(missing.ok).toBe(true);
      if (!missing.ok) throw new Error(missing.message);
      expect(missing.recovery).toBe("missing");
      expect(missing.pending.map((item) => item.id)).toEqual([
        installedFirst.id,
        installedSecond.id,
      ].sort());
      expect(missing.pending.every((item) =>
        Object.keys(item).sort().join(",") ===
          "description,displayName,id,payloadSha256,sdkRange,sourceLabel,version"
      )).toBe(true);

      const reconstructed = await loadPluginsState({ explodexHome: home });
      expect(reconstructed.status).toBe("valid");
      if (reconstructed.status !== "valid") throw new Error("expected valid state");
      for (const record of Object.values(reconstructed.state.plugins)) {
        expect(record.enabled).toBeNull();
        expect(record.pendingReview).toHaveLength(record.installed.length);
      }

      const firstRecord = reconstructed.state.plugins[installedFirst.id];
      if (firstRecord === undefined) throw new Error("missing first record");
      firstRecord.enabled = {
        version: installedFirst.version,
        payloadSha256: installedFirst.payloadSha256,
      };
      firstRecord.pendingReview = [];
      await savePluginsStateAtomic({ explodexHome: home, state: reconstructed.state });
      await writeFile(
        join(home, "state", "plugins.json"),
        JSON.stringify({
          schemaVersion: 999,
          enabledPlugins: [installedFirst.id],
          rendererConsent: true,
        }),
      );

      const malformed = await discoverInstalledPlugins({
        explodexHome: home,
        trigger: "refresh",
        now: () => "2026-07-27T04:03:00.000Z",
      });
      expect(malformed.ok).toBe(true);
      if (!malformed.ok) throw new Error(malformed.message);
      expect(malformed.recovery).toBe("malformed");
      const safe = await loadPluginsState({ explodexHome: home });
      expect(safe.status).toBe("valid");
      if (safe.status !== "valid") throw new Error("expected valid state");
      expect(safe.state.plugins[installedFirst.id]?.enabled).toBeNull();
      expect(safe.state.plugins[installedFirst.id]?.pendingReview).toEqual([
        {
          version: installedFirst.version,
          payloadSha256: installedFirst.payloadSha256,
        },
      ]);
    } finally {
      await first.fixture.cleanup();
      await second.fixture.cleanup();
    }
  }, 300_000);

  test("all four boundaries reoffer exact pending payload identities", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-discovery-boundaries",
      "BOUNDARY",
    );
    try {
      const home = join(fixture.root, "home");
      const installed = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) throw new Error(installed.message);

      for (const trigger of TRIGGERS) {
        const result = await discoverInstalledPlugins({
          explodexHome: home,
          trigger,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        expect(result.trigger).toBe(trigger);
        expect(result.pending).toEqual([
          {
            id: installed.id,
            displayName: "Discovery Boundaries",
            description: "Explodex plugin discovery-boundaries.",
            version: installed.version,
            payloadSha256: installed.payloadSha256,
            sdkRange: installed.sdkRange,
            sourceLabel: `Local archive: ${basename(packaged.outputPath)}`,
          },
        ]);
        expect(result.rendererRequested).toBe(false);
        expect(result.sourceDelivered).toBe(false);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  test("invalid and temporary artifacts are diagnosed and omitted without changing unrelated authority", async () => {
    const valid = await packagedFixture("explodex-plugin-discovery-valid", "VALID");
    const invalid = await packagedFixture("explodex-plugin-discovery-invalid", "INVALID");
    try {
      const home = join(valid.fixture.root, "home");
      const installedValid = await installLocalPluginArchive({
        archivePath: valid.packaged.outputPath,
        explodexHome: home,
      });
      const installedInvalid = await installLocalPluginArchive({
        archivePath: invalid.packaged.outputPath,
        explodexHome: home,
      });
      expect(installedValid.ok).toBe(true);
      expect(installedInvalid.ok).toBe(true);
      if (!installedValid.ok || !installedInvalid.ok) throw new Error("install failed");

      const loaded = await loadPluginsState({ explodexHome: home });
      expect(loaded.status).toBe("valid");
      if (loaded.status !== "valid") throw new Error("expected valid state");
      const validRecord = loaded.state.plugins[installedValid.id];
      if (validRecord === undefined) throw new Error("missing valid record");
      validRecord.enabled = {
        version: installedValid.version,
        payloadSha256: installedValid.payloadSha256,
      };
      validRecord.pendingReview = [];
      await savePluginsStateAtomic({ explodexHome: home, state: loaded.state });

      await writeFile(join(installedInvalid.artifactPath, "index.js"), "tampered");
      const temporary = join(home, "plugins", installedValid.id, ".install-abandoned");
      await mkdir(temporary, { recursive: true });
      await writeFile(join(temporary, "plugin.json"), "{}");

      const result = await discoverInstalledPlugins({
        explodexHome: home,
        trigger: "refresh",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.invalid.some((item) =>
        item.id === installedInvalid.id && item.code === "plugin.artifact.invalid"
      )).toBe(true);
      expect(result.invalid.some((item) => item.path === temporary)).toBe(false);

      const next = await loadPluginsState({ explodexHome: home });
      expect(next.status).toBe("valid");
      if (next.status !== "valid") throw new Error("expected valid state");
      expect(next.state.plugins[installedInvalid.id]?.enabled).toBeNull();
      expect(next.state.plugins[installedInvalid.id]?.pendingReview).toEqual([
        {
          version: installedInvalid.version,
          payloadSha256: installedInvalid.payloadSha256,
        },
      ]);
      expect(result.pending.some((item) => item.id === installedInvalid.id)).toBe(false);
      expect(next.state.plugins[installedValid.id]?.enabled).toEqual({
        version: installedValid.version,
        payloadSha256: installedValid.payloadSha256,
      });
      expect((await stat(temporary)).isDirectory()).toBe(true);
    } finally {
      await valid.fixture.cleanup();
      await invalid.fixture.cleanup();
    }
  }, 240_000);

  test("ordinary state reads and filesystem copies do not discover", async () => {
    const { fixture, packaged } = await packagedFixture(
      "explodex-plugin-discovery-idle",
      "IDLE",
    );
    try {
      const home = join(fixture.root, "home");
      const installed = await installLocalPluginArchive({
        archivePath: packaged.outputPath,
        explodexHome: home,
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) throw new Error(installed.message);
      const statePath = join(home, "state", "plugins.json");
      const before = await readFile(statePath);
      const beforeStat = await stat(statePath);

      const sourceDir = installed.artifactPath;
      const copiedDir = join(home, "plugins", installed.id, `${basename(sourceDir)}-copy`);
      const { cp } = await import("node:fs/promises");
      await cp(sourceDir, copiedDir, { recursive: true });
      const loaded = await loadPluginsState({ explodexHome: home });
      expect(loaded.status).toBe("valid");
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(await readFile(statePath)).toEqual(before);
      expect((await stat(statePath)).mtimeMs).toBe(beforeStat.mtimeMs);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
