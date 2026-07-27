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
import { runPluginUpdateReviewOperation } from "../../src/plugin/update-review-operation.ts";
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
  hostHashes: { "Contents/Info.plist": "b".repeat(64) },
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
  id: "PAGE-UPDATE",
  type: "page",
  url: "app://-/index.html",
  title: "ChatGPT",
  webSocketDebuggerUrl:
    "ws://127.0.0.1:9444/devtools/page/PAGE-UPDATE",
};
const CONTEXT: CdpExecutionContext = {
  id: 17,
  uniqueId: "context-update",
  targetId: TARGET.id,
  frameId: "frame-update",
  isDefault: true,
  origin: "app://-",
  name: "",
};
const NONCE = new Uint8Array(48).fill(1)
  .slice(12, 36)
  .reduce(
    (value, byte) => `${value}${byte.toString(16).padStart(2, "0")}`,
    "",
  );

class UpdateCdpAdapter implements CdpAdapter {
  closed = false;
  cleanupEvaluations = 0;

  constructor(readonly outcome: unknown) {}

  async readEndpoint() {
    return {
      browser: "Chrome/136",
      protocolVersion: "1.3",
      webSocketDebuggerUrl:
        "ws://127.0.0.1:9444/devtools/browser/BROWSER-UPDATE",
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
        if (request.expression.includes("controller.cancelExact(")) {
          this.cleanupEvaluations += 1;
          return { value: true };
        }
        expect(request.expression).toContain('"surface":"update"');
        expect(request.expression).toContain(
          '"enabledPluginIdentities":[{"id":"alpha"',
        );
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

async function run(outcome: unknown) {
  const runtime = createFakeRuntimeHarness({
    startMs: 1_000,
    self: { pid: 8000, processStartedAt: "operation-start" },
  });
  runtime.setProcessAlive(PROCESS.pid, PROCESS.processStartedAt, true);
  const adapter = new UpdateCdpAdapter(outcome);
  const operation = runPluginUpdateReviewOperation({
    runtime: runtime.adapters,
    operationId: "update-operation",
    role: "development",
    homeIdentity: "/tmp/update-home",
    host: HOST,
    process: PROCESS,
    endpoint: { host: "127.0.0.1", port: 9444 },
    cdp: adapter,
    revalidate: async () => ({
      host: HOST,
      process: PROCESS,
      listener: LISTENER,
    }),
    sdkRuntimeSource: "globalThis.Explodex = globalThis.Explodex;",
    artifacts: [{
      id: "alpha",
      displayName: "Alpha",
      description: "Exact selected update",
      version: "opaque-B",
      payloadSha256: DIGEST,
      sdkRange: "^0.2.0",
      sourceLabel: "GitHub release: alpha-B.tgz",
    }],
    enabledPluginIdentities: [{
      id: "alpha",
      version: "opaque-A",
      payloadSha256: "b".repeat(64),
    }],
    timeoutMs: 1_000,
    nowMs: runtime.nowMs,
    randomBytes: (length) => new Uint8Array(length).fill(1),
  });
  return {
    adapter,
    result: await runWithClockPump(runtime, operation),
  };
}

describe("M4-F03 exact-target update selection", () => {
  test("accepts one fresh exact update selection without delivering source", async () => {
    const { adapter, result } = await run({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: NONCE,
        selected: [{
          id: "alpha",
          version: "opaque-B",
          payloadSha256: DIGEST,
        }],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      selected: [{
        id: "alpha",
        version: "opaque-B",
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

  test("cancel and unreviewed identity remain non-authorizing", async () => {
    for (const testCase of [
      {
        outcome: { status: "cancelled", reason: "dismissed" },
        code: "plugin.update.cancelled",
      },
      {
        outcome: {
          status: "submitted",
          payload: {
            schemaVersion: 1,
            nonce: NONCE,
            selected: [{
              id: "alpha",
              version: "opaque-C",
              payloadSha256: DIGEST,
            }],
          },
        },
        code: "plugin.update.unreviewed-selection",
      },
    ]) {
      const { adapter, result } = await run(testCase.outcome);
      expect(result).toMatchObject({
        ok: false,
        code: testCase.code,
        sourceDelivered: false,
        authorityChanged: false,
      });
      expect(adapter.closed).toBe(true);
      expect(adapter.cleanupEvaluations).toBe(1);
    }
  });
});
