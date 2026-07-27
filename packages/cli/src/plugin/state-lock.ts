import { randomUUID } from "node:crypto";
import {
  createDefaultRuntimeAdapters,
  type RuntimeAdapters,
} from "../runtime/adapters.ts";
import {
  acquireOperationLock,
  type LockAcquireResult,
  type LockHandle,
  type ResidualLockAuthority,
} from "../runtime/locks.ts";
import type { OperationIdentity } from "../runtime/types.ts";

export const DEFAULT_PLUGIN_STATE_LOCK_WAIT_MS = 2_000;

export type PluginStateLockFailure<T = never> = {
  ok: false;
  code:
    | "plugin.state.busy"
    | "operation.interrupted"
    | "plugin.state.lock-failed";
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

export type PluginStateLockResult<T> =
  | {
      ok: true;
      value: T;
      operationId: string;
      recoveredStale: boolean;
    }
  | PluginStateLockFailure<T>;

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
): Promise<PluginStateLockFailure> {
  if (result.code === "lock_cleanup_failed") {
    try {
      await result.residual.dispose({ timeoutMs: 5_000 });
    } catch {
      return {
        ok: false,
        code: "plugin.state.lock-failed",
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
  const code = effectiveCode === "lock_busy"
    ? "plugin.state.busy"
    : effectiveCode === "lock_interrupted"
      ? "operation.interrupted"
      : "plugin.state.lock-failed";
  return {
    ok: false,
    code,
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

function lockFailureFromThrown<T>(
  error: unknown,
  residual?: ResidualLockAuthority,
  completedValue?: T,
): PluginStateLockFailure<T> {
  const message = error instanceof Error
    ? error.message
    : "Plugin state lock operation failed.";
  const structured = typeof error === "object" && error !== null
    ? error as { code?: unknown; stage?: unknown; boundMs?: unknown }
    : {};
  return {
    ok: false,
    code: structured.code === "lock_release_interrupted"
      ? "operation.interrupted"
      : "plugin.state.lock-failed",
    message,
    details: {
      lockCode: typeof structured.code === "string"
        ? structured.code
        : "lock_work_or_release_failed",
      stage: "cleanup",
      ...(typeof structured.boundMs === "number" &&
        Number.isFinite(structured.boundMs)
        ? { boundMs: structured.boundMs }
        : {}),
    },
    ...(residual === undefined ? {} : { residual }),
    ...(completedValue === undefined ? {} : { completedValue }),
  };
}

export async function withPluginStateLock<T>(options: {
  explodexHome: string;
  operation: string;
  work: () => Promise<T> | T;
  waitBoundMs?: number;
  signal?: AbortSignal;
  runtimeAdapters?: RuntimeAdapters;
  operationId?: string;
}): Promise<PluginStateLockResult<T>> {
  const adapters = options.runtimeAdapters ?? await createDefaultRuntimeAdapters();
  const self = adapters.process.self();
  const operationId = options.operationId ?? `plugin-state-${randomUUID()}`;
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
      explodexHome: options.explodexHome,
      resource: "plugins-state",
      identity,
      waitBoundMs: options.waitBoundMs ?? DEFAULT_PLUGIN_STATE_LOCK_WAIT_MS,
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
      const residual = residualFromHandle(acquired.handle);
      const combined = workError === null
        ? releaseError
        : new Error(
            `${workError instanceof Error ? workError.message : String(workError)}; ` +
            `plugin state lock release failed: ${
              releaseError instanceof Error ? releaseError.message : String(releaseError)
            }`,
          );
      return lockFailureFromThrown(
        combined,
        residual,
        workError === null ? value : undefined,
      );
    }
    if (workError !== null) throw workError;
    return {
      ok: true,
      value,
      operationId,
      recoveredStale: acquired.recoveredStale,
    };
  } catch (error: unknown) {
    return lockFailureFromThrown(error);
  }
}
