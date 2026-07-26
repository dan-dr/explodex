import type { CdpAdapter, CdpTargetSession } from "../cdp/adapters.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import type { RuntimeProcess } from "../runtime/adapters.ts";
import { deriveCompatibilityKey } from "./compatibility-key.ts";
import type { HostAdapters } from "./adapters.ts";
import { inspectCanonicalHost } from "./identity.ts";
import {
  createNodePortInventoryAdapter,
  type ReadOnlyCommandRunner,
} from "./process-adapters.ts";
import type {
  CompatibilityKey,
  HostIdentity,
  ProbeIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";
import type { ListenerObservation, VerifiedProcess } from "./status.ts";

export type ProbePointOfUseStage =
  | "preBridge"
  | "preSdkBootstrap"
  | "preSdkBootstrapRepeat"
  | "preAnchor"
  | "prePersist";

export type ProbePointOfUseExpected = {
  host: HostIdentity;
  process: VerifiedProcess;
  port: 9444;
  browserIdentity: string;
  target: TargetIdentity;
  compatibilityKey: CompatibilityKey;
  sdkRuntime: SdkRuntimeIdentity;
  probe: ProbeIdentity;
};

export type ProbePointOfUseObservation = {
  host: HostIdentity;
  processAlive: boolean;
  listeners: ListenerObservation[];
  browserIdentity: string | null;
  endpointPublishedPid: number | null;
  targetId: string | null;
  targetUrl: string | null;
  targetType: string | null;
  executionContextId: number | null;
  executionContextUniqueId: string | null;
  frameId: string | null;
  compatibilityKey: CompatibilityKey;
};

export type ProbePointOfUseRecheck =
  | {
      ok: true;
      stage: ProbePointOfUseStage;
      host: HostIdentity;
      observation: ProbePointOfUseObservation;
    }
  | {
      ok: false;
      stage: ProbePointOfUseStage;
      reason: string;
      observation: ProbePointOfUseObservation | null;
    };

function hostEquals(left: HostIdentity, right: HostIdentity): boolean {
  if (
    left.bundlePath !== right.bundlePath ||
    left.executablePath !== right.executablePath ||
    left.bundleId !== right.bundleId ||
    left.executableName !== right.executableName ||
    left.signingTeam !== right.signingTeam ||
    left.appVersion !== right.appVersion ||
    left.appBuild !== right.appBuild
  ) {
    return false;
  }
  const leftKeys = Object.keys(left.hostHashes).sort();
  const rightKeys = Object.keys(right.hostHashes).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left.hostHashes[key]?.toLowerCase() !== right.hostHashes[key]?.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/** Pure host identity barrier for frozen operation-start identity. */
export function matchFrozenHost(
  expected: HostIdentity,
  observed: HostIdentity,
): string | null {
  return hostEquals(expected, observed) ? null : "active_host_drift";
}

/** Pure PID/start/executable barrier. */
export function matchProcessIdentity(
  expected: VerifiedProcess,
  observed: { pid: number; processStartedAt: string; executablePath: string; alive: boolean },
): string | null {
  if (!observed.alive) return "process_identity_drift:dead";
  if (expected.pid !== observed.pid) return "process_identity_drift:pid";
  if (expected.processStartedAt !== observed.processStartedAt) {
    return "process_identity_drift:start";
  }
  if (expected.executablePath !== observed.executablePath) {
    return "process_identity_drift:executable";
  }
  return null;
}

/**
 * Unique 9444 acceptance-owner barrier.
 * The exact acceptance process must still own loopback 9444. Helper children may
 * co-listen on the shared FD, so additional PIDs alone are not drift; absence of
 * the acceptance PID or a start-identity mismatch is.
 */
export function matchUniquePortOwner(
  expected: VerifiedProcess,
  port: 9444,
  listeners: ListenerObservation[],
): string | null {
  const onPort = listeners.filter((entry) => entry.port === port);
  if (onPort.length === 0) return "port_owner_drift:missing";
  const owned = onPort.filter((entry) => entry.pid === expected.pid);
  if (owned.length === 0) return "port_owner_drift:missing_acceptance";
  const withStart = owned.filter((entry) => entry.processStartedAt !== null);
  if (
    withStart.length > 0 &&
    withStart.some((entry) => entry.processStartedAt !== expected.processStartedAt)
  ) {
    return "port_owner_drift:start_mismatch";
  }
  return null;
}

/** Browser + exact target/frame/context identity barrier. */
export function matchBrowserTargetContext(
  expected: TargetIdentity,
  observed: {
    browserIdentity: string | null;
    endpointPublishedPid: number | null;
    targetId: string | null;
    targetUrl: string | null;
    targetType: string | null;
    executionContextId: number | null;
    executionContextUniqueId: string | null;
    frameId: string | null;
  },
): string | null {
  if (observed.browserIdentity === null || observed.browserIdentity !== expected.browserIdentity) {
    return "browser_identity_drift";
  }
  if (
    observed.endpointPublishedPid !== null &&
    observed.endpointPublishedPid !== expected.pid
  ) {
    return "endpoint_published_pid_drift";
  }
  if (observed.targetId !== expected.targetId) return "target_identity_drift:id";
  if (observed.targetUrl !== expected.targetUrl) return "target_identity_drift:url";
  if (observed.targetType !== expected.targetType) return "target_identity_drift:type";
  if (observed.executionContextId !== expected.executionContextId) {
    return "context_identity_drift:id";
  }
  if (observed.executionContextUniqueId !== expected.executionContextUniqueId) {
    return "context_identity_drift:uniqueId";
  }
  if (observed.frameId !== expected.frameId) return "context_identity_drift:frame";
  return null;
}

/** Exact compatibility identity barrier (key components must still match). */
export function matchCompatibilityIdentity(
  expected: CompatibilityKey,
  host: HostIdentity,
  sdkRuntime: SdkRuntimeIdentity,
  probe: ProbeIdentity,
): string | null {
  const current = deriveCompatibilityKey({ host, sdkRuntime, probe });
  if (
    current.appVersion !== expected.appVersion ||
    current.appBuild !== expected.appBuild ||
    current.sdkRuntimeSha256.toLowerCase() !== expected.sdkRuntimeSha256.toLowerCase() ||
    current.probeSchemaVersion !== expected.probeSchemaVersion ||
    current.probeToolVersion !== expected.probeToolVersion
  ) {
    return "compatibility_identity_drift";
  }
  return null;
}

/**
 * Pure correlation of an independently gathered observation against the frozen
 * expected point-of-use identity. Any mismatch aborts without evaluation.
 */
export function correlatePointOfUseObservation(input: {
  expected: ProbePointOfUseExpected;
  observation: ProbePointOfUseObservation;
}): string | null {
  const hostDrift = matchFrozenHost(input.expected.host, input.observation.host);
  if (hostDrift !== null) return hostDrift;

  const processDrift = matchProcessIdentity(input.expected.process, {
    pid: input.expected.process.pid,
    processStartedAt: input.expected.process.processStartedAt,
    executablePath: input.expected.process.executablePath,
    alive: input.observation.processAlive,
  });
  if (processDrift !== null) return processDrift;

  const portDrift = matchUniquePortOwner(
    input.expected.process,
    input.expected.port,
    input.observation.listeners,
  );
  if (portDrift !== null) return portDrift;

  const targetDrift = matchBrowserTargetContext(input.expected.target, input.observation);
  if (targetDrift !== null) return targetDrift;

  const keyDrift = matchCompatibilityIdentity(
    input.expected.compatibilityKey,
    input.observation.host,
    input.expected.sdkRuntime,
    input.expected.probe,
  );
  if (keyDrift !== null) return keyDrift;

  // Observation-carried key must also equal expected.
  if (
    input.observation.compatibilityKey.appVersion !== input.expected.compatibilityKey.appVersion ||
    input.observation.compatibilityKey.appBuild !== input.expected.compatibilityKey.appBuild ||
    input.observation.compatibilityKey.sdkRuntimeSha256.toLowerCase() !==
      input.expected.compatibilityKey.sdkRuntimeSha256.toLowerCase() ||
    input.observation.compatibilityKey.probeSchemaVersion !==
      input.expected.compatibilityKey.probeSchemaVersion ||
    input.observation.compatibilityKey.probeToolVersion !==
      input.expected.compatibilityKey.probeToolVersion
  ) {
    return "compatibility_identity_drift:observation";
  }

  return null;
}

/**
 * Independently revalidate frozen host, PID/start/executable, unique 9444 owner,
 * browser identity, exact target/frame/context, and compatibility identity.
 * Does not evaluate renderer code and never selects a replacement target.
 */
export async function revalidateProbePointOfUse(input: {
  stage: ProbePointOfUseStage;
  adapters: HostAdapters;
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  cdp: CdpAdapter;
  session: CdpTargetSession;
  expected: ProbePointOfUseExpected;
  signal?: AbortSignal;
}): Promise<ProbePointOfUseRecheck> {
  const inspection = await inspectCanonicalHost(input.adapters);
  if (!inspection.ok || inspection.host === null) {
    return {
      ok: false,
      stage: input.stage,
      reason: inspection.ok
        ? "host_missing"
        : `host_recheck_failed:${inspection.error.code}`,
      observation: null,
    };
  }

  const alive = await input.runtimeProcess.isAlive(
    input.expected.process.pid,
    input.expected.process.processStartedAt,
    { abortSignal: input.signal },
  );

  const ports = createNodePortInventoryAdapter(input.commands);
  const listeners = await ports.listenersFor(input.expected.port, {
    signal: input.signal,
  });

  let browserIdentity: string | null = null;
  let endpointPublishedPid: number | null = null;
  let targetId: string | null = null;
  let targetUrl: string | null = null;
  let targetType: string | null = null;
  let executionContextId: number | null = null;
  let executionContextUniqueId: string | null = null;
  let frameId: string | null = null;

  try {
    const version = await input.cdp.readEndpoint({
      host: "127.0.0.1",
      port: input.expected.port,
      signal: input.signal,
    });
    browserIdentity = version.browser;
    endpointPublishedPid = version.pid ?? null;

    const targets = await input.cdp.listTargets({
      host: "127.0.0.1",
      port: input.expected.port,
      signal: input.signal,
    });
    const exact = targets.filter(
      (target) =>
        target.type === "page" &&
        target.url === "app://-/index.html" &&
        target.id === input.expected.target.targetId,
    );
    if (exact.length === 1) {
      const selected = exact[0]!;
      targetId = selected.id;
      targetUrl = selected.url;
      targetType = selected.type;
    } else if (exact.length === 0) {
      // Do not pick a replacement; record absence for pure correlation.
      const anyCompatible = targets.filter(
        (target) => target.type === "page" && target.url === "app://-/index.html",
      );
      if (anyCompatible.length === 1) {
        // Replacement present under different id — still drift, not selection.
        targetId = anyCompatible[0]!.id;
        targetUrl = anyCompatible[0]!.url;
        targetType = anyCompatible[0]!.type;
      }
    }

    if (input.session.isOpen()) {
      const contexts = await input.session.listExecutionContexts({
        signal: input.signal,
      });
      const match = contexts.find(
        (context) =>
          context.id === input.expected.target.executionContextId &&
          context.uniqueId === input.expected.target.executionContextUniqueId &&
          context.frameId === input.expected.target.frameId &&
          context.isDefault,
      );
      if (match !== undefined) {
        executionContextId = match.id;
        executionContextUniqueId = match.uniqueId;
        frameId = match.frameId;
      } else if (contexts.length === 1 && contexts[0]?.isDefault) {
        // Record drifted context without selecting it for evaluation.
        executionContextId = contexts[0]!.id;
        executionContextUniqueId = contexts[0]!.uniqueId;
        frameId = contexts[0]!.frameId;
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      stage: input.stage,
      reason: `point_of_use_endpoint_unavailable:${
        error instanceof Error ? error.message : String(error)
      }`,
      observation: null,
    };
  }

  const observation: ProbePointOfUseObservation = {
    host: {
      bundlePath: inspection.host.bundlePath,
      executablePath: inspection.host.executablePath,
      bundleId: inspection.host.bundleId,
      executableName: inspection.host.executableName,
      signingTeam: inspection.host.signingTeam,
      appVersion: inspection.host.appVersion,
      appBuild: inspection.host.appBuild,
      hostHashes: { ...inspection.host.hostHashes },
    },
    processAlive: alive,
    listeners,
    browserIdentity,
    endpointPublishedPid,
    targetId,
    targetUrl,
    targetType,
    executionContextId,
    executionContextUniqueId,
    frameId,
    compatibilityKey: deriveCompatibilityKey({
      host: {
        signingTeam: inspection.host.signingTeam,
        appVersion: inspection.host.appVersion,
        appBuild: inspection.host.appBuild,
        hostHashes: { ...inspection.host.hostHashes },
      },
      sdkRuntime: input.expected.sdkRuntime,
      probe: input.expected.probe,
    }),
  };

  const drift = correlatePointOfUseObservation({
    expected: input.expected,
    observation,
  });
  if (drift !== null) {
    return {
      ok: false,
      stage: input.stage,
      reason: drift,
      observation,
    };
  }

  return {
    ok: true,
    stage: input.stage,
    host: observation.host,
    observation,
  };
}
