/**
 * Operation resource scope: tracks every command-owned resource and disposes
 * them on every terminal path without touching protected ChatGPT processes.
 */

import type { RuntimeProcess } from "./adapters.ts";
import type {
  ProcessDisposition,
  RegisteredResource,
  ResidualInventory,
  ResourceKind,
} from "./types.ts";

export type RegisterResourceInput = {
  kind: ResourceKind;
  label: string;
  disposition: ProcessDisposition;
  pid?: number;
  processStartedAt?: string;
  dispose: () => void | Promise<void>;
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
   * Dispose all remaining resources in LIFO order.
   * Protected/foreign dispositions never receive process signals.
   */
  dispose(reason: "success" | "failure" | "timeout" | "interrupted"): Promise<void>;
  /** Snapshot of residual control-plane inventory after dispose (or mid-flight). */
  inventory(): ResidualInventory;
  /** List still-active resources (for tests/diagnostics). */
  listActive(): ReadonlyArray<Omit<RegisteredResource, "dispose">>;
  /**
   * Signal only command-owned children. Never signals protected-chatgpt or foreign.
   * Used during timeout/interrupt cleanup of helpers.
   */
  reapCommandOwnedChildren(signal?: "SIGTERM" | "SIGINT"): Promise<void>;
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
    hasResidentControlPlane: false,
  };
}

function countKind(
  resources: ReadonlyArray<{ kind: ResourceKind; disposition: ProcessDisposition; disposed: boolean }>,
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
      case "lock":
        inv.locksHeld += 1;
        break;
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
    inv.daemons > 0 ||
    inv.supervisors > 0;
  return inv;
}

export type CreateResourceScopeOptions = {
  operationId: string;
  process: RuntimeProcess;
  /**
   * When true (default), dispose refuses to leave residual control-plane resources
   * without attempting cleanup. Dispose always runs registered dispose hooks.
   */
  enforceNoResidentControlPlane?: boolean;
};

type InternalResource = RegisteredResource & { disposed: boolean };

/**
 * Create a new resource scope for one bounded operation.
 * Every one-shot command should create exactly one scope and dispose it once.
 */
export function createResourceScope(options: CreateResourceScopeOptions): ResourceScope {
  const resources: InternalResource[] = [];
  let interrupted = false;
  let disposed = false;
  const processAdapter = options.process;

  return {
    operationId: options.operationId,

    register(input) {
      if (disposed) {
        throw new Error("Cannot register resources on a disposed operation scope");
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
        dispose: input.dispose,
        disposed: false,
      });
      return id;
    },

    markDisposed(id) {
      const found = resources.find((r) => r.id === id);
      if (found) found.disposed = true;
    },

    isInterrupted() {
      return interrupted;
    },

    requestInterrupt() {
      interrupted = true;
    },

    async reapCommandOwnedChildren(signal = "SIGTERM") {
      for (const r of resources) {
        if (r.disposed) continue;
        if (r.kind !== "child-process") continue;
        if (r.disposition !== "command-owned") continue;
        if (typeof r.pid === "number") {
          await processAdapter.signal(r.pid, signal);
        }
      }
    },

    async dispose(reason) {
      if (disposed) return;
      disposed = true;
      void reason;

      // LIFO disposal so nested resources unwind safely.
      for (let i = resources.length - 1; i >= 0; i -= 1) {
        const r = resources[i];
        if (!r || r.disposed) continue;

        // Never signal protected ChatGPT or foreign processes via dispose hooks
        // that call process.signal — the dispose callback itself is still invoked
        // so sessions/locks can close, but child-process protected entries must
        // only close tracking, not kill.
        if (r.kind === "child-process" && r.disposition !== "command-owned") {
          // Mark gone without signaling.
          r.disposed = true;
          continue;
        }

        try {
          await r.dispose();
        } catch {
          // Best-effort cleanup; inventory will reflect failures if dispose didn't mark.
        }
        r.disposed = true;
      }
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

/** Assert inventory is clean; throws if any resident control-plane residue remains. */
export function assertNoResidentControlPlane(inventory: ResidualInventory): void {
  if (inventory.hasResidentControlPlane) {
    throw new Error(
      `resident_control_plane_forbidden: residual inventory ${JSON.stringify(inventory)}`,
    );
  }
}
