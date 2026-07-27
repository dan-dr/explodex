import { describe, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  readdir,
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
import {
  disableInstalledPlugin,
  removeInstalledPlugin,
} from "../../src/plugin/mutation-transaction.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import { revalidateEnabledPluginArtifacts } from "../../src/plugin/reconciliation.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function packagedIdentity(options: {
  name: string;
  version: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  marker: string;
}) {
  const fixture = await createValidWorkspace({ name: options.name });
  await writeWorkspaceFile(
    fixture.workspace,
    "explodex.config.ts",
    `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: ${JSON.stringify(options.version)},
  displayName: ${JSON.stringify(options.name)},
  description: "M3-F08 lifecycle mutation fixture",
  assets: ["notice.txt"],
  lifecycle: ${JSON.stringify(options.lifecycle)},
});
`,
  );
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup() {
    (globalThis as unknown as Record<string, unknown>)[${JSON.stringify(options.marker)}] = true;
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

async function install(
  packaged: Awaited<ReturnType<typeof packagedIdentity>>["packaged"],
  home: string,
) {
  const installed = await installLocalPluginArchive({
    archivePath: packaged.outputPath,
    explodexHome: home,
    now: () => "2026-07-27T18:00:00.000Z",
  });
  if (!installed.ok) throw new Error(installed.message);
  return installed;
}

async function enable(home: string, id: string, identity: {
  version: string;
  payloadSha256: string;
}, pending: Array<{ version: string; payloadSha256: string }> = []) {
  const loaded = await loadPluginsState({ explodexHome: home });
  if (loaded.status !== "valid") throw new Error("expected valid plugin state");
  const record = loaded.state.plugins[id];
  if (record === undefined) throw new Error("expected plugin record");
  record.enabled = { ...identity };
  record.pendingReview = pending.map((candidate) => ({ ...candidate }));
  loaded.state.updatedAt = "2026-07-27T18:01:00.000Z";
  await savePluginsStateAtomic({ explodexHome: home, state: loaded.state });
}

async function visibleDirectories(home: string, id: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "plugins", id)))
      .filter((entry) => !entry.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

describe("M3-F08 exact disable and removal transactions", () => {
  test("disable commits authority before optional teardown and reports all lifecycle boundaries", async () => {
    const fixtures = await Promise.all([
      packagedIdentity({
        name: "explodex-plugin-disable-dynamic",
        version: "dynamic-v1",
        lifecycle: "dynamic",
        marker: "__DISABLE_DYNAMIC__",
      }),
      packagedIdentity({
        name: "explodex-plugin-disable-renderer",
        version: "renderer-v1",
        lifecycle: "renderer-start",
        marker: "__DISABLE_RENDERER__",
      }),
      packagedIdentity({
        name: "explodex-plugin-disable-app",
        version: "app-v1",
        lifecycle: "app-start",
        marker: "__DISABLE_APP__",
      }),
    ]);
    try {
      for (const entry of fixtures) {
        const home = join(entry.fixture.root, "home");
        const installed = await install(entry.packaged, home);
        await enable(home, installed.id, {
          version: installed.version,
          payloadSha256: installed.payloadSha256,
        });
        const trace: string[] = [];
        const result = await disableInstalledPlugin({
          explodexHome: home,
          id: installed.id,
          now: () => "2026-07-27T18:02:00.000Z",
          async teardown(request) {
            trace.push(`teardown:${request.id}`);
            const state = await loadPluginsState({ explodexHome: home });
            expect(state.status).toBe("valid");
            if (state.status !== "valid") throw new Error("expected state");
            expect(state.state.plugins[installed.id]?.enabled).toBeNull();
            return {
              status: "applied",
              target: null,
              appliedIdentity: null,
              message: "Exact dynamic teardown completed.",
            };
          },
          adapters: {
            async writeState(options) {
              trace.push("state");
              await savePluginsStateAtomic(options);
            },
          },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        expect(result.mutation.stateCommitted).toBe(true);
        expect(result.mutation.currentIntent).toBeNull();
        expect(result.mutation.application.lifecycle).toBe(
          entry.packaged.report.lifecycle,
        );
        if (entry.packaged.report.lifecycle === "dynamic") {
          expect(trace).toEqual(["state", `teardown:${installed.id}`]);
          expect(result.mutation.application.status).toBe("applied");
          expect(result.mutation.application.boundary).toBe("none");
        } else {
          expect(trace).toEqual(["state"]);
          expect(result.mutation.application.status).toBe(
            "boundary-required",
          );
          expect(result.mutation.application.boundary).toBe(
            entry.packaged.report.lifecycle === "renderer-start"
              ? "renderer"
              : "app",
          );
        }
        expect(await stat(installed.artifactPath)).toBeDefined();
        const reconciled = await revalidateEnabledPluginArtifacts({
          explodexHome: home,
        });
        expect(reconciled).toMatchObject({
          ok: true,
          results: [],
          snapshots: [],
        });
      }
    } finally {
      for (const entry of fixtures) await entry.fixture.cleanup();
    }
  }, 300_000);

  test("ambiguous ID-only removal is inert and exact deletion failure leaves only an orphan", async () => {
    const a = await packagedIdentity({
      name: "explodex-plugin-remove-ambiguous",
      version: "opaque-A",
      lifecycle: "dynamic",
      marker: "__REMOVE_A__",
    });
    const b = await packagedIdentity({
      name: "explodex-plugin-remove-ambiguous",
      version: "opaque-B",
      lifecycle: "dynamic",
      marker: "__REMOVE_B__",
    });
    const other = await packagedIdentity({
      name: "explodex-plugin-remove-unrelated",
      version: "other-v1",
      lifecycle: "dynamic",
      marker: "__REMOVE_OTHER__",
    });
    try {
      const home = join(a.fixture.root, "home");
      const installedA = await install(a.packaged, home);
      const installedB = await install(b.packaged, home);
      const installedOther = await install(other.packaged, home);
      await enable(home, installedA.id, {
        version: installedA.version,
        payloadSha256: installedA.payloadSha256,
      }, [{
        version: installedB.version,
        payloadSha256: installedB.payloadSha256,
      }]);
      await enable(home, installedOther.id, {
        version: installedOther.version,
        payloadSha256: installedOther.payloadSha256,
      });
      const before = await readFile(join(home, "state", "plugins.json"));
      const ambiguous = await removeInstalledPlugin({
        explodexHome: home,
        id: installedA.id,
      });
      expect(ambiguous).toMatchObject({
        ok: false,
        code: "plugin.remove.exact-selection-required",
        stateCommitted: false,
        artifactDeleted: false,
      });
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(before);
      expect(await visibleDirectories(home, installedA.id)).toHaveLength(2);

      const trace: string[] = [];
      const removed = await removeInstalledPlugin({
        explodexHome: home,
        id: installedA.id,
        identity: {
          version: installedA.version,
          payloadSha256: installedA.payloadSha256,
        },
        now: () => "2026-07-27T18:03:00.000Z",
        adapters: {
          async writeState(options) {
            trace.push("state");
            await savePluginsStateAtomic(options);
          },
          async deleteArtifact(path) {
            trace.push(`delete:${path}`);
            throw new Error("injected immutable-directory deletion failure");
          },
        },
      });
      expect(removed).toMatchObject({
        ok: false,
        code: "plugin.remove.artifact-delete-failed",
        stateCommitted: true,
        authorityChanged: true,
        artifactDeleted: false,
        orphanedDirectory: installedA.artifactPath,
        mutation: {
          currentIntent: null,
          stateCommitted: true,
        },
      });
      expect(trace[0]).toBe("state");
      expect(trace[1]).toBe(`delete:${installedA.artifactPath}`);
      const state = await loadPluginsState({ explodexHome: home });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[installedA.id]?.installed).toEqual([
        expect.objectContaining({
          version: installedB.version,
          payloadSha256: installedB.payloadSha256,
        }),
      ]);
      expect(state.state.plugins[installedA.id]?.enabled).toBeNull();
      expect(state.state.plugins[installedA.id]?.pendingReview).toEqual([{
        version: installedB.version,
        payloadSha256: installedB.payloadSha256,
      }]);
      expect(state.state.plugins[installedOther.id]?.enabled).toEqual({
        version: installedOther.version,
        payloadSha256: installedOther.payloadSha256,
      });
      expect((await stat(installedA.artifactPath)).isDirectory()).toBe(true);
    } finally {
      await a.fixture.cleanup();
      await b.fixture.cleanup();
      await other.fixture.cleanup();
    }
  }, 300_000);

  test("successful exact removal followed by identical reinstall requires a new review", async () => {
    const fixture = await packagedIdentity({
      name: "explodex-plugin-remove-reinstall",
      version: "same-v1",
      lifecycle: "renderer-start",
      marker: "__REMOVE_REINSTALL__",
    });
    try {
      const home = join(fixture.fixture.root, "home");
      const installed = await install(fixture.packaged, home);
      await enable(home, installed.id, {
        version: installed.version,
        payloadSha256: installed.payloadSha256,
      });
      const removed = await removeInstalledPlugin({
        explodexHome: home,
        id: installed.id,
        now: () => "2026-07-27T18:04:00.000Z",
      });
      expect(removed).toMatchObject({
        ok: true,
        artifactDeleted: true,
        mutation: {
          currentIntent: null,
          application: {
            status: "boundary-required",
            lifecycle: "renderer-start",
            boundary: "renderer",
          },
        },
      });
      expect(await visibleDirectories(home, installed.id)).toEqual([]);

      const reinstalled = await install(fixture.packaged, home);
      expect(reinstalled.payloadSha256).toBe(installed.payloadSha256);
      const state = await loadPluginsState({ explodexHome: home });
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[installed.id]?.enabled).toBeNull();
      expect(state.state.plugins[installed.id]?.pendingReview).toEqual([{
        version: installed.version,
        payloadSha256: installed.payloadSha256,
      }]);

      const copiedState = await readFile(join(home, "state", "plugins.json"));
      await discoverInstalledPlugins({
        explodexHome: home,
        trigger: "refresh",
      });
      expect(await readFile(join(home, "state", "plugins.json"))).toEqual(
        copiedState,
      );
      const reconciled = await revalidateEnabledPluginArtifacts({
        explodexHome: home,
      });
      expect(reconciled).toMatchObject({
        ok: true,
        results: [],
        snapshots: [],
      });
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 240_000);
});
