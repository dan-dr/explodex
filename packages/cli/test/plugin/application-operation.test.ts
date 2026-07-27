import { describe, expect, test } from "bun:test";
import type {
  CdpAdapter,
  CdpTargetSession,
} from "../../src/cdp/adapters.ts";
import type {
  CdpExecutionContext,
  CdpTarget,
  TargetIdentity,
} from "../../src/cdp/types.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import type {
  ListenerObservation,
  VerifiedProcess,
} from "../../src/host/status.ts";
import {
  runApprovedPluginApplicationOperation,
} from "../../src/plugin/application-operation.ts";
import type {
  PluginPayloadSnapshot,
} from "../../src/plugin/approval-transaction.ts";
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
  pid: 4300,
  parentPid: 1,
  processStartedAt: "2026-07-27T10:00:00.000Z",
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
  id: "PAGE-APPROVAL",
  type: "page",
  url: "app://-/index.html",
  title: "ChatGPT",
  webSocketDebuggerUrl:
    "ws://127.0.0.1:9444/devtools/page/PAGE-APPROVAL",
};
const CONTEXT: CdpExecutionContext = {
  id: 21,
  uniqueId: "context-approval",
  targetId: TARGET.id,
  frameId: "frame-approval",
  isDefault: true,
  origin: "app://-",
  name: "",
};
const TARGET_IDENTITY: TargetIdentity = {
  role: "development",
  pid: PROCESS.pid,
  processStartedAt: PROCESS.processStartedAt,
  executablePath: EXECUTABLE,
  appVersion: HOST.appVersion,
  appBuild: HOST.appBuild,
  port: 9444,
  browserIdentity: "Chrome/136",
  targetId: TARGET.id,
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: CONTEXT.id,
  executionContextUniqueId: CONTEXT.uniqueId,
  frameId: CONTEXT.frameId,
};

class ApplicationCdpAdapter implements CdpAdapter {
  closed = false;
  evaluations = 0;
  expressions: string[] = [];

  constructor(readonly outcome: unknown) {}

  async readEndpoint() {
    return {
      browser: "Chrome/136",
      protocolVersion: "1.3",
      webSocketDebuggerUrl:
        "ws://127.0.0.1:9444/devtools/browser/BROWSER-APPROVAL",
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
        this.evaluations += 1;
        this.expressions.push(request.expression);
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

function snapshot(lifecycle: "dynamic" | "renderer-start" = "dynamic"):
  PluginPayloadSnapshot {
  const files = new Map<string, Uint8Array>([
    [
      "index.js",
      new TextEncoder().encode(
        `globalThis.__EXPLODEX_PRIVATE_REGISTER__("alpha", { setup() { globalThis.__APPROVAL_SOURCE_SENTINEL__ = true; } });\n`,
      ),
    ],
    ["assets/notice.txt", new TextEncoder().encode("ASSET_SENTINEL")],
  ]);
  return Object.freeze({
    identity: Object.freeze({
      id: "alpha",
      version: "opaque-v1",
      payloadSha256: DIGEST,
    }),
    manifest: {
      schemaVersion: 1,
      id: "alpha",
      version: "opaque-v1",
      displayName: "Alpha",
      description: "Approval fixture",
      sdkRange: "^1.2.0",
      lifecycle,
      entry: "index.js",
      assets: ["assets/notice.txt"],
    },
    files: [...files.keys()],
    read(path: string) {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing fixture file");
      return new Uint8Array(value);
    },
  });
}

function run(options: {
  adapter: ApplicationCdpAdapter;
  expectedTarget?: TargetIdentity;
  snapshots?: PluginPayloadSnapshot[];
  revalidate?: () => Promise<{
    host: HostIdentity;
    process: VerifiedProcess;
    listener: ListenerObservation;
  }>;
}) {
  const runtime = createFakeRuntimeHarness({
    startMs: 10_000,
    self: { pid: 8001, processStartedAt: "approval-operation" },
  });
  runtime.setProcessAlive(PROCESS.pid, PROCESS.processStartedAt, true);
  const operation = runApprovedPluginApplicationOperation({
    runtime: runtime.adapters,
    operationId: "approval-operation",
    nonce: "approval-nonce",
    activationSecret: "b".repeat(64),
    role: "development",
    homeIdentity: "/tmp/approval-home",
    host: HOST,
    process: PROCESS,
    endpoint: { host: "127.0.0.1", port: 9444 },
    cdp: options.adapter,
    expectedTarget: options.expectedTarget ?? TARGET_IDENTITY,
    revalidate: options.revalidate ?? (async () => ({
      host: HOST,
      process: PROCESS,
      listener: LISTENER,
    })),
    sdkRuntimeSource: "globalThis.Explodex = globalThis.Explodex;",
    snapshots: options.snapshots ?? [snapshot()],
    timeoutMs: 1_000,
  });
  return { runtime, operation };
}

describe("M3-F05 exact snapshot target application", () => {
  test("evaluates selected source and assets only from the accepted snapshot", async () => {
    const adapter = new ApplicationCdpAdapter({
      schemaVersion: 1,
      applications: [{
        schemaVersion: 1,
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
        status: "applied",
        boundary: "none",
        setupCount: 1,
      }],
    });
    const fixture = run({ adapter });
    const result = await runWithClockPump(fixture.runtime, fixture.operation);
    expect(result).toMatchObject({
      ok: true,
      sourceDelivered: true,
      applications: [{ status: "applied", setupCount: 1 }],
      residualInventory: {
        callbacks: 0,
        sessions: 0,
        hasResidentControlPlane: false,
      },
    });
    const evaluatedSource = adapter.expressions.join("\n");
    expect(evaluatedSource).toContain("__APPROVAL_SOURCE_SENTINEL__");
    expect(evaluatedSource).toContain(
      "65,83,83,69,84,95,83,69,78,84,73,78,69,76",
    );
    expect(evaluatedSource).not.toContain("/tmp/approval-home");
    expect(evaluatedSource).toContain("__explodexFinalizeApprovedOperation");
    expect(adapter.closed).toBe(true);
  });

  test("review target drift prevents evaluation and closes the session", async () => {
    const adapter = new ApplicationCdpAdapter(null);
    const fixture = run({
      adapter,
      expectedTarget: {
        ...TARGET_IDENTITY,
        executionContextUniqueId: "replaced-context",
      },
    });
    const result = await runWithClockPump(fixture.runtime, fixture.operation);
    expect(result.ok).toBe(false);
    expect(adapter.evaluations).toBe(0);
    expect(adapter.closed).toBe(true);
  });

  test("point-of-use host drift reports no source delivery", async () => {
    const adapter = new ApplicationCdpAdapter(null);
    const fixture = run({
      adapter,
      revalidate: async () => ({
        host: { ...HOST, appBuild: "drifted" },
        process: PROCESS,
        listener: LISTENER,
      }),
    });
    const result = await runWithClockPump(fixture.runtime, fixture.operation);
    expect(result).toMatchObject({
      ok: false,
      code: "host_identity_drift",
      sourceDelivered: false,
    });
    expect(adapter.evaluations).toBe(1);
    expect(adapter.closed).toBe(true);
  });

  test("restart lifecycle revokes its grant without delivering plugin source or assets", async () => {
    const adapter = new ApplicationCdpAdapter({
      schemaVersion: 1,
      applications: [],
    });
    const fixture = run({
      adapter,
      snapshots: [snapshot("renderer-start")],
    });
    const result = await fixture.operation;
    expect(result).toMatchObject({
      ok: true,
      sourceDelivered: false,
      applications: [{
        status: "boundary-required",
        boundary: "renderer",
        setupCount: 0,
      }],
      residualInventory: {
        callbacks: 0,
        sessions: 0,
        hasResidentControlPlane: false,
      },
    });
    expect(adapter.evaluations).toBe(2);
    expect(adapter.expressions.join("\n")).not.toContain(
      "__APPROVAL_SOURCE_SENTINEL__",
    );
    expect(adapter.expressions.join("\n")).not.toContain("ASSET_SENTINEL");
    expect(adapter.closed).toBe(true);
  });

  test("malformed renderer response is truthful after source delivery and still cleans up", async () => {
    const adapter = new ApplicationCdpAdapter({ malformed: true });
    const fixture = run({ adapter });
    const result = await runWithClockPump(fixture.runtime, fixture.operation);
    expect(result).toMatchObject({
      ok: false,
      code: "plugin.approval.invalid-application-response",
      sourceDelivered: true,
      applications: [],
    });
    expect(adapter.evaluations).toBe(2);
    expect(adapter.closed).toBe(true);
  });
});
