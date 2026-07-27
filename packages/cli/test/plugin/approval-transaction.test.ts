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
  approveSelectedPluginArtifacts,
  type PluginApprovalAdapters,
} from "../../src/plugin/approval-transaction.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function installedFixture(name: string) {
  const fixture = await createValidWorkspace({ name });
  await writeWorkspaceFile(
    fixture.workspace,
    "explodex.config.ts",
    `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: "approval-v1",
  displayName: "Approval fixture",
  description: "Composed approval transaction fixture.",
  assets: ["notice.txt", "nested/data.bin"],
  lifecycle: "dynamic",
});
`,
  );
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  async setup(api) {
    const notice = await api.assets.open("notice.txt");
    (globalThis as unknown as Record<string, unknown>)["__approvalFixture"] =
      await notice.text();
  },
});
`,
  );
  await writeWorkspaceFile(fixture.workspace, "assets/notice.txt", "SNAPSHOT_A");
  await writeWorkspaceFile(
    fixture.workspace,
    "assets/nested/data.bin",
    String.fromCharCode(0, 1, 2, 255),
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
  expect(packaged.ok).toBe(true);
  if (!packaged.ok) throw new Error(packaged.message);
  const home = join(fixture.root, "home");
  const installed = await installLocalPluginArchive({
    archivePath: packaged.outputPath,
    explodexHome: home,
    now: () => "2026-07-27T10:00:00.000Z",
  });
  expect(installed.ok).toBe(true);
  if (!installed.ok) throw new Error(installed.message);
  return { fixture, home, installed };
}

function selection(fixture: Awaited<ReturnType<typeof installedFixture>>) {
  return [{
    id: fixture.installed.id,
    version: fixture.installed.version,
    payloadSha256: fixture.installed.payloadSha256,
  }];
}

describe("M3-F05 composed approval transaction", () => {
  test("revalidates selected identity, commits state, then captures every payload file once", async () => {
    const fixture = await installedFixture("explodex-plugin-approval-order");
    try {
      const trace: string[] = [];
      const reads = new Map<string, number>();
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
        now: () => "2026-07-27T10:01:00.000Z",
        adapters: {
          beforeSelectedRevalidation() {
            trace.push("revalidate");
          },
          beforeStateCommit() {
            trace.push("commit");
          },
          afterStateCommitBeforeSnapshot() {
            trace.push("snapshot");
          },
          async readSnapshotFile(path) {
            reads.set(path, (reads.get(path) ?? 0) + 1);
            return readFile(path);
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(trace).toEqual(["revalidate", "commit", "snapshot"]);
      expect(result.stateCommitted).toBe(true);
      expect(result.authorityChanged).toBe(true);
      expect(result.snapshots).toHaveLength(1);
      const snapshot = result.snapshots[0]!;
      expect(new TextDecoder().decode(snapshot.read("assets/notice.txt"))).toBe(
        "SNAPSHOT_A",
      );
      expect([...reads.values()].every((count) => count === 1)).toBe(true);
      expect([...reads.keys()].some((path) => path.endsWith("/index.js"))).toBe(
        true,
      );
      expect(
        [...reads.keys()].some((path) =>
          path.endsWith("/assets/nested/data.bin")
        ),
      ).toBe(true);

      const state = await loadPluginsState({ explodexHome: fixture.home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[fixture.installed.id]?.enabled).toEqual({
        version: fixture.installed.version,
        payloadSha256: fixture.installed.payloadSha256,
      });
      expect(
        state.state.plugins[fixture.installed.id]?.pendingReview,
      ).toEqual([]);
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("tamper before inert revalidation rejects the full selection without authority", async () => {
    const fixture = await installedFixture("explodex-plugin-approval-tamper");
    try {
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
        adapters: {
          async beforeSelectedRevalidation() {
            await writeFile(
              join(fixture.installed.artifactPath, "index.js"),
              "tampered",
            );
          },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected revalidation failure");
      expect(result.stateCommitted).toBe(false);
      expect(result.authorityChanged).toBe(false);
      const state = await loadPluginsState({ explodexHome: fixture.home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[fixture.installed.id]?.enabled).toBeNull();
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("state write failure opens no snapshot bytes and preserves prior authority", async () => {
    const fixture = await installedFixture("explodex-plugin-approval-state-fault");
    try {
      let snapshotReads = 0;
      const adapters: PluginApprovalAdapters = {
        async writeState() {
          throw new Error("injected approval state failure");
        },
        async readSnapshotFile(path) {
          snapshotReads += 1;
          return readFile(path);
        },
      };
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
        adapters,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected state failure");
      expect(result.code).toBe("plugin.approval.state-write-failed");
      expect(result.stateCommitted).toBe(false);
      expect(result.authorityChanged).toBe(false);
      expect(snapshotReads).toBe(0);
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("post-rename state durability failure reports committed authority truthfully", async () => {
    const fixture = await installedFixture(
      "explodex-plugin-approval-rename",
    );
    try {
      let snapshotReads = 0;
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
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
          async readSnapshotFile(path) {
            snapshotReads += 1;
            return readFile(path);
          },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected durability failure");
      expect(result.code).toBe("plugin.approval.state-write-failed");
      expect(result.stateCommitted).toBe(true);
      expect(result.authorityChanged).toBe(true);
      expect(result.snapshots).toEqual([]);
      expect(snapshotReads).toBe(0);
      const state = await loadPluginsState({ explodexHome: fixture.home });
      expect(state.status).toBe("valid");
      if (state.status !== "valid") throw new Error("expected valid state");
      expect(state.state.plugins[fixture.installed.id]?.enabled).toEqual({
        version: fixture.installed.version,
        payloadSha256: fixture.installed.payloadSha256,
      });
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("pre-snapshot substitution reports committed intent and evaluates no later disk bytes", async () => {
    const fixture = await installedFixture("explodex-plugin-approval-pre-snapshot");
    try {
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
        adapters: {
          async afterStateCommitBeforeSnapshot() {
            await writeFile(
              join(fixture.installed.artifactPath, "assets/notice.txt"),
              "SUBSTITUTED_BEFORE_SNAPSHOT",
            );
          },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected snapshot failure");
      expect(result.code).toBe("plugin.approval.snapshot-invalid");
      expect(result.stateCommitted).toBe(true);
      expect(result.authorityChanged).toBe(true);
      expect(result.snapshots).toEqual([]);
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("post-snapshot disk replacement cannot change the accepted bytes", async () => {
    const fixture = await installedFixture("explodex-plugin-approval-post-snapshot");
    try {
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
        adapters: {
          async afterSnapshot() {
            await writeFile(
              join(fixture.installed.artifactPath, "assets/notice.txt"),
              "SUBSTITUTED_AFTER_SNAPSHOT",
            );
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(
        new TextDecoder().decode(
          result.snapshots[0]!.read("assets/notice.txt"),
        ),
      ).toBe("SNAPSHOT_A");
      expect(
        await readFile(
          join(fixture.installed.artifactPath, "assets/notice.txt"),
          "utf8",
        ),
      ).toBe("SUBSTITUTED_AFTER_SNAPSHOT");
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("interruption after snapshot preserves committed intent and delivers no snapshot", async () => {
    const fixture = await installedFixture(
      "explodex-plugin-approval-interrupt",
    );
    try {
      const abort = new AbortController();
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: selection(fixture),
        signal: abort.signal,
        adapters: {
          afterSnapshot() {
            abort.abort();
          },
        },
      });
      expect(result).toMatchObject({
        ok: false,
        code: "operation.interrupted",
        stateCommitted: true,
        authorityChanged: true,
        snapshots: [],
      });
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);

  test("empty selection is a successful no-op without taking activation authority", async () => {
    const fixture = await installedFixture("explodex-plugin-approval-empty");
    try {
      const before = await readFile(
        join(fixture.home, "state", "plugins.json"),
      );
      const result = await approveSelectedPluginArtifacts({
        explodexHome: fixture.home,
        selected: [],
      });
      expect(result).toMatchObject({
        ok: true,
        stateCommitted: false,
        authorityChanged: false,
        snapshots: [],
      });
      expect(
        await readFile(join(fixture.home, "state", "plugins.json")),
      ).toEqual(before);
    } finally {
      await fixture.fixture.cleanup();
    }
  }, 180_000);
});
