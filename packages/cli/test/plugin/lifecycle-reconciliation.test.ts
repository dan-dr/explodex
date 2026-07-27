import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { installLocalPluginArchive } from "../../src/plugin/install.ts";
import {
  loadPluginsState,
  savePluginsStateAtomic,
} from "../../src/plugin/install-state.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import {
  revalidateEnabledPluginArtifacts,
} from "../../src/plugin/reconciliation.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function installFixture(options: {
  name: string;
  lifecycle?: "dynamic" | "renderer-start" | "app-start";
  sentinel?: string;
  home?: string;
  enable?: boolean;
}) {
  const fixture = await createValidWorkspace({ name: options.name });
  await writeWorkspaceFile(
    fixture.workspace,
    "explodex.config.ts",
    `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: "reconcile-v1",
  displayName: "Reconciliation fixture",
  description: "Exact enabled lifecycle reconciliation fixture.",
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
      options.sentinel ?? "__RECONCILIATION_A__",
    )}] = true;
  },
});
`,
  );
  await writeWorkspaceFile(
    fixture.workspace,
    "assets/notice.txt",
    options.sentinel ?? "RECONCILIATION_A",
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
  const home = options.home ?? join(fixture.root, "home");
  const installed = await installLocalPluginArchive({
    archivePath: packaged.outputPath,
    explodexHome: home,
    now: () => "2026-07-27T12:00:00.000Z",
  });
  if (!installed.ok) throw new Error(installed.message);
  if (options.enable !== false) {
    const loaded = await loadPluginsState({ explodexHome: home });
    if (loaded.status !== "valid") throw new Error("expected valid state");
    loaded.state.plugins[installed.id]!.enabled = {
      version: installed.version,
      payloadSha256: installed.payloadSha256,
    };
    loaded.state.plugins[installed.id]!.pendingReview = [];
    loaded.state.updatedAt = "2026-07-27T12:01:00.000Z";
    await savePluginsStateAtomic({ explodexHome: home, state: loaded.state });
  }
  return { fixture, home, installed };
}

describe("M3-F06 exact enabled lifecycle reconciliation", () => {
  test("revalidates exact enabled intent and captures one immutable dynamic snapshot", async () => {
    const fixture = await installFixture({
      name: "explodex-plugin-reconcile-exact",
    });
    try {
      const reads = new Map<string, number>();
      const result = await revalidateEnabledPluginArtifacts({
        explodexHome: fixture.home,
        adapters: {
          async readSnapshotFile(path) {
            reads.set(path, (reads.get(path) ?? 0) + 1);
            return readFile(path);
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.stateCommitted).toBe(false);
      expect(result.results).toEqual([{
        id: fixture.installed.id,
        previousIntent: {
          version: fixture.installed.version,
          payloadSha256: fixture.installed.payloadSha256,
        },
        currentIntent: {
          version: fixture.installed.version,
          payloadSha256: fixture.installed.payloadSha256,
        },
        stateCommitted: false,
        reviewStatus: "not-required",
        application: {
          status: "apply-pending",
          lifecycle: "dynamic",
          target: null,
          boundary: "none",
          appliedIdentity: null,
        },
      }]);
      expect(result.snapshots).toHaveLength(1);
      expect(
        new TextDecoder().decode(
          result.snapshots[0]!.read("assets/notice.txt"),
        ),
      ).toBe("RECONCILIATION_A");
      expect([...reads.values()].every((count) => count === 1)).toBe(true);
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("tampered enabled identity remains authoritative and no alternate payload is substituted", async () => {
    const fixture = await installFixture({
      name: "explodex-plugin-reconcile-exact-b",
    });
    const alternate = await installFixture({
      name: "explodex-plugin-reconcile-exact-b",
      sentinel: "__RECONCILIATION_ALTERNATE__",
      home: fixture.home,
      enable: false,
    });
    try {
      const stateBefore = await readFile(
        join(fixture.home, "state", "plugins.json"),
      );
      await writeFile(
        join(fixture.installed.artifactPath, "index.js"),
        "tampered enabled source",
      );
      const result = await revalidateEnabledPluginArtifacts({
        explodexHome: fixture.home,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.snapshots).toEqual([]);
      expect(result.results).toMatchObject([{
        id: fixture.installed.id,
        currentIntent: {
          version: fixture.installed.version,
          payloadSha256: fixture.installed.payloadSha256,
        },
        stateCommitted: false,
        application: {
          status: "blocked",
          target: null,
          appliedIdentity: null,
          error: {
            code: "plugin.artifact.invalid",
          },
        },
      }]);
      expect(
        await readFile(join(fixture.home, "state", "plugins.json")),
      ).toEqual(stateBefore);
      expect(
        JSON.stringify(result).includes("__RECONCILIATION_ALTERNATE__"),
      ).toBe(false);
    } finally {
      await alternate.fixture.cleanup();
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("restart lifecycles are revalidated but remain source-absent with exact boundaries", async () => {
    const renderer = await installFixture({
      name: "explodex-plugin-reconcile-renderer",
      lifecycle: "renderer-start",
      sentinel: "__RENDERER_BOUNDARY_SOURCE__",
    });
    const app = await installFixture({
      name: "explodex-plugin-reconcile-app",
      lifecycle: "app-start",
      sentinel: "__APP_BOUNDARY_SOURCE__",
    });
    try {
      const rendererResult = await revalidateEnabledPluginArtifacts({
        explodexHome: renderer.home,
      });
      const appResult = await revalidateEnabledPluginArtifacts({
        explodexHome: app.home,
      });
      expect(rendererResult).toMatchObject({
        ok: true,
        snapshots: [],
        results: [{
          application: {
            status: "boundary-required",
            lifecycle: "renderer-start",
            boundary: "renderer",
          },
        }],
      });
      expect(appResult).toMatchObject({
        ok: true,
        snapshots: [],
        results: [{
          application: {
            status: "boundary-required",
            lifecycle: "app-start",
            boundary: "app",
          },
        }],
      });
      const rendererBoundary = await revalidateEnabledPluginArtifacts({
        explodexHome: renderer.home,
        boundary: "renderer",
      });
      const appBoundary = await revalidateEnabledPluginArtifacts({
        explodexHome: app.home,
        boundary: "app",
      });
      expect(rendererBoundary).toMatchObject({
        ok: true,
        snapshots: [{ manifest: { lifecycle: "renderer-start" } }],
        results: [{
          application: {
            status: "apply-pending",
            lifecycle: "renderer-start",
          },
        }],
      });
      expect(appBoundary).toMatchObject({
        ok: true,
        snapshots: [{ manifest: { lifecycle: "app-start" } }],
        results: [{
          application: {
            status: "apply-pending",
            lifecycle: "app-start",
          },
        }],
      });
    } finally {
      await renderer.fixture.cleanup();
      await app.fixture.cleanup();
    }
  }, 180_000);
});
