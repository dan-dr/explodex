import { join } from "node:path";
import type { CdpAdapter } from "../cdp/adapters.ts";
import { inspectCompatibleEndpoint } from "../cdp/endpoint.ts";
import type { HostAdapters } from "../host/adapters.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { inspectHost } from "../host/identity.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import {
  roleEndpoint,
  type HostStatusAdapters,
  type ProcessObservation,
  type VerifiedProcess,
} from "../host/status.ts";
import type { ReadOnlyCommandRunner } from "../host/process-adapters.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import { DEV_CDP_PORT } from "./constants.ts";
import type { LaunchSpawnAdapter } from "./launch-adapters.ts";
import type { DevLifecycleLaunchAdapter } from "./lifecycle.ts";
import { freezeHostIdentity, frozenHostEquals } from "./phase0.ts";
import { stopExactProcess } from "./phase0-operation.ts";
import { inspectDevInstanceStatus } from "./status-operation.ts";
import type {
  DevInstanceState,
  DevLayoutPaths,
  Phase0FrozenHost,
  Phase0LaunchContract,
} from "./types.ts";
import type { DevTerminationResult } from "./workflow.ts";

type DevLifecycleOperationKind = "start" | "ensure" | "restart" | "stop";

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw Object.assign(new Error("Development lifecycle interrupted."), {
      code: "ABORT_ERR",
    });
  }
  await new Promise<void>((resolveSleep, reject) => {
    const onAbort = (): void => {
      globalThis.clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("Development lifecycle interrupted."), {
        code: "ABORT_ERR",
      }));
    };
    const handle = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function asVerifiedProcess(
  process: ProcessObservation,
  processStartedAt: string,
): VerifiedProcess {
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    executablePath: process.executablePath,
    arguments: [...process.arguments],
    processStartedAt,
  };
}

function launchDescriptor(options: {
  contract: Phase0LaunchContract;
  frozenHost: Phase0FrozenHost;
  layout: DevLayoutPaths;
}): {
  argv: string[];
  env: Record<string, string | undefined>;
  marker: string;
} {
  const descriptor = options.contract.sanitizedLaunchDescriptor;
  const marker = options.contract.launchMarker?.value;
  const isolation = options.contract.isolation;
  if (
    marker === undefined ||
    descriptor.argv[0] !== options.frozenHost.executablePath ||
    !descriptor.argv.some((token) => token === marker) ||
    !descriptor.argv.some(
      (token) => token === `--remote-debugging-port=${DEV_CDP_PORT}`,
    ) ||
    (
      isolation.electronUserDataPath !== null &&
      isolation.electronUserDataPath !== options.layout.electronUserDataPath
    ) ||
    (
      isolation.codexHomePath !== null &&
      isolation.codexHomePath !== options.layout.codexHomePath
    ) ||
    (
      isolation.explodexHomePath !== null &&
      isolation.explodexHomePath !== options.layout.explodexStatePath
    )
  ) {
    throw new Error(
      "Proven Phase 0 launch descriptor is incomplete or disagrees with the frozen host.",
    );
  }
  const env: Record<string, string | undefined> = {};
  for (const key of descriptor.envKeys) {
    const value = descriptor.envValues?.[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Proven launch descriptor is missing value for ${key}.`);
    }
    env[key] = value;
  }
  return {
    argv: descriptor.argv.slice(1),
    env,
    marker,
  };
}

export function createProductionDevLaunch(options: {
  hostAdapters: HostAdapters;
  runtime: RuntimeAdapters;
  statusAdapters: HostStatusAdapters;
  cdp: CdpAdapter;
  spawn: LaunchSpawnAdapter;
  contract: Phase0LaunchContract;
  frozenHost: Phase0FrozenHost;
  layout: DevLayoutPaths;
  explodexHome: string;
  logsPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): DevLifecycleLaunchAdapter {
  return async ({ onSpawn }) => {
    const descriptor = launchDescriptor({
      contract: options.contract,
      frozenHost: options.frozenHost,
      layout: options.layout,
    });
    const spawned = await options.spawn.spawn({
      executablePath: options.frozenHost.executablePath,
      argv: descriptor.argv,
      env: descriptor.env,
      stdoutPath: join(options.logsPath, "dev.stdout.log"),
      stderrPath: join(options.logsPath, "dev.stderr.log"),
      inheritHostEnvironment: true,
    });
    const deadline = Date.now() + options.timeoutMs;
    let startedAt: string | null = null;
    let announced = false;
    let lastReason = "Development process did not become ready.";
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw Object.assign(new Error("Development launch interrupted."), {
          code: "ABORT_ERR",
        });
      }
      const identity = await options.runtime.process.identify(spawned.pid, {
        abortSignal: options.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (identity === null) {
        lastReason = "Spawned development PID exited before identity verification.";
        break;
      }
      startedAt = identity.processStartedAt;
      if (!announced) {
        await onSpawn({
          pid: spawned.pid,
          processStartedAt: startedAt,
        });
        announced = true;
      }

      const processes = await options.statusAdapters.process.list({
        signal: options.signal,
      });
      const process = processes.find((entry) => entry.pid === spawned.pid);
      if (
        process === undefined ||
        process.executablePath !== options.frozenHost.executablePath ||
        !process.arguments.some((token) => token === descriptor.marker)
      ) {
        lastReason = "Spawned process inventory did not match executable and marker.";
        await sleep(100, options.signal);
        continue;
      }
      const listeners = await options.statusAdapters.port.listenersFor(
        DEV_CDP_PORT,
        { signal: options.signal },
      );
      let exactListenerCount = 0;
      for (const listener of listeners) {
        const listenerIdentity = await options.statusAdapters.process.identify(
          listener.pid,
          { signal: options.signal },
        );
        if (
          listener.host === "127.0.0.1" &&
          listener.pid === spawned.pid &&
          listenerIdentity?.processStartedAt === startedAt
        ) {
          exactListenerCount += 1;
        }
      }
      if (listeners.length !== 1 || exactListenerCount !== 1) {
        lastReason = "9444 did not have one exact owned loopback listener.";
        await sleep(100, options.signal);
        continue;
      }

      let endpoint;
      try {
        endpoint = await inspectCompatibleEndpoint({
          role: "development",
          endpoint: roleEndpoint("development"),
          process: asVerifiedProcess(process, startedAt),
          host: options.frozenHost,
          cdp: options.cdp,
          signal: options.signal,
        });
      } catch (error: unknown) {
        lastReason = error instanceof Error
          ? `Exact renderer endpoint not ready: ${error.message}`
          : "Exact renderer endpoint not ready.";
        await sleep(100, options.signal);
        continue;
      }
      if (endpoint.kind === "identity-mismatch") {
        throw new Error(
          "Development endpoint identity mismatched the exact spawned process.",
        );
      }
      if (
        endpoint.kind === "rejected" &&
        (
          endpoint.code === "target_ambiguous" ||
          endpoint.code === "context_ambiguous"
        )
      ) {
        throw new Error(
          `Development renderer ownership is ambiguous: ${endpoint.code}.`,
        );
      }
      if (endpoint.kind !== "available") {
        lastReason = `Exact renderer readiness incomplete: ${endpoint.code}.`;
        await sleep(100, options.signal);
        continue;
      }
      const rechecked = await inspectHost({
        adapters: options.hostAdapters,
        signal: options.signal,
      });
      if (
        !rechecked.ok ||
        !frozenHostEquals(options.frozenHost, freezeHostIdentity(rechecked.host))
      ) {
        throw new Error(
          "Canonical host identity drifted during development launch; abort without reconnect.",
        );
      }
      const [persisted, sdkRuntime] = await Promise.all([
        loadCompatibilityRecord({
          adapters: options.hostAdapters,
          explodexHome: options.explodexHome,
        }),
        resolveSdkRuntimeIdentityForCli(),
      ]);
      const compatibility = evaluateCompatibility({
        host: rechecked.host,
        sdkRuntime,
        persisted,
        runningProcess: {
          executablePath: process.executablePath,
          appVersion: options.frozenHost.appVersion,
          appBuild: options.frozenHost.appBuild,
        },
      });
      if (!compatibility.allowsCompatibilityDependentWork) {
        throw new Error(
          `Exact current compatibility proof became unavailable: ${compatibility.reason ?? "unproven"}.`,
        );
      }
      return {
        pid: endpoint.target.pid,
        processStartedAt: endpoint.target.processStartedAt,
        targetId: endpoint.target.targetId,
        browserIdentity: endpoint.target.browserIdentity,
        executionContextId: endpoint.target.executionContextId,
        executionContextUniqueId: endpoint.target.executionContextUniqueId,
        frameId: endpoint.target.frameId,
        appVersion: endpoint.target.appVersion,
        appBuild: endpoint.target.appBuild,
        frozenHost: options.frozenHost,
      };
    }
    throw Object.assign(new Error(lastReason), {
      code: Date.now() >= deadline ? "ETIMEDOUT" : "dev_launch_failed",
      spawnedPid: spawned.pid,
      processStartedAt: startedAt,
    });
  };
}

export function createProductionDevTermination(options: {
  kind: DevLifecycleOperationKind;
  osHome: string;
  explodexHome: string;
  explicitRoot: string | null;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  runtime: RuntimeAdapters;
  commands: ReadOnlyCommandRunner;
  cdp: CdpAdapter;
  timeoutMs: number;
  signal?: AbortSignal;
}): (state: DevInstanceState) => Promise<DevTerminationResult> {
  return async (state) => {
    const refreshed = await inspectDevInstanceStatus({
      osHome: options.osHome,
      explodexHome: options.explodexHome,
      explicitRoot: options.explicitRoot,
      operation: "recover",
      signal: options.signal,
      hostAdapters: options.hostAdapters,
      statusAdapters: options.statusAdapters,
      cdp: options.cdp,
    });
    if (
      refreshed.assessment.recoveryEligibility !== "fully-owned-live" ||
      refreshed.state?.pid !== state.pid ||
      refreshed.state?.processStartedAt !== state.processStartedAt ||
      refreshed.state?.targetId !== state.targetId ||
      refreshed.state?.executionContextUniqueId !==
        state.executionContextUniqueId
    ) {
      return {
        ok: false,
        confirmedExit: false,
        code: "dev.ownership-uncertain",
        message:
          "Exact development ownership changed immediately before graceful termination.",
        method: null,
        elapsedMs: 0,
        boundMs: options.timeoutMs,
      };
    }
    if (
      state.pid === null ||
      state.processStartedAt === null ||
      state.targetId === null ||
      state.executionContextUniqueId === null
    ) {
      return {
        ok: false,
        confirmedExit: false,
        code: "dev.ownership-uncertain",
        message: "Graceful termination requires complete exact live identity.",
        method: null,
        elapsedMs: 0,
        boundMs: options.timeoutMs,
      };
    }
    const started = Date.now();
    const stopped = await stopExactProcess({
      runtimeProcess: options.runtime.process,
      commands: options.commands,
      cdp: options.cdp,
      pid: state.pid,
      processStartedAt: state.processStartedAt,
      executablePath: state.executablePath,
      marker: state.launchMarker,
      timeoutMs: options.timeoutMs,
      pollMs: 100,
      expectedTargetId: state.targetId,
      expectedContextUniqueId: state.executionContextUniqueId,
      requireCompleteEndpointOwnershipForSignal: true,
      signal: options.signal,
    });
    const elapsedMs = Date.now() - started;
    if (
      stopped.stopped &&
      stopped.portReleased &&
      !stopped.uncertain &&
      stopped.method !== "none"
    ) {
      return {
        ok: true,
        confirmedExit: true,
        method: stopped.method,
        elapsedMs,
        boundMs: options.timeoutMs,
      };
    }
    return {
      ok: false,
      confirmedExit: false,
      code:
        !stopped.stopped && elapsedMs >= options.timeoutMs
          ? "operation.timeout"
          : "dev.termination-failed",
      message:
        stopped.reason ??
        `Exact development process did not terminate during dev.${options.kind}.`,
      method: stopped.method === "none" ? null : stopped.method,
      elapsedMs,
      boundMs: options.timeoutMs,
    };
  };
}
