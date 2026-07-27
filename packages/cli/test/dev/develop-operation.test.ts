import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import { runCli } from "../../src/cli/entry.ts";
import {
  runForegroundDevelop,
  type DevelopPreflightSuccess,
  type DevelopRuntimeAdapters,
} from "../../src/dev/develop-operation.ts";
import type { DevelopTerminalReason } from "../../src/dev/develop-protocol.ts";

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
  pluginIdentity: {
    id: "sample",
    version: "dev-1",
    payloadSha256: "a".repeat(64),
  },
  sdkRuntimeIdentity: {
    version: "1.2.0",
    sha256: "b".repeat(64),
  },
  distPath: "/tmp/explodex-plugin-sample/dist",
};

type Scenario = {
  name: string;
  expectedReason: DevelopTerminalReason;
  expectedCode: string | null;
  configure(
    adapters: DevelopRuntimeAdapters,
    controls: { abort: AbortController },
  ): void;
};

function harness(options?: {
  preflight?: DevelopRuntimeAdapters["preflight"];
  apply?: DevelopRuntimeAdapters["applyGeneration"];
}): {
  adapters: DevelopRuntimeAdapters;
  calls: string[];
  lines: string[];
  triggerTargetLoss(): void;
  triggerStop(): void;
} {
  const calls: string[] = [];
  const lines: string[] = [];
  let targetLost: (() => void) | null = null;
  let stopped: (() => void) | null = null;
  const adapters: DevelopRuntimeAdapters = {
    nowIso: () => "2026-07-28T00:00:01.000Z",
    preflight: options?.preflight ?? (async () => {
      calls.push("preflight");
      return { ok: true, value: PREFLIGHT };
    }),
    openWatcher: async ({ onStop }) => {
      calls.push("watcher:open");
      stopped = onStop;
      return {
        close: async () => {
          calls.push("watcher:close");
        },
      };
    },
    openTargetMonitor: async ({ onTargetLost }) => {
      calls.push("target:open");
      targetLost = onTargetLost;
      return {
        close: async () => {
          calls.push("target:close");
        },
      };
    },
    buildGeneration: async () => ({
      ok: true,
      pluginIdentity: PREFLIGHT.pluginIdentity,
    }),
    applyGeneration: options?.apply ?? (async () => {
      calls.push("apply");
      return {
        ok: true,
        pluginIdentity: {
          id: "sample",
          version: "dev-1",
          payloadSha256: "a".repeat(64),
        },
        target: TARGET,
      };
    }),
    cleanup: async () => {
      calls.push("cleanup");
      return { ok: true, residuals: [] };
    },
    waitForStop: async () => {
      calls.push("wait");
      return await new Promise<"completed" | "interrupted">((resolve) => {
        stopped = () => resolve("completed");
      });
    },
    writeLine: (line) => lines.push(line),
  };
  return {
    adapters,
    calls,
    lines,
    triggerTargetLoss: () => targetLost?.(),
    triggerStop: () => stopped?.(),
  };
}

describe("M4-F04 foreground develop operation", () => {
  test("public --json command emits JSONL terminal directly without envelope wrapping", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let stdoutText = "";
    let stderrText = "";
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      stdoutText += chunk;
    });
    stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    const result = await runCli({
      argv: [
        "--json",
        "plugin",
        "develop",
        "/definitely/missing/explodex-plugin-workspace",
      ],
      env: {
        HOME: "/tmp/explodex-develop-command-home",
        PWD: "/tmp",
        PATH: process.env.PATH,
      },
      io: {
        stdin,
        stdout,
        stderr,
        stdinIsTty: false,
        stdoutIsTty: false,
        stderrIsTty: false,
      },
      returnResult: true,
    });
    expect(result.outputMode).toBe("already-written");
    const lines = stdoutText.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: 1,
      type: "terminal",
      ok: false,
      reason: "preflight-failed",
      lastSequence: 0,
    });
    expect(stdoutText).not.toContain('"operation":"plugin.develop"');
    expect(stderrText).toBe("");
  });

  test("preflight failure creates no watcher, monitor, apply, or cleanup resource", async () => {
    const fixture = harness({
      preflight: async () => ({
        ok: false,
        code: "develop.workspace-unsafe",
        message: "Workspace overlaps the development instance.",
      }),
    });
    const result = await runForegroundDevelop({
      operationId: "preflight",
      signal: new AbortController().signal,
      adapters: fixture.adapters,
    });
    expect(result.reason).toBe("preflight-failed");
    expect(fixture.calls).toEqual([]);
    expect(fixture.lines).toHaveLength(1);
    expect(JSON.parse(fixture.lines[0]!)).toMatchObject({
      type: "terminal",
      lastSequence: 0,
      reason: "preflight-failed",
      error: { code: "develop.workspace-unsafe" },
    });
  });

  test("target loss closes watcher and target monitor before blocked terminal", async () => {
    const fixture = harness();
    const running = runForegroundDevelop({
      operationId: "target-loss",
      signal: new AbortController().signal,
      adapters: fixture.adapters,
    });
    await Bun.sleep(0);
    fixture.triggerTargetLoss();
    const result = await running;
    expect(result.reason).toBe("blocked");
    expect(result.error?.code).toBe("cdp.target-lost");
    expect(fixture.calls).toEqual([
      "preflight",
      "watcher:open",
      "target:open",
      "apply",
      "wait",
      "target:close",
      "watcher:close",
      "cleanup",
    ]);
    const parsed = fixture.lines.map((line) =>
      JSON.parse(line) as Record<string, unknown>
    );
    expect(parsed.at(-2)?.type).toBe("target-lost");
    expect(parsed.at(-1)).toMatchObject({
      type: "terminal",
      reason: "blocked",
      error: { code: "cdp.target-lost" },
    });
  });

  test("target loss aborts an in-flight apply and still terminates as target-lost", async () => {
    const fixture = harness({
      apply: async ({ signal }) =>
        await new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve({
              ok: false,
              code: "operation.interrupted",
              message: "Apply was aborted.",
              blocked: false,
            });
          }, { once: true });
        }),
    });
    const running = runForegroundDevelop({
      operationId: "target-loss-during-apply",
      signal: new AbortController().signal,
      adapters: fixture.adapters,
    });
    await Bun.sleep(0);
    fixture.triggerTargetLoss();
    const result = await running;
    expect(result).toMatchObject({
      reason: "blocked",
      error: { code: "cdp.target-lost" },
    });
    const parsed = fixture.lines.map((line) =>
      JSON.parse(line) as Record<string, unknown>
    );
    expect(parsed.at(-2)?.type).toBe("target-lost");
    expect(parsed.filter((record) => record.type === "apply-failed")).toHaveLength(0);
  });

  test("terminal matrix performs cleanup before one terminal with no post-exit work", async () => {
    const scenarios: Scenario[] = [
      {
        name: "normal",
        expectedReason: "completed",
        expectedCode: null,
        configure(adapters) {
          adapters.waitForStop = async () => "completed";
        },
      },
      {
        name: "interrupted",
        expectedReason: "interrupted",
        expectedCode: "operation.interrupted",
        configure(adapters, { abort }) {
          adapters.waitForStop = async () => {
            abort.abort();
            return "interrupted";
          };
        },
      },
      {
        name: "runtime-failed",
        expectedReason: "runtime-failed",
        expectedCode: "develop.runtime-failed",
        configure(adapters) {
          adapters.applyGeneration = async () => ({
            ok: false,
            code: "develop.runtime-failed",
            message: "Initial apply failed.",
            blocked: false,
          });
        },
      },
      {
        name: "generic-blocked",
        expectedReason: "blocked",
        expectedCode: "auth.required",
        configure(adapters) {
          adapters.applyGeneration = async () => ({
            ok: false,
            code: "auth.required",
            message: "Sign-in is required.",
            blocked: true,
          });
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = harness();
      const abort = new AbortController();
      scenario.configure(fixture.adapters, { abort });
      const result = await runForegroundDevelop({
        operationId: scenario.name,
        signal: abort.signal,
        adapters: fixture.adapters,
      });
      expect(result.reason).toBe(scenario.expectedReason);
      expect(result.error?.code ?? null).toBe(scenario.expectedCode);
      const terminalIndex = fixture.calls.indexOf("cleanup");
      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      const parsed = fixture.lines.map((line) =>
        JSON.parse(line) as Record<string, unknown>
      );
      expect(parsed.filter((record) => record.type === "terminal")).toHaveLength(1);
      expect(parsed.at(-1)?.type).toBe("terminal");
      expect(fixture.calls.slice(-3)).toEqual([
        "target:close",
        "watcher:close",
        "cleanup",
      ]);
    }
  });

  test("cleanup residue changes the terminal to runtime failure", async () => {
    const fixture = harness();
    fixture.adapters.waitForStop = async () => "completed";
    fixture.adapters.cleanup = async () => ({
      ok: false,
      residuals: ["watcher:sample"],
    });
    const result = await runForegroundDevelop({
      operationId: "cleanup-failure",
      signal: new AbortController().signal,
      adapters: fixture.adapters,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "runtime-failed",
      error: { code: "develop.cleanup-failed" },
    });
  });

  test("hanging owned-resource cleanup is bounded and reported before terminal", async () => {
    const fixture = harness();
    fixture.adapters.waitForStop = async () => "completed";
    fixture.adapters.cleanupBoundMs = 5;
    fixture.adapters.openTargetMonitor = async () => ({
      close: async () => await new Promise<void>(() => {}),
    });
    const startedAt = Date.now();
    const result = await runForegroundDevelop({
      operationId: "cleanup-timeout",
      signal: new AbortController().signal,
      adapters: fixture.adapters,
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      reason: "runtime-failed",
      error: {
        code: "develop.cleanup-failed",
        details: {
          residuals: expect.arrayContaining(["target-monitor"]),
        },
      },
    });
  });
});
