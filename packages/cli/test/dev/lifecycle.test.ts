import { describe, expect, test } from "bun:test";
import {
  createInitialDevInstanceState,
  describeDevLayout,
  evaluateDevOwnership,
  startDevInstance,
  ensureDevInstance,
  restartDevInstance,
  stopDevInstance,
  type DevInstanceState,
  type DevLifecycleLaunchAdapter,
  type DevStatusSnapshot,
} from "../../src/dev/index.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import { createFakeRuntimeHarness } from "../runtime/fixture-runtime.ts";

const HOST: HostIdentity = {
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.codex",
  executableName: "ChatGPT",
  signingTeam: "2DC432GLL2",
  appVersion: "26.727.10000",
  appBuild: "6000",
  hostHashes: {
    "Contents/Info.plist": "a".repeat(64),
    "Contents/MacOS/ChatGPT": "b".repeat(64),
  },
};

const TARGET: TargetIdentity = {
  role: "development",
  pid: 4242,
  processStartedAt: "2026-07-27T20:00:00.000001Z",
  executablePath: HOST.executablePath,
  appVersion: HOST.appVersion,
  appBuild: HOST.appBuild,
  port: 9444,
  browserIdentity: "Chrome/ChatGPT",
  targetId: "target-dev",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 41,
  executionContextUniqueId: "context-dev",
  frameId: "frame-dev",
};

function stoppedState(root: string): DevInstanceState {
  const state = createInitialDevInstanceState({
    layout: describeDevLayout(root),
    appPath: HOST.bundlePath,
    executablePath: HOST.executablePath,
    launchMarker: "--explodex-dev-instance=plugin-dev",
    frozenHost: HOST,
    updatedAt: "2026-07-27T20:00:00.000Z",
  });
  return {
    ...state,
    appVersion: HOST.appVersion,
    appBuild: HOST.appBuild,
  };
}

function readyState(root: string): DevInstanceState {
  return {
    ...stoppedState(root),
    status: "ready",
    pid: TARGET.pid,
    processStartedAt: TARGET.processStartedAt,
    targetId: TARGET.targetId,
    browserIdentity: TARGET.browserIdentity,
    executionContextId: TARGET.executionContextId,
    executionContextUniqueId: TARGET.executionContextUniqueId,
    frameId: TARGET.frameId,
    startedAt: "2026-07-27T20:00:00.000Z",
  };
}

function snapshot(
  operation: "start" | "ensure" | "restart" | "stop",
  state: DevInstanceState,
): DevStatusSnapshot {
  const live = state.pid !== null && state.processStartedAt !== null;
  return {
    rootPath: state.rootPath,
    stateLoadStatus: "valid",
    state,
    assessment: evaluateDevOwnership({
      operation,
      evidence: {
        requestedRoot: state.rootPath,
        stateLoadStatus: "valid",
        state,
        currentHost: HOST,
        phase0: {
          status: "proven",
          frozenHost: HOST,
          markerValue: state.launchMarker,
        },
        process: live
          ? {
              pid: state.pid!,
              parentPid: 1,
              executablePath: state.executablePath,
              arguments: [state.executablePath, state.launchMarker],
            }
          : null,
        currentPidIdentity: live
          ? {
              pid: state.pid!,
              processStartedAt: state.processStartedAt!,
            }
          : null,
        paths: {
          ok: true,
          canonicalRoot: state.rootPath,
          failures: [],
        },
        listeners: live
          ? [{
              pid: state.pid!,
              processStartedAt: state.processStartedAt,
              host: "127.0.0.1",
              port: 9444,
              family: "ipv4",
            }]
          : [],
        endpoint: live
          ? {
              kind: "available",
              target: {
                ...TARGET,
                pid: state.pid!,
                processStartedAt: state.processStartedAt!,
                targetId: state.targetId!,
                browserIdentity: state.browserIdentity!,
                executionContextId: state.executionContextId!,
                executionContextUniqueId: state.executionContextUniqueId!,
                frameId: state.frameId!,
              },
              targets: [{
                id: state.targetId!,
                type: "page",
                url: "app://-/index.html",
              }],
            }
          : null,
        compatibility: {
          status: "proven",
          matched: true,
          reason: null,
        },
        protectedMainOverlap: false,
      },
    }),
    readOnly: true,
    activity: {
      launched: false,
      signaled: false,
      evaluated: false,
      wroteState: false,
      fellBack: false,
    },
  };
}

function successfulLaunch(
  events: string[],
  pid = TARGET.pid,
): DevLifecycleLaunchAdapter {
  return async ({ onSpawn }) => {
    events.push("spawn");
    await onSpawn({
      pid,
      processStartedAt: TARGET.processStartedAt,
    });
    events.push("verified");
    return {
      pid,
      processStartedAt: TARGET.processStartedAt,
      targetId: TARGET.targetId,
      browserIdentity: TARGET.browserIdentity,
      executionContextId: TARGET.executionContextId,
      executionContextUniqueId: TARGET.executionContextUniqueId,
      frameId: TARGET.frameId,
      appVersion: HOST.appVersion,
      appBuild: HOST.appBuild,
      frozenHost: HOST,
    };
  };
}

describe("strict development lifecycle transitions", () => {
  test("start commits starting before spawn and ready only after full verification", async () => {
    const root = "/tmp/dev-lifecycle-start";
    let state = stoppedState(root);
    const events: string[] = [];
    const runtime = createFakeRuntimeHarness();
    const result = await startDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("start", state),
      saveState: async (next) => {
        state = next;
        events.push(`state:${next.status}:${next.pid ?? "none"}`);
      },
      launch: successfulLaunch(events),
      terminate: async () => {
        throw new Error("successful start must not terminate");
      },
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      "state:starting:none",
      "spawn",
      `state:starting:${TARGET.pid}`,
      "verified",
      `state:ready:${TARGET.pid}`,
    ]);
    expect(state.status).toBe("ready");
    expect(state.targetId).toBe(TARGET.targetId);
  });

  test("ensure returns one healthy ready identity without launch or state rewrite", async () => {
    const root = "/tmp/dev-lifecycle-ensure";
    const state = readyState(root);
    let launches = 0;
    let writes = 0;
    const runtime = createFakeRuntimeHarness();
    const result = await ensureDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("ensure", state),
      saveState: async () => {
        writes += 1;
      },
      launch: async () => {
        launches += 1;
        throw new Error("ensure must not launch");
      },
      terminate: async () => {
        throw new Error("ensure must not terminate");
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reusedReady).toBe(true);
    expect(launches).toBe(0);
    expect(writes).toBe(0);
  });

  test("start refuses ready and ensure refuses a failed state that is not confirmed dead", async () => {
    const runtime = createFakeRuntimeHarness();
    for (const testCase of [
      {
        operation: "start" as const,
        state: readyState("/tmp/dev-lifecycle-start-ready"),
        expectedCode: "dev.start-refused",
      },
      {
        operation: "ensure" as const,
        state: {
          ...readyState("/tmp/dev-lifecycle-ensure-failed"),
          status: "failed" as const,
        },
        expectedCode: "dev.ensure-refused",
      },
    ] as const) {
      let launches = 0;
      let writes = 0;
      const common = {
        rootPath: testCase.state.rootPath,
        runtimeAdapters: runtime.adapters,
        readStatus: async () => snapshot(testCase.operation, testCase.state),
        saveState: async () => {
          writes += 1;
        },
        launch: async () => {
          launches += 1;
          throw new Error("ineligible state must not launch");
        },
        terminate: async () => {
          throw new Error("ineligible state must not terminate");
        },
      };
      const result = testCase.operation === "start"
        ? await startDevInstance(common)
        : await ensureDevInstance(common);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(testCase.expectedCode);
        expect(result.recoveryRequired).toBe(
          testCase.operation === "ensure",
        );
      }
      expect(launches).toBe(0);
      expect(writes).toBe(0);
    }
  });

  test("ensure recovers one confirmed-dead record and launches once without termination", async () => {
    const root = "/tmp/dev-lifecycle-ensure-dead";
    let state: DevInstanceState = {
      ...readyState(root),
      status: "failed",
      lastError: {
        code: "renderer-crashed",
        message: "Renderer exited.",
        phase: "runtime",
      },
    };
    const events: string[] = [];
    let reads = 0;
    let terminations = 0;
    const runtime = createFakeRuntimeHarness();
    const result = await ensureDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => {
        reads += 1;
        if (state.status === "failed") {
          const failed = snapshot("ensure", state);
          failed.assessment = {
            ...failed.assessment,
            owned: false,
            mutationAllowed: false,
            recoveryEligibility: "independently-dead",
          };
          return failed;
        }
        return snapshot("ensure", state);
      },
      saveState: async (next) => {
        state = next;
        events.push(`state:${next.status}`);
      },
      launch: successfulLaunch(events),
      terminate: async () => {
        terminations += 1;
        throw new Error("confirmed-dead recovery must not signal");
      },
    });

    expect(result.ok).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(terminations).toBe(0);
    expect(events).toEqual([
      "state:stopped",
      "state:starting",
      "spawn",
      "state:starting",
      "verified",
      "state:ready",
    ]);
    expect(state.recoveryDiagnostics.at(-1)).toMatchObject({
      priorStatus: "failed",
      disposition: "independently-dead",
      terminationMethod: null,
    });
  });

  test("restart orders stopping, stopped, starting, and ready under one claim", async () => {
    const root = "/tmp/dev-lifecycle-restart";
    let state = readyState(root);
    const events: string[] = [];
    const runtime = createFakeRuntimeHarness();
    const result = await restartDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("restart", state),
      saveState: async (next) => {
        state = next;
        events.push(`state:${next.status}`);
      },
      terminate: async () => {
        events.push("terminate");
        return {
          ok: true,
          confirmedExit: true,
          method: "browser-close-only",
          elapsedMs: 12,
          boundMs: 1_000,
        };
      },
      launch: successfulLaunch(events, 5252),
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      "state:stopping",
      "terminate",
      "state:stopped",
      "state:starting",
      "spawn",
      "state:starting",
      "verified",
      "state:ready",
    ]);
    expect(state.pid).toBe(5252);
  });

  test("restart timeout preserves stopping evidence and launches no replacement", async () => {
    const root = "/tmp/dev-lifecycle-timeout";
    let state = readyState(root);
    let launches = 0;
    const runtime = createFakeRuntimeHarness();
    const result = await restartDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("restart", state),
      saveState: async (next) => {
        state = next;
      },
      terminate: async () => ({
        ok: false,
        confirmedExit: false,
        code: "operation.timeout",
        message: "Graceful termination timed out.",
        method: "browser-close-then-signal",
        elapsedMs: 1_000,
        boundMs: 1_000,
      }),
      launch: async () => {
        launches += 1;
        throw new Error("timeout must not launch a replacement");
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("operation.timeout");
    expect(state.status).toBe("stopping");
    expect(state.pid).toBe(TARGET.pid);
    expect(launches).toBe(0);
  });

  test("restart remains available when SDK compatibility is unavailable", async () => {
    const root = "/tmp/dev-lifecycle-restart-unproven";
    const state = readyState(root);
    const runtime = createFakeRuntimeHarness();
    const events: string[] = [];
    let terminations = 0;
    const unavailable = snapshot("restart", state);
    unavailable.assessment = {
      ...unavailable.assessment,
      compatibilityProven: false,
    };
    let current = state;
    const result = await restartDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => ({
        ...unavailable,
        state: current,
      }),
      saveState: async (next) => {
        current = next;
        events.push(`state:${next.status}`);
      },
      terminate: async () => {
        terminations += 1;
        return {
          ok: true,
          confirmedExit: true,
          method: "browser-close-only",
        };
      },
      launch: successfulLaunch(events),
    });
    expect(result.ok).toBe(true);
    expect(terminations).toBe(1);
    expect(current.status).toBe("ready");
    expect(events).toContain("spawn");
  });

  test("stop retains old identity evidence after confirmed graceful exit", async () => {
    const root = "/tmp/dev-lifecycle-stop";
    let state = readyState(root);
    const runtime = createFakeRuntimeHarness();
    const result = await stopDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("stop", state),
      saveState: async (next) => {
        state = next;
      },
      terminate: async () => ({
        ok: true,
        confirmedExit: true,
        method: "browser-close-then-signal",
        elapsedMs: 25,
        boundMs: 1_000,
      }),
    });

    expect(result.ok).toBe(true);
    expect(state.status).toBe("stopped");
    expect(state.pid).toBeNull();
    expect(state.recoveryDiagnostics.at(-1)).toMatchObject({
      priorPid: TARGET.pid,
      priorProcessStartedAt: TARGET.processStartedAt,
      priorTargetId: TARGET.targetId,
      disposition: "owned-process-terminated",
      terminationMethod: "browser-close-then-signal",
    });
  });

  test("verified partial launch makes one safe close attempt and remains failed for recovery", async () => {
    const root = "/tmp/dev-lifecycle-partial";
    let state = stoppedState(root);
    let terminateCalls = 0;
    let readyCommit = false;
    const runtime = createFakeRuntimeHarness();
    const result = await startDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("start", state),
      saveState: async (next) => {
        if (next.status === "ready") {
          readyCommit = true;
          throw new Error("ready state rename failed");
        }
        state = next;
      },
      launch: successfulLaunch([]),
      terminate: async () => {
        terminateCalls += 1;
        return {
          ok: true,
          confirmedExit: true,
          method: "browser-close-only",
          elapsedMs: 10,
          boundMs: 1_000,
        };
      },
    });

    expect(readyCommit).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("dev.launch-partial");
      expect(result.recoveryRequired).toBe(true);
      expect(result.partialDisposition).toBe("gracefully-closed");
    }
    expect(terminateCalls).toBe(1);
    expect(state.status).toBe("failed");
    expect(state.pid).toBe(TARGET.pid);
  });

  test("unverified partial launch records failed and never signals uncertain ownership", async () => {
    const root = "/tmp/dev-lifecycle-unverified";
    let state = stoppedState(root);
    let terminateCalls = 0;
    const runtime = createFakeRuntimeHarness();
    const result = await startDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("start", state),
      saveState: async (next) => {
        state = next;
      },
      launch: async ({ onSpawn }) => {
        await onSpawn({
          pid: TARGET.pid,
          processStartedAt: TARGET.processStartedAt,
        });
        throw new Error("target never became uniquely selectable");
      },
      terminate: async () => {
        terminateCalls += 1;
        throw new Error("uncertain ownership must not be signaled");
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.partialDisposition).toBe("left-running-unverified");
      expect(result.recoveryRequired).toBe(true);
    }
    expect(terminateCalls).toBe(0);
    expect(state.status).toBe("failed");
    expect(state.pid).toBe(TARGET.pid);
  });

  test("verified partial launch makes no second close attempt when graceful close fails", async () => {
    const root = "/tmp/dev-lifecycle-partial-close-failure";
    let state = stoppedState(root);
    let terminateCalls = 0;
    const runtime = createFakeRuntimeHarness();
    const result = await startDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot("start", state),
      saveState: async (next) => {
        if (next.status === "ready") {
          throw new Error("ready state commit failed");
        }
        state = next;
      },
      launch: successfulLaunch([]),
      terminate: async () => {
        terminateCalls += 1;
        return {
          ok: false,
          confirmedExit: false,
          code: "operation.timeout",
          message: "close timed out",
          method: "browser-close-only",
          elapsedMs: 1_000,
          boundMs: 1_000,
        };
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.partialDisposition).toBe("left-running-close-failed");
    }
    expect(terminateCalls).toBe(1);
    expect(state.status).toBe("failed");
  });
});
