import { describe, expect, test } from "bun:test";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  compatibilityProbeRequiresInteractiveAuth,
  createDevInteractiveAuthBlockerDetails,
} from "../../src/dev/auth.ts";
import {
  runForegroundDevelop,
  type DevelopRuntimeAdapters,
} from "../../src/dev/develop-operation.ts";
import type { CompatibilityProbeResult } from "../../src/host/probe-types.ts";

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

function probe(options: {
  status: CompatibilityProbeResult["status"];
  requiresSignedIn: boolean;
}): CompatibilityProbeResult {
  return {
    status: options.status,
    anchors: {
      pendingUnreachable: ["sidebar"],
      matrix: [{
        name: "sidebar",
        verdict: "pending-unreachable",
        requiresSignedIn: options.requiresSignedIn,
      }],
    },
  } as unknown as CompatibilityProbeResult;
}

describe("M4-F07 isolated interactive authentication", () => {
  test("classifies only signed-in pending probe anchors as authentication", () => {
    expect(compatibilityProbeRequiresInteractiveAuth(probe({
      status: "pending",
      requiresSignedIn: true,
    }))).toBe(true);
    expect(compatibilityProbeRequiresInteractiveAuth(probe({
      status: "pending",
      requiresSignedIn: false,
    }))).toBe(false);
    expect(compatibilityProbeRequiresInteractiveAuth(probe({
      status: "failed",
      requiresSignedIn: true,
    }))).toBe(false);
  });

  test("describes one exact persistent dev profile without credential projection", () => {
    const rootPath = "/private/tmp/explodex-auth/dev/plugin-dev";
    const details = createDevInteractiveAuthBlockerDetails({
      rootPath,
      target: TARGET,
    });
    expect(details).toEqual({
      blocker: "authentication",
      authMode: "interactive",
      projectedAuthAdvertised: false,
      role: "development",
      rootPath,
      electronUserDataPath: `${rootPath}/electron-user-data`,
      codexHomePath: `${rootPath}/codex-home`,
      target: {
        role: "development",
        pid: TARGET.pid,
        processStartedAt: TARGET.processStartedAt,
        port: 9444,
        targetId: TARGET.targetId,
        executionContextId: TARGET.executionContextId,
        executionContextUniqueId: TARGET.executionContextUniqueId,
        appVersion: TARGET.appVersion,
        appBuild: TARGET.appBuild,
      },
      requiredAction: expect.stringContaining("Sign in manually"),
      credentialHandling: {
        cliEntryAllowed: false,
        mainStateCopyAllowed: false,
        automaticProjection: false,
      },
      devRemainsRunning: true,
      resume: {
        firstOperation: "dev.status",
        recoveryOperation: "dev.recover",
        continuationOperation: "plugin.develop",
        requiresNewPublicOperation: true,
        reusesBlockedOutput: false,
      },
    });
    const restarted = createDevInteractiveAuthBlockerDetails({
      rootPath,
      target: {
        ...TARGET,
        pid: 5252,
        processStartedAt: "2026-07-28T00:01:00.000001Z",
        targetId: "target-dev-restarted",
        executionContextId: 23,
        executionContextUniqueId: "context-dev-restarted",
      },
    });
    expect(restarted.electronUserDataPath).toBe(details.electronUserDataPath);
    expect(restarted.codexHomePath).toBe(details.codexHomePath);
  });

  test("refuses to describe auth against main or another port", () => {
    expect(() =>
      createDevInteractiveAuthBlockerDetails({
        rootPath: "/private/tmp/explodex-auth/dev/plugin-dev",
        target: { ...TARGET, role: "main", port: 9333 },
      })
    ).toThrow("only for the exact development target");
  });

  test("turns an auth preflight requirement into one blocker event and blocked terminal", async () => {
    const lines: string[] = [];
    const auth = createDevInteractiveAuthBlockerDetails({
      rootPath: "/private/tmp/explodex-auth/dev/plugin-dev",
      target: TARGET,
    });
    const unused = async (): Promise<never> => {
      throw new Error("Auth preflight blockers must open no watcher or target.");
    };
    const adapters: DevelopRuntimeAdapters = {
      nowIso: () => "2026-07-28T00:00:01.000Z",
      preflight: async () => ({
        ok: false,
        code: "auth.required",
        message: "Sign-in is required.",
        details: auth,
      }),
      openWatcher: unused,
      openTargetMonitor: unused,
      buildGeneration: unused,
      applyGeneration: unused,
      waitForStop: unused,
      cleanup: async () => ({ ok: true, residuals: [] }),
      writeLine: (line) => lines.push(line),
    };
    const result = await runForegroundDevelop({
      operationId: "auth-preflight",
      adapters,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "blocked",
      lastSequence: 1,
      lastGood: null,
      error: {
        code: "auth.required",
        details: auth,
      },
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        schemaVersion: 1,
        operationId: "auth-preflight",
        sequence: 1,
        generation: 0,
        type: "blocked",
        details: { code: "auth.required", cause: auth },
      },
      {
        schemaVersion: 1,
        operationId: "auth-preflight",
        type: "terminal",
        ok: false,
        reason: "blocked",
        lastSequence: 1,
        lastGood: null,
        error: {
          code: "auth.required",
          message: "Sign-in is required.",
          details: auth,
        },
      },
    ]);
  });
});
