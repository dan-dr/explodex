/**
 * Routes mutation-lock acquisition through the bounded `lock-acquisition` stage
 * and registers the parent-held lease as a command-owned scope resource.
 */

import { acquireOperationLock, type LockHandle } from "./locks.ts";
import { InterruptError, TimeoutError, type OperationContext } from "./operation.ts";
import type { LockResource } from "./types.ts";

export type StageLockOptions = {
  explodexHome: string;
  resource: LockResource;
  pollIntervalMs?: number;
  label?: string;
};

export type StageLockError = Error & {
  code: "lock_busy" | "lock_stale_unrecoverable" | "lock_invariant_violation" |
    "invalid_stage_bound";
  stage: "lock-acquisition";
  boundMs: number;
};

/**
 * Acquire one mutation lease inside the declared stage bound. The returned
 * handle is already registered for unconditional descriptor close on cleanup.
 * Owner publication and registration are fenced to the stage abort/deadline so
 * a timed-out continuation cannot leak an unregistered advisory lease.
 */
export async function acquireStageLock(
  ctx: OperationContext,
  options: StageLockOptions,
): Promise<LockHandle> {
  return ctx.runExternalWait("lock-acquisition", async (ctl) => {
    const boundMs = Math.max(1, Math.floor(ctl.remainingMs()));
    const acquired = await acquireOperationLock({
      adapters: ctx.adapters,
      explodexHome: options.explodexHome,
      resource: options.resource,
      identity: ctx.identity,
      waitBoundMs: boundMs,
      pollIntervalMs: options.pollIntervalMs ?? 50,
      abortSignal: ctl.signal,
    });
    if (!acquired.ok) {
      if (acquired.code === "lock_interrupted") throw new InterruptError("lock-acquisition");
      throw Object.assign(new Error(acquired.message), {
        code: acquired.code,
        stage: acquired.stage,
        boundMs: acquired.boundMs,
      } satisfies Omit<StageLockError, keyof Error>);
    }
    // Stage may have timed out while acquisition was still settling. Never
    // register or return a handle that the operation can no longer observe.
    if (!ctl.tryCommitEffect()) {
      try {
        await acquired.handle.release({ abortSignal: undefined });
      } catch {
        // Best-effort residual cleanup; the stage timeout/interrupt is primary.
      }
      ctl.throwIfInterrupted();
      throw new TimeoutError("lock-acquisition", boundMs);
    }
    ctx.scope.register({
      kind: "lock",
      label: options.label ?? options.resource,
      disposition: "command-owned",
      lockState: () => {
        const state = acquired.handle.state();
        return { descriptorOpen: state.descriptorOpen, leaseHeld: state.leaseHeld };
      },
      dispose: (control) => acquired.handle.release({ abortSignal: control.signal }),
    });
    return acquired.handle;
  });
}
