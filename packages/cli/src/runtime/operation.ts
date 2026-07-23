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
  type ExternalWaitStage,
  type OperationIdentity,
  type OperationStage,
  type PartialOperationState,
  type ResidualInventory,
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
   */
  runLocal<T>(stage: OperationStage, work: (ctl: StageControl) => Promise<T> | T): Promise<T>;
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

  const scope = createResourceScope({
    operationId: identity.operationId,
    process: adapters.process,
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
      throwIfInterrupted();
      currentStage = stage;
      const ctl: StageControl = {
        stage,
        signal: abort.signal,
        isInterrupted: () => scope.isInterrupted() || abort.signal.aborted,
        throwIfInterrupted,
        remainingMs: () => Number.POSITIVE_INFINITY,
      };
      try {
        const result = await work(ctl);
        throwIfInterrupted();
        return result;
      } finally {
        currentStage = null;
      }
    },

    async runExternalWait(stage, work) {
      throwIfInterrupted();
      currentStage = stage;
      const boundMs = bounds.bounds[stage];
      const started = adapters.clock.nowMs();
      const deadline = started + boundMs;

      const ctl: StageControl = {
        stage,
        signal: abort.signal,
        isInterrupted: () => scope.isInterrupted() || abort.signal.aborted,
        throwIfInterrupted,
        remainingMs: () => Math.max(0, deadline - adapters.clock.nowMs()),
      };

      let settled = false;
      let timeoutHandle: { clear(): void } | null = null;

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = adapters.timers.setTimeout(() => {
          if (settled) return;
          reject(new TimeoutError(stage, boundMs));
        }, boundMs);
      });

      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (abort.signal.aborted) {
          reject(new InterruptError(stage));
          return;
        }
        const onAbort = (): void => {
          reject(new InterruptError(stage));
        };
        abort.signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const result = await Promise.race([work(ctl), timeoutPromise, abortPromise]);
        throwIfInterrupted();
        return result;
      } finally {
        settled = true;
        timeoutHandle?.clear();
        currentStage = null;
      }
    },
  };

  try {
    const result = await options.run(ctx);
    throwIfInterrupted();
    terminalReason = "success";

    await finalizeDispose(scope, terminalReason, adapters);
    const inventory = scope.inventory();
    if (enforce) {
      assertNoResidentControlPlane(inventory);
    }
    if (options.afterDispose) {
      await options.afterDispose(inventory);
    }

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
      await safeCleanup(scope, adapters, terminalReason);
      const inventory = scope.inventory();
      if (options.afterDispose) await options.afterDispose(inventory);
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
      await safeCleanup(scope, adapters, terminalReason);
      const inventory = scope.inventory();
      if (options.afterDispose) await options.afterDispose(inventory);
      return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
        code: "operation_interrupted",
        message: error.message,
        stage: error.stage,
      });
    }

    terminalReason = "failure";
    const message =
      error instanceof Error ? error.message : "Operation failed with a non-Error throw";
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      (error as { code: string }).code === "resident_control_plane_forbidden"
        ? ("resident_control_plane_forbidden" as const)
        : ("operation_failed" as const);

    await safeCleanup(scope, adapters, terminalReason);
    const inventory = scope.inventory();
    if (options.afterDispose) await options.afterDispose(inventory);

    // If cleanup left residue and enforcement is on, surface that too.
    if (enforce && inventory.hasResidentControlPlane && code === "operation_failed") {
      warnings.push({
        code: "residual_after_cleanup",
        message: "Cleanup completed but residual inventory was non-empty",
      });
    }

    return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
      code,
      message,
      stage: currentStage ?? partial.stalledStage,
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
  adapters: RuntimeAdapters,
): Promise<void> {
  // Reap command-owned children first (never protected ChatGPT).
  await scope.reapCommandOwnedChildren("SIGTERM");
  await scope.dispose(reason);
  void adapters;
}

async function safeCleanup(
  scope: ResourceScope,
  adapters: RuntimeAdapters,
  reason: "success" | "failure" | "timeout" | "interrupted",
): Promise<void> {
  try {
    await finalizeDispose(scope, reason, adapters);
  } catch {
    // Best-effort.
  }
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
