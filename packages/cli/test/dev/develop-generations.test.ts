import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  runForegroundDevelop,
  type DevelopBuildResult,
  type DevelopPreflightSuccess,
  type DevelopRuntimeAdapters,
} from "../../src/dev/develop-operation.ts";
import {
  isDevelopWatchChangeIncluded,
} from "../../src/dev/develop-production.ts";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { fingerprintDistTree } from "../../src/plugin/dist-files.ts";
import {
  createValidWorkspace,
  writeWorkspaceFile,
} from "../plugin/helpers.ts";

const TARGET: TargetIdentity = {
  role: "development",
  pid: 4242,
  processStartedAt: "2026-07-28T00:00:00.000001Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "26.721.41059",
  appBuild: "5848",
  port: 9444,
  browserIdentity: "Chrome/ChatGPT",
  targetId: "target-dev",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 17,
  executionContextUniqueId: "context-dev",
  frameId: "frame-dev",
};

function identity(version: string, digestCharacter: string) {
  return {
    id: "sample",
    version,
    payloadSha256: digestCharacter.repeat(64),
  };
}

const PREFLIGHT: DevelopPreflightSuccess = {
  workspacePath: "/tmp/explodex-plugin-sample",
  watchedPaths: ["/tmp/explodex-plugin-sample"],
  excludedPaths: [
    "/tmp/explodex-plugin-sample/dist",
    "/tmp/explodex-plugin-sample/node_modules",
  ],
  lifecycle: "dynamic",
  route: "dynamic",
  target: TARGET,
  pluginIdentity: identity("dev-a", "a"),
  sdkRuntimeIdentity: {
    version: "1.2.0",
    sha256: "b".repeat(64),
  },
  distPath: "/tmp/explodex-plugin-sample/dist",
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function generationHarness(options?: {
  build?(generation: number, signal?: AbortSignal): Promise<DevelopBuildResult>;
  apply?: DevelopRuntimeAdapters["applyGeneration"];
}) {
  const lines: string[] = [];
  const calls: string[] = [];
  let onChange: (() => void) | null = null;
  let onStop: (() => void) | null = null;
  const adapters: DevelopRuntimeAdapters = {
    nowIso: () => "2026-07-28T00:00:01.000Z",
    debounceMs: 5,
    preflight: async () => ({ ok: true, value: PREFLIGHT }),
    openWatcher: async (watcherOptions) => {
      calls.push("watcher:open");
      onChange = watcherOptions.onChange;
      onStop = watcherOptions.onStop;
      return {
        close() {
          calls.push("watcher:close");
        },
      };
    },
    openTargetMonitor: async () => ({
      close() {
        calls.push("target:close");
      },
    }),
    buildGeneration: async ({ generation, signal }) => {
      calls.push(`build:${generation}`);
      if (options?.build !== undefined) {
        return options.build(generation, signal);
      }
      return {
        ok: true,
        pluginIdentity: identity(`dev-${generation}`, String(generation)),
      };
    },
    applyGeneration: options?.apply ?? (async ({
      generation,
      pluginIdentity,
    }) => {
      calls.push(`apply:${generation}`);
      return { ok: true, pluginIdentity, target: TARGET };
    }),
    waitForStop: async () =>
      await new Promise<"completed">((resolve) => {
        onStop = () => resolve("completed");
      }),
    cleanup: async () => ({ ok: true, residuals: [] }),
    writeLine: (line) => lines.push(line),
  };
  return {
    adapters,
    calls,
    lines,
    change() {
      onChange?.();
    },
    stop() {
      onStop?.();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture.");
    await Bun.sleep(1);
  }
}

describe("M4-F05 foreground generations", () => {
  test("excludes generated outputs and unrelated roots from watch generations", () => {
    const preflight = {
      workspacePath: "/tmp/explodex-plugin-sample",
      excludedPaths: [
        "/tmp/explodex-plugin-sample/dist",
        "/tmp/explodex-plugin-sample/node_modules",
      ],
    };
    expect(isDevelopWatchChangeIncluded({
      preflight,
      fileName: "src/index.ts",
    })).toBe(true);
    expect(isDevelopWatchChangeIncluded({
      preflight,
      fileName: "dist/index.js",
    })).toBe(false);
    expect(isDevelopWatchChangeIncluded({
      preflight,
      fileName: "node_modules/dependency/index.js",
    })).toBe(false);
    expect(isDevelopWatchChangeIncluded({
      preflight,
      fileName: "../unrelated/index.ts",
    })).toBe(false);
  });

  test("a superseded build cannot replace prior dist and removes its staging output", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-generation-preservation",
    });
    try {
      const initial = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
      });
      expect(initial.ok).toBe(true);
      const priorFingerprint = await fingerprintDistTree(fixture.workspace);
      expect(priorFingerprint).not.toBeNull();

      await writeWorkspaceFile(
        fixture.workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup() {
    globalThis.document?.documentElement.setAttribute("data-generation", "new");
  },
});
`,
      );
      const superseded = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
        shouldCommit: () => false,
      });
      expect(superseded).toMatchObject({
        ok: false,
        code: "operation.interrupted",
        priorDistFingerprint: priorFingerprint,
        distFingerprintAfter: priorFingerprint,
      });
      expect(await fingerprintDistTree(fixture.workspace)).toBe(
        priorFingerprint,
      );
      expect(
        (await readdir(fixture.workspace)).filter((entry) =>
          entry.startsWith(".explodex-dist-staging-") ||
          entry.startsWith(".dist-backup-") ||
          entry.startsWith(".dist-rejected-")
        ),
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("coalesces bursts, invalidates a stale build, and applies only the newest generation", async () => {
    const staleBuild = deferred<DevelopBuildResult>();
    let staleSignal: AbortSignal | undefined;
    const fixture = generationHarness({
      async build(generation, signal) {
        if (generation === 2) {
          expect(signal?.aborted).toBe(false);
          staleSignal = signal;
          return staleBuild.promise;
        }
        return {
          ok: true,
          pluginIdentity: identity("dev-c", "c"),
        };
      },
    });
    const running = runForegroundDevelop({
      operationId: "generation-coalescing",
      adapters: fixture.adapters,
    });
    await waitFor(() => fixture.calls.includes("apply:1"));

    fixture.change();
    fixture.change();
    fixture.change();
    await waitFor(() => fixture.calls.includes("build:2"));
    fixture.change();
    await waitFor(() => staleSignal?.aborted === true);
    staleBuild.resolve({
      ok: true,
      pluginIdentity: identity("dev-stale", "d"),
    });
    await waitFor(() => fixture.lines.some((line) => {
      const event = JSON.parse(line) as { type?: string; generation?: number };
      return event.type === "build-started" && event.generation === 3;
    }));
    await waitFor(() => fixture.calls.includes("apply:3"));
    fixture.stop();

    const result = await running;
    const records = fixture.lines.map((line) =>
      JSON.parse(line) as {
        type: string;
        generation?: number;
        lastGood?: { generation: number };
      }
    );
    expect(fixture.calls.filter((call) => call === "build:2")).toHaveLength(1);
    expect(fixture.calls).not.toContain("apply:2");
    expect(
      records.filter((record) => record.type === "apply-succeeded")
        .map((record) => record.generation),
    ).toEqual([1, 3]);
    expect(result.lastGood?.generation).toBe(3);
  });

  test("keeps last-good through build failure and applies a corrected generation in the same process", async () => {
    const priorFingerprint = "prior-dist-fingerprint";
    const fixture = generationHarness({
      async build(generation) {
        if (generation === 2) {
          return {
            ok: false,
            code: "plugin.source.invalid",
            message: "Plugin TypeScript typecheck failed.",
            priorDistFingerprint: priorFingerprint,
            distFingerprintAfter: priorFingerprint,
          };
        }
        return {
          ok: true,
          pluginIdentity: identity("dev-b", "c"),
        };
      },
    });
    const running = runForegroundDevelop({
      operationId: "generation-recovery",
      adapters: fixture.adapters,
    });
    await waitFor(() => fixture.calls.includes("apply:1"));
    fixture.change();
    await waitFor(() => fixture.lines.some((line) => {
      const event = JSON.parse(line) as { type?: string; generation?: number };
      return event.type === "build-failed" && event.generation === 2;
    }));
    expect(fixture.calls).not.toContain("apply:2");

    fixture.change();
    await waitFor(() => fixture.calls.includes("apply:3"));
    fixture.stop();
    const result = await running;
    const records = fixture.lines.map((line) =>
      JSON.parse(line) as {
        type: string;
        generation?: number;
        details?: Record<string, unknown>;
      }
    );
    const failed = records.find((record) =>
      record.type === "build-failed" && record.generation === 2
    );
    expect(failed?.details).toMatchObject({
      code: "plugin.source.invalid",
      priorDistPreserved: true,
    });
    expect(result.lastGood).toMatchObject({
      generation: 3,
      pluginIdentity: identity("dev-b", "c"),
    });
  });

  test("does not promote a post-setup failure and truthfully reports the preserved prior live identity", async () => {
    const fixture = generationHarness({
      apply: async ({ generation, pluginIdentity, previousLastGood }) => {
        fixture.calls.push(`apply:${generation}`);
        if (generation === 2) {
          return {
            ok: false,
            code: "plugin.lifecycle.setup-failed",
            message: "Replacement setup failed.",
            blocked: false,
            liveDisposition: "previous-preserved",
            liveIdentity: previousLastGood?.pluginIdentity ?? null,
            stage: "setup",
            possiblePartialEffects: true,
          };
        }
        return { ok: true, pluginIdentity, target: TARGET };
      },
    });
    const running = runForegroundDevelop({
      operationId: "generation-apply-failure",
      adapters: fixture.adapters,
    });
    await waitFor(() => fixture.calls.includes("apply:1"));
    fixture.change();
    await waitFor(() => fixture.lines.some((line) => {
      const event = JSON.parse(line) as { type?: string; generation?: number };
      return event.type === "apply-failed" && event.generation === 2;
    }));
    fixture.stop();
    const result = await running;
    const records = fixture.lines.map((line) =>
      JSON.parse(line) as {
        type: string;
        generation?: number;
        details?: Record<string, unknown>;
      }
    );
    expect(records.find((record) =>
      record.type === "apply-failed" && record.generation === 2
    )?.details).toMatchObject({
      code: "plugin.lifecycle.setup-failed",
      liveDisposition: "previous-preserved",
      stage: "setup",
      possiblePartialEffects: true,
    });
    expect(result.lastGood).toMatchObject({
      generation: 1,
      pluginIdentity: identity("dev-a", "a"),
    });
  });

  test("truthfully reports the plugin absent when a later apply cannot preserve the prior generation", async () => {
    const fixture = generationHarness({
      apply: async ({ generation, pluginIdentity }) => {
        fixture.calls.push(`apply:${generation}`);
        if (generation === 2) {
          return {
            ok: false,
            code: "plugin.lifecycle.previous-cleanup-failed",
            message: "Replacement failed after prior teardown.",
            blocked: false,
            liveDisposition: "plugin-absent",
            liveIdentity: null,
            stage: "cleanup",
            possiblePartialEffects: true,
          };
        }
        return { ok: true, pluginIdentity, target: TARGET };
      },
    });
    const running = runForegroundDevelop({
      operationId: "generation-plugin-absent",
      adapters: fixture.adapters,
    });
    await waitFor(() => fixture.calls.includes("apply:1"));
    fixture.change();
    await waitFor(() => fixture.lines.some((line) => {
      const event = JSON.parse(line) as { type?: string; generation?: number };
      return event.type === "apply-failed" && event.generation === 2;
    }));
    fixture.stop();
    const result = await running;
    const records = fixture.lines.map((line) =>
      JSON.parse(line) as {
        type: string;
        generation?: number;
        details?: Record<string, unknown>;
      }
    );
    expect(records.find((record) =>
      record.type === "apply-failed" && record.generation === 2
    )?.details).toMatchObject({
      liveDisposition: "plugin-absent",
      liveIdentity: null,
      stage: "cleanup",
    });
    expect(result.lastGood?.generation).toBe(1);
  });
});
