import { describe, expect, test } from "bun:test";
import type {
  CdpAdapter,
  CdpTargetSession,
} from "../../src/cdp/adapters.ts";
import type {
  CdpExecutionContext,
  CdpTarget,
} from "../../src/cdp/types.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import type {
  ListenerObservation,
  VerifiedProcess,
} from "../../src/host/status.ts";
import { runPluginReviewOperation } from "../../src/plugin/review-operation.ts";
import {
  createFakeRuntimeHarness,
  runWithClockPump,
} from "../runtime/fixture-runtime.ts";

const DIGEST = "a".repeat(64);
const EXECUTABLE = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const HOST: HostIdentity = {
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: EXECUTABLE,
  bundleId: "com.openai.codex",
  executableName: "ChatGPT",
  signingTeam: "2DC432GLL2",
  appVersion: "26.721.41059",
  appBuild: "5848",
  hostHashes: {
    "Contents/Info.plist": "b".repeat(64),
  },
};
const PROCESS: VerifiedProcess = {
  pid: 4200,
  parentPid: 1,
  processStartedAt: "2026-07-27T05:00:00.000Z",
  executablePath: EXECUTABLE,
  arguments: [EXECUTABLE, "--explodex-dev"],
};
const LISTENER: ListenerObservation = {
  pid: PROCESS.pid,
  processStartedAt: PROCESS.processStartedAt,
  host: "127.0.0.1",
  port: 9444,
  family: "ipv4",
};
const TARGET: CdpTarget = {
  id: "PAGE-REVIEW",
  type: "page",
  url: "app://-/index.html",
  title: "ChatGPT",
  webSocketDebuggerUrl:
    "ws://127.0.0.1:9444/devtools/page/PAGE-REVIEW",
};
const CONTEXT: CdpExecutionContext = {
  id: 17,
  uniqueId: "context-review",
  targetId: TARGET.id,
  frameId: "frame-review",
  isDefault: true,
  origin: "app://-",
  name: "",
};
const NONCE = new Uint8Array(48).fill(1)
  .slice(12, 36)
  .reduce((value, byte) => `${value}${byte.toString(16).padStart(2, "0")}`, "");

class ReviewCdpAdapter implements CdpAdapter {
  outcome: unknown;
  evaluationMode: "resolve" | "hang" | "target-lost" = "resolve";
  closed = false;
  cleanupEvaluations = 0;
  readonly evaluationStarted: Promise<void>;
  private markEvaluationStarted: () => void = () => {};

  constructor(outcome: unknown) {
    this.outcome = outcome;
    this.evaluationStarted = new Promise((resolve) => {
      this.markEvaluationStarted = resolve;
    });
  }

  async readEndpoint() {
    return {
      browser: "Chrome/136",
      protocolVersion: "1.3",
      webSocketDebuggerUrl:
        "ws://127.0.0.1:9444/devtools/browser/BROWSER-REVIEW",
      pid: PROCESS.pid,
    };
  }

  async listTargets(): Promise<CdpTarget[]> {
    return [{ ...TARGET }];
  }

  async openTargetSession(input: {
    onSessionOpened?(session: CdpTargetSession): void;
  }): Promise<CdpTargetSession> {
    const session: CdpTargetSession = {
      targetId: TARGET.id,
      isOpen: () => !this.closed,
      listExecutionContexts: async () => [{ ...CONTEXT }],
      evaluate: async (request) => {
        if (request.expression.includes("review.cancelExact(")) {
          this.cleanupEvaluations += 1;
          return { value: true };
        }
        this.markEvaluationStarted();
        if (this.evaluationMode === "hang") {
          return new Promise(() => undefined);
        }
        if (this.evaluationMode === "target-lost") {
          throw Object.assign(new Error("renderer target lost"), {
            code: "target_identity_drift" as const,
          });
        }
        return { value: this.outcome };
      },
      close: async () => {
        this.closed = true;
      },
    };
    input.onSessionOpened?.(session);
    return session;
  }
}

function run(options: {
  adapter: ReviewCdpAdapter;
  timeoutMs?: number;
  signal?: AbortSignal;
  nowMs?: () => number;
}) {
  const runtime = createFakeRuntimeHarness({
    startMs: 1_000,
    self: {
      pid: 8000,
      processStartedAt: "operation-start",
    },
  });
  runtime.setProcessAlive(PROCESS.pid, PROCESS.processStartedAt, true);
  const operation = runPluginReviewOperation({
    runtime: runtime.adapters,
    operationId: "review-operation",
    role: "development",
    homeIdentity: "/tmp/review-home",
    host: HOST,
    process: PROCESS,
    endpoint: { host: "127.0.0.1", port: 9444 },
    cdp: options.adapter,
    revalidate: async () => ({
      host: HOST,
      process: PROCESS,
      listener: LISTENER,
    }),
    sdkRuntimeSource: "globalThis.Explodex = globalThis.Explodex;",
    artifacts: [{
      id: "alpha",
      displayName: "Alpha",
      description: "Metadata only",
      version: "opaque-A",
      payloadSha256: DIGEST,
      sdkRange: "^0.2.0",
      sourceLabel: "Local archive: alpha.tgz",
    }],
    timeoutMs: options.timeoutMs ?? 1_000,
    signal: options.signal,
    nowMs: options.nowMs ?? runtime.nowMs,
    randomBytes: (length) => new Uint8Array(length).fill(1),
  });
  return { runtime, operation };
}

describe("M3-F04 bounded exact-target review operation", () => {
  test("returns a validated selection without changing authority or delivering source", async () => {
    const adapter = new ReviewCdpAdapter({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: NONCE,
        selected: [{
          id: "alpha",
          version: "opaque-A",
          payloadSha256: DIGEST,
        }],
      },
    });
    const fixture = run({ adapter });
    const result = await runWithClockPump(fixture.runtime, fixture.operation);
    expect(result).toMatchObject({
      ok: true,
      operationId: "review-operation",
      selected: [{
        id: "alpha",
        version: "opaque-A",
        payloadSha256: DIGEST,
      }],
      sourceDelivered: false,
      authorityChanged: false,
      residualInventory: {
        callbacks: 0,
        sessions: 0,
        hasResidentControlPlane: false,
      },
    });
    expect(adapter.closed).toBe(true);
    expect(adapter.cleanupEvaluations).toBe(1);
  });

  test("cancel, malformed response, and target loss never authorize", async () => {
    const fixtures = [
      {
        adapter: new ReviewCdpAdapter({
          status: "cancelled",
          reason: "cancelled",
        }),
        code: "plugin.review.cancelled",
      },
      {
        adapter: new ReviewCdpAdapter({
          status: "submitted",
          payload: {
            schemaVersion: 1,
            nonce: NONCE,
            selected: [{
              id: "alpha",
              version: "opaque-A",
              payloadSha256: DIGEST.toUpperCase(),
            }],
          },
        }),
        code: "plugin.review.unreviewed-selection",
      },
      {
        adapter: Object.assign(new ReviewCdpAdapter(null), {
          evaluationMode: "target-lost" as const,
        }),
        code: "target_identity_drift",
      },
    ];
    for (const fixture of fixtures) {
      const running = run({ adapter: fixture.adapter });
      const result = await runWithClockPump(running.runtime, running.operation);
      expect(result).toMatchObject({
        ok: false,
        code: fixture.code,
        sourceDelivered: false,
        authorityChanged: false,
      });
      expect(fixture.adapter.closed).toBe(true);
      expect(fixture.adapter.cleanupEvaluations).toBe(1);
    }
  });

  test("late submitted response identifies pending capability cleanup", async () => {
    const adapter = new ReviewCdpAdapter({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: NONCE,
        selected: [{
          id: "alpha",
          version: "opaque-A",
          payloadSha256: DIGEST,
        }],
      },
    });
    let read = 0;
    const fixture = run({
      adapter,
      timeoutMs: 1_000,
      nowMs: () => read++ === 0 ? 1_000 : 2_000,
    });
    const result = await runWithClockPump(fixture.runtime, fixture.operation);
    expect(result).toMatchObject({
      ok: false,
      code: "plugin.review.expired",
      cleanupProtocol: {
        nonce: NONCE,
        target: {
          targetId: TARGET.id,
          executionContextUniqueId: CONTEXT.uniqueId,
        },
      },
    });
  });

  test("timeout interrupts the wait, closes the session, and returns no authority", async () => {
    const adapter = new ReviewCdpAdapter(null);
    adapter.evaluationMode = "hang";
    const fixture = run({ adapter, timeoutMs: 50 });
    const result = await runWithClockPump(fixture.runtime, fixture.operation, {
      stepMs: 10,
      maxSteps: 1_000,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "operation_timeout",
      details: {
        stage: "cdp-evaluation",
        boundMs: 50,
      },
      sourceDelivered: false,
      authorityChanged: false,
    });
    expect(adapter.closed).toBe(true);
    expect(adapter.cleanupEvaluations).toBe(1);
  });

  test("SIGINT abandons the renderer wait and closes the exact session without authority", async () => {
    const adapter = new ReviewCdpAdapter(null);
    adapter.evaluationMode = "hang";
    const fixture = run({ adapter, timeoutMs: 1_000 });
    await Promise.resolve();
    await Promise.resolve();
    fixture.runtime.emitSignal("SIGINT");
    const result = await runWithClockPump(fixture.runtime, fixture.operation, {
      stepMs: 10,
      maxSteps: 1_000,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "operation_interrupted",
      sourceDelivered: false,
      authorityChanged: false,
    });
    expect(adapter.closed).toBe(true);
    expect(adapter.cleanupEvaluations).toBe(0);
  });

  test("caller interruption after callback install actively cancels renderer review", async () => {
    const adapter = new ReviewCdpAdapter(null);
    adapter.evaluationMode = "hang";
    const abort = new AbortController();
    const fixture = run({
      adapter,
      timeoutMs: 1_000,
      signal: abort.signal,
    });
    await adapter.evaluationStarted;
    abort.abort();
    const result = await runWithClockPump(fixture.runtime, fixture.operation, {
      stepMs: 10,
      maxSteps: 1_000,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "operation_interrupted",
      details: {
        residualInventory: {
          callbacks: 0,
          sessions: 0,
          hasResidentControlPlane: false,
        },
      },
    });
    expect(adapter.cleanupEvaluations).toBe(1);
    expect(adapter.closed).toBe(true);
  });
});
