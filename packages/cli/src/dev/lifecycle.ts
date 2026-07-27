import type { RuntimeAdapters } from "../runtime/adapters.ts";
import { frozenHostEquals } from "./phase0.ts";
import type {
  DevInstanceError,
  DevInstanceState,
  DevRecoveryDiagnostic,
} from "./types.ts";
import {
  withDevInstanceLock,
  type DevStatusSnapshot,
  type DevTerminationResult,
} from "./workflow.ts";
import type {
  DevLifecycleFailure,
  DevLifecycleLaunchAdapter,
  DevLifecycleResult,
  DevVerifiedLaunch,
} from "./lifecycle-types.ts";
export type {
  DevLifecycleFailure,
  DevLifecycleLaunchAdapter,
  DevLifecycleResult,
  DevLifecycleSuccess,
  DevVerifiedLaunch,
} from "./lifecycle-types.ts";

type CommonLifecycleOptions = {
  rootPath: string;
  readStatus(): Promise<DevStatusSnapshot>;
  saveState(state: DevInstanceState): Promise<void>;
  runtimeAdapters?: RuntimeAdapters;
  waitBoundMs?: number;
  signal?: AbortSignal;
  operationId?: string;
  /** Internal composition hook for a caller already holding this root's dev-instance lease. */
  lockAlreadyHeld?: boolean;
};

type LaunchLifecycleOptions = CommonLifecycleOptions & {
  launch: DevLifecycleLaunchAdapter;
  terminate(state: DevInstanceState): Promise<DevTerminationResult>;
  createState?: () => DevInstanceState;
};

function lifecycleError(
  code: DevLifecycleFailure["code"],
  message: string,
  state: DevInstanceState | null,
  options?: {
    recoveryRequired?: boolean;
    partialDisposition?: DevLifecycleFailure["partialDisposition"];
    details?: unknown;
  },
): DevLifecycleFailure {
  return {
    ok: false,
    code,
    message,
    state,
    recoveryRequired: options?.recoveryRequired ?? false,
    partialDisposition: options?.partialDisposition ?? "none",
    ...(options?.details === undefined ? {} : { details: options.details }),
  };
}

function errorRecord(options: {
  code: string;
  message: string;
  phase: string;
}): DevInstanceError {
  return {
    code: options.code,
    message: options.message,
    phase: options.phase,
  };
}

function withoutLastError(state: DevInstanceState): DevInstanceState {
  const next = { ...state };
  delete next.lastError;
  return next;
}

function startingState(
  state: DevInstanceState,
  updatedAt: string,
): DevInstanceState {
  return withoutLastError({
    ...state,
    status: "starting",
    pid: null,
    processStartedAt: null,
    targetId: null,
    browserIdentity: null,
    executionContextId: null,
    executionContextUniqueId: null,
    frameId: null,
    startedAt: null,
    updatedAt,
  });
}

function spawnedStartingState(options: {
  state: DevInstanceState;
  pid: number;
  processStartedAt: string;
  updatedAt: string;
}): DevInstanceState {
  return {
    ...options.state,
    status: "starting",
    pid: options.pid,
    processStartedAt: options.processStartedAt,
    startedAt: options.updatedAt,
    updatedAt: options.updatedAt,
  };
}

function readyFromVerified(options: {
  state: DevInstanceState;
  verified: DevVerifiedLaunch;
  updatedAt: string;
}): DevInstanceState {
  const { state, verified } = options;
  if (
    verified.pid !== state.pid ||
    verified.processStartedAt !== state.processStartedAt ||
    verified.appVersion !== verified.frozenHost.appVersion ||
    verified.appBuild !== verified.frozenHost.appBuild ||
    state.frozenHost === null ||
    !frozenHostEquals(state.frozenHost, verified.frozenHost)
  ) {
    throw new Error(
      "Verified launch identity disagreed with the operation-frozen starting state.",
    );
  }
  return withoutLastError({
    ...state,
    status: "ready",
    targetId: verified.targetId,
    browserIdentity: verified.browserIdentity,
    executionContextId: verified.executionContextId,
    executionContextUniqueId: verified.executionContextUniqueId,
    frameId: verified.frameId,
    appVersion: verified.appVersion,
    appBuild: verified.appBuild,
    frozenHost: verified.frozenHost,
    updatedAt: options.updatedAt,
  });
}

function failedPartialState(options: {
  state: DevInstanceState;
  error: DevInstanceError;
  updatedAt: string;
}): DevInstanceState {
  return {
    ...options.state,
    status: "failed",
    lastError: options.error,
    updatedAt: options.updatedAt,
  };
}

function stoppedAfterTermination(options: {
  state: DevInstanceState;
  stoppedAt: string;
  method: Exclude<DevRecoveryDiagnostic["terminationMethod"], null>;
}): DevInstanceState {
  const diagnostic: DevRecoveryDiagnostic = {
    recoveredAt: options.stoppedAt,
    priorStatus: options.state.status === "stopped"
      ? "stale"
      : options.state.status,
    priorPid: options.state.pid,
    priorProcessStartedAt: options.state.processStartedAt,
    priorTargetId: options.state.targetId,
    priorError: options.state.lastError ?? null,
    disposition: "owned-process-terminated",
    terminationMethod: options.method,
  };
  const next = {
    ...options.state,
    status: "stopped" as const,
    pid: null,
    processStartedAt: null,
    targetId: null,
    browserIdentity: null,
    executionContextId: null,
    executionContextUniqueId: null,
    frameId: null,
    recoveryDiagnostics: [
      ...options.state.recoveryDiagnostics,
      diagnostic,
    ].slice(-8),
    startedAt: null,
    updatedAt: options.stoppedAt,
  };
  return withoutLastError(next);
}

async function persistFailureBestEffort(options: {
  saveState(state: DevInstanceState): Promise<void>;
  state: DevInstanceState;
}): Promise<boolean> {
  try {
    await options.saveState(options.state);
    return true;
  } catch {
    return false;
  }
}

async function withLifecycleClaim<T>(options: {
  rootPath: string;
  operation: string;
  work(): Promise<T>;
  runtime: RuntimeAdapters;
  waitBoundMs?: number;
  signal?: AbortSignal;
  operationId?: string;
  lockAlreadyHeld?: boolean;
}): Promise<
  | { ok: true; value: T; operationId: string }
  | {
      ok: false;
      code: "dev.instance-busy" | "dev.lock-failed" | "operation.interrupted";
      message: string;
      details: unknown;
    }
> {
  if (options.lockAlreadyHeld === true) {
    return {
      ok: true,
      value: await options.work(),
      operationId: options.operationId ?? options.operation,
    };
  }
  const locked = await withDevInstanceLock({
    rootPath: options.rootPath,
    operation: options.operation,
    work: options.work,
    waitBoundMs: options.waitBoundMs,
    signal: options.signal,
    runtimeAdapters: options.runtime,
    operationId: options.operationId,
  });
  if (!locked.ok) {
    return {
      ok: false,
      code: locked.code,
      message: locked.message,
      details: locked.details,
    };
  }
  return {
    ok: true,
    value: locked.value,
    operationId: locked.operationId,
  };
}

async function launchFromStopped(options: {
  state: DevInstanceState;
  saveState(state: DevInstanceState): Promise<void>;
  launch: DevLifecycleLaunchAdapter;
  terminate(state: DevInstanceState): Promise<DevTerminationResult>;
  runtime: RuntimeAdapters;
}): Promise<
  | { ok: true; state: DevInstanceState }
  | DevLifecycleFailure
> {
  let current = startingState(options.state, options.runtime.clock.nowIso());
  try {
    await options.saveState(current);
  } catch (error: unknown) {
    return lifecycleError(
      "dev.state-write-failed",
      error instanceof Error ? error.message : "Failed to commit starting state.",
      options.state,
    );
  }

  let spawned = false;
  let verified = false;
  try {
    const launch = await options.launch({
      onSpawn: async (identity) => {
        spawned = true;
        current = spawnedStartingState({
          state: current,
          pid: identity.pid,
          processStartedAt: identity.processStartedAt,
          updatedAt: options.runtime.clock.nowIso(),
        });
        await options.saveState(current);
      },
    });
    verified = true;
    const ready = readyFromVerified({
      state: current,
      verified: launch,
      updatedAt: options.runtime.clock.nowIso(),
    });
    try {
      await options.saveState(ready);
      return { ok: true, state: ready };
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : "Failed to commit verified ready state.";
      const failed = failedPartialState({
        state: ready,
        error: errorRecord({
          code: "dev_ready_commit_failed",
          message,
          phase: "state-write",
        }),
        updatedAt: options.runtime.clock.nowIso(),
      });
      const failedStatePersisted = await persistFailureBestEffort({
        saveState: options.saveState,
        state: failed,
      });
      const termination = failedStatePersisted
        ? await options.terminate(failed)
        : null;
      return lifecycleError(
        "dev.launch-partial",
        message,
        failed,
        {
          recoveryRequired: true,
          partialDisposition: termination === null
            ? "left-running-unverified"
            : termination.ok
              ? "gracefully-closed"
              : "left-running-close-failed",
          details: {
            verified: true,
            failedStatePersisted,
            termination,
          },
        },
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "Development launch failed.";
    const failed = failedPartialState({
      state: current,
      error: errorRecord({
        code: spawned ? "dev_launch_partial" : "dev_launch_failed",
        message,
        phase: verified ? "verification" : spawned ? "readiness" : "spawn",
      }),
      updatedAt: options.runtime.clock.nowIso(),
    });
    const persisted = await persistFailureBestEffort({
      saveState: options.saveState,
      state: failed,
    });
    return lifecycleError(
      spawned ? "dev.launch-partial" : "dev.launch-failed",
      message,
      persisted ? failed : current,
      {
        recoveryRequired: true,
        partialDisposition: spawned
          ? "left-running-unverified"
          : "none",
        details: {
          spawned,
          verified,
          failedStatePersisted: persisted,
        },
      },
    );
  }
}

async function runStartOrEnsure(options: LaunchLifecycleOptions & {
  operation: "dev.start" | "dev.ensure";
  ensure: boolean;
}): Promise<DevLifecycleResult> {
  const runtime = options.runtimeAdapters;
  if (runtime === undefined) {
    return lifecycleError(
      "dev.lock-failed",
      "Development lifecycle requires explicit runtime adapters.",
      null,
    );
  }
  const locked = await withLifecycleClaim({
    rootPath: options.rootPath,
    operation: options.operation,
    work: async () => {
      const snapshot = await options.readStatus();
      if (
        options.ensure &&
        snapshot.state?.status === "ready" &&
        snapshot.assessment.owned &&
        snapshot.assessment.mutationAllowed &&
        snapshot.assessment.compatibilityProven
      ) {
        return {
          ok: true as const,
          state: snapshot.state,
          reusedReady: true,
          terminationMethod: null,
        };
      }
      if (
        !snapshot.assessment.mutationAllowed ||
        !snapshot.assessment.compatibilityProven
      ) {
        return lifecycleError(
          options.ensure ? "dev.ensure-refused" : "dev.start-refused",
          `Development ${options.ensure ? "ensure" : "start"} refused because the recorded state or observed ownership is ineligible.`,
          snapshot.state,
          {
            recoveryRequired:
              snapshot.assessment.recordedStatus === "stale" ||
              snapshot.assessment.recordedStatus === "failed" ||
              snapshot.assessment.recordedStatus === "starting" ||
              snapshot.assessment.recordedStatus === "stopping",
            details: {
              failures: snapshot.assessment.failures,
              recordedStatus: snapshot.assessment.recordedStatus,
              observedStatus: snapshot.assessment.observedStatus,
            },
          },
        );
      }
      const state = snapshot.state ?? options.createState?.() ?? null;
      if (state === null || state.status !== "stopped") {
        return lifecycleError(
          options.ensure ? "dev.ensure-refused" : "dev.start-refused",
          "Development creation requires absent or stopped state.",
          state,
        );
      }
      const launched = await launchFromStopped({
        state,
        saveState: options.saveState,
        launch: options.launch,
        terminate: options.terminate,
        runtime,
      });
      if (!launched.ok) return launched;
      return {
        ok: true as const,
        state: launched.state,
        reusedReady: false,
        terminationMethod: null,
      };
    },
    waitBoundMs: options.waitBoundMs,
    signal: options.signal,
    runtime,
    operationId: options.operationId,
    lockAlreadyHeld: options.lockAlreadyHeld,
  });
  if (!locked.ok) {
    return lifecycleError(
      locked.code,
      locked.message,
      null,
      { details: locked.details },
    );
  }
  if (!locked.value.ok) return locked.value;
  return {
    ...locked.value,
    operationId: locked.operationId,
  };
}

export async function startDevInstance(
  options: LaunchLifecycleOptions,
): Promise<DevLifecycleResult> {
  return runStartOrEnsure({
    ...options,
    operation: "dev.start",
    ensure: false,
  });
}

export async function ensureDevInstance(
  options: LaunchLifecycleOptions,
): Promise<DevLifecycleResult> {
  return runStartOrEnsure({
    ...options,
    operation: "dev.ensure",
    ensure: true,
  });
}

async function transitionReadyToStopped(options: {
  state: DevInstanceState;
  saveState(state: DevInstanceState): Promise<void>;
  terminate(state: DevInstanceState): Promise<DevTerminationResult>;
  runtime: RuntimeAdapters;
}): Promise<
  | {
      ok: true;
      state: DevInstanceState;
      terminationMethod: Exclude<DevRecoveryDiagnostic["terminationMethod"], null>;
    }
  | DevLifecycleFailure
> {
  const stopping = withoutLastError({
    ...options.state,
    status: "stopping",
    updatedAt: options.runtime.clock.nowIso(),
  });
  try {
    await options.saveState(stopping);
  } catch (error: unknown) {
    return lifecycleError(
      "dev.state-write-failed",
      error instanceof Error ? error.message : "Failed to commit stopping state.",
      options.state,
    );
  }
  const termination = await options.terminate(stopping);
  if (!termination.ok || !termination.confirmedExit) {
    const failedStopping: DevInstanceState = {
      ...stopping,
      lastError: errorRecord({
        code: termination.code,
        message: termination.message,
        phase: "termination",
      }),
      updatedAt: options.runtime.clock.nowIso(),
    };
    await persistFailureBestEffort({
      saveState: options.saveState,
      state: failedStopping,
    });
    return lifecycleError(
      termination.code === "operation.timeout"
        ? "operation.timeout"
        : "dev.termination-failed",
      termination.message,
      failedStopping,
      {
        recoveryRequired: true,
        details: termination,
      },
    );
  }
  const stopped = stoppedAfterTermination({
    state: stopping,
    stoppedAt: options.runtime.clock.nowIso(),
    method: termination.method,
  });
  try {
    await options.saveState(stopped);
  } catch (error: unknown) {
    return lifecycleError(
      "dev.state-write-failed",
      error instanceof Error
        ? error.message
        : "Process exited but stopped state commit failed.",
      stopping,
      {
        recoveryRequired: true,
        details: {
          processDisposition: "confirmed-exited",
          termination,
        },
      },
    );
  }
  return {
    ok: true,
    state: stopped,
    terminationMethod: termination.method,
  };
}

export async function stopDevInstance(
  options: CommonLifecycleOptions & {
    terminate(state: DevInstanceState): Promise<DevTerminationResult>;
  },
): Promise<DevLifecycleResult> {
  const runtime = options.runtimeAdapters;
  if (runtime === undefined) {
    return lifecycleError(
      "dev.lock-failed",
      "Development lifecycle requires explicit runtime adapters.",
      null,
    );
  }
  const locked = await withLifecycleClaim({
    rootPath: options.rootPath,
    operation: "dev.stop",
    work: async () => {
      const snapshot = await options.readStatus();
      if (
        snapshot.state === null ||
        snapshot.state.status !== "ready" ||
        !snapshot.assessment.owned ||
        !snapshot.assessment.mutationAllowed
      ) {
        return lifecycleError(
          "dev.stop-refused",
          "Development stop requires one exact healthy ready instance.",
          snapshot.state,
          {
            recoveryRequired: snapshot.state !== null &&
              snapshot.state.status !== "stopped",
            details: {
              failures: snapshot.assessment.failures,
              recordedStatus: snapshot.assessment.recordedStatus,
            },
          },
        );
      }
      const stopped = await transitionReadyToStopped({
        state: snapshot.state,
        saveState: options.saveState,
        terminate: options.terminate,
        runtime,
      });
      if (!stopped.ok) return stopped;
      return {
        ok: true as const,
        state: stopped.state,
        reusedReady: false,
        terminationMethod: stopped.terminationMethod,
      };
    },
    waitBoundMs: options.waitBoundMs,
    signal: options.signal,
    runtime,
    operationId: options.operationId,
    lockAlreadyHeld: options.lockAlreadyHeld,
  });
  if (!locked.ok) {
    return lifecycleError(
      locked.code,
      locked.message,
      null,
      { details: locked.details },
    );
  }
  if (!locked.value.ok) return locked.value;
  return {
    ...locked.value,
    operationId: locked.operationId,
  };
}

export async function restartDevInstance(
  options: LaunchLifecycleOptions,
): Promise<DevLifecycleResult> {
  const runtime = options.runtimeAdapters;
  if (runtime === undefined) {
    return lifecycleError(
      "dev.lock-failed",
      "Development lifecycle requires explicit runtime adapters.",
      null,
    );
  }
  const locked = await withLifecycleClaim({
    rootPath: options.rootPath,
    operation: "dev.restart",
    work: async () => {
      const snapshot = await options.readStatus();
      if (
        snapshot.state === null ||
        snapshot.state.status !== "ready" ||
        !snapshot.assessment.owned ||
        !snapshot.assessment.mutationAllowed ||
        !snapshot.assessment.compatibilityProven
      ) {
        return lifecycleError(
          "dev.restart-refused",
          "Development restart requires one exact healthy ready instance.",
          snapshot.state,
          {
            recoveryRequired: snapshot.state !== null &&
              snapshot.state.status !== "stopped",
            details: {
              failures: snapshot.assessment.failures,
              recordedStatus: snapshot.assessment.recordedStatus,
            },
          },
        );
      }
      const stopped = await transitionReadyToStopped({
        state: snapshot.state,
        saveState: options.saveState,
        terminate: options.terminate,
        runtime,
      });
      if (!stopped.ok) return stopped;
      const launched = await launchFromStopped({
        state: stopped.state,
        saveState: options.saveState,
        launch: options.launch,
        terminate: options.terminate,
        runtime,
      });
      if (!launched.ok) return launched;
      return {
        ok: true as const,
        state: launched.state,
        reusedReady: false,
        terminationMethod: stopped.terminationMethod,
      };
    },
    waitBoundMs: options.waitBoundMs,
    signal: options.signal,
    runtime,
    operationId: options.operationId,
    lockAlreadyHeld: options.lockAlreadyHeld,
  });
  if (!locked.ok) {
    return lifecycleError(
      locked.code,
      locked.message,
      null,
      { details: locked.details },
    );
  }
  if (!locked.value.ok) return locked.value;
  return {
    ...locked.value,
    operationId: locked.operationId,
  };
}
