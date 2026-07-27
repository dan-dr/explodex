import { randomUUID } from "node:crypto";
import type { EndpointInspectionResult, TargetIdentity } from "../cdp/types.ts";
import type { HostIdentity } from "../host/types.ts";
import type { ListenerObservation, ProcessObservation } from "../host/status.ts";
import {
  createDefaultRuntimeAdapters,
  type ProcessIdentity,
  type RuntimeAdapters,
} from "../runtime/adapters.ts";
import {
  acquireOperationLock,
  type LockAcquireResult,
  type LockHandle,
  type ResidualLockAuthority,
} from "../runtime/locks.ts";
import type { OperationIdentity } from "../runtime/types.ts";
import { DEV_CDP_HOST, DEV_CDP_PORT, DEFAULT_DEV_INSTANCE_ID } from "./constants.ts";
import { describeDevLayout } from "./layout.ts";
import { frozenHostEquals } from "./phase0.ts";
import type {
  DevInstanceState,
  DevInstanceStatus,
  DevRecoveryDiagnostic,
  Phase0FrozenHost,
} from "./types.ts";

export type DevOwnershipOperation =
  | "status"
  | "recover"
  | "start"
  | "ensure"
  | "inject"
  | "restart"
  | "stop"
  | "renderer-boundary"
  | "app-boundary"
  | "focus"
  | "develop";

export type DevPathEvidence = {
  ok: boolean;
  canonicalRoot: string | null;
  failures: string[];
};

export type DevCompatibilityEvidence = {
  status: "unproven" | "proven" | "pending";
  matched: boolean;
  reason: string | null;
};

export type DevOwnershipEvidence = {
  requestedRoot: string;
  stateLoadStatus: "absent" | "valid" | "malformed";
  state: DevInstanceState | null;
  currentHost: HostIdentity | null;
  phase0: {
    status: "proven" | "incomplete" | "disabled" | "missing";
    frozenHost: Phase0FrozenHost | null;
    markerValue: string | null;
  };
  process: ProcessObservation | null;
  currentPidIdentity: ProcessIdentity | null;
  paths: DevPathEvidence;
  listeners: ListenerObservation[];
  operationOwnedCompanionPids?: number[];
  endpoint: EndpointInspectionResult | null;
  compatibility: DevCompatibilityEvidence;
  protectedMainOverlap: boolean;
};

export type DevOwnershipFailureCode =
  | "state_missing_foreign_process"
  | "state_malformed"
  | "state_schema_mismatch"
  | "state_role_mismatch"
  | "state_instance_mismatch"
  | "state_root_mismatch"
  | "state_status_incompatible"
  | "pid_dead"
  | "pid_start_mismatch"
  | "process_missing"
  | "executable_mismatch"
  | "host_missing"
  | "host_identity_mismatch"
  | "host_build_mismatch"
  | "phase0_unproven"
  | "phase0_host_mismatch"
  | "marker_mismatch"
  | "path_alias"
  | "port_owner_missing"
  | "foreign_9444_owner"
  | "endpoint_missing"
  | "endpoint_identity_mismatch"
  | "target_missing"
  | "target_ambiguous"
  | "target_drift"
  | "context_drift"
  | "main_overlap"
  | "compatibility_unproven";

export type DevOwnershipFailure = {
  code: DevOwnershipFailureCode;
  message: string;
};

export type DevRecoveryEligibility =
  | "none"
  | "independently-dead"
  | "start-mismatched"
  | "fully-owned-live";

export type DevOwnershipAssessment = {
  operation: DevOwnershipOperation;
  recordedStatus: DevInstanceStatus | "absent" | "malformed";
  observedStatus: DevInstanceStatus;
  owned: boolean;
  compatibilityProven: boolean;
  mutationAllowed: boolean;
  selectedTarget: TargetIdentity | null;
  failures: DevOwnershipFailure[];
  recoveryEligibility: DevRecoveryEligibility;
};

function add(
  failures: DevOwnershipFailure[],
  code: DevOwnershipFailureCode,
  message: string,
): void {
  if (!failures.some((failure) => failure.code === code)) {
    failures.push({ code, message });
  }
}

function requiresReadyOwnership(operation: DevOwnershipOperation): boolean {
  return operation === "inject" ||
    operation === "restart" ||
    operation === "stop" ||
    operation === "renderer-boundary" ||
    operation === "app-boundary" ||
    operation === "focus" ||
    operation === "develop";
}

function requiresCompatibility(operation: DevOwnershipOperation): boolean {
  return operation === "inject" ||
    operation === "renderer-boundary" ||
    operation === "app-boundary" ||
    operation === "develop";
}

function statusCompatible(
  operation: DevOwnershipOperation,
  state: DevInstanceState,
): boolean {
  if (operation === "status") return true;
  if (operation === "recover") {
    return state.status === "stale" ||
      state.status === "failed" ||
      state.status === "starting" ||
      state.status === "stopping";
  }
  if (operation === "start") return state.status === "stopped";
  if (operation === "ensure") return state.status === "stopped" || state.status === "ready";
  return state.status === "ready";
}

function exactHostMatches(
  stateHost: Phase0FrozenHost | null,
  currentHost: HostIdentity,
): boolean {
  return stateHost !== null && frozenHostEquals(stateHost, currentHost);
}

function exactTargetMatches(
  state: DevInstanceState,
  target: TargetIdentity,
): boolean {
  return target.role === "development" &&
    target.pid === state.pid &&
    target.processStartedAt === state.processStartedAt &&
    target.executablePath === state.executablePath &&
    target.appVersion === state.appVersion &&
    target.appBuild === state.appBuild &&
    target.port === DEV_CDP_PORT &&
    target.targetId === state.targetId &&
    target.browserIdentity === state.browserIdentity &&
    target.executionContextId === state.executionContextId &&
    target.executionContextUniqueId === state.executionContextUniqueId &&
    target.frameId === state.frameId;
}

function liveIdentityFailureCodes(
  failures: readonly DevOwnershipFailure[],
): Set<DevOwnershipFailureCode> {
  return new Set(failures.map((failure) => failure.code));
}

/**
 * Complete, pure ownership predicate. It never launches, signals, writes state,
 * evaluates renderer code, or selects a fallback endpoint.
 */
export function evaluateDevOwnership(options: {
  operation: DevOwnershipOperation;
  evidence: DevOwnershipEvidence;
}): DevOwnershipAssessment {
  const { operation, evidence } = options;
  const failures: DevOwnershipFailure[] = [];
  const recordedStatus = evidence.stateLoadStatus === "malformed"
    ? "malformed"
    : evidence.state?.status ?? "absent";
  const state = evidence.state;
  const hasUnrecordedLiveEvidence =
    evidence.process !== null || evidence.listeners.length > 0;

  if (evidence.stateLoadStatus === "malformed") {
    add(failures, "state_malformed", "Development state is malformed or unsupported.");
  }
  if (!evidence.paths.ok) {
    add(
      failures,
      "path_alias",
      `Development root is aliased, escaped, non-private, protected, or unowned: ${evidence.paths.failures.join(", ")}`,
    );
  }
  if (state === null) {
    if (hasUnrecordedLiveEvidence) {
      add(
        failures,
        "state_missing_foreign_process",
        "A ChatGPT-looking process or 9444 listener without exact state is foreign and cannot be adopted.",
      );
    }
    const observedStatus: DevInstanceStatus =
      hasUnrecordedLiveEvidence ||
        evidence.stateLoadStatus === "malformed" ||
        !evidence.paths.ok
      ? "stale"
      : "stopped";
    return {
      operation,
      recordedStatus,
      observedStatus,
      owned: false,
      compatibilityProven: false,
      mutationAllowed: operation === "start" || operation === "ensure"
        ? !hasUnrecordedLiveEvidence &&
          evidence.stateLoadStatus === "absent" &&
          evidence.paths.ok
        : false,
      selectedTarget: null,
      failures,
      recoveryEligibility: "none",
    };
  }

  if (state.schemaVersion !== 1) {
    add(failures, "state_schema_mismatch", "Development state schema is unsupported.");
  }
  if (state.role !== "development") {
    add(failures, "state_role_mismatch", "Development state role does not match.");
  }
  if (state.instanceId !== DEFAULT_DEV_INSTANCE_ID) {
    add(failures, "state_instance_mismatch", "Development instance ID does not match.");
  }
  if (
    state.rootPath !== evidence.requestedRoot ||
    describeDevLayout(evidence.requestedRoot).rootPath !== state.rootPath
  ) {
    add(failures, "state_root_mismatch", "Recorded root does not match the requested canonical root.");
  }
  if (!statusCompatible(operation, state)) {
    add(
      failures,
      "state_status_incompatible",
      `Recorded status '${state.status}' is not eligible for '${operation}'.`,
    );
  }

  if (evidence.currentHost === null) {
    add(failures, "host_missing", "Current canonical ChatGPT host identity is unavailable.");
  } else {
    if (
      state.appPath !== evidence.currentHost.bundlePath ||
      state.executablePath !== evidence.currentHost.executablePath ||
      !exactHostMatches(state.frozenHost, evidence.currentHost)
    ) {
      add(
        failures,
        "host_identity_mismatch",
        "Recorded canonical bundle, executable, signature, paths, or hashes do not match the operation freeze.",
      );
    }
    if (
      state.appVersion !== evidence.currentHost.appVersion ||
      state.appBuild !== evidence.currentHost.appBuild
    ) {
      add(
        failures,
        "host_build_mismatch",
        "Recorded app version/build does not match the operation-frozen canonical host.",
      );
    }
  }

  if (
    evidence.phase0.status !== "proven" ||
    evidence.phase0.markerValue === null
  ) {
    add(failures, "phase0_unproven", "Phase 0 launch marker/isolation proof is not proven.");
  } else if (
    evidence.currentHost === null ||
    evidence.phase0.frozenHost === null ||
    !frozenHostEquals(evidence.phase0.frozenHost, evidence.currentHost)
  ) {
    add(
      failures,
      "phase0_host_mismatch",
      "Phase 0 proof does not match the exact current operation-frozen host.",
    );
  }

  if (!evidence.paths.ok || evidence.paths.canonicalRoot !== state.rootPath) {
    add(
      failures,
      "path_alias",
      `Development paths are aliased, escaped, non-private, or protected: ${evidence.paths.failures.join(", ")}`,
    );
  }

  const process = evidence.process;
  const currentIdentity = evidence.currentPidIdentity;
  if (state.pid !== null) {
    if (currentIdentity === null) {
      add(failures, "pid_dead", "Recorded PID is independently absent.");
    } else if (
      currentIdentity.pid !== state.pid ||
      currentIdentity.processStartedAt !== state.processStartedAt
    ) {
      add(
        failures,
        "pid_start_mismatch",
        "Recorded PID now has a different kernel process-start identity.",
      );
    }
    if (process === null || process.pid !== state.pid) {
      add(failures, "process_missing", "Recorded process is absent from canonical process inventory.");
    } else {
      if (process.executablePath !== state.executablePath) {
        add(failures, "executable_mismatch", "Running executable does not match canonical state.");
      }
      if (
        state.launchMarker.length === 0 ||
        evidence.phase0.markerValue !== state.launchMarker ||
        !process.arguments.some((argument) => argument === state.launchMarker)
      ) {
        add(failures, "marker_mismatch", "Exact proven launch marker is absent or mismatched.");
      }
    }
  } else if (requiresReadyOwnership(operation) || operation === "recover") {
    add(failures, "process_missing", "Operation requires a recorded live PID identity.");
  }

  if (evidence.protectedMainOverlap) {
    add(failures, "main_overlap", "Development identity overlaps a protected authoring main.");
  }

  const matchingListeners = evidence.listeners.filter((listener) =>
    listener.host === DEV_CDP_HOST &&
    listener.port === DEV_CDP_PORT &&
    listener.pid === state.pid &&
    listener.processStartedAt === state.processStartedAt
  );
  const companionPids = new Set(evidence.operationOwnedCompanionPids ?? []);
  const foreignListeners = evidence.listeners.filter((listener) =>
    listener.pid !== state.pid && !companionPids.has(listener.pid)
  );
  if (state.pid !== null) {
    if (evidence.listeners.length === 0) {
      add(failures, "port_owner_missing", "Declared development port has no listener.");
    } else if (
      matchingListeners.length !== 1 ||
      foreignListeners.length > 0
    ) {
      add(
        failures,
        "foreign_9444_owner",
        "Declared development port has a foreign, co-owned, or start-mismatched listener.",
      );
    }
  } else if (evidence.listeners.length > 0) {
    add(
      failures,
      "foreign_9444_owner",
      "Unrecorded listener on 9444 is foreign and cannot be adopted.",
    );
  }

  let selectedTarget: TargetIdentity | null = null;
  if (state.pid !== null && matchingListeners.length === 1) {
    if (evidence.endpoint === null) {
      add(failures, "endpoint_missing", "Exact endpoint was not safely inspected.");
    } else if (evidence.endpoint.kind === "identity-mismatch") {
      add(failures, "endpoint_identity_mismatch", "Endpoint browser/PID identity mismatched.");
    } else if (evidence.endpoint.kind === "rejected") {
      add(
        failures,
        evidence.endpoint.code === "target_ambiguous" ||
          evidence.endpoint.code === "context_ambiguous"
          ? "target_ambiguous"
          : "target_missing",
        `Endpoint rejected exact target selection: ${evidence.endpoint.code}.`,
      );
    } else {
      selectedTarget = evidence.endpoint.target;
      if (selectedTarget.targetId !== state.targetId) {
        add(failures, "target_drift", "Target ID drifted from recorded state.");
      } else if (!exactTargetMatches(state, selectedTarget)) {
        add(failures, "context_drift", "Browser or execution-context identity drifted.");
      }
    }
  }

  const compatibilityProven =
    evidence.compatibility.status === "proven" &&
    evidence.compatibility.matched;
  if (requiresCompatibility(operation) && !compatibilityProven) {
    add(
      failures,
      "compatibility_unproven",
      `Current exact compatibility is unavailable: ${evidence.compatibility.reason ?? "unproven"}.`,
    );
  }

  const failureCodes = liveIdentityFailureCodes(failures);
  const statusOnlyFailures = new Set<DevOwnershipFailureCode>([
    "state_status_incompatible",
    "compatibility_unproven",
  ]);
  const liveOwnershipFailures = [...failureCodes].filter(
    (code) => !statusOnlyFailures.has(code),
  );
  const owned = state.pid !== null && liveOwnershipFailures.length === 0;

  let recoveryEligibility: DevRecoveryEligibility = "none";
  const recoveryStatus =
    state.status === "stale" ||
    state.status === "failed" ||
    state.status === "starting" ||
    state.status === "stopping";
  if (recoveryStatus) {
    const alwaysUncertainForRecovery = new Set<DevOwnershipFailureCode>([
      "state_malformed",
      "state_schema_mismatch",
      "state_role_mismatch",
      "state_instance_mismatch",
      "state_root_mismatch",
      "path_alias",
      "foreign_9444_owner",
      "endpoint_identity_mismatch",
      "target_ambiguous",
      "target_drift",
      "context_drift",
      "main_overlap",
    ]);
    const hasUncertainRecoveryFailure = failures.some((failure) =>
      alwaysUncertainForRecovery.has(failure.code)
    );
    if (
      state.pid === null &&
      evidence.listeners.length === 0 &&
      !hasUncertainRecoveryFailure
    ) {
      recoveryEligibility = "independently-dead";
    } else if (
      failureCodes.has("pid_dead") &&
      evidence.listeners.length === 0 &&
      !hasUncertainRecoveryFailure
    ) {
      recoveryEligibility = "independently-dead";
    } else if (
      failureCodes.has("pid_start_mismatch") &&
      evidence.listeners.length === 0 &&
      !hasUncertainRecoveryFailure
    ) {
      recoveryEligibility = "start-mismatched";
    } else if (owned) {
      recoveryEligibility = "fully-owned-live";
    }
  }

  let observedStatus = state.status;
  if (
    state.status !== "failed" &&
    state.status !== "stopped" &&
    liveOwnershipFailures.length > 0
  ) {
    observedStatus = "stale";
  }

  const mutationAllowed = operation === "status"
    ? false
    : operation === "recover"
      ? recoveryEligibility !== "none"
      : operation === "start"
        ? state.status === "stopped" && failures.length === 0
        : operation === "ensure" && state.status === "stopped"
          ? failures.length === 0
          : owned && failures.length === 0;

  return {
    operation,
    recordedStatus,
    observedStatus,
    owned,
    compatibilityProven,
    mutationAllowed,
    selectedTarget: owned ? selectedTarget : null,
    failures,
    recoveryEligibility,
  };
}

export type DevMutationEffects = {
  launch(): void;
  signal(): void;
  promote(): void;
  evaluate(): void;
  fallback(): void;
};

/**
 * Enforce the zero-mutation failure matrix at call sites. Effects are exposed only
 * inside the authorized callback, never invoked on a failed predicate.
 */
export function guardDevMutation<T>(options: {
  assessment: DevOwnershipAssessment;
  effects: DevMutationEffects;
  run: (effects: DevMutationEffects) => T;
}): { ok: true; value: T } | { ok: false; assessment: DevOwnershipAssessment } {
  if (!options.assessment.mutationAllowed) {
    return { ok: false, assessment: options.assessment };
  }
  return { ok: true, value: options.run(options.effects) };
}

export type DevStatusSnapshot = {
  rootPath: string;
  stateLoadStatus: "absent" | "valid" | "malformed";
  state: DevInstanceState | null;
  assessment: DevOwnershipAssessment;
  readOnly: true;
  activity: {
    launched: false;
    signaled: false;
    evaluated: false;
    wroteState: false;
    fellBack: false;
  };
};

export const DEFAULT_DEV_INSTANCE_LOCK_WAIT_MS = 2_000;

export type DevInstanceLockFailure<T = never> = {
  ok: false;
  code: "dev.instance-busy" | "operation.interrupted" | "dev.lock-failed";
  message: string;
  details: {
    lockCode: string;
    stage: "lock-acquisition" | "cleanup";
    boundMs?: number;
    holderOperationId?: string;
  };
  residual?: ResidualLockAuthority;
  completedValue?: T;
};

export type DevInstanceLockResult<T> =
  | {
      ok: true;
      value: T;
      operationId: string;
      recoveredStale: boolean;
    }
  | DevInstanceLockFailure<T>;

function residualFromHandle(handle: LockHandle): ResidualLockAuthority {
  return {
    path: handle.path,
    leasePath: handle.leasePath,
    descriptor: handle.descriptor,
    handle,
    state: () => handle.state(),
    dispose: (options) => handle.release(options),
  };
}

async function mapLockFailure(
  result: Extract<LockAcquireResult, { ok: false }>,
): Promise<DevInstanceLockFailure> {
  if (result.code === "lock_cleanup_failed") {
    try {
      await result.residual.dispose({ timeoutMs: 5_000 });
    } catch {
      return {
        ok: false,
        code: "dev.lock-failed",
        message: result.message,
        details: {
          lockCode: result.code,
          stage: result.stage,
          boundMs: result.boundMs,
          ...(result.holder === null
            ? {}
            : { holderOperationId: result.holder.operationId }),
        },
        residual: result.residual,
      };
    }
  }
  const effectiveCode = result.code === "lock_cleanup_failed"
    ? result.primaryCode
    : result.code;
  return {
    ok: false,
    code: effectiveCode === "lock_busy"
      ? "dev.instance-busy"
      : effectiveCode === "lock_interrupted"
        ? "operation.interrupted"
        : "dev.lock-failed",
    message: result.message,
    details: {
      lockCode: effectiveCode,
      stage: result.stage,
      boundMs: result.boundMs,
      ...(result.holder === null
        ? {}
        : { holderOperationId: result.holder.operationId }),
    },
  };
}

export async function withDevInstanceLock<T>(options: {
  rootPath: string;
  operation: string;
  work: () => Promise<T> | T;
  waitBoundMs?: number;
  signal?: AbortSignal;
  runtimeAdapters?: RuntimeAdapters;
  operationId?: string;
}): Promise<DevInstanceLockResult<T>> {
  const adapters = options.runtimeAdapters ?? await createDefaultRuntimeAdapters();
  const self = adapters.process.self();
  const operationId = options.operationId ?? `dev-instance-${randomUUID()}`;
  const identity: OperationIdentity = {
    operationId,
    operation: options.operation,
    startedAt: adapters.clock.nowIso(),
    ownerPid: self.pid,
    ownerProcessStartedAt: self.processStartedAt,
  };
  try {
    const acquired = await acquireOperationLock({
      adapters,
      // Root-scoped lock authority is physically under <root>/locks.
      explodexHome: options.rootPath,
      resource: "dev-instance",
      identity,
      waitBoundMs: options.waitBoundMs ?? DEFAULT_DEV_INSTANCE_LOCK_WAIT_MS,
      pollIntervalMs: 25,
      abortSignal: options.signal,
    });
    if (!acquired.ok) return await mapLockFailure(acquired);
    let value: T;
    let workError: unknown = null;
    try {
      value = await options.work();
    } catch (error: unknown) {
      workError = error;
      value = undefined as T;
    }
    try {
      await acquired.handle.release({ timeoutMs: 5_000 });
    } catch (releaseError: unknown) {
      return {
        ok: false,
        code: "dev.lock-failed",
        message: releaseError instanceof Error
          ? releaseError.message
          : "Development instance lock release failed.",
        details: {
          lockCode: "lock_release_failed",
          stage: "cleanup",
        },
        residual: residualFromHandle(acquired.handle),
        ...(workError === null ? { completedValue: value } : {}),
      };
    }
    if (workError !== null) throw workError;
    return {
      ok: true,
      value,
      operationId,
      recoveredStale: acquired.recoveredStale,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      code: "dev.lock-failed",
      message: error instanceof Error
        ? error.message
        : "Development instance lock work failed.",
      details: {
        lockCode: "lock_work_failed",
        stage: "cleanup",
      },
    };
  }
}

export type DevTerminationResult =
  | {
      ok: true;
      confirmedExit: true;
      method:
        | "browser-close-only"
        | "exact-signal-only"
        | "browser-close-then-signal";
      elapsedMs?: number;
      boundMs?: number;
    }
  | {
      ok: false;
      confirmedExit: false;
      code: string;
      message: string;
      method:
        | "browser-close-only"
        | "exact-signal-only"
        | "browser-close-then-signal"
        | null;
      elapsedMs?: number;
      boundMs?: number;
    };

export type DevRecoverSuccess = {
  ok: true;
  operationId: string;
  previous: DevStatusSnapshot;
  state: DevInstanceState;
  disposition: DevRecoveryDiagnostic["disposition"];
  terminationMethod: DevRecoveryDiagnostic["terminationMethod"];
};

export type DevRecoverFailure = {
  ok: false;
  code:
    | "dev.recovery-required"
    | "dev.ownership-uncertain"
    | "dev.instance-busy"
    | "operation.interrupted"
    | "operation.timeout"
    | "dev.recovery-failed"
    | "dev.lock-failed";
  message: string;
  snapshot?: DevStatusSnapshot;
  details?: unknown;
};

function stoppedAfterRecovery(options: {
  state: DevInstanceState;
  recoveredAt: string;
  disposition: DevRecoveryDiagnostic["disposition"];
  terminationMethod: DevRecoveryDiagnostic["terminationMethod"];
}): DevInstanceState {
  const diagnostic: DevRecoveryDiagnostic = {
    recoveredAt: options.recoveredAt,
    priorStatus: options.state.status === "stopped"
      ? "stale"
      : options.state.status,
    priorPid: options.state.pid,
    priorProcessStartedAt: options.state.processStartedAt,
    priorTargetId: options.state.targetId,
    priorError: options.state.lastError ?? null,
    disposition: options.disposition,
    terminationMethod: options.terminationMethod,
  };
  const retained = [...options.state.recoveryDiagnostics, diagnostic].slice(-8);
  const next: DevInstanceState = {
    ...options.state,
    status: "stopped",
    pid: null,
    processStartedAt: null,
    targetId: null,
    browserIdentity: null,
    executionContextId: null,
    executionContextUniqueId: null,
    frameId: null,
    lastError: undefined,
    recoveryDiagnostics: retained,
    startedAt: null,
    updatedAt: options.recoveredAt,
  };
  delete next.lastError;
  return next;
}

/**
 * Public explicit recovery core. It performs no launch, injection, adoption,
 * evaluation, fallback, or supervision.
 */
export async function recoverDevInstance(options: {
  rootPath: string;
  readStatus: () => Promise<DevStatusSnapshot>;
  saveState: (state: DevInstanceState) => Promise<void>;
  terminate: (snapshot: DevStatusSnapshot) => Promise<DevTerminationResult>;
  waitBoundMs?: number;
  signal?: AbortSignal;
  runtimeAdapters?: RuntimeAdapters;
  operationId?: string;
}): Promise<DevRecoverSuccess | DevRecoverFailure> {
  const runtime = options.runtimeAdapters ?? await createDefaultRuntimeAdapters();
  const locked = await withDevInstanceLock({
    rootPath: options.rootPath,
    operation: "dev.recover",
    waitBoundMs: options.waitBoundMs,
    signal: options.signal,
    runtimeAdapters: runtime,
    operationId: options.operationId,
    work: async () => {
      const snapshot = await options.readStatus();
      const state = snapshot.state;
      if (state === null || snapshot.stateLoadStatus !== "valid") {
        return {
          ok: false as const,
          code: "dev.recovery-required" as const,
          message: "Recovery requires one valid recorded development state.",
          snapshot,
        };
      }
      if (
        state.status !== "stale" &&
        state.status !== "failed" &&
        state.status !== "starting" &&
        state.status !== "stopping"
      ) {
        return {
          ok: false as const,
          code: "dev.recovery-required" as const,
          message: `Recorded status '${state.status}' is not eligible for recovery.`,
          snapshot,
        };
      }

      const eligibility = snapshot.assessment.recoveryEligibility;
      let disposition: DevRecoveryDiagnostic["disposition"];
      let terminationMethod: DevRecoveryDiagnostic["terminationMethod"] = null;
      if (
        eligibility === "independently-dead" ||
        eligibility === "start-mismatched"
      ) {
        disposition = eligibility;
      } else if (eligibility === "fully-owned-live") {
        const terminated = await options.terminate(snapshot);
        if (!terminated.ok || !terminated.confirmedExit) {
          return {
            ok: false as const,
            code: terminated.code === "operation.timeout"
              ? "operation.timeout" as const
              : "dev.recovery-failed" as const,
            message: terminated.message,
            snapshot,
            details: {
              terminationMethod: terminated.method,
              confirmedExit: false,
            },
          };
        }
        disposition = "owned-process-terminated";
        terminationMethod = terminated.method;
      } else {
        return {
          ok: false as const,
          code: "dev.ownership-uncertain" as const,
          message:
            "Recovery refused because the record is neither independently dead/start-mismatched nor a fully owned live partial process.",
          snapshot,
          details: {
            failures: snapshot.assessment.failures,
          },
        };
      }

      const next = stoppedAfterRecovery({
        state,
        recoveredAt: runtime.clock.nowIso(),
        disposition,
        terminationMethod,
      });
      try {
        await options.saveState(next);
      } catch (error: unknown) {
        return {
          ok: false as const,
          code: "dev.recovery-failed" as const,
          message: error instanceof Error
            ? error.message
            : "Development recovery state commit failed.",
          snapshot,
          details: {
            processDisposition:
              disposition === "owned-process-terminated" ? "stopped" : "not-live",
            priorStatePreserved: true,
          },
        };
      }
      return {
        ok: true as const,
        previous: snapshot,
        state: next,
        disposition,
        terminationMethod,
      };
    },
  });

  if (!locked.ok) {
    return {
      ok: false,
      code: locked.code,
      message: locked.message,
      details: locked.details,
    };
  }
  if (!locked.value.ok) return locked.value;
  return {
    ok: true,
    operationId: locked.operationId,
    previous: locked.value.previous,
    state: locked.value.state,
    disposition: locked.value.disposition,
    terminationMethod: locked.value.terminationMethod,
  };
}
