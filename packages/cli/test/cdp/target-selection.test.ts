import { describe, expect, test } from "bun:test";
import {
  inspectCompatibleEndpoint,
  runExactTargetOperation,
  selectExactPageAndContext,
  TargetingError,
  type CdpAdapter,
  type CdpExecutionContext,
  type CdpTarget,
  type TargetSelectionRejectionCode,
} from "../../src/cdp/index.ts";
import { CANONICAL_BUNDLE_PATH, CANONICAL_EXECUTABLE_NAME } from "../../src/host/constants.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import type {
  DeclaredRoleEndpoint,
  ListenerObservation,
  VerifiedProcess,
} from "../../src/host/status.ts";
import { createFakeRuntimeHarness, runWithClockPump } from "../runtime/fixture-runtime.ts";

const EXECUTABLE = `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`;
const START_MAIN = "2026-07-25T12:00:00.000000000Z";
const START_DEV = "2026-07-25T12:00:01.000000000Z";

const HOST: HostIdentity = {
  bundlePath: CANONICAL_BUNDLE_PATH,
  executablePath: EXECUTABLE,
  bundleId: "com.openai.codex",
  executableName: "ChatGPT",
  signingTeam: "2DC432GLL2",
  appVersion: "26.715.61943",
  appBuild: "5628",
  hostHashes: {
    "Contents/Info.plist": "a".repeat(64),
    "Contents/MacOS/ChatGPT": "b".repeat(64),
    "Contents/Resources/app.asar": "c".repeat(64),
  },
};

function process(role: "main" | "development"): VerifiedProcess {
  return {
    pid: role === "main" ? 4100 : 4200,
    parentPid: 1,
    processStartedAt: role === "main" ? START_MAIN : START_DEV,
    executablePath: EXECUTABLE,
    arguments: [EXECUTABLE],
  };
}

function listener(role: "main" | "development", pid = process(role).pid): ListenerObservation {
  return {
    pid,
    processStartedAt: role === "main" ? START_MAIN : START_DEV,
    host: "127.0.0.1",
    port: role === "main" ? 9333 : 9444,
    family: "ipv4",
  };
}

function endpoint(role: "main" | "development"): DeclaredRoleEndpoint {
  return {
    host: "127.0.0.1",
    port: role === "main" ? 9333 : 9444,
  };
}

function page(id: string, url = "app://-/index.html", type = "page"): CdpTarget {
  return {
    id,
    type,
    url,
    title: `target-${id}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}`,
  };
}

function context(
  id: number,
  targetId: string,
  isDefault = true,
  overrides: Partial<CdpExecutionContext> = {},
): CdpExecutionContext {
  return {
    id,
    uniqueId: `unique-${targetId}-${id}`,
    targetId,
    frameId: `frame-${targetId}`,
    isDefault,
    origin: "app://-",
    name: "",
    ...overrides,
  };
}

class FixtureCdpAdapter implements CdpAdapter {
  readonly evaluations: Array<{
    targetId: string;
    contextId: number;
    contextUniqueId: string;
    expression: string;
  }> = [];
  readonly closeLog: string[] = [];
  readonly endpointReads: Array<number> = [];
  readonly sessionReads: string[] = [];
  targets: CdpTarget[];
  contexts: Record<string, CdpExecutionContext[]>;
  browser = "Chrome/150.0.7871.124";
  protocolVersion = "1.3";
  endpointPid: number;
  beforeEvaluate: (() => void) | null = null;
  beforeSessionReturn: (() => Promise<void>) | null = null;
  beforeListExecutionContexts: (() => Promise<void>) | null = null;
  evaluationError: Error | null = null;
  operationSentinels = new Map<string, string[]>();

  constructor(options: {
    targets?: CdpTarget[];
    contexts?: Record<string, CdpExecutionContext[]>;
    endpointPid?: number;
  } = {}) {
    this.targets = options.targets ?? [page("PAGE-1")];
    this.contexts = options.contexts ?? { "PAGE-1": [context(91, "PAGE-1")] };
    this.endpointPid = options.endpointPid ?? 4100;
  }

  async readEndpoint(input: { port: 9333 | 9444 }) {
    this.endpointReads.push(input.port);
    return {
      browser: this.browser,
      protocolVersion: this.protocolVersion,
      webSocketDebuggerUrl: `ws://127.0.0.1:${input.port}/devtools/browser/BROWSER-1`,
      pid: this.endpointPid,
    };
  }

  async listTargets() {
    return this.targets.map((target) => ({ ...target }));
  }

  async openTargetSession(input: {
    target: CdpTarget;
    onSessionOpened?(session: Awaited<ReturnType<CdpAdapter["openTargetSession"]>>): void;
  }) {
    const targetId = input.target.id;
    this.sessionReads.push(targetId);
    let closed = false;
    const session = {
      targetId,
      isOpen: () => !closed,
      listExecutionContexts: async () => {
        await this.beforeListExecutionContexts?.();
        return (this.contexts[targetId] ?? []).map((item) => ({ ...item }));
      },
      evaluate: async (input: {
        executionContextId: number;
        executionContextUniqueId: string;
        expression: string;
      }) => {
        this.beforeEvaluate?.();
        if (this.evaluationError !== null) throw this.evaluationError;
        this.evaluations.push({
          targetId,
          contextId: input.executionContextId,
          contextUniqueId: input.executionContextUniqueId,
          expression: input.expression,
        });
        const owner = input.expression.split(":", 1)[0] ?? "unknown";
        const list = this.operationSentinels.get(owner) ?? [];
        list.push(targetId);
        this.operationSentinels.set(owner, list);
        return { value: `${owner}@${targetId}` };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.closeLog.push(targetId);
      },
    };
    try {
      input.onSessionOpened?.(session);
    } catch (error: unknown) {
      await session.close();
      throw error;
    }
    await this.beforeSessionReturn?.();
    return session;
  }
}

function fixture(options: {
  role?: "main" | "development";
  adapter?: FixtureCdpAdapter;
  currentHost?: HostIdentity;
  currentProcess?: VerifiedProcess;
  currentListener?: ListenerObservation;
} = {}) {
  const role = options.role ?? "main";
  const expectedProcess = process(role);
  const adapter = options.adapter ?? new FixtureCdpAdapter({ endpointPid: expectedProcess.pid });
  const current = {
    host: options.currentHost ?? HOST,
    process: options.currentProcess ?? expectedProcess,
    listener: options.currentListener ?? listener(role),
  };
  return {
    role,
    expectedProcess,
    adapter,
    current,
    revalidate: async () => ({
      host: current.host,
      process: { ...current.process, arguments: [...current.process.arguments] },
      listener: { ...current.listener },
    }),
  };
}

describe("exact target and context selection", () => {
  test("selects exactly one app page/default context and ignores nonmatching targets", () => {
    const result = selectExactPageAndContext({
      targets: [
        page("WORKER-1", "app://-/index.html", "worker"),
        page("HTTP-1", "https://example.com/"),
        page("APP-1"),
        page("DEVTOOLS-1", "devtools://devtools/bundled/inspector.html"),
      ],
      contextsByTarget: {
        "APP-1": [context(18, "APP-1", false), context(19, "APP-1", true)],
      },
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected target selection");
    expect(result.target.id).toBe("APP-1");
    expect(result.context).toMatchObject({
      id: 19,
      uniqueId: "unique-APP-1-19",
      targetId: "APP-1",
      frameId: "frame-APP-1",
    });
    expect(result.ignoredTargetIds).toEqual(["WORKER-1", "HTTP-1", "DEVTOOLS-1"]);
  });

  test("keeps frame IDs separate from the selected target ID", () => {
    const result = selectExactPageAndContext({
      targets: [page("APP-1")],
      contextsByTarget: {
        "APP-1": [context(19, "APP-1", true, { frameId: "FRAME-9" })],
      },
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected target selection");
    expect(result.context.targetId).toBe("APP-1");
    expect(result.context.frameId).toBe("FRAME-9");
  });

  const rejectionCases: Array<{
    targets: CdpTarget[];
    contexts: Record<string, CdpExecutionContext[]>;
    code: TargetSelectionRejectionCode;
  }> = [
    { targets: [page("HTTP", "https://example.com/")], contexts: {}, code: "target_not_found" },
    {
      targets: [page("A"), page("B")],
      contexts: { A: [context(1, "A")], B: [context(2, "B")] },
      code: "target_ambiguous",
    },
    { targets: [page("A")], contexts: { A: [] }, code: "context_not_found" },
    {
      targets: [page("A")],
      contexts: { A: [context(1, "A"), context(2, "A")] },
      code: "context_ambiguous",
    },
  ];

  test.each(rejectionCases)("fails closed with $code", ({ targets, contexts, code }) => {
    const result = selectExactPageAndContext({ targets, contextsByTarget: contexts });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("expected rejection");
    expect(result.code).toBe(code);
  });

  const endpointContextRejections: Array<{
    contexts: Record<string, CdpExecutionContext[]>;
    code: "context_not_found" | "context_ambiguous";
  }> = [
    { contexts: { "PAGE-1": [] }, code: "context_not_found" },
    {
      contexts: { "PAGE-1": [context(91, "PAGE-1"), context(92, "PAGE-1")] },
      code: "context_ambiguous",
    },
  ];

  test.each(endpointContextRejections)("endpoint inspection preserves $code diagnostics", async ({ contexts, code }) => {
    const scenario = fixture({ adapter: new FixtureCdpAdapter({ contexts }) });
    const result = await inspectCompatibleEndpoint({
      role: scenario.role,
      endpoint: endpoint(scenario.role),
      process: scenario.expectedProcess,
      host: HOST,
      cdp: scenario.adapter,
    });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("expected endpoint rejection");
    expect(result.code).toBe(code);
    expect(result.details).toEqual(expect.objectContaining({ code }));
  });

  test("an exact URL is insufficient when endpoint PID mismatches", async () => {
    const scenario = fixture({ adapter: new FixtureCdpAdapter({ endpointPid: 9999 }) });
    const result = await inspectCompatibleEndpoint({
      role: scenario.role,
      endpoint: endpoint(scenario.role),
      process: scenario.expectedProcess,
      host: HOST,
      cdp: scenario.adapter,
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe("identity-mismatch");
    expect(scenario.adapter.sessionReads).toEqual([]);
    expect(scenario.adapter.evaluations).toEqual([]);
  });
});

describe("point-of-use identity revalidation", () => {
  test.each([
    {
      name: "host build drift",
      mutate: (scenario: ReturnType<typeof fixture>) => {
        scenario.current.host = { ...HOST, appBuild: "5629" };
      },
      code: "host_identity_drift" as const,
    },
    {
      name: "process start drift",
      mutate: (scenario: ReturnType<typeof fixture>) => {
        scenario.current.process = { ...scenario.expectedProcess, processStartedAt: "reused-pid" };
      },
      code: "process_identity_drift" as const,
    },
    {
      name: "port owner drift",
      mutate: (scenario: ReturnType<typeof fixture>) => {
        scenario.current.listener = listener(scenario.role, 9999);
      },
      code: "port_owner_drift" as const,
    },
    {
      name: "target replacement",
      mutate: (scenario: ReturnType<typeof fixture>) => {
        scenario.adapter.targets = [page("PAGE-2")];
        scenario.adapter.contexts = { "PAGE-2": [context(92, "PAGE-2")] };
      },
      code: "target_identity_drift" as const,
    },
    {
      name: "context replacement",
      mutate: (scenario: ReturnType<typeof fixture>) => {
        scenario.adapter.contexts = { "PAGE-1": [context(92, "PAGE-1")] };
      },
      code: "context_identity_drift" as const,
    },
    {
      name: "context unique identity replacement",
      mutate: (scenario: ReturnType<typeof fixture>) => {
        scenario.adapter.contexts = {
          "PAGE-1": [context(91, "PAGE-1", true, { uniqueId: "replacement-context" })],
        };
      },
      code: "context_identity_drift" as const,
    },
  ])("$name stops before evaluation and never reconnects", async ({ mutate, code }) => {
    const scenario = fixture();
    const runtime = createFakeRuntimeHarness({
      self: { pid: 8001, processStartedAt: "operation-start" },
    });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    const result = await runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: `op-${code}`,
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-a",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: async () => {
        mutate(scenario);
        return scenario.revalidate();
      },
      evaluate: { expression: `op-${code}:sentinel` },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected drift failure");
    expect(result.error.code).toBe(code);
    expect(result.error.stage).toBe("cdp-evaluation");
    expect(result.error.details).toEqual(expect.objectContaining({
      pointOfUse: expect.any(Object),
    }));
    expect(result.partial.lastCompletedStage).toBe("cdp-discovery");
    expect(scenario.adapter.evaluations).toEqual([]);
    expect(scenario.adapter.sessionReads[0]).toBe("PAGE-1");
    const expectedSessionReads = code === "host_identity_drift" || code === "process_identity_drift" || code === "port_owner_drift"
      ? 1
      : 2;
    expect(scenario.adapter.sessionReads).toHaveLength(expectedSessionReads);
    expect(scenario.adapter.closeLog.filter((targetId) => targetId === "PAGE-1").length).toBeGreaterThanOrEqual(1);
  });

  test("discovery timeout after session open still closes the registered websocket", async () => {
    const scenario = fixture();
    scenario.adapter.beforeSessionReturn = () => new Promise<void>(() => undefined);
    const runtime = createFakeRuntimeHarness({ self: { pid: 8004, processStartedAt: "operation-start" } });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    const operation = runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: "op-discovery-timeout",
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-a",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: scenario.revalidate,
      evaluate: { expression: "op-discovery-timeout:sentinel" },
    });
    // Pump stage timeout plus the post-timeout settlement fence.
    const result = await runWithClockPump(runtime, operation, { stepMs: 500, maxSteps: 40 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected discovery timeout");
    expect(result.error).toMatchObject({
      code: "operation_timeout",
      stage: "cdp-discovery",
      boundMs: 10_000,
    });
    expect(scenario.adapter.closeLog).toEqual(["PAGE-1"]);
    expect(result.residualInventory.sessions).toBe(0);
  });

  test("M1-F03R: late open after discovery timeout closes session when registration throws", async () => {
    const scenario = fixture();
    const runtime = createFakeRuntimeHarness({ self: { pid: 8010, processStartedAt: "operation-start" } });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    // Delay open until after the discovery stage timeout so registration races
    // terminal cleanup; the adapter must still close the unreachable session.
    const originalOpen = scenario.adapter.openTargetSession.bind(scenario.adapter);
    let openStarted = false;
    scenario.adapter.openTargetSession = async (input) => {
      openStarted = true;
      await new Promise<void>((resolve) => {
        runtime.adapters.timers.setTimeout(resolve, 12_000);
      });
      return originalOpen(input);
    };
    const operation = runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: "op-late-open-registration",
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-late-open",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: scenario.revalidate,
      evaluate: { expression: "op-late-open:sentinel" },
    });
    // Pump through discovery timeout + settlement fence + delayed open completion.
    const result = await runWithClockPump(runtime, operation, { stepMs: 500, maxSteps: 60 });

    expect(openStarted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected discovery timeout");
    expect(
      result.error.code === "operation_timeout" ||
        result.error.code === "operation_failed" ||
        result.error.code === "cleanup_failed",
    ).toBe(true);
    // No unreachable session/websocket remains after late open/registration.
    expect(scenario.adapter.closeLog).toEqual(["PAGE-1"]);
    expect(result.residualInventory.sessions).toBe(0);
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
  });

  test.each([
    { phase: "discovery" as const, stage: "cdp-discovery" as const },
    { phase: "reinspection" as const, stage: "cdp-evaluation" as const },
  ])("plain adapter failure during $phase retains $stage", async ({ phase, stage }) => {
    const scenario = fixture();
    const runtime = createFakeRuntimeHarness({ self: { pid: 8006, processStartedAt: "operation-start" } });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    let endpointReads = 0;
    const originalReadEndpoint = scenario.adapter.readEndpoint.bind(scenario.adapter);
    scenario.adapter.readEndpoint = async (input) => {
      endpointReads += 1;
      if (phase === "discovery" || endpointReads > 1) throw new Error(`${phase} endpoint failed`);
      return originalReadEndpoint(input);
    };
    const result = await runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: `op-${phase}-failure`,
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-a",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: scenario.revalidate,
      evaluate: { expression: `op-${phase}-failure:sentinel` },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected adapter failure");
    expect(result.error).toMatchObject({ code: "operation_failed", stage });
    expect(result.error.details).toEqual(expect.objectContaining({
      cause: expect.objectContaining({ message: `${phase} endpoint failed` }),
    }));
  });

  test("rejection retains context code, evaluation stage, and candidate details", async () => {
    const scenario = fixture();
    const runtime = createFakeRuntimeHarness({ self: { pid: 8003, processStartedAt: "operation-start" } });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    const result = await runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: "op-context-ambiguous",
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-a",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: async () => {
        scenario.adapter.contexts = {
          "PAGE-1": [context(91, "PAGE-1"), context(92, "PAGE-1")],
        };
        return scenario.revalidate();
      },
      evaluate: { expression: "op-context-ambiguous:sentinel" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected context rejection");
    expect(result.error).toMatchObject({
      code: "context_ambiguous",
      stage: "cdp-evaluation",
    });
    expect(result.error.details).toEqual(expect.objectContaining({
      inspection: expect.objectContaining({
        code: "context_ambiguous",
        details: expect.objectContaining({ candidates: expect.any(Array) }),
      }),
    }));
  });

  test("evaluation adapter failures retain cdp-evaluation stage details", async () => {
    const scenario = fixture();
    scenario.adapter.evaluationError = new Error("fixture exceptionDetails");
    const runtime = createFakeRuntimeHarness({ self: { pid: 8005, processStartedAt: "operation-start" } });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    const result = await runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: "op-evaluation-protocol-error",
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-a",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: scenario.revalidate,
      evaluate: { expression: "op-evaluation-protocol-error:sentinel" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected evaluation failure");
    expect(result.error).toMatchObject({
      code: "operation_failed",
      stage: "cdp-evaluation",
    });
    expect(result.error.details).toEqual(expect.objectContaining({
      target: expect.objectContaining({ targetId: "PAGE-1" }),
      cause: expect.objectContaining({ message: "fixture exceptionDetails" }),
    }));
  });

  test("each evaluation revalidates identity and reports exact target/context", async () => {
    const scenario = fixture();
    const runtime = createFakeRuntimeHarness({ self: { pid: 8002, processStartedAt: "operation-start" } });
    runtime.setProcessAlive(scenario.expectedProcess.pid, scenario.expectedProcess.processStartedAt, true);
    let revalidationCount = 0;
    const result = await runExactTargetOperation({
      runtime: runtime.adapters,
      operationId: "op-exact",
      operation: "fixture-evaluate",
      role: scenario.role,
      homeIdentity: "/tmp/home-a",
      host: HOST,
      process: scenario.expectedProcess,
      endpoint: endpoint(scenario.role),
      cdp: scenario.adapter,
      revalidate: async () => {
        revalidationCount += 1;
        return scenario.revalidate();
      },
      evaluate: { expression: "op-exact:sentinel" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(revalidationCount).toBe(1);
    expect(result.result.target).toMatchObject({
      targetId: "PAGE-1",
      executionContextId: 91,
      executionContextUniqueId: "unique-PAGE-1-91",
    });
    expect(result.result.evaluation.value).toBe("op-exact@PAGE-1");
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
    expect(scenario.adapter.evaluations).toEqual([{
      targetId: "PAGE-1",
      contextId: 91,
      contextUniqueId: "unique-PAGE-1-91",
      expression: "op-exact:sentinel",
    }]);
    expect(scenario.adapter.closeLog).toEqual(["PAGE-1", "PAGE-1"]);
  });
});

describe("cross-operation target isolation", () => {
  test("concurrent homes and roles keep ports, targets, contexts, callbacks, and results isolated", async () => {
    const mainAdapter = new FixtureCdpAdapter({
      endpointPid: 4100,
      targets: [page("MAIN-PAGE")],
      contexts: { "MAIN-PAGE": [context(101, "MAIN-PAGE")] },
    });
    mainAdapter.targets[0] = { ...mainAdapter.targets[0], webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/MAIN-PAGE" };
    const devAdapter = new FixtureCdpAdapter({
      endpointPid: 4200,
      targets: [page("DEV-PAGE")],
      contexts: { "DEV-PAGE": [context(202, "DEV-PAGE")] },
    });
    devAdapter.targets[0] = { ...devAdapter.targets[0], webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/DEV-PAGE" };
    const mainScenario = fixture({ role: "main", adapter: mainAdapter });
    const devScenario = fixture({ role: "development", adapter: devAdapter });
    const mainRuntime = createFakeRuntimeHarness({ self: { pid: 8101, processStartedAt: "main-operation" } });
    const devRuntime = createFakeRuntimeHarness({ self: { pid: 8102, processStartedAt: "dev-operation" } });
    mainRuntime.setProcessAlive(4100, START_MAIN, true);
    devRuntime.setProcessAlive(4200, START_DEV, true);

    const [mainResult, devResult] = await Promise.all([
      runExactTargetOperation({
        runtime: mainRuntime.adapters,
        operationId: "main-op",
        operation: "fixture-evaluate",
        role: "main",
        homeIdentity: "/tmp/home-main",
        host: HOST,
        process: mainScenario.expectedProcess,
        endpoint: endpoint("main"),
        cdp: mainAdapter,
        revalidate: mainScenario.revalidate,
        evaluate: { expression: "main-op:sentinel", callbackIdentity: "callback-main" },
      }),
      runExactTargetOperation({
        runtime: devRuntime.adapters,
        operationId: "dev-op",
        operation: "fixture-evaluate",
        role: "development",
        homeIdentity: "/tmp/home-dev",
        host: HOST,
        process: devScenario.expectedProcess,
        endpoint: endpoint("development"),
        cdp: devAdapter,
        revalidate: devScenario.revalidate,
        evaluate: { expression: "dev-op:sentinel", callbackIdentity: "callback-dev" },
      }),
    ]);

    expect(mainResult.ok).toBe(true);
    expect(devResult.ok).toBe(true);
    if (!mainResult.ok || !devResult.ok) throw new Error("expected both operations to pass");
    expect(mainResult.result.operationBinding).toEqual({
      operationId: "main-op",
      homeIdentity: "/tmp/home-main",
      role: "main",
      port: 9333,
      callbackIdentity: "callback-main",
    });
    expect(devResult.result.operationBinding).toEqual({
      operationId: "dev-op",
      homeIdentity: "/tmp/home-dev",
      role: "development",
      port: 9444,
      callbackIdentity: "callback-dev",
    });
    expect(mainResult.result.target).toMatchObject({
      targetId: "MAIN-PAGE",
      executionContextId: 101,
      executionContextUniqueId: "unique-MAIN-PAGE-101",
    });
    expect(devResult.result.target).toMatchObject({
      targetId: "DEV-PAGE",
      executionContextId: 202,
      executionContextUniqueId: "unique-DEV-PAGE-202",
    });
    expect(mainAdapter.evaluations).toEqual([{
      targetId: "MAIN-PAGE",
      contextId: 101,
      contextUniqueId: "unique-MAIN-PAGE-101",
      expression: "main-op:sentinel",
    }]);
    expect(devAdapter.evaluations).toEqual([{
      targetId: "DEV-PAGE",
      contextId: 202,
      contextUniqueId: "unique-DEV-PAGE-202",
      expression: "dev-op:sentinel",
    }]);
    expect(mainAdapter.operationSentinels.get("main-op")).toEqual(["MAIN-PAGE"]);
    expect(devAdapter.operationSentinels.get("dev-op")).toEqual(["DEV-PAGE"]);
  });

  test("targeting errors retain stable structured codes", () => {
    const error = new TargetingError("target_ambiguous", "two targets", { candidateIds: ["A", "B"] });
    expect(error.code).toBe("target_ambiguous");
    expect(error.details).toEqual({ candidateIds: ["A", "B"] });
  });
});
