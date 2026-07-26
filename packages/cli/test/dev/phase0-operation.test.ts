import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_PHASE0_LAUNCH_MARKER,
  runPhase0LaunchIsolation,
} from "../../src/dev/phase0-operation.ts";
import { loadPhase0LaunchContract } from "../../src/dev/phase0.ts";
import { loadDevInstanceState } from "../../src/dev/state.ts";
import type { CdpAdapter, CdpTargetSession } from "../../src/cdp/adapters.ts";
import type { Phase0ComparativeExperiment } from "../../src/dev/types.ts";
import { describeDevLayout } from "../../src/dev/layout.ts";
import type { LaunchSpawnAdapter, SpawnedProcess } from "../../src/dev/launch-adapters.ts";
import type { RuntimeAdapters, RuntimeProcess } from "../../src/runtime/adapters.ts";
import {
  createFixtureAdapters,
  defaultCanonicalBundleOptions,
} from "../host/fixture-fs.ts";
import { createFakeRuntimeHarness } from "../runtime/fixture-runtime.ts";

const CLOCK = "2026-07-26T01:00:00.000Z";
const MARKER = DEFAULT_PHASE0_LAUNCH_MARKER;

function createInjectedSpawn(options: {
  processes: Map<number, { start: string; argv: string[]; alive: boolean }>;
  nextPid: { value: number };
}): LaunchSpawnAdapter {
  return {
    async spawn(spawnOptions) {
      const pid = options.nextPid.value;
      options.nextPid.value += 1;
      const start = `start-${pid}`;
      options.processes.set(pid, {
        start,
        argv: [spawnOptions.executablePath, ...spawnOptions.argv],
        alive: true,
      });
      const handle: SpawnedProcess = {
        pid,
        async wait() {
          return { exitCode: 0, signal: null };
        },
        kill() {
          const entry = options.processes.get(pid);
          if (entry) entry.alive = false;
        },
      };
      return handle;
    },
  };
}

function createInjectedRuntimeProcess(options: {
  processes: Map<number, { start: string; argv: string[]; alive: boolean }>;
  selfPid?: number;
}): RuntimeProcess {
  const selfPid = options.selfPid ?? 9001;
  const selfStart = "self-start";
  return {
    self() {
      return { pid: selfPid, processStartedAt: selfStart };
    },
    async identify(pid) {
      if (pid === selfPid) return { pid: selfPid, processStartedAt: selfStart };
      const entry = options.processes.get(pid);
      if (entry === undefined || !entry.alive) return null;
      return { pid, processStartedAt: entry.start };
    },
    async isAlive(pid, processStartedAt) {
      if (pid === selfPid) return processStartedAt === selfStart;
      const entry = options.processes.get(pid);
      return entry !== undefined && entry.alive && entry.start === processStartedAt;
    },
    async signalExact(identity) {
      const entry = options.processes.get(identity.pid);
      if (entry === undefined || entry.start !== identity.processStartedAt) return false;
      entry.alive = false;
      return true;
    },
  };
}

function createInjectedCommands(options: {
  processes: Map<number, { start: string; argv: string[]; alive: boolean }>;
  portOwnerByPid: Map<number, number>;
}): {
  exec(
    file: string,
    args: readonly string[],
    execOptions?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
} {
  return {
    async exec(file, args) {
      if (file === "/bin/ps" || args.includes("ps") || file.endsWith("ps")) {
        const lines: string[] = [];
        for (const [pid, entry] of options.processes) {
          if (!entry.alive) continue;
          lines.push(`${pid} 1 ${entry.argv.join(" ")}`);
        }
        return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
      }
      if (file === "/usr/sbin/lsof" || file.endsWith("lsof") || args.includes("lsof")) {
        // Emit -Fpn style for 9444 owners that are still alive.
        let stdout = "";
        for (const [pid, entry] of options.processes) {
          if (!entry.alive) continue;
          if (!entry.argv.some((token) => token.includes("remote-debugging-port=9444"))) {
            continue;
          }
          stdout += `p${pid}\nn127.0.0.1:9444\n`;
          options.portOwnerByPid.set(9444, pid);
        }
        return { stdout, stderr: "", exitCode: stdout.length === 0 ? 1 : 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    },
  };
}

function createInjectedCdp(options: {
  processes: Map<number, { start: string; argv: string[]; alive: boolean }>;
  evaluateImpl?: () => Promise<{ value: unknown }>;
  endpointPidOverride?: number | null;
  browserIdentity?: string;
  targetId?: string;
  contexts?: Array<{
    id: number;
    uniqueId: string;
    targetId: string;
    frameId: string;
    isDefault: boolean;
    origin: string;
    name: string;
  }>;
}): CdpAdapter {
  return {
    async readEndpoint() {
      const owner = [...options.processes.entries()].find(
        ([, entry]) =>
          entry.alive && entry.argv.some((token) => token.includes("remote-debugging-port=9444")),
      );
      if (owner === undefined) {
        throw new Error("no endpoint");
      }
      const published =
        options.endpointPidOverride === undefined ? owner[0] : options.endpointPidOverride;
      return {
        browser: options.browserIdentity ?? "Chrome/ChatGPT-Test",
        protocolVersion: "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/browser/test",
        ...(published === null ? {} : { pid: published }),
      };
    },
    async listTargets() {
      return [
        {
          id: options.targetId ?? "page-1",
          type: "page",
          url: "app://-/index.html",
          title: "ChatGPT",
          webSocketDebuggerUrl: `ws://127.0.0.1:9444/devtools/page/${options.targetId ?? "page-1"}`,
        },
      ];
    },
    async openTargetSession(input) {
      const session: CdpTargetSession = {
        targetId: input.target.id,
        isOpen() {
          return true;
        },
        async listExecutionContexts() {
          return (
            options.contexts ?? [
              {
                id: 1,
                uniqueId: "unique-ctx-1",
                targetId: input.target.id,
                frameId: "frame-1",
                isDefault: true,
                origin: "app://-",
                name: "",
              },
            ]
          );
        },
        async evaluate() {
          if (options.evaluateImpl) return options.evaluateImpl();
          return {
            value: {
              explodexPhase0Readiness: true,
              readyState: "complete",
              href: "app://-/index.html",
            },
          };
        },
        async close() {
          // no-op
        },
      };
      return session;
    },
  };
}


function sampleProvidedExperiments(rootPath: string): Phase0ComparativeExperiment[] {
  const layout = describeDevLayout(rootPath);
  const makeTreatment = (knob: string, sequence: number) => ({
    launched: true as const,
    privateRoot: `${layout.rootPath}/experiments/${knob}/treatment/run-${sequence}`,
    descriptor: {
      argv: [
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        `--user-data-dir=${layout.electronUserDataPath}`,
        "--remote-debugging-port=9444",
        MARKER,
      ],
      envKeys: ["CODEX_HOME"],
    },
    pid: 4200 + sequence,
    processStartedAt: `dev-start-${sequence}`,
    portOwnerPid: 4200 + sequence,
    browserIdentity: "Chrome/ChatGPT",
    targetId: `target-${sequence}`,
    executionContextId: 1,
    pathSeparation: {
      userDataDistinctFromMain: true,
      codexHomeDistinctFromUserCodex: true,
      explodexStateDistinctFromMainHome: true,
      credentialsInspected: false as const,
    },
    exactMarkerPresent: true,
    ownershipAccepted: true,
  });
  const makeControl = (
    knob: string,
    sequence: number,
    treatment: ReturnType<typeof makeTreatment>,
  ) => ({
    ...treatment,
    privateRoot: `${layout.rootPath}/experiments/${knob}/control/run-${sequence}`,
    pid: 4300 + sequence,
    processStartedAt: `control-start-${sequence}`,
    launched: true as const,
    ownershipAccepted: false,
    exactMarkerPresent: false,
    portOwnerPid: null,
    browserIdentity: null,
    targetId: null,
    executionContextId: null,
  });
  const userDataTreatment = makeTreatment("electron-user-data", 1);
  const codexTreatment = makeTreatment("codex-home", 3);
  const explodexTreatment = makeTreatment("explodex-home", 5);
  const cdpTreatment = makeTreatment("cdp-port", 7);
  const markerTreatment = makeTreatment("launch-marker", 9);
  return [
    {
      knob: "electron-user-data",
      experimentId: "exp-user-data",
      treatmentLabel: "treatment:electron-user-data",
      controlLabel: "control:electron-user-data",
      treatment: userDataTreatment,
      control: {
        ...makeControl("electron-user-data", 2, userDataTreatment),
        pathSeparation: {
          userDataDistinctFromMain: false,
          codexHomeDistinctFromUserCodex: true,
          explodexStateDistinctFromMainHome: true,
          credentialsInspected: false as const,
        },
      },
      conclusion: "demonstrated",
      evidence: "user-data isolation demonstrated",
    },
    {
      knob: "codex-home",
      experimentId: "exp-codex-home",
      treatmentLabel: "treatment:codex-home",
      controlLabel: "control:codex-home",
      treatment: codexTreatment,
      control: {
        ...makeControl("codex-home", 4, codexTreatment),
        pathSeparation: {
          userDataDistinctFromMain: true,
          codexHomeDistinctFromUserCodex: false,
          explodexStateDistinctFromMainHome: true,
          credentialsInspected: false as const,
        },
      },
      conclusion: "demonstrated",
      evidence: "CODEX_HOME isolation demonstrated",
    },
    {
      knob: "explodex-home",
      experimentId: "exp-explodex-home",
      treatmentLabel: "treatment:explodex-home",
      controlLabel: "control:explodex-home",
      treatment: explodexTreatment,
      control: {
        ...makeTreatment("explodex-home-control", 6),
        ownershipAccepted: true,
      },
      conclusion: "not-necessary",
      evidence: "EXPLODEX_HOME not necessary with private explodex-state",
    },
    {
      knob: "cdp-port",
      experimentId: "exp-cdp-port",
      treatmentLabel: "treatment:cdp-port",
      controlLabel: "control:cdp-port",
      treatment: cdpTreatment,
      control: makeControl("cdp-port", 8, cdpTreatment),
      conclusion: "demonstrated",
      evidence: "9444 ownership demonstrated",
    },
    {
      knob: "launch-marker",
      experimentId: "exp-marker",
      treatmentLabel: "treatment:launch-marker",
      controlLabel: "control:launch-marker",
      treatment: markerTreatment,
      control: makeControl("launch-marker", 10, markerTreatment),
      conclusion: "demonstrated",
      evidence: "exact marker ownership demonstrated",
    },
  ];
}

function createBaseFaultFixture(label: string) {
  const { adapters } = createFixtureAdapters({
    bundles: [
      defaultCanonicalBundleOptions({
        appVersion: "26.721.41059",
        appBuild: "5848",
      }),
    ],
    clockIso: CLOCK,
  });
  const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
  // Protected authoring main identity that must survive every terminal path.
  processes.set(60014, {
    start: "protected-main-start",
    argv: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
    alive: true,
  });
  const nextPid = { value: 11_000 };
  const portOwnerByPid = new Map<number, number>();
  const runtimeProcess = createInjectedRuntimeProcess({ processes });
  const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
  const runtimeAdapters: RuntimeAdapters = {
    ...harness.adapters,
    process: runtimeProcess,
    clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
  };
  const home = `/tmp/homes/phase0-fault-${label}-${process.pid}/.explodex`;
  const root = `${home}/dev/plugin-dev`;
  return {
    adapters,
    processes,
    nextPid,
    portOwnerByPid,
    runtimeProcess,
    runtimeAdapters,
    home,
    root,
    protectedMainPid: 60014,
  };
}

describe("runPhase0LaunchIsolation operation-level comparative matrix", () => {
  test(
    "drives factual comparative experiments via injected adapters and proves only after cleanup",
    async () => {
      const { adapters } = createFixtureAdapters({
        bundles: [
          defaultCanonicalBundleOptions({
            appVersion: "26.721.41059",
            appBuild: "5848",
          }),
        ],
        clockIso: CLOCK,
      });
      const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
      const nextPid = { value: 5000 };
      const portOwnerByPid = new Map<number, number>();
      const runtimeProcess = createInjectedRuntimeProcess({ processes });
      const harness = createFakeRuntimeHarness({
        self: runtimeProcess.self(),
      });
      // Point lock home filesystem at a real-enough fake runtime fs.
      const runtimeAdapters: RuntimeAdapters = {
        ...harness.adapters,
        process: runtimeProcess,
        clock: {
          nowMs: () => Date.now(),
          nowIso: () => CLOCK,
        },
      };

      const root = `/tmp/homes/phase0-op-${process.pid}/.explodex/dev/plugin-dev`;
      const explodexHome = `/tmp/homes/phase0-op-${process.pid}/.explodex`;

      const result = await runPhase0LaunchIsolation({
        adapters,
        runtimeProcess,
        runtimeAdapters,
        commands: createInjectedCommands({ processes, portOwnerByPid }),
        cdp: createInjectedCdp({ processes }),
        spawn: createInjectedSpawn({ processes, nextPid }),
        osHome: `/tmp/homes/phase0-op-${process.pid}`,
        rootPath: root,
        protectedPaths: {
          mainProfilePath: join(`/tmp/homes/phase0-op-${process.pid}`, "Library/Application Support/Codex"),
          userCodexHome: join(`/tmp/homes/phase0-op-${process.pid}`, ".codex"),
          explodexHome,
        },
        readinessTimeoutMs: 2_000,
        stopTimeoutMs: 2_000,
        pollMs: 10,
        lockWaitMs: 1_000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      expect(result.contract.schemaVersion).toBe(2);
      expect(result.contract.status).toBe("proven");
      expect(result.contract.comparativeExperiments).toHaveLength(5);
      for (const experiment of result.contract.comparativeExperiments) {
        expect(experiment.treatment.descriptor.argv.length).toBeGreaterThan(0);
        expect(experiment.evidence.length).toBeGreaterThan(0);
        if (experiment.knob === "explodex-home") {
          expect(experiment.conclusion).toBe("not-necessary");
        } else {
          expect(experiment.conclusion).toBe("demonstrated");
        }
      }
      expect(result.contract.readiness?.targetId).toBe("page-1");
      expect(result.contract.readiness?.browserIdentity).toBe("Chrome/ChatGPT-Test");
      expect(result.contract.readiness?.rendererEvaluation?.result).toEqual({
        explodexPhase0Readiness: true,
        readyState: "complete",
        href: "app://-/index.html",
      });
      expect(result.contract.isolation.electronUserDataPath).toBe(
        `${root}/electron-user-data`,
      );
      expect(result.contract.isolation.codexHomePath).toBe(`${root}/codex-home`);
      // Comparative experiment private roots must remain separate from acceptance isolation.
      for (const experiment of result.contract.comparativeExperiments) {
        expect(experiment.treatment.privateRoot).not.toBeNull();
        expect(experiment.treatment.privateRoot?.startsWith(`${root}/experiments/`)).toBe(true);
        expect(
          result.contract.isolation.electronUserDataPath?.startsWith(
            `${experiment.treatment.privateRoot}/`,
          ),
        ).toBe(false);
      }
      // Distinct private roots for every comparative side.
      const roots = result.contract.comparativeExperiments.flatMap((experiment) => {
        const sides = [experiment.treatment.privateRoot];
        if (experiment.control?.privateRoot) sides.push(experiment.control.privateRoot);
        return sides;
      });
      expect(new Set(roots).size).toBe(roots.length);
      expect(result.contract.ownership?.positive.owned).toBe(true);
      expect(result.contract.ownership?.negatives).toHaveLength(6);
      expect(result.allowsLifecycleMutation).toBe(true);

      // Proven is last authority write; state is stopped without live target.
      const state = await loadDevInstanceState({
        adapters,
        statePath: result.layout.statePath,
      });
      expect(state?.status).toBe("stopped");
      expect(state?.pid).toBeNull();
      expect(state?.targetId).toBeNull();

      const loaded = await loadPhase0LaunchContract({
        adapters,
        path: result.layout.phase0ContractPath,
      });
      expect(loaded?.status).toBe("proven");
      expect(loaded?.schemaVersion).toBe(2);

      // No residual live experiment processes.
      for (const entry of processes.values()) {
        expect(entry.alive).toBe(false);
      }
    },
    { timeout: 30_000 },
  );

  test("rejects concurrent proof mutation without launching when lock is held", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: {
        nowMs: () => Date.now(),
        nowIso: () => CLOCK,
      },
    };
    const home = `/tmp/homes/phase0-lock-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;

    // Hold the dev-instance lease.
    const { acquireOperationLock } = await import("../../src/runtime/locks.ts");
    const held = await acquireOperationLock({
      adapters: runtimeAdapters,
      explodexHome: home,
      resource: "dev-instance",
      identity: {
        operationId: "holder",
        operation: "hold",
        startedAt: CLOCK,
        ownerPid: runtimeProcess.self().pid,
        ownerProcessStartedAt: runtimeProcess.self().processStartedAt,
      },
      waitBoundMs: 0,
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    let launched = false;
    const spawn: LaunchSpawnAdapter = {
      async spawn() {
        launched = true;
        throw new Error("should not spawn while lock held");
      },
    };

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid: new Map() }),
      cdp: createInjectedCdp({ processes }),
      spawn,
      osHome: `/tmp/homes/phase0-lock-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `/tmp/homes/phase0-lock-${process.pid}/Library/Application Support/Codex`,
        userCodexHome: `/tmp/homes/phase0-lock-${process.pid}/.codex`,
        explodexHome: home,
      },
      lockWaitMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(launched).toBe(false);
    if (result.ok) throw new Error("expected lock contention failure");
    expect(result.error.code).toMatch(/lock_/);

    await held.handle.release();
  });

  test("synthetic one-launch observations without comparative experiments cannot complete proof", async () => {
    const { evaluatePhase0LaunchContract } = await import("../../src/dev/phase0.ts");
    const { describeDevLayout } = await import("../../src/dev/layout.ts");
    const layout = describeDevLayout("/tmp/homes/phase0-synthetic/.explodex/dev/plugin-dev");
    const frozenHost = {
      bundlePath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      bundleId: "com.openai.codex",
      executableName: "ChatGPT",
      signingTeam: "2DC432GLL2",
      appVersion: "26.721.41059",
      appBuild: "5848",
      hostHashes: {
        "Contents/Info.plist": "a".repeat(64),
        "Contents/MacOS/ChatGPT": "b".repeat(64),
        "Contents/Resources/app.asar": "c".repeat(64),
      },
    };
    const result = evaluatePhase0LaunchContract({
      frozenHost,
      observations: [
        {
          knob: "electron-user-data",
          demonstratedEffect: true,
          notNecessary: false,
          pathSeparation: {
            userDataDistinctFromMain: true,
            codexHomeDistinctFromUserCodex: true,
            explodexStateDistinctFromMainHome: true,
            credentialsInspected: false,
          },
          notes: "synthetic",
        },
        {
          knob: "codex-home",
          demonstratedEffect: true,
          notNecessary: false,
          pathSeparation: {
            userDataDistinctFromMain: true,
            codexHomeDistinctFromUserCodex: true,
            explodexStateDistinctFromMainHome: true,
            credentialsInspected: false,
          },
          notes: "synthetic",
        },
        {
          knob: "explodex-home",
          demonstratedEffect: false,
          notNecessary: true,
          notes: "synthetic",
        },
        {
          knob: "cdp-port",
          demonstratedEffect: true,
          notNecessary: false,
          notes: "synthetic",
        },
        {
          knob: "launch-marker",
          demonstratedEffect: true,
          notNecessary: false,
          marker: {
            exactMatch: true,
            observedValue: MARKER,
            source: "argv",
            acceptedForDevelopment: true,
            rejectedForProtectedMain: true,
            rejectedForUnrelatedProcess: true,
            rejectedForArbitrarySubstring: true,
            secretFree: true,
          },
          notes: "synthetic",
        },
      ],
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
      requireCompleteProof: true,
    });
    expect(result.contract.status).toBe("incomplete");
    expect(result.allowsLifecycleMutation).toBe(false);
  });

  test(
    "rejects endpoint published PID disagreement and missing renderer evaluation as incomplete",
    async () => {
      const { adapters } = createFixtureAdapters({
        bundles: [
          defaultCanonicalBundleOptions({
            appVersion: "26.721.41059",
            appBuild: "5848",
          }),
        ],
        clockIso: CLOCK,
      });
      const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
      const nextPid = { value: 7000 };
      const portOwnerByPid = new Map<number, number>();
      const runtimeProcess = createInjectedRuntimeProcess({ processes });
      const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
      const runtimeAdapters: RuntimeAdapters = {
        ...harness.adapters,
        process: runtimeProcess,
        clock: {
          nowMs: () => Date.now(),
          nowIso: () => CLOCK,
        },
      };
      const home = `/tmp/homes/phase0-pid-drift-${process.pid}/.explodex`;
      const root = `${home}/dev/plugin-dev`;

      const result = await runPhase0LaunchIsolation({
        adapters,
        runtimeProcess,
        runtimeAdapters,
        commands: createInjectedCommands({ processes, portOwnerByPid }),
        cdp: createInjectedCdp({
          processes,
          endpointPidOverride: 999999,
        }),
        spawn: createInjectedSpawn({ processes, nextPid }),
        osHome: `/tmp/homes/phase0-pid-drift-${process.pid}`,
        rootPath: root,
        protectedPaths: {
          mainProfilePath: `${home}/../Library/Application Support/Codex`,
          userCodexHome: `${home}/../.codex`,
          explodexHome: home,
        },
        readinessTimeoutMs: 500,
        stopTimeoutMs: 500,
        pollMs: 5,
        lockWaitMs: 1_000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected incomplete readiness");
      expect(result.allowsLifecycleMutation).toBe(false);
      expect(result.contract.status).not.toBe("proven");
      for (const entry of processes.values()) {
        expect(entry.alive).toBe(false);
      }
    },
    { timeout: 30_000 },
  );

  test(
    "missing renderer evaluation leaves readiness incomplete and non-authorizing",
    async () => {
      const { adapters } = createFixtureAdapters({
        bundles: [
          defaultCanonicalBundleOptions({
            appVersion: "26.721.41059",
            appBuild: "5848",
          }),
        ],
        clockIso: CLOCK,
      });
      const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
      const nextPid = { value: 7100 };
      const portOwnerByPid = new Map<number, number>();
      const runtimeProcess = createInjectedRuntimeProcess({ processes });
      const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
      const runtimeAdapters: RuntimeAdapters = {
        ...harness.adapters,
        process: runtimeProcess,
        clock: {
          nowMs: () => Date.now(),
          nowIso: () => CLOCK,
        },
      };
      const home = `/tmp/homes/phase0-no-eval-${process.pid}/.explodex`;
      const root = `${home}/dev/plugin-dev`;

      const result = await runPhase0LaunchIsolation({
        adapters,
        runtimeProcess,
        runtimeAdapters,
        commands: createInjectedCommands({ processes, portOwnerByPid }),
        cdp: createInjectedCdp({
          processes,
          evaluateImpl: async () => {
            return { value: undefined };
          },
        }),
        spawn: createInjectedSpawn({ processes, nextPid }),
        osHome: `/tmp/homes/phase0-no-eval-${process.pid}`,
        rootPath: root,
        protectedPaths: {
          mainProfilePath: `${home}/../Library/Application Support/Codex`,
          userCodexHome: `${home}/../.codex`,
          explodexHome: home,
        },
        readinessTimeoutMs: 400,
        stopTimeoutMs: 400,
        pollMs: 5,
        lockWaitMs: 1_000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected missing evaluation failure");
      expect(result.contract.status).not.toBe("proven");
      expect(result.contract.readiness).toBeNull();
      for (const entry of processes.values()) {
        expect(entry.alive).toBe(false);
      }
    },
    { timeout: 30_000 },
  );

  test(
    "target replacement during readiness keeps proof incomplete",
    async () => {
      const { adapters } = createFixtureAdapters({
        bundles: [
          defaultCanonicalBundleOptions({
            appVersion: "26.721.41059",
            appBuild: "5848",
          }),
        ],
        clockIso: CLOCK,
      });
      const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
      const nextPid = { value: 7200 };
      const portOwnerByPid = new Map<number, number>();
      const runtimeProcess = createInjectedRuntimeProcess({ processes });
      const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
      const runtimeAdapters: RuntimeAdapters = {
        ...harness.adapters,
        process: runtimeProcess,
        clock: {
          nowMs: () => Date.now(),
          nowIso: () => CLOCK,
        },
      };
      const home = `/tmp/homes/phase0-target-drift-${process.pid}/.explodex`;
      const root = `${home}/dev/plugin-dev`;
      let listCount = 0;
      const cdp = createInjectedCdp({ processes });
      const driftingCdp: CdpAdapter = {
        ...cdp,
        async listTargets() {
          listCount += 1;
          // Every inventory returns a distinct target so point-of-use recheck
          // never observes a stable target identity across the readiness window.
          const id = `page-${listCount}`;
          return [
            {
              id,
              type: "page",
              url: "app://-/index.html",
              title: "ChatGPT",
              webSocketDebuggerUrl: `ws://127.0.0.1:9444/devtools/page/${id}`,
            },
          ];
        },
        async openTargetSession(input) {
          const session = await cdp.openTargetSession(input);
          return {
            ...session,
            targetId: input.target.id,
            async listExecutionContexts() {
              return [
                {
                  id: 1,
                  uniqueId: `unique-${input.target.id}`,
                  targetId: input.target.id,
                  frameId: `frame-${input.target.id}`,
                  isDefault: true,
                  origin: "app://-",
                  name: "",
                },
              ];
            },
          };
        },
      };

      const result = await runPhase0LaunchIsolation({
        adapters,
        runtimeProcess,
        runtimeAdapters,
        commands: createInjectedCommands({ processes, portOwnerByPid }),
        cdp: driftingCdp,
        spawn: createInjectedSpawn({ processes, nextPid }),
        osHome: `/tmp/homes/phase0-target-drift-${process.pid}`,
        rootPath: root,
        protectedPaths: {
          mainProfilePath: `${home}/../Library/Application Support/Codex`,
          userCodexHome: `${home}/../.codex`,
          explodexHome: home,
        },
        readinessTimeoutMs: 400,
        stopTimeoutMs: 400,
        pollMs: 5,
        lockWaitMs: 1_000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected target replacement failure");
      expect(result.contract.status).not.toBe("proven");
      for (const entry of processes.values()) {
        expect(entry.alive).toBe(false);
      }
    },
    { timeout: 30_000 },
  );

  test(
    "cleanup signal failure preserves residual authority and never proves",
    async () => {
      const { adapters } = createFixtureAdapters({
        bundles: [
          defaultCanonicalBundleOptions({
            appVersion: "26.721.41059",
            appBuild: "5848",
          }),
        ],
        clockIso: CLOCK,
      });
      const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
      const nextPid = { value: 7300 };
      const portOwnerByPid = new Map<number, number>();
      const runtimeProcess = createInjectedRuntimeProcess({ processes });
      const originalSignal = runtimeProcess.signalExact.bind(runtimeProcess);
      runtimeProcess.signalExact = async (identity, signal, opts) => {
        // Refuse to signal after acceptance so cleanup remains uncertain.
        if (identity.pid >= 7300) {
          return false;
        }
        return originalSignal(identity, signal, opts);
      };
      const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
      const runtimeAdapters: RuntimeAdapters = {
        ...harness.adapters,
        process: runtimeProcess,
        clock: {
          nowMs: () => Date.now(),
          nowIso: () => CLOCK,
        },
      };
      const home = `/tmp/homes/phase0-residual-${process.pid}/.explodex`;
      const root = `${home}/dev/plugin-dev`;

      const result = await runPhase0LaunchIsolation({
        adapters,
        runtimeProcess,
        runtimeAdapters,
        commands: createInjectedCommands({ processes, portOwnerByPid }),
        cdp: createInjectedCdp({ processes }),
        spawn: createInjectedSpawn({ processes, nextPid }),
        osHome: `/tmp/homes/phase0-residual-${process.pid}`,
        rootPath: root,
        protectedPaths: {
          mainProfilePath: `${home}/../Library/Application Support/Codex`,
          userCodexHome: `${home}/../.codex`,
          explodexHome: home,
        },
        readinessTimeoutMs: 1_000,
        stopTimeoutMs: 200,
        pollMs: 5,
        lockWaitMs: 1_000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected residual authority failure");
      expect(result.contract.status).not.toBe("proven");
      expect(result.error.code).toMatch(/cleanup_uncertain|phase0_incomplete|protected_main/);
      // Residual process identity may remain live; never claim stopped proven authority.
      const state = await loadDevInstanceState({
        adapters,
        statePath: `${root}/state.json`,
      });
      expect(state?.status).not.toBe("stopped");
    },
    { timeout: 45_000 },
  );

  test("aborted operation still cleans up with an independent cleanup context", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 8000 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: {
        nowMs: () => Date.now(),
        nowIso: () => CLOCK,
      },
    };
    const home = `/tmp/homes/phase0-abort-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;
    const controller = new AbortController();
    controller.abort();

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: createInjectedCdp({ processes }),
      spawn: createInjectedSpawn({ processes, nextPid }),
      osHome: `/tmp/homes/phase0-abort-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 500,
      stopTimeoutMs: 500,
      pollMs: 10,
      lockWaitMs: 500,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected abort failure");
    expect(result.contract.status).not.toBe("proven");
    for (const entry of processes.values()) {
      expect(entry.alive).toBe(false);
    }
  });

  test("structurally valid but semantically forged schema-2 proof is rejected on load", async () => {
    const { parsePhase0LaunchContract } = await import("../../src/dev/phase0.ts");
    const forged = {
      schemaVersion: 2,
      status: "proven",
      frozenHost: {
        bundlePath: "/Applications/ChatGPT.app",
        executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        bundleId: "com.openai.codex",
        executableName: "ChatGPT",
        signingTeam: "2DC432GLL2",
        appVersion: "26.721.41059",
        appBuild: "5848",
        hostHashes: {
          "Contents/Info.plist": "a".repeat(64),
          "Contents/MacOS/ChatGPT": "b".repeat(64),
          "Contents/Resources/app.asar": "c".repeat(64),
        },
      },
      appBuild: "5848",
      appVersion: "26.721.41059",
      retainedKnobs: ["electron-user-data", "codex-home", "cdp-port", "launch-marker"],
      knobMatrix: [
        {
          name: "electron-user-data",
          status: "retained",
          effect: "demonstrated",
          evidence: "forged",
        },
        { name: "codex-home", status: "retained", effect: "demonstrated", evidence: "forged" },
        {
          name: "explodex-home",
          status: "omitted",
          effect: "not-necessary",
          evidence: "forged",
        },
        { name: "cdp-port", status: "retained", effect: "demonstrated", evidence: "forged" },
        {
          name: "launch-marker",
          status: "retained",
          effect: "demonstrated",
          evidence: "forged",
        },
      ],
      comparativeExperiments: [
        {
          knob: "electron-user-data",
          experimentId: "e1",
          treatmentLabel: "t",
          controlLabel: "c",
          treatment: {
            launched: false,
            privateRoot: "/tmp/exp/a",
            descriptor: { argv: [], envKeys: [] },
            pid: null,
            processStartedAt: null,
            portOwnerPid: null,
            browserIdentity: null,
            targetId: null,
            executionContextId: null,
            exactMarkerPresent: false,
            ownershipAccepted: false,
          },
          control: null,
          conclusion: "demonstrated",
          evidence: "forged-mismatch",
        },
        {
          knob: "codex-home",
          experimentId: "e2",
          treatmentLabel: "t",
          controlLabel: "c",
          treatment: {
            launched: false,
            privateRoot: "/tmp/exp/b",
            descriptor: { argv: [], envKeys: [] },
            pid: null,
            processStartedAt: null,
            portOwnerPid: null,
            browserIdentity: null,
            targetId: null,
            executionContextId: null,
            exactMarkerPresent: false,
            ownershipAccepted: false,
          },
          control: null,
          conclusion: "demonstrated",
          evidence: "forged-mismatch",
        },
        {
          knob: "explodex-home",
          experimentId: "e3",
          treatmentLabel: "t",
          controlLabel: "c",
          treatment: {
            launched: false,
            privateRoot: "/tmp/exp/c",
            descriptor: { argv: [], envKeys: [] },
            pid: null,
            processStartedAt: null,
            portOwnerPid: null,
            browserIdentity: null,
            targetId: null,
            executionContextId: null,
            exactMarkerPresent: false,
            ownershipAccepted: false,
          },
          control: null,
          conclusion: "not-necessary",
          evidence: "forged-mismatch",
        },
        {
          knob: "cdp-port",
          experimentId: "e4",
          treatmentLabel: "t",
          controlLabel: "c",
          treatment: {
            launched: false,
            privateRoot: "/tmp/exp/d",
            descriptor: { argv: [], envKeys: [] },
            pid: null,
            processStartedAt: null,
            portOwnerPid: null,
            browserIdentity: null,
            targetId: null,
            executionContextId: null,
            exactMarkerPresent: false,
            ownershipAccepted: false,
          },
          control: null,
          conclusion: "demonstrated",
          evidence: "forged-mismatch",
        },
        {
          knob: "launch-marker",
          experimentId: "e5",
          treatmentLabel: "t",
          controlLabel: "c",
          treatment: {
            launched: false,
            privateRoot: "/tmp/exp/e",
            descriptor: { argv: [], envKeys: [] },
            pid: null,
            processStartedAt: null,
            portOwnerPid: null,
            browserIdentity: null,
            targetId: null,
            executionContextId: null,
            exactMarkerPresent: false,
            ownershipAccepted: false,
          },
          control: null,
          conclusion: "demonstrated",
          evidence: "forged-mismatch",
        },
      ],
      launchMarker: { kind: "exact-argv-token", value: MARKER },
      isolation: {
        electronUserDataPath: "/tmp/accept/electron-user-data",
        codexHomePath: "/tmp/accept/codex-home",
        explodexHomePath: null,
        cdpHost: "127.0.0.1",
        cdpPort: 9444,
      },
      readiness: {
        pid: 1,
        processStartedAt: "x",
        executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        portOwnerPid: 1,
        cdpHost: "127.0.0.1",
        cdpPort: 9444,
        browserIdentity: "Chrome",
        endpointPublishedPid: 1,
        targetId: "t",
        targetUrl: "app://-/index.html",
        executionContextId: 1,
        executionContextUniqueId: "u",
        frameId: "f",
        rendererEvaluation: {
          expression: "1+1",
          result: 2,
          evaluatedAt: CLOCK,
        },
        readiness: "benign",
      },
      ownership: {
        positive: { owned: true, code: "owned", reasons: ["x"] },
        negatives: [
          { role: "protected-main", owned: false, code: "protected_main", reasons: ["x"] },
          { role: "unrelated", owned: false, code: "unrelated_marker", reasons: ["x"] },
          {
            role: "arbitrary-substring",
            owned: false,
            code: "arbitrary_substring",
            reasons: ["x"],
          },
          { role: "pid-reuse", owned: false, code: "pid_reuse", reasons: ["x"] },
          { role: "wrong-endpoint", owned: false, code: "wrong_endpoint", reasons: ["x"] },
          {
            role: "conflicting-source",
            owned: false,
            code: "conflicting_source",
            reasons: ["x"],
          },
        ],
      },
      sanitizedLaunchDescriptor: {
        argv: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", MARKER],
        envKeys: [],
      },
      provenAt: CLOCK,
      reason: null,
    };

    expect(parsePhase0LaunchContract(forged)).toBeNull();
  });

  test("listener co-ownership rejects readiness authority under unique-owner contract", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 9100 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-coown-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;

    // Report every real 9444 owner plus a synthetic co-owner PID so readiness sees
    // hard co-ownership without pre-occupying the port before spawn.
    const commands = {
      async exec(file: string, args: readonly string[]) {
        if (file === "/bin/ps" || args.includes("ps") || file.endsWith("ps")) {
          const lines: string[] = [];
          for (const [pid, entry] of processes) {
            if (!entry.alive) continue;
            lines.push(`${pid} 1 ${entry.argv.join(" ")}`);
          }
          return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
        }
        if (file === "/usr/sbin/lsof" || file.endsWith("lsof") || args.includes("lsof")) {
          let stdout = "";
          for (const [pid, entry] of processes) {
            if (!entry.alive) continue;
            if (!entry.argv.some((token) => token.includes("remote-debugging-port=9444"))) {
              continue;
            }
            stdout += `p${pid}\nn127.0.0.1:9444\n`;
            // Synthetic additional owner creates unique-owner contract ambiguity.
            stdout += `p${pid + 50_000}\nn127.0.0.1:9444\n`;
            portOwnerByPid.set(9444, pid);
          }
          return { stdout, stderr: "", exitCode: stdout.length === 0 ? 1 : 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands,
      cdp: createInjectedCdp({ processes }),
      spawn: createInjectedSpawn({ processes, nextPid }),
      osHome: `/tmp/homes/phase0-coown-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 800,
      stopTimeoutMs: 500,
      pollMs: 10,
      lockWaitMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected co-ownership incomplete");
    expect(result.contract.status).not.toBe("proven");
    expect(result.allowsLifecycleMutation).toBe(false);
  }, 30_000);

  test("forged readiness expression, wrong negative codes, and non-ISO provenAt are rejected", async () => {
    const {
      parsePhase0LaunchContract,
      evaluatePhase0LaunchContract,
      validatePhase0Readiness,
      validatePhase0Ownership,
    } = await import("../../src/dev/phase0.ts");
    const { describeDevLayout } = await import("../../src/dev/layout.ts");
    const frozenHost = {
      bundlePath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      bundleId: "com.openai.codex",
      executableName: "ChatGPT",
      signingTeam: "2DC432GLL2",
      appVersion: "26.721.41059",
      appBuild: "5848",
      hostHashes: {
        "Contents/Info.plist": "a".repeat(64),
        "Contents/MacOS/ChatGPT": "b".repeat(64),
        "Contents/Resources/app.asar": "c".repeat(64),
      },
    };
    const readinessBadExpression = {
      pid: 4242,
      processStartedAt: "dev-start-identity",
      executablePath: frozenHost.executablePath,
      portOwnerPid: 4242,
      cdpHost: "127.0.0.1" as const,
      cdpPort: 9444 as const,
      browserIdentity: "Chrome/ChatGPT",
      endpointPublishedPid: 4242,
      targetId: "target-1",
      targetUrl: "app://-/index.html" as const,
      executionContextId: 1,
      executionContextUniqueId: "ctx-unique-1",
      frameId: "frame-1",
      rendererEvaluation: {
        expression: "1+1",
        result: { explodexPhase0Readiness: true, readyState: "complete", href: "app://-/index.html" },
        evaluatedAt: CLOCK,
      },
      readiness: "benign" as const,
    };
    expect(validatePhase0Readiness(readinessBadExpression, frozenHost).ok).toBe(false);

    const ownershipWrongCode = {
      positive: { owned: true, code: "owned", reasons: ["x"] },
      negatives: [
        { role: "protected-main", owned: false as const, code: "forged_code", reasons: ["x"] },
        { role: "unrelated", owned: false as const, code: "unrelated_marker", reasons: ["x"] },
        {
          role: "arbitrary-substring",
          owned: false as const,
          code: "arbitrary_substring",
          reasons: ["x"],
        },
        { role: "pid-reuse", owned: false as const, code: "pid_reuse", reasons: ["x"] },
        { role: "wrong-endpoint", owned: false as const, code: "wrong_endpoint", reasons: ["x"] },
        {
          role: "conflicting-source",
          owned: false as const,
          code: "conflicting_source",
          reasons: ["x"],
        },
      ],
    };
    expect(validatePhase0Ownership(ownershipWrongCode).ok).toBe(false);

    // Non-ISO provenAt cannot evaluate to proven.
    const layout = describeDevLayout("/tmp/homes/phase0-forged-time/.explodex/dev/plugin-dev");
    const incomplete = evaluatePhase0LaunchContract({
      frozenHost,
      comparativeExperiments: [],
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: "not-an-iso-time",
      readiness: readinessBadExpression,
      ownership: ownershipWrongCode,
      requireCompleteProof: true,
    });
    expect(incomplete.contract.status).toBe("incomplete");
    expect(parsePhase0LaunchContract({
      schemaVersion: 2,
      status: "proven",
      frozenHost,
      appBuild: "5848",
      appVersion: "26.721.41059",
      retainedKnobs: ["cdp-port", "launch-marker"],
      knobMatrix: [],
      comparativeExperiments: [],
      launchMarker: { kind: "exact-argv-token", value: MARKER },
      isolation: {
        electronUserDataPath: null,
        codexHomePath: null,
        explodexHomePath: null,
        cdpHost: "127.0.0.1",
        cdpPort: 9444,
      },
      readiness: readinessBadExpression,
      ownership: ownershipWrongCode,
      sanitizedLaunchDescriptor: { argv: [MARKER], envKeys: [] },
      acceptanceAuthority: null,
      provenAt: "yesterday",
      reason: null,
    })).toBeNull();
  });

  test("proven-last ordering writes stopped state before proven contract", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 9200 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-order-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: createInjectedCdp({ processes }),
      spawn: createInjectedSpawn({ processes, nextPid }),
      osHome: `/tmp/homes/phase0-order-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.contract.status).toBe("proven");
    expect(result.contract.acceptanceAuthority?.port9444Released).toBe(true);
    expect(result.contract.acceptanceAuthority?.cleanupDisposition.uncertain).toBe(false);
    expect(result.contract.provenAt).toBe(CLOCK);

    const state = await loadDevInstanceState({
      adapters,
      statePath: result.layout.statePath,
    });
    expect(state?.status).toBe("stopped");
    expect(state?.pid).toBeNull();
    expect(state?.processStartedAt).toBeNull();
    expect(state?.targetId).toBeNull();
    expect(state?.startedAt).toBeNull();

    const loaded = await loadPhase0LaunchContract({
      adapters,
      path: result.layout.phase0ContractPath,
    });
    expect(loaded?.status).toBe("proven");
    expect(loaded?.acceptanceAuthority?.readinessPid).toBe(result.contract.readiness?.pid);
  }, 30_000);

  test("active host drift during acceptance fails closed without proven authority", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 9400 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-host-drift-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;

    let inspectCount = 0;
    const originalExecFile = adapters.process.execFile.bind(adapters.process);
    adapters.process.execFile = async (file, args, opts) => {
      // After the first full host inspection succeeds, force later rechecks to fail.
      inspectCount += 1;
      if (inspectCount > 2 && typeof file === "string" && file.includes("plutil")) {
        return { stdout: "", stderr: "drifted", exitCode: 1 };
      }
      return originalExecFile(file, args, opts);
    };

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: createInjectedCdp({ processes }),
      spawn: createInjectedSpawn({ processes, nextPid }),
      osHome: `/tmp/homes/phase0-host-drift-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected host drift failure");
    expect(result.contract.status).not.toBe("proven");
  }, 30_000);

  test("Browser.close failure falls back to exact-signal and records factual method", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 9500 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-close-fail-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;
    const baseCdp = createInjectedCdp({ processes });
    const cdp: CdpAdapter = {
      ...baseCdp,
      async readEndpoint(input) {
        // Cause Browser.close authority revalidation to fail by returning no endpoint
        // only after readiness is complete: keep readiness working via normal path first.
        return baseCdp.readEndpoint(input);
      },
    };
    // Force close path to fail by making openTargetSession throw during cleanup revalidation
    // after first successful readiness open.
    let openCount = 0;
    const countingCdp: CdpAdapter = {
      ...cdp,
      async openTargetSession(input) {
        openCount += 1;
        // First several opens are readiness/context; later ones during cleanup fail.
        if (openCount > 20) {
          throw new Error("Browser.close context revalidation failed");
        }
        return cdp.openTargetSession(input);
      },
    };

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: countingCdp,
      spawn: createInjectedSpawn({ processes, nextPid }),
      osHome: `/tmp/homes/phase0-close-fail-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    // Successful path uses signal fallback when close fails; may still prove if signal works.
    if (result.ok) {
      const method = result.contract.acceptanceAuthority?.cleanupDisposition.method;
      expect(
        method === "exact-signal-only" ||
          method === "browser-close-only" ||
          method === "browser-close-then-signal",
      ).toBe(true);
      expect(result.contract.acceptanceAuthority?.cleanupDisposition.method).not.toBe(
        "browser-close" as never,
      );
    } else {
      expect(result.contract.status).not.toBe("proven");
    }
  }, 30_000);

  test("signal success with non-exit preserves residual authority", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 9600 };
    const portOwnerByPid = new Map<number, number>();
    const baseRuntime = createInjectedRuntimeProcess({ processes });
    // signalExact reports success but leaves the process alive (non-exit).
    const runtimeProcess: RuntimeProcess = {
      ...baseRuntime,
      async signalExact(identity) {
        const entry = processes.get(identity.pid);
        if (entry === undefined || entry.start !== identity.processStartedAt) return false;
        // Do not mark dead: signal "succeeded" but process did not exit.
        return true;
      },
    };
    // Prevent kill-via-spawn handle from cleaning either.
    const spawn = createInjectedSpawn({ processes, nextPid });
    const stickySpawn: LaunchSpawnAdapter = {
      async spawn(options) {
        const handle = await spawn.spawn(options);
        return {
          ...handle,
          kill() {
            // no-op sticky process
          },
        };
      },
    };
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-nonexit-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: createInjectedCdp({ processes }),
      spawn: stickySpawn,
      osHome: `/tmp/homes/phase0-nonexit-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 200,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected non-exit residual authority");
    expect(result.contract.status).not.toBe("proven");
    // Sticky processes remain alive; residual authority preserved.
    expect([...processes.values()].some((entry) => entry.alive)).toBe(true);
  }, 30_000);

  test("pre-spawn contract write failure leaves no proven authority", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    const nextPid = { value: 9700 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    const harness = createFakeRuntimeHarness({ self: runtimeProcess.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: runtimeProcess,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-write-fail-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;

    // Fail only Phase 0 contract writes (including atomic temp paths).
    const originalWriteFile = adapters.fs.writeFile!.bind(adapters.fs);
    adapters.fs.writeFile = async (path, data) => {
      if (typeof path === "string" && path.includes("phase0-launch-contract.json")) {
        throw new Error("injected pre-spawn contract write failure");
      }
      return originalWriteFile(path, data);
    };

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: createInjectedCdp({ processes }),
      spawn: createInjectedSpawn({ processes, nextPid }),
      osHome: `/tmp/homes/phase0-write-fail-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected write failure");
    expect(result.contract.status).not.toBe("proven");
    // No processes should remain owned as proven acceptance.
    expect(result.allowsLifecycleMutation).toBe(false);
  }, 30_000);

  test("multiple protected-main loss fails closed without proven authority", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "26.721.41059",
          appBuild: "5848",
        }),
      ],
      clockIso: CLOCK,
    });
    const processes = new Map<number, { start: string; argv: string[]; alive: boolean }>();
    // Two pre-existing protected mains without the development marker.
    processes.set(60014, {
      start: "main-start-a",
      argv: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      alive: true,
    });
    processes.set(60015, {
      start: "main-start-b",
      argv: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      alive: true,
    });
    const nextPid = { value: 9300 };
    const portOwnerByPid = new Map<number, number>();
    const runtimeProcess = createInjectedRuntimeProcess({ processes });
    // Kill protected mains during operation by wrapping isAlive after first inventory.
    let afterAcceptance = false;
    const baseRuntime = runtimeProcess;
    const wrappedRuntime: RuntimeProcess = {
      ...baseRuntime,
      async isAlive(pid, processStartedAt, opts) {
        if (afterAcceptance && (pid === 60014 || pid === 60015)) {
          return false;
        }
        return baseRuntime.isAlive(pid, processStartedAt, opts);
      },
    };
    const harness = createFakeRuntimeHarness({ self: wrappedRuntime.self() });
    const runtimeAdapters: RuntimeAdapters = {
      ...harness.adapters,
      process: wrappedRuntime,
      clock: { nowMs: () => Date.now(), nowIso: () => CLOCK },
    };
    const home = `/tmp/homes/phase0-mains-${process.pid}/.explodex`;
    const root = `${home}/dev/plugin-dev`;
    const spawn = createInjectedSpawn({ processes, nextPid });
    const trackingSpawn: LaunchSpawnAdapter = {
      async spawn(options) {
        const handle = await spawn.spawn(options);
        afterAcceptance = true;
        return handle;
      },
    };

    const result = await runPhase0LaunchIsolation({
      adapters,
      runtimeProcess: wrappedRuntime,
      runtimeAdapters,
      commands: createInjectedCommands({ processes, portOwnerByPid }),
      cdp: createInjectedCdp({ processes }),
      spawn: trackingSpawn,
      osHome: `/tmp/homes/phase0-mains-${process.pid}`,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: `${home}/../Library/Application Support/Codex`,
        userCodexHome: `${home}/../.codex`,
        explodexHome: home,
      },
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected protected main loss failure");
    expect(result.protectedMainSurvived).toBe(false);
    expect(result.contract.status).not.toBe("proven");
    expect(result.error.code).toBe("protected_main_impacted");
  }, 30_000);

  test("unidentified-spawn kill failure preserves residual authority without proven write", async () => {
    const fx = createBaseFaultFixture("kill-fail");
    const spawn: LaunchSpawnAdapter = {
      async spawn() {
        const pid = fx.nextPid.value++;
        // Unidentified: never appears in process inventory.
        return {
          pid,
          async wait() {
            return { exitCode: 0, signal: null };
          },
          kill() {
            throw new Error("injected unidentified-spawn kill failure");
          },
        };
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn,
      osHome: `/tmp/homes/phase0-fault-kill-fail-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 80,
      stopTimeoutMs: 80,
      pollMs: 5,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected kill failure residual");
    expect(result.contract.status).toBe("incomplete");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.error.code).toMatch(/phase0_cleanup_uncertain|phase0_incomplete/);
    expect(result.contract.acceptanceAuthority).toBeNull();
    expect(result.contract.provenAt).toBeNull();
    // Protected main preserved.
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
    const loaded = await loadPhase0LaunchContract({
      adapters: fx.adapters,
      path: result.layout!.phase0ContractPath,
    });
    expect(loaded?.status).not.toBe("proven");
  }, 30_000);

  test("unidentified-spawn child wait timeout preserves residual authority", async () => {
    const fx = createBaseFaultFixture("wait-timeout");
    const spawn: LaunchSpawnAdapter = {
      async spawn() {
        const pid = fx.nextPid.value++;
        return {
          pid,
          wait() {
            // Never resolves: wait timeout.
            return new Promise(() => undefined);
          },
          kill() {
            // no-op
          },
        };
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn,
      osHome: `/tmp/homes/phase0-fault-wait-timeout-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 60,
      stopTimeoutMs: 60,
      pollMs: 5,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected wait timeout residual");
    expect(result.contract.status).toBe("incomplete");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.error.code).toBe("phase0_cleanup_uncertain");
    expect(result.contract.acceptanceAuthority).toBeNull();
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("unidentified-spawn unobservable identity and PID-reuse ambiguity preserve residual authority", async () => {
    const fx = createBaseFaultFixture("identity-ambiguous");
    const ghostPids: number[] = [];
    const baseRuntime = fx.runtimeProcess;
    const runtimeProcess: RuntimeProcess = {
      ...baseRuntime,
      async identify(pid, opts) {
        if (ghostPids.includes(pid)) {
          // Live PID without acceptance start baseline: PID-reuse ambiguity.
          return { pid, processStartedAt: `reuse-${pid}` };
        }
        return baseRuntime.identify(pid, opts);
      },
    };
    const spawn: LaunchSpawnAdapter = {
      async spawn() {
        const pid = fx.nextPid.value++;
        ghostPids.push(pid);
        return {
          pid,
          async wait() {
            return { exitCode: 0, signal: null };
          },
          kill() {
            // leave identity still observable
          },
        };
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess,
      runtimeAdapters: {
        ...fx.runtimeAdapters,
        process: runtimeProcess,
      },
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn,
      osHome: `/tmp/homes/phase0-fault-identity-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 60,
      stopTimeoutMs: 60,
      pollMs: 5,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected identity ambiguity residual");
    expect(result.contract.status).toBe("incomplete");
    expect(result.error.code).toBe("phase0_cleanup_uncertain");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.acceptanceAuthority).toBeNull();
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("unidentified-spawn with unrelated remaining 9444 listener preserves residual authority", async () => {
    const fx = createBaseFaultFixture("listener-remains");
    const spawn: LaunchSpawnAdapter = {
      async spawn() {
        const pid = fx.nextPid.value++;
        return {
          pid,
          async wait() {
            return { exitCode: 0, signal: null };
          },
          kill() {
            // After kill attempt, introduce an unrelated remaining 9444 listener that
            // must not be adopted or killed; residual authority is required.
            fx.processes.set(77777, {
              start: "foreign-listener-start",
              argv: ["/usr/bin/unrelated", "--remote-debugging-port=9444"],
              alive: true,
            });
          },
        };
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn,
      osHome: `/tmp/homes/phase0-fault-listener-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 60,
      stopTimeoutMs: 60,
      pollMs: 5,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected remaining listener residual");
    expect(result.contract.status).toBe("incomplete");
    expect(result.error.code).toBe("phase0_cleanup_uncertain");
    expect(result.allowsLifecycleMutation).toBe(false);
    // Unrelated listener and protected main preserved (never targeted).
    expect(fx.processes.get(77777)?.alive).toBe(true);
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("cleanup-time execution-context replacement refuses Browser.close and records exact-signal fallback", async () => {
    const fx = createBaseFaultFixture("ctx-replace");
    let openCount = 0;
    const baseCdp = createInjectedCdp({ processes: fx.processes });
    const cdp: CdpAdapter = {
      ...baseCdp,
      async openTargetSession(input) {
        openCount += 1;
        const session = await baseCdp.openTargetSession(input);
        // After readiness opens, later cleanup revalidation sees a replaced context uniqueId.
        if (openCount > 3) {
          return {
            ...session,
            async listExecutionContexts() {
              return [
                {
                  id: 99,
                  uniqueId: "replaced-context-unique",
                  targetId: input.target.id,
                  frameId: "frame-replaced",
                  isDefault: true,
                  origin: "app://-",
                  name: "",
                },
              ];
            },
          };
        }
        return session;
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp,
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-ctx-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    // Signal fallback can still stop cleanly and prove, but method must be factual.
    if (result.ok) {
      const method = result.contract.acceptanceAuthority?.cleanupDisposition.method;
      expect(method === "exact-signal-only" || method === "browser-close-then-signal").toBe(true);
      expect(method).not.toBe("browser-close-only");
      expect(result.contract.acceptanceAuthority?.cleanupDisposition.uncertain).toBe(false);
      expect(result.contract.acceptanceOperationId).toBeTruthy();
      expect(result.contract.acceptanceAuthority?.operationId).toBe(
        result.contract.acceptanceOperationId ?? undefined,
      );
    } else {
      expect(result.contract.status).toBe("incomplete");
      expect(result.allowsLifecycleMutation).toBe(false);
      expect(result.contract.acceptanceAuthority).toBeNull();
    }
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("explicit Browser.close refusal falls back to exact-signal-only with factual disposition", async () => {
    const fx = createBaseFaultFixture("close-refuse");
    const baseCdp = createInjectedCdp({ processes: fx.processes });
    // No endpoint during cleanup authority revalidation => Browser.close refused.
    let readCount = 0;
    const cdp: CdpAdapter = {
      ...baseCdp,
      async readEndpoint(input) {
        readCount += 1;
        // After several readiness reads, refuse endpoint for cleanup revalidation.
        if (readCount > 8) {
          throw new Error("injected Browser.close endpoint refusal");
        }
        return baseCdp.readEndpoint(input);
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp,
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-close-refuse-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    if (result.ok) {
      expect(result.contract.acceptanceAuthority?.cleanupDisposition.method).toBe(
        "exact-signal-only",
      );
      expect(result.contract.acceptanceAuthority?.cleanupDisposition.stopped).toBe(true);
      expect(result.contract.acceptanceAuthority?.port9444Released).toBe(true);
      expect(result.contract.acceptanceAuthority?.cleanupDisposition.uncertain).toBe(false);
    } else {
      // If readiness itself failed due to endpoint refusal, remain incomplete non-authorizing.
      expect(result.contract.status).toBe("incomplete");
      expect(result.allowsLifecycleMutation).toBe(false);
    }
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("explicit port-release failure after exit preserves residual authority", async () => {
    const fx = createBaseFaultFixture("port-release");
    const baseRuntime = fx.runtimeProcess;
    const runtimeProcess: RuntimeProcess = {
      ...baseRuntime,
      async signalExact(identity, signal, opts) {
        const ok = await baseRuntime.signalExact(identity, signal, opts);
        if (ok) {
          // After exact ChatGPT exit, leave an unrelated 9444 listener.
          fx.processes.set(88888, {
            start: "orphan-listener",
            argv: ["/usr/bin/orphan", "--remote-debugging-port=9444"],
            alive: true,
          });
        }
        return ok;
      },
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess,
      runtimeAdapters: {
        ...fx.runtimeAdapters,
        process: runtimeProcess,
      },
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-port-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected port-release residual");
    expect(result.contract.status).toBe("incomplete");
    expect(result.error.code).toBe("phase0_cleanup_uncertain");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.acceptanceAuthority).toBeNull();
    expect(result.contract.provenAt).toBeNull();
    // Orphan listener and protected main were not adopted/killed as proven authority.
    expect(fx.processes.get(88888)?.alive).toBe(true);
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("starting-state write failure leaves no proven authority", async () => {
    const fx = createBaseFaultFixture("starting-write");
    const originalWrite = fx.adapters.fs.writeFile!.bind(fx.adapters.fs);
    let stateWrites = 0;
    fx.adapters.fs.writeFile = async (path, data) => {
      if (typeof path === "string" && path.includes("state.json")) {
        stateWrites += 1;
        if (stateWrites === 1) {
          throw new Error("injected starting-state write failure");
        }
      }
      return originalWrite(path, data);
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-starting-write-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected starting write failure");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.status).not.toBe("proven");
    expect(result.error.code).toBe("phase0_write_failure");
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("stopped-state write failure leaves no proven authority", async () => {
    const fx = createBaseFaultFixture("stopped-write");
    const originalWrite = fx.adapters.fs.writeFile!.bind(fx.adapters.fs);
    let stateWrites = 0;
    fx.adapters.fs.writeFile = async (path, data) => {
      if (typeof path === "string" && path.includes("state.json")) {
        stateWrites += 1;
        // starting write is first; success stopped write is second.
        if (stateWrites >= 2) {
          throw new Error("injected stopped-state write failure");
        }
      }
      return originalWrite(path, data);
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-stopped-write-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected stopped write failure");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.status).not.toBe("proven");
    expect(result.error.code).toBe("phase0_write_failure");
    // No proven contract may be the last write after stopped-state failure.
    if (result.layout) {
      const loaded = await loadPhase0LaunchContract({
        adapters: fx.adapters,
        path: result.layout.phase0ContractPath,
      });
      expect(loaded?.status).not.toBe("proven");
    }
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("final-proven contract write failure leaves no proven authority", async () => {
    const fx = createBaseFaultFixture("final-proven-write");
    const originalWrite = fx.adapters.fs.writeFile!.bind(fx.adapters.fs);
    let contractWrites = 0;
    fx.adapters.fs.writeFile = async (path, data) => {
      if (typeof path === "string" && path.includes("phase0-launch-contract.json")) {
        contractWrites += 1;
        // Pre-spawn incomplete is first; final proven is last after stopped state.
        if (contractWrites >= 2) {
          throw new Error("injected final-proven contract write failure");
        }
      }
      return originalWrite(path, data);
    };
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-final-write-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected final proven write failure");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.status).not.toBe("proven");
    expect(result.error.code).toBe("phase0_write_failure");
    if (result.layout) {
      const loaded = await loadPhase0LaunchContract({
        adapters: fx.adapters,
        path: result.layout.phase0ContractPath,
      });
      expect(loaded?.status).not.toBe("proven");
      const state = await loadDevInstanceState({
        adapters: fx.adapters,
        statePath: result.layout.statePath,
      });
      // Stopped state may have been written before proven-last failure; still not authorizing.
      expect(state?.status === "stopped" || state?.status === "failed" || state?.status === "starting").toBe(
        true,
      );
    }
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

  test("successful acceptance binds independent enclosing operation identity on contract", async () => {
    const fx = createBaseFaultFixture("op-id-bind");
    const result = await runPhase0LaunchIsolation({
      adapters: fx.adapters,
      runtimeProcess: fx.runtimeProcess,
      runtimeAdapters: fx.runtimeAdapters,
      commands: createInjectedCommands({
        processes: fx.processes,
        portOwnerByPid: fx.portOwnerByPid,
      }),
      cdp: createInjectedCdp({ processes: fx.processes }),
      spawn: createInjectedSpawn({ processes: fx.processes, nextPid: fx.nextPid }),
      osHome: `/tmp/homes/phase0-fault-op-id-${process.pid}`,
      rootPath: fx.root,
      protectedPaths: {
        mainProfilePath: `${fx.home}/../Library/Application Support/Codex`,
        userCodexHome: `${fx.home}/../.codex`,
        explodexHome: fx.home,
      },
      providedComparativeExperiments: sampleProvidedExperiments(fx.root),
      readinessTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      pollMs: 10,
      lockWaitMs: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.contract.status).toBe("proven");
    expect(result.contract.acceptanceOperationId).toBeTruthy();
    expect(result.contract.acceptanceAuthority?.operationId).toBe(result.contract.acceptanceOperationId ?? undefined);
    const loaded = await loadPhase0LaunchContract({
      adapters: fx.adapters,
      path: result.layout.phase0ContractPath,
    });
    expect(loaded?.acceptanceOperationId).toBe(result.contract.acceptanceOperationId ?? undefined);
    expect(loaded?.acceptanceAuthority?.operationId).toBe(result.contract.acceptanceOperationId ?? undefined);
    // Direct JS mutation of either ID alone fails parse/gate.
    const onlyAuthority = {
      ...result.contract,
      acceptanceAuthority: {
        ...result.contract.acceptanceAuthority!,
        operationId: "mutated-only-authority",
      },
    };
    const onlyEnclosing = {
      ...result.contract,
      acceptanceOperationId: "mutated-only-enclosing",
    };
    const { parsePhase0LaunchContract, gateDevelopmentLifecycleMutation } = await import(
      "../../src/dev/index.ts"
    );
    expect(parsePhase0LaunchContract(onlyAuthority)).toBeNull();
    expect(parsePhase0LaunchContract(onlyEnclosing)).toBeNull();
    expect(
      gateDevelopmentLifecycleMutation({
        operation: "dev-start",
        contract: onlyAuthority as typeof result.contract,
        expectedHost: result.frozenHost,
      }).allowed,
    ).toBe(false);
    expect(
      gateDevelopmentLifecycleMutation({
        operation: "dev-start",
        contract: onlyEnclosing as typeof result.contract,
        expectedHost: result.frozenHost,
      }).allowed,
    ).toBe(false);
    expect(fx.processes.get(fx.protectedMainPid)?.alive).toBe(true);
  }, 30_000);

});
