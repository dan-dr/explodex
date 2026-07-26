import { deriveCompatibilityKey } from "./compatibility-key.ts";
import type { CompatibilityRecord } from "./types.ts";
import {
  COMPATIBILITY_PROBE_RESULT_SCHEMA_VERSION,
  REQUIRED_PROBE_ANCHORS,
  type CompatibilityProbeCommitDecision,
  type CompatibilityProbeResult,
  type ProbeAnchorObservation,
  type ProbeAnchorsSection,
  type ProbeBridgeSection,
  type ProbeCorrelationIdentity,
  type ProbeEndpointSection,
  type ProbeIsolationSection,
  type ProbeOutcome,
  type ProbeSafetySection,
  type ProbeSdkBootstrapSection,
} from "./probe-types.ts";

function isHostIdentityEqual(
  left: ProbeCorrelationIdentity["frozenHost"],
  right: ProbeCorrelationIdentity["frozenHost"] | null | undefined,
): boolean {
  if (right === null || right === undefined) return false;
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

/** Compare every section against the operation correlation identity. */
export function correlateProbeSections(input: {
  identity: ProbeCorrelationIdentity;
  isolation: ProbeIsolationSection;
  endpoint: ProbeEndpointSection;
  bridge: ProbeBridgeSection;
  sdkBootstrap: ProbeSdkBootstrapSection;
  anchors: ProbeAnchorsSection;
  safety: ProbeSafetySection;
}): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const { identity } = input;

  if (input.isolation.phase0FrozenHost !== null) {
    const phaseHost = input.isolation.phase0FrozenHost;
    if (
      phaseHost.appVersion !== identity.frozenHost.appVersion ||
      phaseHost.appBuild !== identity.frozenHost.appBuild ||
      phaseHost.bundlePath !== identity.frozenHost.bundlePath ||
      phaseHost.executablePath !== identity.frozenHost.executablePath ||
      phaseHost.signingTeam !== identity.frozenHost.signingTeam
    ) {
      mismatches.push("isolation.phase0FrozenHost");
    }
  }

  if (input.endpoint.complete) {
    if (input.endpoint.portOwnerPid !== identity.pid) {
      mismatches.push("endpoint.portOwnerPid");
    }
    if (input.endpoint.selectedTargetId !== identity.targetId) {
      mismatches.push("endpoint.selectedTargetId");
    }
    if (input.endpoint.executionContextId !== identity.executionContextId) {
      mismatches.push("endpoint.executionContextId");
    }
    if (
      input.endpoint.executionContextUniqueId !== null &&
      input.endpoint.executionContextUniqueId !== identity.executionContextUniqueId
    ) {
      mismatches.push("endpoint.executionContextUniqueId");
    }
    if (
      input.endpoint.endpointPublishedPid !== null &&
      input.endpoint.endpointPublishedPid !== identity.pid
    ) {
      mismatches.push("endpoint.endpointPublishedPid");
    }
  }

  if (input.sdkBootstrap.complete) {
    if (
      input.sdkBootstrap.sdkRuntime === null ||
      input.sdkBootstrap.sdkRuntime.version !== identity.sdkRuntime.version ||
      input.sdkBootstrap.sdkRuntime.sha256.toLowerCase() !==
        identity.sdkRuntime.sha256.toLowerCase()
    ) {
      mismatches.push("sdkBootstrap.sdkRuntime");
    }
  }

  const snapshots = [
    input.safety.hostSnapshots.operationStart,
    input.safety.hostSnapshots.preEndpoint,
    input.safety.hostSnapshots.preBridge,
    input.safety.hostSnapshots.preSdk,
    input.safety.hostSnapshots.preAnchor,
    input.safety.hostSnapshots.prePersist,
  ];
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot === null) continue;
    if (!isHostIdentityEqual(identity.frozenHost, snapshot)) {
      mismatches.push(`safety.hostSnapshots[${index}]`);
    }
  }

  const key = deriveCompatibilityKey({
    host: identity.frozenHost,
    sdkRuntime: identity.sdkRuntime,
    probe: identity.probe,
  });
  if (
    key.appVersion !== identity.compatibilityKey.appVersion ||
    key.appBuild !== identity.compatibilityKey.appBuild ||
    key.sdkRuntimeSha256.toLowerCase() !==
      identity.compatibilityKey.sdkRuntimeSha256.toLowerCase() ||
    key.probeSchemaVersion !== identity.compatibilityKey.probeSchemaVersion ||
    key.probeToolVersion !== identity.compatibilityKey.probeToolVersion
  ) {
    mismatches.push("compatibilityKey");
  }

  return { ok: mismatches.length === 0, mismatches };
}

function requiredAnchorsSatisfied(matrix: ProbeAnchorObservation[]): {
  ok: boolean;
  pending: boolean;
  reason: string | null;
} {
  const byName = new Map(matrix.map((entry) => [entry.name, entry]));
  let pending = false;
  for (const name of REQUIRED_PROBE_ANCHORS) {
    const observation = byName.get(name);
    if (observation === undefined) {
      return { ok: false, pending: false, reason: `missing_anchor:${name}` };
    }
    if (observation.verdict === "fail") {
      return { ok: false, pending: false, reason: `anchor_failed:${name}` };
    }
    if (observation.verdict === "pending-unreachable") {
      pending = true;
    }
  }
  return { ok: true, pending, reason: null };
}

/**
 * Decide whether one complete correlated probe may atomically commit proven.
 * Partial, mismatched, drifted, or pending signed-in results never authorize injection.
 */
export function decideProbeCommit(
  result: Omit<
    CompatibilityProbeResult,
    "status" | "allowsCompatibilityCommit" | "correlation" | "reason" | "probedAt"
  > & {
    correlation: CompatibilityProbeResult["correlation"];
    reason?: string | null;
  },
): CompatibilityProbeCommitDecision & { outcome: ProbeOutcome; reason: string | null } {
  if (!result.correlation.ok) {
    return {
      commit: false,
      status: "failed",
      recordReady: false,
      reason: `probe_identity_mismatch:${result.correlation.mismatches.join(",")}`,
      outcome: "failed",
    };
  }

  if (!result.isolation.complete) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: result.isolation.reason ?? "isolation_incomplete",
      outcome: "unproven",
    };
  }
  if (!result.endpoint.complete) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: result.endpoint.reason ?? "endpoint_incomplete",
      outcome: "unproven",
    };
  }
  if (!result.bridge.complete) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: result.bridge.reason ?? "bridge_incomplete",
      outcome: "unproven",
    };
  }
  if (!result.sdkBootstrap.complete || !result.sdkBootstrap.singleInstance) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: result.sdkBootstrap.reason ?? "sdk_bootstrap_incomplete",
      outcome: "unproven",
    };
  }
  if (!result.safety.complete) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: result.safety.reason ?? "safety_incomplete",
      outcome: "unproven",
    };
  }
  if (
    !result.safety.hostReadOnly ||
    !result.safety.conversationNondestructive ||
    !result.safety.isolated ||
    !result.safety.devFirst
  ) {
    return {
      commit: false,
      status: "failed",
      recordReady: false,
      reason: result.safety.reason ?? "safety_violation",
      outcome: "failed",
    };
  }
  // Nondestructive claims require factual bridge surface evidence; fabricated
  // true flags without before/after observations cannot authorize proven.
  if (
    !result.bridge.surfaceEvidenceComplete ||
    result.bridge.conversationMutated !== false ||
    result.bridge.turnStarted !== false ||
    result.bridge.settingsChanged !== false ||
    result.bridge.beforeSurface === null ||
    result.bridge.afterSurface === null
  ) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: "bridge_nondestructive_evidence_incomplete",
      outcome: "unproven",
    };
  }
  // Successful benign request/response through an actually invoked exact transport.
  if (
    result.bridge.invokedTransport === null ||
    result.bridge.benignRequest === null ||
    result.bridge.benignResponse === null
  ) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: "bridge_invoked_transport_evidence_incomplete",
      outcome: "unproven",
    };
  }
  if (result.safety.authoringMain.survived === false) {
    return {
      commit: false,
      status: "failed",
      recordReady: false,
      reason: "authoring_main_impacted",
      outcome: "failed",
    };
  }

  const anchors = requiredAnchorsSatisfied(result.anchors.matrix);
  if (!anchors.ok) {
    return {
      commit: false,
      status: "unproven",
      recordReady: false,
      reason: anchors.reason ?? "anchors_incomplete",
      outcome: "unproven",
    };
  }
  if (anchors.pending || !result.anchors.complete) {
    return {
      commit: false,
      status: "pending",
      recordReady: false,
      reason: result.anchors.reason ?? "signed_in_anchor_pending",
      outcome: "pending",
    };
  }

  return {
    commit: true,
    status: "proven",
    recordReady: true,
    outcome: "proven",
    reason: null,
  };
}

/** Assemble a full probe result from completed or partial sections. */
export function assembleCompatibilityProbeResult(input: {
  identity: ProbeCorrelationIdentity;
  isolation: ProbeIsolationSection;
  endpoint: ProbeEndpointSection;
  bridge: ProbeBridgeSection;
  sdkBootstrap: ProbeSdkBootstrapSection;
  anchors: ProbeAnchorsSection;
  safety: ProbeSafetySection;
  clockIso: string;
}): CompatibilityProbeResult {
  const correlation = correlateProbeSections(input);
  const decision = decideProbeCommit({
    ...input,
    operationId: input.identity.operationId,
    schemaVersion: COMPATIBILITY_PROBE_RESULT_SCHEMA_VERSION,
    correlation,
  });

  return {
    schemaVersion: COMPATIBILITY_PROBE_RESULT_SCHEMA_VERSION,
    operationId: input.identity.operationId,
    status: decision.outcome,
    reason: decision.reason,
    identity: input.identity,
    isolation: input.isolation,
    endpoint: input.endpoint,
    bridge: input.bridge,
    sdkBootstrap: input.sdkBootstrap,
    anchors: input.anchors,
    safety: input.safety,
    correlation,
    allowsCompatibilityCommit: decision.commit,
    probedAt: decision.commit ? input.clockIso : null,
  };
}

/** Build the persisted compatibility record from a proven probe result only. */
export function buildCompatibilityRecordFromProbe(
  result: CompatibilityProbeResult,
): CompatibilityRecord {
  if (result.status !== "proven" || !result.allowsCompatibilityCommit || result.probedAt === null) {
    throw new Error("Only a complete proven probe result may build a compatibility record");
  }
  return {
    key: result.identity.compatibilityKey,
    status: "proven",
    probedAt: result.probedAt,
    target: {
      role: "development",
      pid: result.identity.pid,
      processStartedAt: result.identity.processStartedAt,
      port: 9444,
      targetId: result.identity.targetId,
    },
    capabilitySummary: {
      probeSchemaVersion: result.schemaVersion,
      isolation: {
        retainedKnobs: result.isolation.retainedKnobs,
        launchMarker: result.isolation.launchMarker,
      },
      endpoint: {
        browserIdentity: result.endpoint.browserIdentity,
        targetId: result.endpoint.selectedTargetId,
        executionContextId: result.endpoint.executionContextId,
      },
      bridge: {
        transportAvailable: result.bridge.transportAvailable,
        invokedTransport: result.bridge.invokedTransport,
        requiredMethods: [...result.bridge.requiredMethods],
        observedMethods: result.bridge.observedMethods,
        benignRequest: result.bridge.benignRequest,
      },
      sdkBootstrap: {
        version: result.sdkBootstrap.firstBootstrapVersion,
        singleInstance: result.sdkBootstrap.singleInstance,
        repeatCount: result.sdkBootstrap.repeatCount,
      },
      anchors: result.anchors.matrix.map((entry) => ({
        name: entry.name,
        verdict: entry.verdict,
      })),
      safety: {
        hostReadOnly: result.safety.hostReadOnly,
        conversationNondestructive: result.safety.conversationNondestructive,
        isolated: result.safety.isolated,
        devFirst: result.safety.devFirst,
      },
    },
  };
}
