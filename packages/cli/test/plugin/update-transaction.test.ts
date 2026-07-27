import { describe, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { discoverInstalledPlugins } from "../../src/plugin/discovery.ts";
import { installLocalPluginArchive } from "../../src/plugin/install.ts";
import {
  loadPluginsState,
  savePluginsStateAtomic,
} from "../../src/plugin/install-state.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import {
  applySelectedPluginUpdates,
  listPluginUpdateRecommendations,
  mergePluginUpdateApplicationResults,
  type PluginUpdateRecommendation,
} from "../../src/plugin/update-transaction.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function packagedIdentity(options: {
  name: string;
  version: string;
  marker: string;
  lifecycle?: "dynamic" | "renderer-start" | "app-start";
}) {
  const fixture = await createValidWorkspace({ name: options.name });
  await writeWorkspaceFile(
    fixture.workspace,
    "explodex.config.ts",
    `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: ${JSON.stringify(options.version)},
  displayName: ${JSON.stringify(options.name)},
  description: "Exact update fixture",
  assets: ["notice.txt"],
  lifecycle: ${JSON.stringify(options.lifecycle ?? "dynamic")},
});
`,
  );
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup() {
    (globalThis as unknown as Record<string, unknown>)[${JSON.stringify(
      options.marker,
    )}] = true;
  },
});
`,
  );
  await writeWorkspaceFile(
    fixture.workspace,
    "assets/notice.txt",
    options.marker,
  );
  const built = await buildPluginWorkspace({
    workspacePath: fixture.workspace,
    timeoutMs: 60_000,
  });
  if (!built.ok) throw new Error(built.message);
  const outputDir = join(fixture.root, "out");
  await mkdir(outputDir, { recursive: true });
  const packaged = await packagePluginWorkspace({
    workspacePath: fixture.workspace,
    outputDir,
    timeoutMs: 60_000,
  });
  if (!packaged.ok) throw new Error(packaged.message);
  return { fixture, packaged };
}

function recommendation(
  packaged: Awaited<ReturnType<typeof packagedIdentity>>["packaged"],
): PluginUpdateRecommendation {
  return {
    artifact: {
      id: packaged.report.id,
      displayName: packaged.report.displayName,
      description: packaged.report.description,
      version: packaged.report.version,
      payloadSha256: packaged.payloadSha256,
      sdkRange: packaged.report.sdkRange,
      sourceLabel: "GitHub release: owner/repo",
    },
    archiveSha256: packaged.archiveSha256,
    artifactUrl:
      `https://github.com/owner/repo/releases/download/update/${packaged.archiveFileName}`,
    source: {
      kind: "github",
      repositoryUrl: "https://github.com/owner/repo",
      artifactUrl:
        `https://github.com/owner/repo/releases/download/update/${packaged.archiveFileName}`,
      expectedArchiveSha256: packaged.archiveSha256,
    },
  };
}

async function install(
  packaged: Awaited<ReturnType<typeof packagedIdentity>>["packaged"],
  home: string,
) {
  const installed = await installLocalPluginArchive({
    archivePath: packaged.outputPath,
    explodexHome: home,
    now: () => "2026-07-27T16:00:00.000Z",
  });
  if (!installed.ok) throw new Error(installed.message);
  return installed;
}

async function setEnabled(home: string, id: string, identity: {
  version: string;
  payloadSha256: string;
} | null, pending?: Array<{ version: string; payloadSha256: string }>) {
  const loaded = await loadPluginsState({ explodexHome: home });
  if (loaded.status !== "valid") throw new Error("expected valid state");
  const record = loaded.state.plugins[id];
  if (record === undefined) throw new Error("expected plugin state record");
  record.enabled = identity === null ? null : { ...identity };
  if (pending !== undefined) record.pendingReview = pending.map((item) => ({ ...item }));
  loaded.state.updatedAt = "2026-07-27T16:01:00.000Z";
  await savePluginsStateAtomic({ explodexHome: home, state: loaded.state });
}

async function visibleArtifactDirectories(home: string, id: string) {
  try {
    return (await readdir(join(home, "plugins", id)))
      .filter((entry) => !entry.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

describe("M3-F07 exact selected plugin updates", () => {
  test("post-commit dynamic setup failure keeps replacement intent and prior live identity visible", () => {
    const mutations = mergePluginUpdateApplicationResults({
      target: null,
      mutations: [{
        id: "alpha",
        previousIntent: {
          version: "opaque-A",
          payloadSha256: "a".repeat(64),
        },
        currentIntent: {
          version: "opaque-B",
          payloadSha256: "b".repeat(64),
        },
        stateCommitted: true,
        reviewStatus: "approved",
        application: {
          status: "apply-pending",
          lifecycle: "dynamic",
          target: null,
          boundary: "none",
          appliedIdentity: null,
        },
      }, {
        id: "beta",
        previousIntent: {
          version: "opaque-A",
          payloadSha256: "c".repeat(64),
        },
        currentIntent: {
          version: "opaque-B",
          payloadSha256: "d".repeat(64),
        },
        stateCommitted: true,
        reviewStatus: "approved",
        application: {
          status: "apply-pending",
          lifecycle: "dynamic",
          target: null,
          boundary: "none",
          appliedIdentity: null,
        },
      }],
      applications: [{
        schemaVersion: 1,
        id: "alpha",
        version: "opaque-B",
        payloadSha256: "b".repeat(64),
        status: "failed",
        boundary: "none",
        setupCount: 0,
        previousAppliedIdentity: {
          id: "alpha",
          version: "opaque-A",
          payloadSha256: "a".repeat(64),
        },
        appliedIdentity: {
          id: "alpha",
          version: "opaque-A",
          payloadSha256: "a".repeat(64),
        },
        stage: "setup",
        possiblePartialEffects: true,
        error: {
          code: "plugin.application.setup-failed",
          message: "replacement setup failed",
        },
      }, {
        schemaVersion: 1,
        id: "beta",
        version: "opaque-B",
        payloadSha256: "d".repeat(64),
        status: "not-attempted",
        boundary: "none",
        setupCount: 0,
        previousAppliedIdentity: null,
        appliedIdentity: null,
        stage: "evaluation",
        possiblePartialEffects: false,
        error: {
          code: "plugin.application.runtime-unusable",
          message: "runtime unavailable",
        },
      }],
    });
    expect(mutations).toMatchObject([{
      currentIntent: {
        version: "opaque-B",
        payloadSha256: "b".repeat(64),
      },
      stateCommitted: true,
      application: {
        status: "failed",
        appliedIdentity: {
          version: "opaque-A",
          payloadSha256: "a".repeat(64),
        },
        error: {
          stage: "setup",
          possiblePartialEffects: true,
        },
      },
    }, {
      currentIntent: {
        version: "opaque-B",
        payloadSha256: "d".repeat(64),
      },
      stateCommitted: true,
      application: {
        status: "not-attempted",
        appliedIdentity: null,
      },
    }]);
  });

  test("listing is metadata-only and selected enabled updates preserve alternates", async () => {
    const a = await packagedIdentity({
      name: "explodex-plugin-update-matrix",
      version: "opaque-A",
      marker: "__UPDATE_A__",
    });
    const b = await packagedIdentity({
      name: "explodex-plugin-update-matrix",
      version: "opaque-B",
      marker: "__UPDATE_B__",
    });
    const c = await packagedIdentity({
      name: "explodex-plugin-update-matrix",
      version: "opaque-C",
      marker: "__UPDATE_C__",
    });
    try {
      const home = join(a.fixture.root, "home");
      const installedA = await install(a.packaged, home);
      const installedC = await install(c.packaged, home);
      await setEnabled(home, installedA.id, {
        version: installedA.version,
        payloadSha256: installedA.payloadSha256,
      }, [{
        version: installedC.version,
        payloadSha256: installedC.payloadSha256,
      }]);
      const beforeState = await readFile(join(home, "state", "plugins.json"));
      const beforeTree = await visibleArtifactDirectories(home, installedA.id);
      const unselectedBytes = await readFile(
        join(installedC.artifactPath, "index.js"),
      );
      const unselectedRecommendation = recommendation(b.packaged);
      unselectedRecommendation.artifact = {
        ...unselectedRecommendation.artifact,
        id: "unselected-plugin",
        displayName: "Unselected plugin",
      };
      const recommendations = [
        recommendation(b.packaged),
        unselectedRecommendation,
      ];
      let fetches = 0;
      const listed = await listPluginUpdateRecommendations({
        explodexHome: home,
        recommendations,
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error(listed.message);
      expect(listed.recommendations).toEqual([{
        ...recommendation(b.packaged).artifact,
        disposition: "will-replace-enabled",
        downloadRequired: true,
      }]);
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(
        beforeState,
      );
      expect(await visibleArtifactDirectories(home, installedA.id)).toEqual(
        beforeTree,
      );

      let staleFetches = 0;
      const stale = await applySelectedPluginUpdates({
        explodexHome: home,
        recommendations,
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        expectedEnabledPluginIdentities: [],
        async fetchArchive() {
          staleFetches += 1;
          return readFile(b.packaged.outputPath);
        },
      });
      expect(stale).toMatchObject({
        ok: false,
        code: "plugin.update.stale-selection",
        stateCommitted: false,
        downloaded: [],
      });
      expect(staleFetches).toBe(0);

      const applied = await applySelectedPluginUpdates({
        explodexHome: home,
        recommendations,
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        expectedEnabledPluginIdentities: [{
          id: installedA.id,
          version: installedA.version,
          payloadSha256: installedA.payloadSha256,
        }],
        now: () => "2026-07-27T16:02:00.000Z",
        async fetchArchive(candidate) {
          fetches += 1;
          expect(candidate.artifactUrl).toBe(
            recommendation(b.packaged).artifactUrl,
          );
          return readFile(b.packaged.outputPath);
        },
        async afterStateCommit({ snapshots }) {
          expect(snapshots).toHaveLength(1);
          const committed = await loadPluginsState({ explodexHome: home });
          if (committed.status !== "valid") {
            throw new Error("expected committed update state");
          }
          expect(committed.state.plugins[installedA.id]!.enabled).toEqual({
            version: b.packaged.report.version,
            payloadSha256: b.packaged.payloadSha256,
          });
        },
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) throw new Error(applied.message);
      expect(fetches).toBe(1);
      expect(applied.snapshots).toHaveLength(1);
      expect(new TextDecoder().decode(
        applied.snapshots[0]!.read("assets/notice.txt"),
      )).toBe("__UPDATE_B__");
      expect(applied.mutations).toMatchObject([{
        id: installedA.id,
        previousIntent: {
          version: installedA.version,
          payloadSha256: installedA.payloadSha256,
        },
        currentIntent: {
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        },
        stateCommitted: true,
        reviewStatus: "approved",
        application: {
          status: "apply-pending",
          lifecycle: "dynamic",
          boundary: "none",
        },
      }]);

      const state = await loadPluginsState({ explodexHome: home });
      if (state.status !== "valid") throw new Error("expected valid state");
      const record = state.state.plugins[installedA.id]!;
      expect(record.installed.map((item) => ({
        version: item.version,
        payloadSha256: item.payloadSha256,
      }))).toEqual([
        {
          version: installedA.version,
          payloadSha256: installedA.payloadSha256,
        },
        {
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        },
        {
          version: installedC.version,
          payloadSha256: installedC.payloadSha256,
        },
      ]);
      expect(record.enabled).toEqual({
        version: b.packaged.report.version,
        payloadSha256: b.packaged.payloadSha256,
      });
      expect(record.pendingReview).toEqual([{
        version: installedC.version,
        payloadSha256: installedC.payloadSha256,
      }]);
      expect((await stat(installedA.artifactPath)).isDirectory()).toBe(true);
      expect(await visibleArtifactDirectories(home, installedA.id)).toHaveLength(3);
      expect(await readFile(join(installedC.artifactPath, "index.js"))).toEqual(
        unselectedBytes,
      );
    } finally {
      await a.fixture.cleanup();
      await b.fixture.cleanup();
      await c.fixture.cleanup();
    }
  }, 300_000);

  test("disabled, pending, and already-installed transitions remain disabled and deduplicated", async () => {
    const a = await packagedIdentity({
      name: "explodex-plugin-update-disabled",
      version: "opaque-A",
      marker: "__DISABLED_A__",
    });
    const b = await packagedIdentity({
      name: "explodex-plugin-update-disabled",
      version: "opaque-B",
      marker: "__DISABLED_B__",
      lifecycle: "renderer-start",
    });
    try {
      const disabledHome = join(a.fixture.root, "disabled-home");
      const installedA = await install(a.packaged, disabledHome);
      await setEnabled(disabledHome, installedA.id, null, []);
      const disabled = await applySelectedPluginUpdates({
        explodexHome: disabledHome,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        fetchArchive: () => readFile(b.packaged.outputPath),
      });
      expect(disabled).toMatchObject({
        ok: true,
        snapshots: [],
        mutations: [{
          currentIntent: null,
          reviewStatus: "pending",
          application: {
            status: "not-applicable",
            lifecycle: "renderer-start",
            boundary: "none",
          },
        }],
      });
      let state = await loadPluginsState({ explodexHome: disabledHome });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[installedA.id]?.pendingReview).toEqual([{
        version: b.packaged.report.version,
        payloadSha256: b.packaged.payloadSha256,
      }]);

      const pendingHome = join(a.fixture.root, "pending-home");
      const pendingA = await install(a.packaged, pendingHome);
      const pending = await applySelectedPluginUpdates({
        explodexHome: pendingHome,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        fetchArchive: () => readFile(b.packaged.outputPath),
      });
      expect(pending.ok).toBe(true);
      state = await loadPluginsState({ explodexHome: pendingHome });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[pendingA.id]?.enabled).toBeNull();
      expect(state.state.plugins[pendingA.id]?.pendingReview).toEqual([
        {
          version: pendingA.version,
          payloadSha256: pendingA.payloadSha256,
        },
        {
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        },
      ]);

      let unexpectedFetches = 0;
      const already = await applySelectedPluginUpdates({
        explodexHome: pendingHome,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        async fetchArchive() {
          unexpectedFetches += 1;
          throw new Error("already installed updates must not redownload");
        },
      });
      expect(already.ok).toBe(true);
      expect(unexpectedFetches).toBe(0);
      state = await loadPluginsState({ explodexHome: pendingHome });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[pendingA.id]?.installed).toHaveLength(2);
      expect(state.state.plugins[pendingA.id]?.pendingReview).toHaveLength(2);

      await setEnabled(pendingHome, pendingA.id, {
        version: pendingA.version,
        payloadSha256: pendingA.payloadSha256,
      }, [
        {
          version: pendingA.version,
          payloadSha256: pendingA.payloadSha256,
        },
        {
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        },
      ]);
      const installedReplacement = await applySelectedPluginUpdates({
        explodexHome: pendingHome,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        async fetchArchive() {
          throw new Error("installed replacement must not redownload");
        },
      });
      expect(installedReplacement.ok).toBe(true);
      state = await loadPluginsState({ explodexHome: pendingHome });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[pendingA.id]?.enabled).toEqual({
        version: b.packaged.report.version,
        payloadSha256: b.packaged.payloadSha256,
      });
      expect(state.state.plugins[pendingA.id]?.pendingReview).toEqual([{
        version: pendingA.version,
        payloadSha256: pendingA.payloadSha256,
      }]);
    } finally {
      await a.fixture.cleanup();
      await b.fixture.cleanup();
    }
  }, 300_000);

  test("cancellation, digest failure, and post-rename state failure leave only safe old-or-orphan state", async () => {
    const a = await packagedIdentity({
      name: "explodex-plugin-update-failure",
      version: "opaque-A",
      marker: "__FAILURE_A__",
    });
    const b = await packagedIdentity({
      name: "explodex-plugin-update-failure",
      version: "opaque-B",
      marker: "__FAILURE_B__",
    });
    try {
      const home = join(a.fixture.root, "home");
      const installedA = await install(a.packaged, home);
      await setEnabled(home, installedA.id, {
        version: installedA.version,
        payloadSha256: installedA.payloadSha256,
      }, []);
      const before = await readFile(join(home, "state", "plugins.json"));
      const aborted = new AbortController();
      aborted.abort();
      const interrupted = await applySelectedPluginUpdates({
        explodexHome: home,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        signal: aborted.signal,
        fetchArchive: () => readFile(b.packaged.outputPath),
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "operation.interrupted",
        stateCommitted: false,
        artifactCommitted: false,
      });
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(before);

      const wrongDigest = recommendation(b.packaged);
      wrongDigest.archiveSha256 = "0".repeat(64);
      if (wrongDigest.source.kind !== "github") {
        throw new Error("expected GitHub update recommendation");
      }
      wrongDigest.source = {
        ...wrongDigest.source,
        expectedArchiveSha256: "0".repeat(64),
      };
      const rejected = await applySelectedPluginUpdates({
        explodexHome: home,
        recommendations: [wrongDigest],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        fetchArchive: () => readFile(b.packaged.outputPath),
      });
      expect(rejected).toMatchObject({
        ok: false,
        code: "plugin.install.archive-digest-mismatch",
        stateCommitted: false,
        artifactCommitted: false,
      });
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(before);
      expect(await visibleArtifactDirectories(home, installedA.id)).toHaveLength(1);

      const orphaned = await applySelectedPluginUpdates({
        explodexHome: home,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        fetchArchive: () => readFile(b.packaged.outputPath),
        adapters: {
          async writeState() {
            throw new Error("injected update state failure");
          },
        },
      });
      expect(orphaned).toMatchObject({
        ok: false,
        code: "plugin.update.state-write-failed",
        stateCommitted: false,
        artifactCommitted: true,
      });
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(before);
      expect(await visibleArtifactDirectories(home, installedA.id)).toHaveLength(2);

      await rm(join(home, "state", "plugins.json"));
      const recovered = await discoverInstalledPlugins({
        explodexHome: home,
        trigger: "update-check",
        now: () => "2026-07-27T16:03:00.000Z",
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error(recovered.message);
      const state = await loadPluginsState({ explodexHome: home });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[installedA.id]?.enabled).toBeNull();
      expect(state.state.plugins[installedA.id]?.pendingReview).toHaveLength(2);

      const durabilityHome = join(a.fixture.root, "durability-home");
      const durabilityA = await install(a.packaged, durabilityHome);
      await setEnabled(durabilityHome, durabilityA.id, {
        version: durabilityA.version,
        payloadSha256: durabilityA.payloadSha256,
      }, []);
      const committedFailure = await applySelectedPluginUpdates({
        explodexHome: durabilityHome,
        recommendations: [recommendation(b.packaged)],
        selected: [{
          id: b.packaged.report.id,
          version: b.packaged.report.version,
          payloadSha256: b.packaged.payloadSha256,
        }],
        fetchArchive: () => readFile(b.packaged.outputPath),
        adapters: {
          writeState(options) {
            return savePluginsStateAtomic({
              ...options,
              adapters: {
                beforeDirectorySync() {
                  throw new Error("injected post-rename durability failure");
                },
              },
            });
          },
        },
      });
      expect(committedFailure).toMatchObject({
        ok: false,
        code: "plugin.update.state-write-failed",
        stateCommitted: true,
        authorityChanged: true,
        artifactCommitted: true,
        mutations: [{
          currentIntent: {
            version: b.packaged.report.version,
            payloadSha256: b.packaged.payloadSha256,
          },
          stateCommitted: true,
          application: {
            status: "apply-pending",
          },
        }],
      });
      const committedState = await loadPluginsState({
        explodexHome: durabilityHome,
      });
      if (committedState.status !== "valid") {
        throw new Error("expected committed state");
      }
      expect(committedState.state.plugins[durabilityA.id]?.enabled).toEqual({
        version: b.packaged.report.version,
        payloadSha256: b.packaged.payloadSha256,
      });
    } finally {
      await a.fixture.cleanup();
      await b.fixture.cleanup();
    }
  }, 300_000);
});
