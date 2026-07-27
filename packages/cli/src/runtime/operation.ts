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
  /** Optional caller-owned cooperative interruption signal. */
  abortSignal?: AbortSignal;
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
  const onExternalAbort = (): void => onInterrupt();
  if (options.abortSignal?.aborted) onExternalAbort();
  else {
    options.abortSignal?.addEventListener("abort", onExternalAbort, {
      once: true,
    });
  }

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
      // Observe settlement either way so late continuations can reverse/register
      // residual authority before terminal dispose starts.
      const settledWork = workPromise.then(
        () => undefined,
        () => undefined,
      );

      try {
        const result = await Promise.race([workPromise, timeoutPromise]);
        throwIfInterrupted();
        if (!stageActive || adapters.clock.nowMs() > deadline) {
          stageActive = false;
          stageAbort.abort();
          await fenceStageWorkSettlement(settledWork, adapters, boundMs);
          throw new TimeoutError(stage, boundMs);
        }
        return result;
      } catch (error: unknown) {
        // Timeout/interrupt won the race: fence late work settlement so residual
        // authority can still register before terminal dispose. Bound the wait so
        // a permanently hung stage cannot stall cleanup.
        if (error instanceof TimeoutError || error instanceof InterruptError) {
          stageActive = false;
          stageAbort.abort();
          await fenceStageWorkSettlement(settledWork, adapters, boundMs);
        }
        throw error;
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
    // Adapter-created residual CDP session authority must enter scope before
    // terminal dispose so inventory cannot publish a false-clean control plane.
    const residualSession = extractResidualSessionAuthority(error);
    if (residualSession !== null) {
      tryRegisterResidualSession(scope, residualSession);
    }
    const details = enrichFailureDetails(error, residualSession);

    const cleanup = await finalizeDispose(
      scope,
      terminalReason,
      bounds.bounds["owned-child-shutdown"],
    );
    let inventory = scope.inventory();
    // Open residual that could not enter ResourceScope still counts as one
    // session / resident control-plane authority until disposal succeeds.
    inventory = mergeOpenResidualSessionInventory(inventory, residualSession);
    if (options.afterDispose) await options.afterDispose(inventory);
    if (cleanup.failures.length > 0 || (enforce && inventory.hasResidentControlPlane)) {
      // Preserve the specific residual classification when cleanup cannot clear
      // the open session; do not collapse it to a generic cleanup_failed alone.
      if (errorCode === "cdp_session_registration_cleanup_failed") {
        return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
          code: errorCode,
          message: `${message}; terminal cleanup was incomplete`,
          stage: errorStage ?? "cleanup",
          boundMs: errorBoundMs,
          details: {
            ...asRecord(details),
            cleanupFailures: cleanup.failures,
            residualInventory: inventory,
          },
        });
      }
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
          details,
        },
      );
    }

    return failureResult(identity, stagesCompleted, warnings, partial, inventory, {
      code: errorCode,
      message,
      stage: errorStage,
      boundMs: errorBoundMs,
      details,
    });
  } finally {
    options.abortSignal?.removeEventListener("abort", onExternalAbort);
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

/**
 * After a stage times out or is interrupted, give the stage continuation a
 * finite chance to reverse publication / register residual authority before
 * terminal dispose begins. Never waits unbounded for hung stage work.
 */
function fenceStageWorkSettlement(
  settledWork: Promise<void>,
  adapters: RuntimeAdapters,
  stageBoundMs: number,
): Promise<void> {
  // Settlement fence is finite and independent of the already-expired stage.
  // Cap by the owned-child-shutdown bound so cleanup cannot be starved.
  const settlementBoundMs = Math.max(
    1,
    Math.min(stageBoundMs, DEFAULT_STAGE_BOUNDS_MS["owned-child-shutdown"]),
  );
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      handle.clear();
      resolve();
    };
    const handle = adapters.timers.setTimeout(finish, settlementBoundMs);
    void settledWork.then(finish, finish);
  });
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
  if (code === "lock_cleanup_failed") return code;
  if (code === "lock_release_timeout") return code;
  if (code === "lock_release_interrupted") return code;
  if (code === "lock_stale_unrecoverable") return code;
  if (code === "lock_invariant_violation") return code;
  if (code === "target_not_found") return code;
  if (code === "target_ambiguous") return code;
  if (code === "context_not_found") return code;
  if (code === "context_ambiguous") return code;
  if (code === "endpoint_identity_mismatch") return code;
  if (code === "host_identity_drift") return code;
  if (code === "process_identity_drift") return code;
  if (code === "port_owner_drift") return code;
  if (code === "browser_identity_drift") return code;
  if (code === "target_identity_drift") return code;
  if (code === "context_identity_drift") return code;
  if (code === "cdp_session_registration_cleanup_failed") return code;
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

function readRuntimeErrorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  if ("details" in error) {
    const details = (error as Error & { details?: unknown }).details;
    if (details !== undefined) return details;
  }
  return { name: error.name };
}

/**
 * In-process residual CDP session authority. Kept structural (duck-typed) so
 * the runtime package does not hard-depend on the CDP module graph.
 */
type ResidualSessionAuthorityLike = {
  targetId: string;
  isOpen(): boolean;
  dispose(options?: { timeoutMs?: number }): Promise<void>;
};

function isResidualSessionAuthorityLike(value: unknown): value is ResidualSessionAuthorityLike {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["targetId"] === "string" &&
    typeof record["isOpen"] === "function" &&
    typeof record["dispose"] === "function";
}

function extractResidualSessionAuthority(error: unknown): ResidualSessionAuthorityLike | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (record["code"] !== "cdp_session_registration_cleanup_failed") return null;
  return isResidualSessionAuthorityLike(record["residual"]) ? record["residual"] : null;
}

function tryRegisterResidualSession(
  scope: ResourceScope,
  residual: ResidualSessionAuthorityLike,
): string | null {
  try {
    return scope.register({
      kind: "session",
      label: `cdp-residual:${residual.targetId}`,
      disposition: "command-owned",
      dispose: (control) => {
        // Bound residual dispose by remaining cleanup control; never leave an
        // untracked open session when dispose eventually succeeds.
        void control;
        return residual.dispose();
      },
    });
  } catch {
    // Terminal dispose may already have started. Residual remains on details
    // for bounded dispose/retry and inventory merge below.
    return null;
  }
}

function mergeOpenResidualSessionInventory(
  inventory: ResidualInventory,
  residual: ResidualSessionAuthorityLike | null,
): ResidualInventory {
  if (residual === null || !residual.isOpen()) return inventory;
  if (inventory.sessions > 0) return inventory;
  return {
    ...inventory,
    sessions: inventory.sessions + 1,
    hasResidentControlPlane: true,
  };
}

function secretFreeErrorSummary(value: unknown): { name?: string; message: string; code?: string } {
  if (value instanceof Error) {
    const code = "code" in value && typeof (value as { code?: unknown }).code === "string"
      ? (value as { code: string }).code
      : undefined;
    return {
      name: value.name,
      message: value.message,
      ...(code === undefined ? {} : { code }),
    };
  }
  return { message: String(value) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : value === undefined
      ? {}
      : { details: value };
}

/**
 * Secret-free residual diagnostics plus a reachable in-process residual handle.
 * Never puts raw session/socket internals into serializable diagnostic fields.
 */
function enrichFailureDetails(
  error: unknown,
  residual: ResidualSessionAuthorityLike | null,
): unknown {
  const base = readRuntimeErrorDetails(error);
  if (residual === null) return base;
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const boundMs = typeof record["boundMs"] === "number" && Number.isFinite(record["boundMs"])
    ? record["boundMs"]
    : undefined;
  const residualHandle = {
    targetId: residual.targetId,
    isOpen: () => residual.isOpen(),
    dispose: (options?: { timeoutMs?: number }) => residual.dispose(options),
  };
  return {
    ...asRecord(base),
    residualSession: {
      targetId: residual.targetId,
      isOpen: residual.isOpen(),
      ...(boundMs === undefined ? {} : { boundMs }),
    },
    // Reachable in-process for bounded dispose/retry; functions are not JSON fields.
    residualAuthority: residualHandle,
    ...(record["registrationError"] === undefined
      ? {}
      : { registrationError: secretFreeErrorSummary(record["registrationError"]) }),
    ...(record["cleanupError"] === undefined
      ? {}
      : { cleanupError: secretFreeErrorSummary(record["cleanupError"]) }),
  };
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
