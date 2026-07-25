/**
 * Routes mutation-lock acquisition through the bounded `lock-acquisition` stage
 * and registers the parent-held lease as a command-owned scope resource.
 */

import {
  acquireOperationLock,
  type LockHandle,
  type ResidualLockAuthority,
} from "./locks.ts";
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
    "invalid_stage_bound" | "lock_cleanup_failed";
  stage: "lock-acquisition" | "cleanup";
  boundMs: number;
  primaryCode?: "lock_interrupted" | "lock_busy" | "lock_stale_unrecoverable" |
    "lock_invariant_violation" | "invalid_stage_bound" | "lock_cleanup_failed";
  cleanupError?: unknown;
  residual?: ResidualLockAuthority;
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
      if (acquired.code === "lock_cleanup_failed") {
        // Residual authority must remain reachable for bounded disposal/retry.
        // Registration may race terminal dispose; never lose residual on the error.
        tryRegisterResidual(ctx, {
          label: `${options.label ?? options.resource}-residual`,
          residual: acquired.residual,
        });
        throw Object.assign(new Error(acquired.message), {
          code: "lock_cleanup_failed" as const,
          stage: "cleanup" as const,
          boundMs: acquired.boundMs,
          primaryCode: acquired.primaryCode,
          cleanupError: acquired.cleanupError,
          residual: acquired.residual,
        } satisfies Omit<StageLockError, keyof Error>);
      }
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
      } catch (cleanupError: unknown) {
        // Never swallow stage-fence cleanup faults. Capture residual authority
        // so dispose/retry can reach the still-held advisory lease.
        const residual: ResidualLockAuthority = {
          path: acquired.handle.path,
          leasePath: acquired.handle.leasePath,
          descriptor: acquired.handle.descriptor,
          handle: acquired.handle,
          state: () => acquired.handle.state(),
          dispose: (disposeOptions?: { abortSignal?: AbortSignal; timeoutMs?: number }) =>
            acquired.handle.release(disposeOptions),
        };
        tryRegisterResidual(ctx, {
          label: `${options.label ?? options.resource}-residual`,
          residual,
        });
        const cleanupMessage = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        throw Object.assign(
          new Error(
            `Lock ${options.resource} stage-fence cleanup failed after abort/deadline: ${cleanupMessage}`,
          ),
          {
            code: "lock_cleanup_failed" as const,
            stage: "cleanup" as const,
            boundMs,
            primaryCode: "lock_cleanup_failed" as const,
            cleanupError,
            residual,
          } satisfies Omit<StageLockError, keyof Error>,
        );
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

function tryRegisterResidual(
  ctx: OperationContext,
  options: { label: string; residual: ResidualLockAuthority },
): void {
  try {
    ctx.scope.register({
      kind: "lock",
      label: options.label,
      disposition: "command-owned",
      lockState: () => {
        const state = options.residual.state();
        return { descriptorOpen: state.descriptorOpen, leaseHeld: state.leaseHeld };
      },
      dispose: (control) =>
        options.residual.dispose({ abortSignal: control.signal }),
    });
  } catch {
    // Terminal dispose may already have started. Residual remains on the thrown
    // error for bounded dispose/retry and inventory truthfulness.
  }
}
