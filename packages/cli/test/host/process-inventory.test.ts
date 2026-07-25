import { describe, expect, test } from "bun:test";
import {
  collectHostStatus,
  formatHostStatusJson,
  roleEndpoint,
  type CdpAvailabilityInspector,
  type HostStatusAdapters,
  type ListenerObservation,
  type ProcessObservation,
} from "../../src/host/status.ts";
import {
  createNodePortInventoryAdapter,
  parseListenerInventory,
  parseProcessInventory,
  type ReadOnlyCommandRunner,
} from "../../src/host/process-adapters.ts";
import { CANONICAL_BUNDLE_PATH, CANONICAL_EXECUTABLE_NAME } from "../../src/host/constants.ts";
import type { ProcessIdentity } from "../../src/runtime/adapters.ts";

const EXECUTABLE = `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`;
const START = "2026-07-25T12:00:00.000000000Z";

function mainProcess(pid = 4100, overrides: Partial<ProcessObservation> = {}): ProcessObservation {
  return {
    pid,
    parentPid: 1,
    executablePath: EXECUTABLE,
    arguments: [EXECUTABLE],
    ...overrides,
  };
}

function listener(pid: number, overrides: Partial<ListenerObservation> = {}): ListenerObservation {
  return {
    pid,
    processStartedAt: START,
    host: "127.0.0.1",
    port: 9333,
    family: "ipv4",
    ...overrides,
  };
}

function createAdapters(options: {
  processes?: ProcessObservation[];
  listeners?: ListenerObservation[];
  identities?: Record<number, ProcessIdentity | null>;
} = {}): HostStatusAdapters & { endpointQueries: Array<{ role: string; pid: number; port: number }> } {
  const processes = options.processes ?? [];
  const listeners = options.listeners ?? [];
  const identities = options.identities ?? {};
  const endpointQueries: Array<{ role: string; pid: number; port: number }> = [];
  return {
    endpointQueries,
    process: {
      async list() {
        return processes.map((process) => ({ ...process, arguments: [...process.arguments] }));
      },
      async identify(pid) {
        const found = identities[pid];
        return found === undefined ? null : found === null ? null : { ...found };
      },
    },
    port: {
      async listenersFor(port) {
        return listeners.filter((candidate) => candidate.port === port).map((candidate) => ({ ...candidate }));
      },
    },
  };
}

function endpointInspector(options: {
  kind?:
    | "available"
    | "target-not-found"
    | "target-ambiguous"
    | "context-not-found"
    | "context-ambiguous"
    | "identity-mismatch";
  pid?: number;
  processStartedAt?: string;
} = {}): CdpAvailabilityInspector {
  return {
    async inspect(input) {
      (input.adapters as ReturnType<typeof createAdapters>).endpointQueries.push({
        role: input.role,
        pid: input.process.pid,
        port: input.endpoint.port,
      });
      const kind = options.kind ?? "available";
      if (kind === "identity-mismatch") {
        return {
          kind,
          browserIdentity: "Foreign/1.0",
          targets: [],
        };
      }
      if (kind !== "available") {
        const code = kind === "target-ambiguous"
          ? "target_ambiguous"
          : kind === "context-ambiguous"
            ? "context_ambiguous"
            : kind === "context-not-found"
              ? "context_not_found"
              : "target_not_found";
        return {
          kind: "rejected",
          code,
          browserIdentity: "Chrome/150.0",
          targets: [],
          details: { code, candidates: [] },
        };
      }
      return {
        kind: "available",
        target: {
          role: input.role,
          pid: options.pid ?? input.process.pid,
          processStartedAt: options.processStartedAt ?? input.process.processStartedAt,
          executablePath: EXECUTABLE,
          appVersion: "26.715.61943",
          appBuild: "5628",
          port: input.endpoint.port,
          browserIdentity: "Chrome/150.0.7871.124",
          targetId: "PAGE-1",
          targetType: "page",
          targetUrl: "app://-/index.html",
          executionContextId: 91,
          executionContextUniqueId: "unique-PAGE-1-91",
          frameId: "FRAME-1",
        },
        targets: [
          { id: "PAGE-1", type: "page", url: "app://-/index.html" },
        ],
      };
    },
  };
}

describe("read-only main classification and port obstruction", () => {
  test.each([
    {
      name: "no-main with free 9333",
      processes: [],
      listeners: [],
      expectedState: "no-main",
      expectedObstruction: "port-free",
      expectedQueries: 0,
    },
    {
      name: "no-main with foreign 9333 remains no-main",
      processes: [],
      listeners: [listener(9000)],
      expectedState: "no-main",
      expectedObstruction: "foreign-or-mismatched-endpoint",
      expectedQueries: 0,
    },
    {
      name: "plain-main with free 9333",
      processes: [mainProcess()],
      listeners: [],
      expectedState: "plain-main",
      expectedObstruction: "port-free",
      expectedQueries: 0,
    },
    {
      name: "plain-main with foreign 9333 remains plain-main",
      processes: [mainProcess()],
      listeners: [listener(9000)],
      expectedState: "plain-main",
      expectedObstruction: "foreign-or-mismatched-endpoint",
      expectedQueries: 0,
    },
  ])("$name", async ({ processes, listeners, expectedState, expectedObstruction, expectedQueries }) => {
    const identities: Record<number, ProcessIdentity> = {};
    for (const process of processes) identities[process.pid] = { pid: process.pid, processStartedAt: START };
    const adapters = createAdapters({ processes: [...processes], listeners: [...listeners], identities });
    const result = await collectHostStatus({ role: "main", adapters, inspectCdp: endpointInspector() });

    expect(result.mainState).toBe(expectedState);
    expect(result.endpointObstruction).toBe(expectedObstruction);
    expect(adapters.endpointQueries).toHaveLength(expectedQueries);
    expect(result.readOnly).toBe(true);
  });

  test("one exact process and renderer reports cdp-main with non-secret identity", async () => {
    const process = mainProcess();
    const adapters = createAdapters({
      processes: [process],
      listeners: [listener(process.pid)],
      identities: { [process.pid]: { pid: process.pid, processStartedAt: START } },
    });
    const result = await collectHostStatus({ role: "main", adapters, inspectCdp: endpointInspector() });

    expect(result.mainState).toBe("cdp-main");
    expect(result.endpointObstruction).toBe("matching-endpoint");
    expect(result.selectedTarget).toMatchObject({
      pid: process.pid,
      processStartedAt: START,
      port: 9333,
      targetId: "PAGE-1",
      targetUrl: "app://-/index.html",
      executionContextId: 91,
      executionContextUniqueId: "unique-PAGE-1-91",
      frameId: "FRAME-1",
    });
    expect(result.listeners).toEqual([
      expect.objectContaining({ pid: process.pid, processStartedAt: START }),
    ]);
    expect(adapters.endpointQueries).toEqual([{ role: "main", pid: process.pid, port: 9333 }]);
  });

  test("revalidates listener PID/start immediately before endpoint access", async () => {
    const main = mainProcess();
    let listenerReads = 0;
    let identityReads = 0;
    const endpointQueries: Array<{ role: string; pid: number; port: number }> = [];
    const adapters: HostStatusAdapters & { endpointQueries: typeof endpointQueries } = {
      endpointQueries,
      process: {
        async list() {
          return [{ ...main, arguments: [...main.arguments] }];
        },
        async identify(pid) {
          identityReads += 1;
          if (pid !== main.pid) return null;
          return {
            pid,
            processStartedAt: identityReads >= 4 ? "listener-reused" : START,
          };
        },
      },
      port: {
        async listenersFor() {
          listenerReads += 1;
          return [listener(main.pid, { processStartedAt: null })];
        },
      },
    };

    const result = await collectHostStatus({ role: "main", adapters, inspectCdp: endpointInspector() });

    expect(listenerReads).toBe(2);
    expect(result.mainState).toBe("plain-main");
    expect(result.endpointObstruction).toBe("foreign-or-mismatched-endpoint");
    expect(adapters.endpointQueries).toEqual([]);
  });

  test("multiple plausible mains are ambiguous without endpoint selection", async () => {
    const first = mainProcess(4100);
    const second = mainProcess(4200);
    const adapters = createAdapters({
      processes: [first, second],
      listeners: [listener(first.pid)],
      identities: {
        [first.pid]: { pid: first.pid, processStartedAt: START },
        [second.pid]: { pid: second.pid, processStartedAt: "2026-07-25T12:00:01.000000000Z" },
      },
    });
    const result = await collectHostStatus({ role: "main", adapters, inspectCdp: endpointInspector() });

    expect(result.mainState).toBe("ambiguous-main");
    expect(result.diagnostic.code).toBe("process_ambiguous");
    expect(result.processes).toHaveLength(2);
    expect(adapters.endpointQueries).toEqual([]);
  });

  test.each([
    { kind: "target-not-found" as const, code: "renderer_not_found" },
    { kind: "target-ambiguous" as const, code: "renderer_ambiguous" },
    { kind: "context-not-found" as const, code: "context_not_found" },
    { kind: "context-ambiguous" as const, code: "context_ambiguous" },
    { kind: "identity-mismatch" as const, code: "endpoint_identity_mismatch" },
  ])("distinct endpoint diagnostic for $kind", async ({ kind, code }) => {
    const process = mainProcess();
    const adapters = createAdapters({
      processes: [process],
      listeners: [listener(process.pid)],
      identities: { [process.pid]: { pid: process.pid, processStartedAt: START } },
    });
    const result = await collectHostStatus({ role: "main", adapters, inspectCdp: endpointInspector({ kind }) });

    expect(result.mainState).toBe("ambiguous-main");
    expect(result.diagnostic.code).toBe(code);
    expect(result.selectedTarget).toBeNull();
  });

  test.each([
    listener(4100, { host: "0.0.0.0" }),
    listener(4100, { host: "::" }),
    listener(4100, { host: "127.0.0.1", port: 9444 }),
  ])("wildcard or wrong-role listeners never become matching endpoints", async (candidate) => {
    const process = mainProcess();
    const adapters = createAdapters({
      processes: [process],
      listeners: [candidate],
      identities: { [process.pid]: { pid: process.pid, processStartedAt: START } },
    });
    const result = await collectHostStatus({ role: "main", adapters, inspectCdp: endpointInspector() });

    expect(result.mainState).toBe("plain-main");
    expect(result.endpointObstruction).toBe(candidate.port === 9333 ? "foreign-or-mismatched-endpoint" : "port-free");
    expect(adapters.endpointQueries).toEqual([]);
  });

  test("status repetition is normalized, read-only, and does not evaluate", async () => {
    const process = mainProcess();
    const adapters = createAdapters({
      processes: [process],
      listeners: [listener(process.pid)],
      identities: { [process.pid]: { pid: process.pid, processStartedAt: START } },
    });
    const inspector = endpointInspector();
    const first = await collectHostStatus({ role: "main", adapters, inspectCdp: inspector });
    const second = await collectHostStatus({ role: "main", adapters, inspectCdp: inspector });

    expect(formatHostStatusJson(first)).toEqual(formatHostStatusJson(second));
    expect(first.activity).toEqual({ launched: false, evaluated: false, wroteState: false, focused: false });
    expect(second.activity).toEqual(first.activity);
    expect(adapters.endpointQueries).toHaveLength(2);
  });
});

describe("declared role endpoints", () => {
  test("roles map only to exact loopback 9333 and 9444", () => {
    expect(roleEndpoint("main")).toEqual({ host: "127.0.0.1", port: 9333 });
    expect(roleEndpoint("development")).toEqual({ host: "127.0.0.1", port: 9444 });
  });

  test("production parser preserves exact executable and actual lsof field ownership facts", () => {
    const processes = parseProcessInventory([
      `4100 1 ${EXECUTABLE} --remote-debugging-port=9333`,
      "4200 1 /usr/bin/python3 server.py",
    ].join("\n"));
    const listeners = parseListenerInventory([
      "p4100",
      "f12",
      "n127.0.0.1:9333",
      "p4200",
      "f13",
      "n*:9333",
    ].join("\n"));

    expect(processes[0]).toMatchObject({
      pid: 4100,
      parentPid: 1,
      executablePath: EXECUTABLE,
      arguments: [EXECUTABLE, "--remote-debugging-port=9333"],
    });
    expect(listeners).toEqual([
      { pid: 4100, processStartedAt: null, host: "127.0.0.1", port: 9333, family: "ipv4" },
      { pid: 4200, processStartedAt: null, host: "*", port: 9333, family: "ipv4" },
    ]);
  });

  test("lsof exit 1 with empty output means the declared port is free", async () => {
    const commands: ReadOnlyCommandRunner = {
      async exec() {
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    await expect(createNodePortInventoryAdapter(commands).listenersFor(9333)).resolves.toEqual([]);
  });

  test("lsof operational failure is not masked as an empty inventory", async () => {
    const commands: ReadOnlyCommandRunner = {
      async exec() {
        return { stdout: "", stderr: "lsof: kernel inspection failed", exitCode: 2 };
      },
    };

    await expect(createNodePortInventoryAdapter(commands).listenersFor(9333)).rejects.toThrow(
      "lsof inventory failed",
    );
  });
});
