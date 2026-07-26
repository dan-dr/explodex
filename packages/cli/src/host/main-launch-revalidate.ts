/**
 * Full pre-effect revalidation for explicit main launch/attach.
 *
 * Before work and every evaluation, independently revalidate frozen host,
 * PID/start/executable, unique 9333 owner, browser, target/frame/context,
 * compatibility identity, and same-operation authority. Drift stops effects
 * without reconnect and never selects a replacement target.
 */

import type { CdpAdapter, CdpTargetSession } from "../cdp/adapters.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import type { RuntimeProcess } from "../runtime/adapters.ts";
import { deriveCompatibilityKey } from "./compatibility-key.ts";
import {
  authorityStillMatches,
  type SameOperationAuthority,
} from "./main-launch-authority.ts";
import { MAIN_CDP_HOST, MAIN_CDP_PORT } from "./main-launch-types.ts";
import type { HostStatusResult, ListenerObservation, VerifiedProcess } from "./status.ts";
import type {
  CompatibilityKey,
  HostIdentity,
  ProbeIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";

export type MainLaunchRevalidateExpected = {
  host: HostIdentity;
  process: VerifiedProcess;
  target: TargetIdentity;
  compatibilityKey: CompatibilityKey;
  sdkRuntime: SdkRuntimeIdentity;
  probe: ProbeIdentity;
  authority: SameOperationAuthority;
};

export type MainLaunchRevalidateObservation = {
  host: HostIdentity;
  processAlive: boolean;
  processExecutablePath: string | null;
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
  authorityMatches: boolean;
};

export type MainLaunchRevalidateResult =
  | {
      ok: true;
      observation: MainLaunchRevalidateObservation;
    }
  | {
      ok: false;
      reason: string;
      observation: MainLaunchRevalidateObservation | null;
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

/** Unique loopback 9333 owner must still be the exact bound process. */
export function matchMainPortOwner(
  expected: VerifiedProcess,
  listeners: ListenerObservation[],
): string | null {
  const onPort = listeners.filter(
    (entry) =>
      entry.port === MAIN_CDP_PORT &&
      entry.host === MAIN_CDP_HOST,
  );
  if (onPort.length === 0) return "port_owner_drift:missing";
  const owned = onPort.filter((entry) => entry.pid === expected.pid);
  if (owned.length === 0) return "port_owner_drift:missing_owner";
  // Foreign co-listeners on 9333 fail closed for main (unique owner required).
  const foreign = onPort.filter((entry) => entry.pid !== expected.pid);
  if (foreign.length > 0) return "port_owner_drift:not_unique";
  const withStart = owned.filter((entry) => entry.processStartedAt !== null);
  if (
    withStart.length > 0 &&
    withStart.some((entry) => entry.processStartedAt !== expected.processStartedAt)
  ) {
    return "port_owner_drift:start_mismatch";
  }
  return null;
}

export function correlateMainLaunchObservation(input: {
  expected: MainLaunchRevalidateExpected;
  observation: MainLaunchRevalidateObservation;
}): string | null {
  if (!hostEquals(input.expected.host, input.observation.host)) {
    return "host_identity_drift";
  }
  if (!input.observation.processAlive) {
    return "process_identity_drift:dead";
  }
  if (
    input.observation.processExecutablePath !== null &&
    input.observation.processExecutablePath !== input.expected.process.executablePath
  ) {
    return "process_identity_drift:executable";
  }
  const portDrift = matchMainPortOwner(input.expected.process, input.observation.listeners);
  if (portDrift !== null) return portDrift;

  if (
    input.observation.browserIdentity === null ||
    input.observation.browserIdentity !== input.expected.target.browserIdentity
  ) {
    return "browser_identity_drift";
  }
  if (
    input.observation.endpointPublishedPid !== null &&
    input.observation.endpointPublishedPid !== input.expected.process.pid
  ) {
    return "endpoint_published_pid_drift";
  }
  if (input.observation.targetId !== input.expected.target.targetId) {
    return "target_identity_drift:id";
  }
  if (input.observation.targetUrl !== input.expected.target.targetUrl) {
    return "target_identity_drift:url";
  }
  if (input.observation.targetType !== input.expected.target.targetType) {
    return "target_identity_drift:type";
  }
  if (input.observation.executionContextId !== input.expected.target.executionContextId) {
    return "context_identity_drift:id";
  }
  if (
    input.observation.executionContextUniqueId !==
      input.expected.target.executionContextUniqueId
  ) {
    return "context_identity_drift:uniqueId";
  }
  if (input.observation.frameId !== input.expected.target.frameId) {
    return "context_identity_drift:frame";
  }

  const expectedKey = input.expected.compatibilityKey;
  const observedKey = input.observation.compatibilityKey;
  if (
    observedKey.appVersion !== expectedKey.appVersion ||
    observedKey.appBuild !== expectedKey.appBuild ||
    observedKey.sdkRuntimeSha256.toLowerCase() !== expectedKey.sdkRuntimeSha256.toLowerCase() ||
    observedKey.probeSchemaVersion !== expectedKey.probeSchemaVersion ||
    observedKey.probeToolVersion !== expectedKey.probeToolVersion
  ) {
    return "compatibility_identity_drift";
  }

  if (!input.observation.authorityMatches) {
    return "same_operation_authority_mismatch";
  }
  return null;
}

/**
 * Independently revalidate every pre-effect identity barrier for main 9333.
 * Never reconnects and never selects a replacement target/context.
 */
export async function revalidateMainLaunchPointOfUse(input: {
  freezeHost: () => Promise<HostIdentity>;
  collectStatus: (signal?: AbortSignal) => Promise<HostStatusResult>;
  runtimeProcess: RuntimeProcess;
  cdp: CdpAdapter;
  session: CdpTargetSession;
  expected: MainLaunchRevalidateExpected;
  signal?: AbortSignal;
}): Promise<MainLaunchRevalidateResult> {
  let host: HostIdentity;
  try {
    host = await input.freezeHost();
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `host_recheck_failed:${error instanceof Error ? error.message : String(error)}`,
      observation: null,
    };
  }

  const alive = await input.runtimeProcess.isAlive(
    input.expected.process.pid,
    input.expected.process.processStartedAt,
    { abortSignal: input.signal },
  );

  let processExecutablePath: string | null = input.expected.process.executablePath;
  const identified = await input.runtimeProcess.identify(input.expected.process.pid, {
    abortSignal: input.signal,
  });
  if (identified === null || identified.processStartedAt !== input.expected.process.processStartedAt) {
    // Dead or start-mismatched identity is process drift; executable stays expected for correlation.
    processExecutablePath = identified === null ? null : processExecutablePath;
  }

  const status = await input.collectStatus(input.signal);
  const listeners = status.listeners.filter(
    (entry) => entry.port === MAIN_CDP_PORT && entry.host === MAIN_CDP_HOST,
  );

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
      host: MAIN_CDP_HOST,
      port: MAIN_CDP_PORT,
      signal: input.signal,
    });
    browserIdentity = version.browser;
    endpointPublishedPid = version.pid ?? null;

    const targets = await input.cdp.listTargets({
      host: MAIN_CDP_HOST,
      port: MAIN_CDP_PORT,
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
      // Record a replacement if present, but never select it for evaluation.
      const anyCompatible = targets.filter(
        (target) => target.type === "page" && target.url === "app://-/index.html",
      );
      if (anyCompatible.length === 1) {
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
        executionContextId = contexts[0]!.id;
        executionContextUniqueId = contexts[0]!.uniqueId;
        frameId = contexts[0]!.frameId;
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `point_of_use_endpoint_unavailable:${
        error instanceof Error ? error.message : String(error)
      }`,
      observation: null,
    };
  }

  const authorityMatches = authorityStillMatches(input.expected.authority, {
    pid: input.expected.process.pid,
    processStartedAt: input.expected.process.processStartedAt,
    executablePath: input.expected.process.executablePath,
  }) && alive && (
    identified === null
      ? false
      : identified.pid === input.expected.process.pid &&
        identified.processStartedAt === input.expected.process.processStartedAt
  );

  const observation: MainLaunchRevalidateObservation = {
    host: {
      bundlePath: host.bundlePath,
      executablePath: host.executablePath,
      bundleId: host.bundleId,
      executableName: host.executableName,
      signingTeam: host.signingTeam,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      hostHashes: { ...host.hostHashes },
    },
    processAlive: alive,
    processExecutablePath,
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
        signingTeam: host.signingTeam,
        appVersion: host.appVersion,
        appBuild: host.appBuild,
        hostHashes: { ...host.hostHashes },
      },
      sdkRuntime: input.expected.sdkRuntime,
      probe: input.expected.probe,
    }),
    authorityMatches,
  };

  const drift = correlateMainLaunchObservation({
    expected: input.expected,
    observation,
  });
  if (drift !== null) {
    return { ok: false, reason: drift, observation };
  }
  return { ok: true, observation };
}

export function buildMainLaunchCompatibilityKey(input: {
  host: HostIdentity;
  sdkRuntime: SdkRuntimeIdentity;
  probe?: ProbeIdentity;
}): CompatibilityKey {
  return deriveCompatibilityKey({
    host: input.host,
    sdkRuntime: input.sdkRuntime,
    probe: input.probe,
  });
}

/**
 * Fail closed when pre-effect revalidation reports drift. Callers supply a
 * failure factory so this module stays free of launch-result coupling.
 */
export async function requireMainLaunchRevalidation(input: {
  freezeHost: () => Promise<HostIdentity>;
  collectStatus: (signal?: AbortSignal) => Promise<HostStatusResult>;
  runtimeProcess: RuntimeProcess;
  cdp: CdpAdapter;
  session: CdpTargetSession;
  expected: MainLaunchRevalidateExpected;
  signal?: AbortSignal;
  onFailure(reason: string, observation: MainLaunchRevalidateObservation | null): never;
}): Promise<void> {
  const result = await revalidateMainLaunchPointOfUse({
    freezeHost: input.freezeHost,
    collectStatus: input.collectStatus,
    runtimeProcess: input.runtimeProcess,
    cdp: input.cdp,
    session: input.session,
    expected: input.expected,
    signal: input.signal,
  });
  if (!result.ok) {
    input.onFailure(result.reason, result.observation);
  }
}
