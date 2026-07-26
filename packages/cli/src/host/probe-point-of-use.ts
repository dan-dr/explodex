import type { CdpAdapter, CdpTargetSession } from "../cdp/adapters.ts";
import type { CdpExecutionContext, CdpTarget, TargetIdentity } from "../cdp/types.ts";
import type { RuntimeProcess } from "../runtime/adapters.ts";
import { deriveCompatibilityKey } from "./compatibility-key.ts";
import type { HostAdapters } from "./adapters.ts";
import { EXACT_RENDERER_URL } from "./constants.ts";
import { inspectCanonicalHost } from "./identity.ts";
import {
  createNodePortInventoryAdapter,
  createNodeProcessInventoryAdapter,
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

export type CompatibleTargetObservation = {
  id: string;
  type: string;
  url: string;
};

export type DefaultContextObservation = {
  id: number;
  uniqueId: string;
  frameId: string;
  isDefault: boolean;
};

export type ProbePointOfUseObservation = {
  host: HostIdentity;
  processAlive: boolean;
  /** Freshly observed executable path for the expected PID, or null if unobserved. */
  processExecutablePath: string | null;
  /** Freshly observed kernel start identity for the expected PID, or null if unobserved. */
  processStartedAt: string | null;
  listeners: ListenerObservation[];
  browserIdentity: string | null;
  endpointPublishedPid: number | null;
  /** Complete compatible page inventory (type=page, url=app://-/index.html). */
  compatibleTargets: CompatibleTargetObservation[];
  /** Complete default execution-context inventory from the attached session. */
  defaultContexts: DefaultContextObservation[];
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

/** Pure PID/start/executable barrier against freshly observed identity. */
export function matchProcessIdentity(
  expected: VerifiedProcess,
  observed: {
    pid: number;
    processStartedAt: string | null;
    executablePath: string | null;
    alive: boolean;
  },
): string | null {
  if (!observed.alive) return "process_identity_drift:dead";
  if (expected.pid !== observed.pid) return "process_identity_drift:pid";
  if (observed.processStartedAt === null) return "process_identity_drift:start_unobserved";
  if (expected.processStartedAt !== observed.processStartedAt) {
    return "process_identity_drift:start";
  }
  if (observed.executablePath === null || observed.executablePath.length === 0) {
    return "process_identity_drift:executable_unobserved";
  }
  if (expected.executablePath !== observed.executablePath) {
    return "process_identity_drift:executable";
  }
  return null;
}

/**
 * Unique 9444 acceptance-owner barrier.
 * Exactly one distinct loopback-9444 owner PID is allowed, and it must be the
 * acceptance process with matching start identity. Any undeclared co-owner aborts.
 */
export function matchUniquePortOwner(
  expected: VerifiedProcess,
  port: 9444,
  listeners: ListenerObservation[],
): string | null {
  const onPort = listeners.filter((entry) => entry.port === port);
  if (onPort.length === 0) return "port_owner_drift:missing";

  const distinctPids = [...new Set(onPort.map((entry) => entry.pid))].sort((a, b) => a - b);
  if (distinctPids.length !== 1) {
    return "port_owner_drift:undeclared_co_owner";
  }
  if (distinctPids[0] !== expected.pid) {
    return "port_owner_drift:missing_acceptance";
  }

  const owned = onPort.filter((entry) => entry.pid === expected.pid);
  const withStart = owned.filter((entry) => entry.processStartedAt !== null);
  if (
    withStart.length > 0 &&
    withStart.some((entry) => entry.processStartedAt !== expected.processStartedAt)
  ) {
    return "port_owner_drift:start_mismatch";
  }
  return null;
}

/**
 * Require one complete compatible target inventory that matches the frozen target.
 * Additional or missing compatible app targets abort without replacement selection.
 */
export function matchCompleteCompatibleTargetInventory(
  expected: TargetIdentity,
  compatibleTargets: readonly CompatibleTargetObservation[],
): string | null {
  if (compatibleTargets.length === 0) return "target_inventory_empty";
  if (compatibleTargets.length > 1) return "target_inventory_ambiguous";
  const only = compatibleTargets[0];
  if (only === undefined) return "target_inventory_empty";
  if (only.id !== expected.targetId) return "target_identity_drift:id";
  if (only.url !== expected.targetUrl) return "target_identity_drift:url";
  if (only.type !== expected.targetType) return "target_identity_drift:type";
  return null;
}

/**
 * Require one complete default-context inventory matching the frozen context.
 * Additional compatible default contexts abort without replacement selection.
 */
export function matchCompleteDefaultContextInventory(
  expected: TargetIdentity,
  defaultContexts: readonly DefaultContextObservation[],
): string | null {
  if (defaultContexts.length === 0) return "context_inventory_empty";
  if (defaultContexts.length > 1) return "context_inventory_ambiguous";
  const only = defaultContexts[0];
  if (only === undefined) return "context_inventory_empty";
  if (only.id !== expected.executionContextId) return "context_identity_drift:id";
  if (only.uniqueId !== expected.executionContextUniqueId) {
    return "context_identity_drift:uniqueId";
  }
  if (only.frameId !== expected.frameId) return "context_identity_drift:frame";
  return null;
}

/** Browser + exact target/frame/context identity barrier (legacy field equality). */
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

  // Freshly observed executable/start only — never copy expected identity.
  const processDrift = matchProcessIdentity(input.expected.process, {
    pid: input.expected.process.pid,
    processStartedAt: input.observation.processStartedAt,
    executablePath: input.observation.processExecutablePath,
    alive: input.observation.processAlive,
  });
  if (processDrift !== null) return processDrift;

  const portDrift = matchUniquePortOwner(
    input.expected.process,
    input.expected.port,
    input.observation.listeners,
  );
  if (portDrift !== null) return portDrift;

  const targetInventoryDrift = matchCompleteCompatibleTargetInventory(
    input.expected.target,
    input.observation.compatibleTargets,
  );
  if (targetInventoryDrift !== null) return targetInventoryDrift;

  const contextInventoryDrift = matchCompleteDefaultContextInventory(
    input.expected.target,
    input.observation.defaultContexts,
  );
  if (contextInventoryDrift !== null) return contextInventoryDrift;

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

function compatibleTargetsFrom(targets: readonly CdpTarget[]): CompatibleTargetObservation[] {
  return targets
    .filter((target) => target.type === "page" && target.url === EXACT_RENDERER_URL)
    .map((target) => ({ id: target.id, type: target.type, url: target.url }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function defaultContextsFrom(
  contexts: readonly CdpExecutionContext[],
): DefaultContextObservation[] {
  return contexts
    .filter((context) => context.isDefault)
    .map((context) => ({
      id: context.id,
      uniqueId: context.uniqueId,
      frameId: context.frameId,
      isDefault: true as const,
    }))
    .sort((left, right) => left.id - right.id);
}

/**
 * Independently revalidate frozen host, PID/start/executable, unique 9444 owner,
 * complete compatible target/default-context inventory, browser identity, exact
 * target/frame/context, and compatibility identity.
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

  // Fresh process identity: start via identify, executable via process inventory.
  const processInventory = createNodeProcessInventoryAdapter({
    commands: input.commands,
    exactProcess: input.runtimeProcess,
  });
  let processExecutablePath: string | null = null;
  let processStartedAt: string | null = null;
  let processAlive = false;
  try {
    const identity = await input.runtimeProcess.identify(input.expected.process.pid, {
      abortSignal: input.signal,
    });
    if (identity !== null && identity.pid === input.expected.process.pid) {
      processStartedAt = identity.processStartedAt;
      processAlive =
        identity.processStartedAt === input.expected.process.processStartedAt;
    }
    const processes = await processInventory.list({ signal: input.signal });
    const match = processes.find((entry) => entry.pid === input.expected.process.pid);
    if (match !== undefined) {
      processExecutablePath = match.executablePath;
    }
  } catch (error: unknown) {
    return {
      ok: false,
      stage: input.stage,
      reason: `process_recheck_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
      observation: null,
    };
  }

  const ports = createNodePortInventoryAdapter(input.commands);
  let listeners: ListenerObservation[] = [];
  try {
    const rawListeners = await ports.listenersFor(input.expected.port, {
      signal: input.signal,
    });
    // Attach start identity per listener PID when possible.
    listeners = [];
    for (const entry of rawListeners) {
      try {
        const identity = await input.runtimeProcess.identify(entry.pid, {
          abortSignal: input.signal,
        });
        listeners.push({
          ...entry,
          processStartedAt:
            identity?.pid === entry.pid ? identity.processStartedAt : null,
        });
      } catch {
        listeners.push({ ...entry, processStartedAt: null });
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      stage: input.stage,
      reason: `port_recheck_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
      observation: null,
    };
  }

  let browserIdentity: string | null = null;
  let endpointPublishedPid: number | null = null;
  let compatibleTargets: CompatibleTargetObservation[] = [];
  let defaultContexts: DefaultContextObservation[] = [];
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
    // Complete compatible inventory first — never filter to expected before counting.
    compatibleTargets = compatibleTargetsFrom(targets);
    if (compatibleTargets.length === 1) {
      const only = compatibleTargets[0]!;
      targetId = only.id;
      targetUrl = only.url;
      targetType = only.type;
    } else if (compatibleTargets.length > 1) {
      // Record ambiguity without selecting a replacement.
      targetId = null;
      targetUrl = null;
      targetType = null;
    }

    if (input.session.isOpen()) {
      const contexts = await input.session.listExecutionContexts({
        signal: input.signal,
      });
      defaultContexts = defaultContextsFrom(contexts);
      if (defaultContexts.length === 1) {
        const only = defaultContexts[0]!;
        executionContextId = only.id;
        executionContextUniqueId = only.uniqueId;
        frameId = only.frameId;
      } else {
        executionContextId = null;
        executionContextUniqueId = null;
        frameId = null;
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
    processAlive,
    processExecutablePath,
    processStartedAt,
    listeners,
    browserIdentity,
    endpointPublishedPid,
    compatibleTargets,
    defaultContexts,
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
