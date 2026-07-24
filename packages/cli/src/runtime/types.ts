/**
 * Shared bounded-operation runtime types for every one-shot CLI command.
 * See architecture §§2, 4.2, 7 and VAL-HOST-027/028/029.
 */

/** Lock resources that serialize state-changing work for one home/instance. */
export type LockResource =
  | "plugins-state"
  | "main-launch"
  | "dev-instance"
  | "registry-publication";

/** Named external-wait stages that must finish within a finite bound. */
export type ExternalWaitStage =
  | "launch-readiness"
  | "cdp-discovery"
  | "cdp-evaluation"
  | "renderer-response"
  | "approval"
  | "http-download"
  | "owned-child-shutdown"
  | "lock-acquisition";

/** Deterministic local work stages (interruptible, no mandatory wall deadline). */
export type DeterministicStage =
  | "preflight"
  | "local-work"
  | "state-write"
  | "cleanup";

export type OperationStage = ExternalWaitStage | DeterministicStage;

/** How a registered process/resource may be disposed on cleanup. */
export type ProcessDisposition =
  /** Explodex-owned helper; may be reaped on timeout/interrupt/failure/success. */
  | "command-owned"
  /**
   * Successfully launched normal ChatGPT (or user-owned main).
   * Never signaled by the runtime; survival is reported in partial state.
   */
  | "protected-chatgpt"
  /** Foreign/unknown; never signaled. */
  | "foreign";

export type ResourceKind =
  | "child-process"
  | "session"
  | "lock"
  | "callback"
  | "watcher"
  | "socket"
  | "future-document"
  | "reconnect-loop"
  | "approval-listener"
  | "transient-file";

export type OperationLockRecord = {
  schemaVersion: 1;
  resource: LockResource;
  operationId: string;
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
};

export type OperationIdentity = {
  operationId: string;
  operation: string;
  startedAt: string;
  /** Optional CLI/home owner PID for lock records. */
  ownerPid: number;
  ownerProcessStartedAt: string;
};

export type PartialOperationState = {
  lastCompletedStage: OperationStage | null;
  stalledStage: OperationStage | null;
  /** Surviving protected ChatGPT identity when a partial launch occurred. */
  survivingChatGpt?: {
    pid: number;
    processStartedAt: string;
    port?: 9333 | 9444;
  };
  alreadyApplied?: unknown;
  details?: unknown;
};

export type BoundedOperationErrorCode =
  | "operation_timeout"
  | "operation_interrupted"
  | "operation_failed"
  | "invalid_stage_bound"
  | "external_wait_requires_bound"
  | "lock_busy"
  | "lock_stale_unrecoverable"
  | "cleanup_failed"
  | "resident_control_plane_forbidden";

export type BoundedOperationError = {
  code: BoundedOperationErrorCode;
  message: string;
  stage: OperationStage | null;
  boundMs?: number;
  details?: unknown;
};

export type BoundedOperationSuccess<T> = {
  ok: true;
  operationId: string;
  operation: string;
  result: T;
  stagesCompleted: OperationStage[];
  warnings: Array<{ code: string; message: string }>;
  /** Always empty after a successful terminal cleanup. */
  residualInventory: ResidualInventory;
};

export type BoundedOperationFailure = {
  ok: false;
  operationId: string;
  operation: string;
  error: BoundedOperationError;
  partial: PartialOperationState;
  stagesCompleted: OperationStage[];
  warnings: Array<{ code: string; message: string }>;
  residualInventory: ResidualInventory;
};

export type BoundedOperationResult<T> = BoundedOperationSuccess<T> | BoundedOperationFailure;

/** Post-exit inventory used to enforce no resident control plane (VAL-HOST-027). */
export type ResidualInventory = {
  commandOwnedChildren: number;
  sessions: number;
  locksHeld: number;
  callbacks: number;
  watchers: number;
  sockets: number;
  futureDocuments: number;
  reconnectLoops: number;
  approvalListeners: number;
  daemons: number;
  supervisors: number;
  /** True when any residual control-plane resource remains. */
  hasResidentControlPlane: boolean;
};

export type RegisteredResource = {
  id: string;
  kind: ResourceKind;
  label: string;
  disposition: ProcessDisposition;
  /** Optional OS pid for child processes. */
  pid?: number;
  processStartedAt?: string;
  /** Cleanup invoked at most once with a timeout-fenced control object. */
  dispose: (control: {
    signal: AbortSignal;
    isActive(): boolean;
    tryCommitEffect(): boolean;
  }) => void | Promise<void>;
};

export type ResourceCleanupOutcome =
  | "disposed"
  | "failed"
  | "timed-out"
  | "identity-mismatch"
  | "still-running"
  | "invalid-registration";

export type ResourceCleanupFailure = {
  id: string;
  kind: ResourceKind;
  label: string;
  disposition: ProcessDisposition;
  pid?: number;
  processStartedAt?: string;
  outcome: Exclude<ResourceCleanupOutcome, "disposed">;
  message: string;
};

export type ResourceCleanupReport = {
  failures: ResourceCleanupFailure[];
  timedOut: boolean;
  boundMs: number;
};

export type StageBoundConfig = {
  /** Milliseconds for each external-wait stage. */
  bounds: Readonly<Record<ExternalWaitStage, number>>;
};

export const DEFAULT_STAGE_BOUNDS_MS: Readonly<Record<ExternalWaitStage, number>> = {
  "launch-readiness": 30_000,
  "cdp-discovery": 10_000,
  "cdp-evaluation": 15_000,
  "renderer-response": 15_000,
  approval: 120_000,
  "http-download": 60_000,
  "owned-child-shutdown": 5_000,
  "lock-acquisition": 2_000,
};
