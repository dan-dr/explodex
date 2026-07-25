/**
 * Bounded one-shot operation runner: stage timeouts, cooperative SIGINT,
 * resource-scope cleanup, and no-resident-control-plane enforcement.
 */

import type { RuntimeAdapters } from "./adapters.ts";
import { createResourceScope, type ResourceScope } from "./resource-scope.ts";
import {
  DEFAULT_STAGE_BOUNDS_MS,
  type BoundedOperationFailure,
  type BoundedOperationResult,
  type BoundedOperationSuccess,
  type DeterministicStage,
  type ExternalWaitStage,
  type OperationIdentity,
  type OperationStage,
  type PartialOperationState,
  type ResidualInventory,
  type ResourceCleanupReport,
  type StageBoundConfig,
} from "./types.ts";
import { assertNoResidentControlPlane } from "./resource-scope.ts";

export type OperationContext = {
  identity: OperationIdentity;
  scope: ResourceScope;
  adapters: RuntimeAdapters;
  /**
   * Run work that may wait on an external system. Enforces the stage bound
   * and cooperative interruption. Throws TimeoutError / InterruptError.
   */
  runExternalWait<T>(stage: ExternalWaitStage, work: (ctl: StageControl) => Promise<T>): Promise<T>;
  /**
   * Run deterministic local work. No wall deadline, but abortable on interrupt.
   * External-wait stages are rejected and must use runExternalWait().
   */
  runLocal<T>(stage: DeterministicStage, work: (ctl: StageControl) => Promise<T> | T): Promise<T>;
  /** Record that a stage completed successfully. */
  markStageComplete(stage: OperationStage): void;
  /** Update partial-state fields (surviving ChatGPT, already-applied work). */
  setPartial(patch: Partial<PartialOperationState>): void;
  /** Current partial snapshot. */
  getPartial(): PartialOperationState;
  /** Throw if interrupted; for cooperative polling loops. */
  throwIfInterrupted(): void;
};

export type StageControl = {
  stage: OperationStage;
  signal: AbortSignal;
  isInterrupted(): boolean;
  throwIfInterrupted(): void;
  /** Remaining ms for external waits; Infinity for local work. */
  remainingMs(): number;
  /**
   * Atomically claim permission for an externally visible effect.
   * Returns false after timeout, interruption, supersession, or terminal cleanup.
   */
  tryCommitEffect(): boolean;
};

export class TimeoutError extends Error {
  readonly code = "operation_timeout" as const;
  readonly stage: OperationStage;
  readonly boundMs: number;

  constructor(stage: OperationStage, boundMs: number) {
    super(`Stage "${stage}" timed out after ${boundMs}ms`);
    this.name = "TimeoutError";
    this.stage = stage;
    this.boundMs = boundMs;
  }
}

export class InterruptError extends Error {
  readonly code = "operation_interrupted" as const;
  readonly stage: OperationStage | null;

  constructor(stage: OperationStage | null) {
    super(
      stage === null
        ? "Operation interrupted"
        : `Operation interrupted during stage "${stage}"`,
    );
    this.name = "InterruptError";
    this.stage = stage;
  }
}

export type RunBoundedOperationOptions<T> = {
  adapters: RuntimeAdapters;
  operation: string;
  /** Optional fixed operation id (tests). */
  operationId?: string;
  stageBounds?: Partial<Record<ExternalWaitStage, number>>;
  /**
   * Body of the one-shot command. Must not leave resident control plane resources.
   * Should register every child/session/lock/callback on ctx.scope.
   */
  run: (ctx: OperationContext) => Promise<T>;
  /**
   * When true (default), assert residual inventory is clean after dispose.
   * Failures of this assertion become cleanup_failed / resident errors.
   */
  enforceNoResidentControlPlane?: boolean;
  /**
   * Optional hook after dispose for tests (e.g. delayed observation).
   */
  afterDispose?: (inventory: ResidualInventory) => void | Promise<void>;
};

function newOperationId(clockIso: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const stamp = clockIso.replace(/[:.]/g, "-");
  return `op_${stamp}_${rand}`;
}

const EXTERNAL_WAIT_STAGES: ReadonlySet<ExternalWaitStage> = new Set([
  "launch-readiness",
  "cdp-discovery",
  "cdp-evaluation",
  "renderer-response",
  "approval",
  "http-download",
  "owned-child-shutdown",
  "lock-acquisition",
]);

function mergeBounds(
  overrides: Partial<Record<ExternalWaitStage, number>> | undefined,
): StageBoundConfig {
  return {
    bounds: {
      ...DEFAULT_STAGE_BOUNDS_MS,
      ...overrides,
    },
  };
}

function invalidBoundFailure<T>(
  operationId: string,
  operation: string,
  stage: ExternalWaitStage,
  boundMs: number,
): BoundedOperationResult<T> {
  return {
    ok: false,
    operationId,
    operation,
    error: {
      code: "invalid_stage_bound",
      message: `Stage "${stage}" requires a finite positive bound`,
      stage,
      boundMs,
    },
    partial: emptyPartial(),
    stagesCompleted: [],
    warnings: [],
    residualInventory: emptyResidualInventory(),
  };
}

function emptyResidualInventory(): ResidualInventory {
  return {
    commandOwnedChildren: 0,
    sessions: 0,
    locksHeld: 0,
    callbacks: 0,
    watchers: 0,
    sockets: 0,
    futureDocuments: 0,
    reconnectLoops: 0,
    approvalListeners: 0,
    daemons: 0,
    supervisors: 0,
    openLockDescriptors: 0,
    advisoryLeasesHeld: 0,
    hasResidentControlPlane: false,
  };
}

function emptyPartial(): PartialOperationState {
  return {
    lastCompletedStage: null,
    stalledStage: null,
  };
}

/**
 * Run a complete one-shot bounded operation with:
 * - finite external-wait stage bounds (VAL-HOST-028)
 * - cooperative first-SIGINT interruption (VAL-HOST-029)
 * - resource-scope cleanup that never signals protected ChatGPT
 * - no residual daemon/socket/watcher/callback/lock/reconnect (VAL-HOST-027)
 */
export async function runBoundedOperation<T>(
  options: RunBoundedOperationOptions<T>,
): Promise<BoundedOperationResult<T>> {
  const { adapters } = options;
  const bounds = mergeBounds(options.stageBounds);
  const enforce = options.enforceNoResidentControlPlane !== false;

  const self = adapters.process.self();
  const identity: OperationIdentity = {
    operationId: options.operationId ?? newOperationId(adapters.clock.nowIso()),
    operation: options.operation,
    startedAt: adapters.clock.nowIso(),
    ownerPid: self.pid,
    ownerProcessStartedAt: self.processStartedAt,
  };

  for (const stage of EXTERNAL_WAIT_STAGES) {
    const boundMs = bounds.bounds[stage];
    if (!Number.isFinite(boundMs) || boundMs <= 0) {
      return invalidBoundFailure(identity.operationId, identity.operation, stage, boundMs);
    }
  }

  const scope = createResourceScope({
    operationId: identity.operationId,
    process: adapters.process,
    clock: adapters.clock,
    timers: adapters.timers,
  });

  const stagesCompleted: OperationStage[] = [];
  const warnings: Array<{ code: string; message: string }> = [];
  let partial = emptyPartial();
  let currentStage: OperationStage | null = null;
  let terminalReason: "success" | "failure" | "timeout" | "interrupted" = "failure";

  const abort = new AbortController();

  const onInterrupt = (): void => {
    if (scope.isInterrupted()) return;
    scope.requestInterrupt();
    abort.abort();
  };

  const unsubInt = adapters.signals.on("SIGINT", onInterrupt);
  const unsubTerm = adapters.signals.on("SIGTERM", onInterrupt);

  const throwIfInterrupted = (): void => {
    if (scope.isInterrupted() || abort.signal.aborted) {
      throw new InterruptError(currentStage);
    }
  };

  const ctx: OperationContext = {
    identity,
    scope,
    adapters,

    markStageComplete(stage) {
      stagesCompleted.push(stage);
      partial = {
        ...partial,
        lastCompletedStage: stage,
        stalledStage: null,
      };
    },

    setPartial(patch) {
      partial = { ...partial, ...patch };
    },

    getPartial() {
      return { ...partial };
    },

    throwIfInterrupted,

    async runLocal(stage, work) {
      if (EXTERNAL_WAIT_STAGES.has(stage as ExternalWaitStage)) {
        throw Object.assign(
          new Error(`External wait stage "${stage}" must use runExternalWait()`),
          {
            code: "external_wait_requires_bound" as const,
            stage: stage as OperationStage,
          },
        );
      }
      throwIfInterrupted();
      currentStage = stage;
      let stageActive = true;
      const ctl: StageControl = {
        stage,
        signal: abort.signal,
        isInterrupted: () => scope.isInterrupted() || abort.signal.aborted,
        throwIfInterrupted,
        remainingMs: () => Number.POSITIVE_INFINITY,
        tryCommitEffect: () => stageActive && !scope.isInterrupted() && !abort.signal.aborted,
      };
      try {
        const result = await work(ctl);
        throwIfInterrupted();
        return result;
      } finally {
        stageActive = false;
        currentStage = null;
      }
    },

    async runExternalWait(stage, work) {
      throwIfInterrupted();
      currentStage = stage;
      const boundMs = bounds.bounds[stage];
      const started = adapters.clock.nowMs();
      const deadline = started + boundMs;
      const stageAbort = new AbortController();
      let stageActive = true;

      const propagateAbort = (): void => {
        stageActive = false;
        stageAbort.abort();
      };
      if (abort.signal.aborted) propagateAbort();
      else abort.signal.addEventListener("abort", propagateAbort, { once: true });

      const ctl: StageControl = {
        stage,
        signal: stageAbort.signal,
        isInterrupted: () => scope.isInterrupted() || stageAbort.signal.aborted,
        throwIfInterrupted: () => {
          if (scope.isInterrupted() || abort.signal.aborted) {
            throw new InterruptError(stage);
          }
          if (!stageActive || stageAbort.signal.aborted) {
            throw new TimeoutError(stage, boundMs);
          }
        },
        remainingMs: () => Math.max(0, deadline - adapters.clock.nowMs()),
        tryCommitEffect: () =>
          stageActive &&
          adapters.clock.nowMs() <= deadline &&
          !stageAbort.signal.aborted &&
          !scope.isInterrupted() &&
          !abort.signal.aborted,
      };

      let settled = false;
      const timeoutHandle = adapters.timers.setTimeout(() => {
        if (settled) return;
        stageActive = false;
        stageAbort.abort();
      }, boundMs);

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const onStageAbort = (): void => {
          if (abort.signal.aborted || scope.isInterrupted()) {
            reject(new InterruptError(stage));
          } else {
            reject(new TimeoutError(stage, boundMs));
          }
        };
        if (stageAbort.signal.aborted) onStageAbort();
        else stageAbort.signal.addEventListener("abort", onStageAbort, { once: true });
      });

      const workPromise = Promise.resolve().then(() => work(ctl));
      void workPromise.catch(() => undefined);

      try {
        const result = await Promise.race([workPromise, timeoutPromise]);
        throwIfInterrupted();
        if (!stageActive || adapters.clock.nowMs() > deadline) {
          stageActive = false;
          stageAbort.abort();
          throw new TimeoutError(stage, boundMs);
        }
        return result;
      } finally {
        settled = true;
        stageActive = false;
        timeoutHandle.clear();
        abort.signal.removeEventListener("abort", propagateAbort);
        currentStage = null;
      }
    },
  };

  try {
    const result = await options.run(ctx);
    throwIfInterrupted();
    terminalReason = "success";
    abort.abort();

    const cleanup = await finalizeDispose(
      scope,
      terminalReason,
      bounds.bounds["owned-child-shutdown"],
    );
    const inventory = scope.inventory();
    if (options.afterDispose) await options.afterDispose(inventory);
    if (cleanup.failures.length > 0 || (enforce && inventory.hasResidentControlPlane)) {
      return cleanupFailureResult(
        identity,
        stagesCompleted,
        warnings,
        partial,
        inventory,
        cleanup,
      );
    }
    if (enforce) assertNoResidentControlPlane(inventory);

    const success: BoundedOperationSuccess<T> = {
      ok: true,
      operationId: identity.operationId,
      operation: identity.operation,
      result,
      stagesCompleted: [...stagesCompleted],
      warnings,
      residualInventory: inventory,
    };
    return success;
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      terminalReason = "timeout";
      partial = {
        ...partial,
        stalledStage: error.stage,
      };
      abort.abort();
      const cleanup = await finalizeDispose(
        scope,
        terminalReason,
        bounds.bounds["owned-child-shutdown"],
      );
      const inventory = scope.inventory();
      if (options.afterDispose) await options.afterDispose(inventory);
      if (cleanup.failures.length > 0 || (enforce && inventory.hasResidentControlPlane)) {
        return cleanupFailureResult(
          identity,
          stagesCompleted,
          warnings,
          partial,
          inventory,
          cleanup,
          {
            code: "operation_timeout",
            message: error.message,
            stage: error.stage,
            boundMs: error.boundMs,
          },
        );
      }
      return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
        code: "operation_timeout",
        message: error.message,
        stage: error.stage,
        boundMs: error.boundMs,
      });
    }

    if (error instanceof InterruptError) {
      terminalReason = "interrupted";
      partial = {
        ...partial,
        stalledStage: error.stage,
      };
      const cleanup = await finalizeDispose(
        scope,
        terminalReason,
        bounds.bounds["owned-child-shutdown"],
      );
      const inventory = scope.inventory();
      if (options.afterDispose) await options.afterDispose(inventory);
      if (cleanup.failures.length > 0 || (enforce && inventory.hasResidentControlPlane)) {
        return cleanupFailureResult(
          identity,
          stagesCompleted,
          warnings,
          partial,
          inventory,
          cleanup,
          {
            code: "operation_interrupted",
            message: error.message,
            stage: error.stage,
          },
        );
      }
      return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
        code: "operation_interrupted",
        message: error.message,
        stage: error.stage,
      });
    }

    terminalReason = "failure";
    abort.abort();
    const message =
      error instanceof Error ? error.message : "Operation failed with a non-Error throw";
    const errorCode = readRuntimeErrorCode(error);
    const errorStage = readRuntimeErrorStage(error) ?? currentStage ?? partial.stalledStage;
    const errorBoundMs = readRuntimeErrorBoundMs(error);

    const cleanup = await finalizeDispose(
      scope,
      terminalReason,
      bounds.bounds["owned-child-shutdown"],
    );
    const inventory = scope.inventory();
    if (options.afterDispose) await options.afterDispose(inventory);
    if (cleanup.failures.length > 0 || (enforce && inventory.hasResidentControlPlane)) {
      return cleanupFailureResult(
        identity,
        stagesCompleted,
        warnings,
        partial,
        inventory,
        cleanup,
        {
          code: errorCode,
          message,
          stage: errorStage,
          boundMs: errorBoundMs,
          details: error instanceof Error ? { name: error.name } : undefined,
        },
      );
    }

    return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
      code: errorCode,
      message,
      stage: errorStage,
      boundMs: errorBoundMs,
      details: error instanceof Error ? { name: error.name } : undefined,
    });
  } finally {
    unsubInt();
    unsubTerm();
  }
}

async function finalizeDispose(
  scope: ResourceScope,
  reason: "success" | "failure" | "timeout" | "interrupted",
  boundMs: number,
): Promise<ResourceCleanupReport> {
  return scope.dispose(reason, boundMs);
}

function cleanupFailureResult(
  identity: OperationIdentity,
  stagesCompleted: OperationStage[],
  warnings: Array<{ code: string; message: string }>,
  partial: PartialOperationState,
  inventory: ResidualInventory,
  cleanup: ResourceCleanupReport,
  cause?: BoundedOperationFailure["error"],
): BoundedOperationFailure {
  return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
    code: "cleanup_failed",
    message: cause
      ? `${cause.message}; terminal cleanup was incomplete`
      : "Terminal cleanup was incomplete",
    stage: "cleanup",
    boundMs: cleanup.boundMs,
    details: {
      failures: cleanup.failures,
      residualInventory: inventory,
      ...(cause ? { cause } : {}),
    },
  });
}

function readRuntimeErrorCode(error: unknown): BoundedOperationFailure["error"]["code"] {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "operation_failed";
  }
  const code = (error as { code?: unknown }).code;
  if (code === "resident_control_plane_forbidden") return code;
  if (code === "external_wait_requires_bound") return code;
  if (code === "invalid_stage_bound") return code;
  if (code === "lock_busy") return code;
  if (code === "lock_release_timeout") return code;
  if (code === "lock_release_interrupted") return code;
  if (code === "lock_stale_unrecoverable") return code;
  if (code === "lock_invariant_violation") return code;
  return "operation_failed";
}

function readRuntimeErrorStage(error: unknown): OperationStage | null {
  if (typeof error !== "object" || error === null || !("stage" in error)) return null;
  const stage = (error as { stage?: unknown }).stage;
  return typeof stage === "string" ? (stage as OperationStage) : null;
}

function readRuntimeErrorBoundMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("boundMs" in error)) return undefined;
  const boundMs = (error as { boundMs?: unknown }).boundMs;
  return typeof boundMs === "number" && Number.isFinite(boundMs) ? boundMs : undefined;
}

function failureResult(
  identity: OperationIdentity,
  stagesCompleted: OperationStage[],
  warnings: Array<{ code: string; message: string }>,
  partial: PartialOperationState,
  inventory: ResidualInventory,
  error: BoundedOperationFailure["error"],
): BoundedOperationFailure {
  return {
    ok: false,
    operationId: identity.operationId,
    operation: identity.operation,
    error,
    partial: { ...partial },
    stagesCompleted: [...stagesCompleted],
    warnings: [...warnings],
    residualInventory: inventory,
  };
}

/** Exported for tests that need to construct a minimal context manually. */
export function createOperationIdentity(
  adapters: RuntimeAdapters,
  operation: string,
  operationId?: string,
): OperationIdentity {
  const self = adapters.process.self();
  return {
    operationId: operationId ?? newOperationId(adapters.clock.nowIso()),
    operation,
    startedAt: adapters.clock.nowIso(),
    ownerPid: self.pid,
    ownerProcessStartedAt: self.processStartedAt,
  };
}
