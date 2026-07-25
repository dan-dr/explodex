/**
 * Operation resource scope: tracks every command-owned resource and disposes
 * them on every terminal path without touching protected ChatGPT processes.
 */

import type { RuntimeClock, RuntimeProcess, RuntimeTimers } from "./adapters.ts";
import type {
  ProcessDisposition,
  RegisteredResource,
  ResidualInventory,
  ResourceCleanupFailure,
  ResourceCleanupReport,
  ResourceKind,
} from "./types.ts";

export type ResourceCleanupControl = {
  signal: AbortSignal;
  isActive(): boolean;
  tryCommitEffect(): boolean;
};

export type RegisterResourceInput = {
  kind: ResourceKind;
  label: string;
  disposition: ProcessDisposition;
  pid?: number;
  processStartedAt?: string;
  /** Real lock-handle state used to report open descriptors and active leases. */
  lockState?: () => { descriptorOpen: boolean; leaseHeld: boolean };
  /** Cleanup work must fence externally visible effects through the supplied control. */
  dispose: (control: ResourceCleanupControl) => void | Promise<void>;
};

export type ResourceScope = {
  readonly operationId: string;
  /** Register a resource; returns its id. Dispose is deferred until scope.dispose(). */
  register(input: RegisterResourceInput): string;
  /** Mark a resource already cleaned (e.g. lock released early). */
  markDisposed(id: string): void;
  /** True while cooperative interruption has been requested. */
  isInterrupted(): boolean;
  /** Request cooperative stop; does not dispose yet. */
  requestInterrupt(): void;
  /**
   * Dispose all remaining resources in LIFO order within one cleanup bound.
   * Protected/foreign processes are never signaled, but their detach callbacks run.
   * When provided, `skipResourceIds` keeps already-failed resources as truthful residue.
   */
  dispose(
    reason: "success" | "failure" | "timeout" | "interrupted",
    boundMs: number,
  ): Promise<ResourceCleanupReport>;
  /** Snapshot of residual control-plane inventory after dispose (or mid-flight). */
  inventory(): ResidualInventory;
  /** List still-active resources (for tests/diagnostics). */
  listActive(): ReadonlyArray<Omit<RegisteredResource, "dispose">>;
  /**
   * Signal only exact command-owned children and verify their bounded shutdown.
   * Never signals protected-chatgpt, foreign, or a reused numeric PID.
   */
  reapCommandOwnedChildren(
    boundMs: number,
    signal?: "SIGTERM" | "SIGINT",
  ): Promise<ResourceCleanupReport>;
};

let nextResourceSeq = 1;

function emptyInventory(): ResidualInventory {
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

function countKind(
  resources: ReadonlyArray<{
    kind: ResourceKind;
    disposition: ProcessDisposition;
    disposed: boolean;
    lockState?: () => { descriptorOpen: boolean; leaseHeld: boolean };
  }>,
): ResidualInventory {
  const inv = emptyInventory();
  for (const r of resources) {
    if (r.disposed) continue;
    switch (r.kind) {
      case "child-process":
        if (r.disposition === "command-owned") inv.commandOwnedChildren += 1;
        break;
      case "session":
        inv.sessions += 1;
        break;
      case "lock": {
        inv.locksHeld += 1;
        const state = r.lockState?.();
        if (state?.descriptorOpen) inv.openLockDescriptors += 1;
        if (state?.leaseHeld) inv.advisoryLeasesHeld += 1;
        break;
      }
      case "callback":
        inv.callbacks += 1;
        break;
      case "watcher":
        inv.watchers += 1;
        break;
      case "socket":
        inv.sockets += 1;
        break;
      case "future-document":
        inv.futureDocuments += 1;
        break;
      case "reconnect-loop":
        inv.reconnectLoops += 1;
        break;
      case "approval-listener":
        inv.approvalListeners += 1;
        break;
      case "transient-file":
        break;
      default: {
        const _exhaustive: never = r.kind;
        void _exhaustive;
      }
    }
  }
  inv.hasResidentControlPlane =
    inv.commandOwnedChildren > 0 ||
    inv.sessions > 0 ||
    inv.locksHeld > 0 ||
    inv.callbacks > 0 ||
    inv.watchers > 0 ||
    inv.sockets > 0 ||
    inv.futureDocuments > 0 ||
    inv.reconnectLoops > 0 ||
    inv.approvalListeners > 0 ||
    inv.openLockDescriptors > 0 ||
    inv.advisoryLeasesHeld > 0 ||
    inv.daemons > 0 ||
    inv.supervisors > 0;
  return inv;
}

export type CreateResourceScopeOptions = {
  operationId: string;
  process: RuntimeProcess;
  clock: RuntimeClock;
  timers: RuntimeTimers;
};

type InternalResource = RegisteredResource & {
  disposed: boolean;
  disposeHookCompleted: boolean;
  childExitConfirmed: boolean;
};

/**
 * Create a new resource scope for one bounded operation.
 * Every one-shot command should create exactly one scope and dispose it once.
 */
export function createResourceScope(options: CreateResourceScopeOptions): ResourceScope {
  const resources: InternalResource[] = [];
  let interrupted = false;
  let disposalStarted = false;
  const processAdapter = options.process;
  const clock = options.clock;
  const timers = options.timers;

  return {
    operationId: options.operationId,

    register(input) {
      if (disposalStarted) {
        throw new Error("Cannot register resources while disposing an operation scope");
      }
      // Forbidden resident control-plane kinds must never be registered as long-lived.
      if (
        input.kind === "reconnect-loop" ||
        (input.kind === "watcher" && input.disposition !== "command-owned")
      ) {
        // Watchers are allowed only as command-owned (foreground develop); reconnect loops never.
      }
      if (input.kind === "reconnect-loop") {
        throw new Error(
          "resident_control_plane_forbidden: reconnect loops are not permitted in one-shot operations",
        );
      }

      const id = `${options.operationId}:r${nextResourceSeq++}`;
      resources.push({
        id,
        kind: input.kind,
        label: input.label,
        disposition: input.disposition,
        pid: input.pid,
        processStartedAt: input.processStartedAt,
        lockState: input.lockState,
        dispose: input.dispose,
        disposed: false,
        disposeHookCompleted: false,
        childExitConfirmed:
          input.kind !== "child-process" || input.disposition !== "command-owned",
      });
      return id;
    },

    markDisposed(id) {
      const found = resources.find((r) => r.id === id);
      if (found) {
        found.disposeHookCompleted = true;
        found.childExitConfirmed = true;
        found.disposed = true;
      }
    },

    isInterrupted() {
      return interrupted;
    },

    requestInterrupt() {
      interrupted = true;
    },

    async reapCommandOwnedChildren(boundMs, signal = "SIGTERM") {
      const failures: ResourceCleanupFailure[] = [];
      const deadline = clock.nowMs() + boundMs;
      const signaled: Array<{ resource: InternalResource; pid: number; processStartedAt: string }> = [];

      for (const r of resources) {
        if (r.disposed || r.kind !== "child-process" || r.disposition !== "command-owned") {
          continue;
        }
        if (
          typeof r.pid !== "number" ||
          !Number.isInteger(r.pid) ||
          r.pid <= 0 ||
          !r.processStartedAt
        ) {
          failures.push(cleanupFailure(
            r,
            "invalid-registration",
            "Command-owned child requires a positive integer PID and process start identity",
          ));
          continue;
        }

        const pid = r.pid;
        const processStartedAt = r.processStartedAt;
        const expected = { pid, processStartedAt };
        const signalBudget = deadline - clock.nowMs();
        if (signalBudget <= 0) {
          failures.push(cleanupFailure(r, "timed-out", `Cleanup exceeded ${boundMs}ms`));
          continue;
        }
        const signalAbort = new AbortController();
        const signalOutcome = await callWithin(
          () => processAdapter.signalExact(expected, signal, {
            abortSignal: signalAbort.signal,
            timeoutMs: signalBudget,
          }),
          signalBudget,
          timers,
          signalAbort,
        );
        if (signalOutcome.status !== "completed") {
          failures.push(cleanupFailure(
            r,
            signalOutcome.status === "timed-out" ? "timed-out" : "failed",
            signalOutcome.message,
          ));
          continue;
        }
        if (!signalOutcome.value) {
          const identityBudget = deadline - clock.nowMs();
          if (identityBudget <= 0) {
            failures.push(cleanupFailure(r, "timed-out", `Cleanup exceeded ${boundMs}ms`));
            continue;
          }
          const identityAbort = new AbortController();
          const identityOutcome = await callWithin(
            () => processAdapter.identify(pid, {
              abortSignal: identityAbort.signal,
              timeoutMs: identityBudget,
            }),
            identityBudget,
            timers,
            identityAbort,
          );
          if (identityOutcome.status !== "completed") {
            failures.push(cleanupFailure(
              r,
              identityOutcome.status === "timed-out" ? "timed-out" : "failed",
              identityOutcome.message,
            ));
            continue;
          }
          if (identityOutcome.value === null) continue;
          failures.push(cleanupFailure(
            r,
            "identity-mismatch",
            `Refused to signal PID ${r.pid} after process start identity changed`,
          ));
          continue;
        }

        signaled.push({ resource: r, pid, processStartedAt });
      }

      const pending = new Map(
        signaled.map((entry) => [entry.resource.id, entry]),
      );
      while (pending.size > 0 && clock.nowMs() < deadline) {
        for (const [id, { resource: r, pid, processStartedAt }] of [...pending]) {
          const aliveBudget = deadline - clock.nowMs();
          if (aliveBudget <= 0) break;
          const aliveAbort = new AbortController();
          const aliveOutcome = await callWithin(
            () => processAdapter.isAlive(pid, processStartedAt, {
              abortSignal: aliveAbort.signal,
              timeoutMs: aliveBudget,
            }),
            aliveBudget,
            timers,
            aliveAbort,
          );
          if (aliveOutcome.status !== "completed") {
            failures.push(cleanupFailure(
              r,
              aliveOutcome.status === "timed-out" ? "timed-out" : "failed",
              aliveOutcome.message,
            ));
            pending.delete(id);
          } else if (!aliveOutcome.value) {
            pending.delete(id);
          }
        }
        if (pending.size === 0) break;
        const sleepBudget = deadline - clock.nowMs();
        if (sleepBudget <= 0) break;
        await sleepUntil(timers, Math.min(10, sleepBudget));
      }

      for (const { resource: r, pid } of pending.values()) {
        failures.push(cleanupFailure(
          r,
          "still-running",
          `Command-owned child PID ${pid} remained alive after ${boundMs}ms`,
        ));
      }

      return {
        failures,
        timedOut: failures.some(
          (failure) => failure.outcome === "still-running" || failure.outcome === "timed-out",
        ),
        boundMs,
      };
    },

    async dispose(reason, boundMs) {
      if (disposalStarted) {
        return { failures: [], timedOut: false, boundMs };
      }
      disposalStarted = true;
      void reason;

      const targets = resources.filter((resource) => !resource.disposed);
      const deadline = clock.nowMs() + boundMs;
      const childCleanup = cleanupCommandOwnedChildren(
        targets,
        deadline,
        boundMs,
        "SIGTERM",
        processAdapter,
        clock,
        timers,
      );
      const disposerCleanup = disposeResourcesFairly(
        [...targets].reverse(),
        deadline,
        boundMs,
        clock,
        timers,
      );
      const [childFailures, disposerFailures] = await Promise.all([
        childCleanup,
        disposerCleanup,
      ]);

      for (const resource of targets) {
        resource.disposed =
          resource.disposeHookCompleted &&
          (resource.kind !== "child-process" ||
            resource.disposition !== "command-owned" ||
            resource.childExitConfirmed);
      }

      const failures = mergeCleanupFailures(childFailures, disposerFailures);
      return {
        failures,
        timedOut: failures.some(
          (failure) => failure.outcome === "timed-out" || failure.outcome === "still-running",
        ),
        boundMs,
      };
    },

    inventory() {
      return countKind(resources);
    },

    listActive() {
      return resources
        .filter((r) => !r.disposed)
        .map(({ id, kind, label, disposition, pid, processStartedAt }) => ({
          id,
          kind,
          label,
          disposition,
          pid,
          processStartedAt,
        }));
    },
  };
}

async function disposeResourcesFairly(
  resources: InternalResource[],
  deadline: number,
  boundMs: number,
  clock: RuntimeClock,
  timers: RuntimeTimers,
): Promise<ResourceCleanupFailure[]> {
  const failures: ResourceCleanupFailure[] = [];

  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index];
    if (!resource || resource.disposed) continue;
    const remainingMs = Math.max(0, deadline - clock.nowMs());
    const remainingResources = Math.max(1, resources.length - index);
    const sliceMs = remainingMs <= 0
      ? 0
      : Math.max(1, Math.floor(remainingMs / remainingResources));
    const sliceDeadline = Math.min(deadline, clock.nowMs() + sliceMs);
    const outcome = await settleWithin(resource.dispose, sliceDeadline, clock, timers);
    if (outcome.status === "disposed") {
      resource.disposeHookCompleted = true;
      continue;
    }
    failures.push(cleanupFailure(resource, outcome.status, outcome.message));
  }

  return failures;
}

async function cleanupCommandOwnedChildren(
  resources: InternalResource[],
  deadline: number,
  boundMs: number,
  signal: "SIGTERM" | "SIGINT",
  processAdapter: RuntimeProcess,
  clock: RuntimeClock,
  timers: RuntimeTimers,
): Promise<ResourceCleanupFailure[]> {
  const failures: ResourceCleanupFailure[] = [];
  const children = resources.filter(
    (resource) =>
      resource.kind === "child-process" && resource.disposition === "command-owned",
  );

  const outcomes = await Promise.all(children.map(async (resource) => {
    if (
      typeof resource.pid !== "number" ||
      !Number.isInteger(resource.pid) ||
      resource.pid <= 0 ||
      !resource.processStartedAt
    ) {
      return [cleanupFailure(
        resource,
        "invalid-registration",
        "Command-owned child requires a positive integer PID and process start identity",
      )];
    }

    const pid = resource.pid;
    const processStartedAt = resource.processStartedAt;
    const localFailures: ResourceCleanupFailure[] = [];
    const signalBudget = deadline - clock.nowMs();
    if (signalBudget <= 0) {
      localFailures.push(cleanupFailure(resource, "timed-out", `Cleanup exceeded ${boundMs}ms`));
      return localFailures;
    }

    const signalAbort = new AbortController();
    const signalOutcome = await callWithin(
      () => processAdapter.signalExact(
        { pid, processStartedAt },
        signal,
        { abortSignal: signalAbort.signal, timeoutMs: signalBudget },
      ),
      signalBudget,
      timers,
      signalAbort,
    );
    if (signalOutcome.status !== "completed") {
      localFailures.push(cleanupFailure(
        resource,
        signalOutcome.status === "timed-out" ? "timed-out" : "failed",
        signalOutcome.message,
      ));
      return localFailures;
    }

    if (!signalOutcome.value) {
      const identityBudget = deadline - clock.nowMs();
      if (identityBudget <= 0) {
        localFailures.push(cleanupFailure(resource, "timed-out", `Cleanup exceeded ${boundMs}ms`));
        return localFailures;
      }
      const identityAbort = new AbortController();
      const identityOutcome = await callWithin(
        () => processAdapter.identify(pid, {
          abortSignal: identityAbort.signal,
          timeoutMs: identityBudget,
        }),
        identityBudget,
        timers,
        identityAbort,
      );
      if (identityOutcome.status !== "completed") {
        localFailures.push(cleanupFailure(
          resource,
          identityOutcome.status === "timed-out" ? "timed-out" : "failed",
          identityOutcome.message,
        ));
        return localFailures;
      }
      if (identityOutcome.value === null) {
        resource.childExitConfirmed = true;
        return localFailures;
      }
      if (identityOutcome.value.processStartedAt !== processStartedAt) {
        resource.childExitConfirmed = true;
        localFailures.push(cleanupFailure(
          resource,
          "identity-mismatch",
          `Refused to signal PID ${pid} after process start identity changed`,
        ));
        return localFailures;
      }
      localFailures.push(cleanupFailure(
        resource,
        "failed",
        `Exact signal was refused while PID ${pid} retained the expected identity`,
      ));
      return localFailures;
    }

    while (clock.nowMs() < deadline) {
      const livenessBudget = deadline - clock.nowMs();
      if (livenessBudget <= 0) break;
      const livenessAbort = new AbortController();
      const liveness = await callWithin(
        () => processAdapter.isAlive(pid, processStartedAt, {
          abortSignal: livenessAbort.signal,
          timeoutMs: livenessBudget,
        }),
        livenessBudget,
        timers,
        livenessAbort,
      );
      if (liveness.status !== "completed") {
        localFailures.push(cleanupFailure(
          resource,
          liveness.status === "timed-out" ? "timed-out" : "failed",
          liveness.message,
        ));
        return localFailures;
      }
      if (!liveness.value) {
        resource.childExitConfirmed = true;
        return localFailures;
      }
      const sleepBudget = deadline - clock.nowMs();
      if (sleepBudget <= 0) break;
      await sleepUntil(timers, Math.min(10, sleepBudget));
    }

    localFailures.push(cleanupFailure(
      resource,
      "still-running",
      `Command-owned child PID ${pid} remained alive after ${boundMs}ms`,
    ));
    return localFailures;
  }));

  for (const childFailures of outcomes) failures.push(...childFailures);
  return failures;
}

function mergeCleanupFailures(
  first: ResourceCleanupFailure[],
  second: ResourceCleanupFailure[],
): ResourceCleanupFailure[] {
  const merged = new Map<string, ResourceCleanupFailure>();
  for (const failure of [...first, ...second]) {
    merged.set(`${failure.id}:${failure.outcome}`, failure);
  }
  return [...merged.values()];
}

function cleanupFailure(
  resource: InternalResource,
  outcome: ResourceCleanupFailure["outcome"],
  message: string,
): ResourceCleanupFailure {
  return {
    id: resource.id,
    kind: resource.kind,
    label: resource.label,
    disposition: resource.disposition,
    pid: resource.pid,
    processStartedAt: resource.processStartedAt,
    outcome,
    message,
  };
}

async function settleWithin(
  dispose: (control: ResourceCleanupControl) => void | Promise<void>,
  deadline: number,
  clock: RuntimeClock,
  timers: RuntimeTimers,
): Promise<
  | { status: "disposed" }
  | { status: "failed" | "timed-out"; message: string }
> {
  const boundMs = Math.max(0, deadline - clock.nowMs());
  let active = true;
  const abort = new AbortController();
  const control: ResourceCleanupControl = {
    signal: abort.signal,
    isActive: () => active && clock.nowMs() <= deadline && !abort.signal.aborted,
    tryCommitEffect: () => active && clock.nowMs() <= deadline && !abort.signal.aborted,
  };
  let resolveTimeout: ((value: { status: "timed-out"; message: string }) => void) | null = null;
  const timeout = new Promise<{ status: "timed-out"; message: string }>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeoutHandle = timers.setTimeout(() => {
    active = false;
    abort.abort();
    resolveTimeout?.({
      status: "timed-out",
      message: `Resource cleanup timed out after ${boundMs}ms`,
    });
  }, boundMs);
  const cleanup = Promise.resolve()
    .then(() => dispose(control))
    .then(
      () => clock.nowMs() <= deadline
        ? ({ status: "disposed" as const })
        : ({
            status: "timed-out" as const,
            message: `Resource cleanup timed out after ${boundMs}ms`,
          }),
      (error: unknown) => ({
        status: "failed" as const,
        message: error instanceof Error ? error.message : "Resource cleanup failed",
      }),
    );

  const result = await Promise.race([cleanup, timeout]);
  active = false;
  abort.abort();
  timeoutHandle.clear();
  return result;
}

async function callWithin<T>(
  work: () => Promise<T>,
  boundMs: number,
  timers: RuntimeTimers,
  abort?: AbortController,
): Promise<
  | { status: "completed"; value: T }
  | { status: "failed" | "timed-out"; message: string }
> {
  let resolveTimeout: ((value: { status: "timed-out"; message: string }) => void) | null = null;
  const timeout = new Promise<{ status: "timed-out"; message: string }>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeoutHandle = timers.setTimeout(() => {
    abort?.abort();
    resolveTimeout?.({
      status: "timed-out",
      message: `Cleanup adapter call timed out after ${boundMs}ms`,
    });
  }, boundMs);
  const pending = Promise.resolve()
    .then(work)
    .then(
      (value) => ({ status: "completed" as const, value }),
      (error: unknown) => ({
        status: "failed" as const,
        message: error instanceof Error ? error.message : "Cleanup adapter call failed",
      }),
    );
  const result = await Promise.race([pending, timeout]);
  timeoutHandle.clear();
  return result;
}

function sleepUntil(timers: RuntimeTimers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/** Assert inventory is clean; throws if any resident control-plane residue remains. */
export function assertNoResidentControlPlane(inventory: ResidualInventory): void {
  if (inventory.hasResidentControlPlane) {
    throw new Error(
      `resident_control_plane_forbidden: residual inventory ${JSON.stringify(inventory)}`,
    );
  }
}
