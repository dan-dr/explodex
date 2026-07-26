import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_PHASE0_LAUNCH_MARKER,
  runPhase0LaunchIsolation,
} from "../../src/dev/phase0-operation.ts";
import { loadPhase0LaunchContract } from "../../src/dev/phase0.ts";
import { loadDevInstanceState } from "../../src/dev/state.ts";
import type { CdpAdapter, CdpTargetSession } from "../../src/cdp/adapters.ts";
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
      return {
        browser: "Chrome/ChatGPT-Test",
        protocolVersion: "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/browser/test",
        pid: owner[0],
      };
    },
    async listTargets() {
      return [
        {
          id: "page-1",
          type: "page",
          url: "app://-/index.html",
          title: "ChatGPT",
          webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/page-1",
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
          return [
            {
              id: 1,
              uniqueId: "unique-ctx-1",
              targetId: input.target.id,
              frameId: "frame-1",
              isDefault: true,
              origin: "app://-",
              name: "",
            },
          ];
        },
        async evaluate() {
          return { value: null };
        },
        async close() {
          // no-op
        },
      };
      return session;
    },
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
});
