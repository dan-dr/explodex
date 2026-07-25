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
 * Acquire one mutation lease inside the declared stage bound. Residual lease
 * authority is registered immediately on open (before delayed publication/stat),
 * so a late continuation cannot vanish past a finite settlement fence and leave
 * false-clean inventory. The returned handle reuses that residual registration.
 */
export async function acquireStageLock(
  ctx: OperationContext,
  options: StageLockOptions,
): Promise<LockHandle> {
  return ctx.runExternalWait("lock-acquisition", async (ctl) => {
    const boundMs = Math.max(1, Math.floor(ctl.remainingMs()));
    const residualLabel = `${options.label ?? options.resource}-residual`;
    let residualId: string | null = null;
    let openResidual: ResidualLockAuthority | null = null;

    const acquired = await acquireOperationLock({
      adapters: ctx.adapters,
      explodexHome: options.explodexHome,
      resource: options.resource,
      identity: ctx.identity,
      waitBoundMs: boundMs,
      pollIntervalMs: options.pollIntervalMs ?? 50,
      abortSignal: ctl.signal,
      onLeaseOpened(residual) {
        // Register before any delayed publication/stat work so terminal cleanup
        // and inventory always observe post-open authority.
        openResidual = residual;
        residualId = tryRegisterResidual(ctx, {
          label: residualLabel,
          residual,
        });
      },
    });
    if (!acquired.ok) {
      if (acquired.code === "lock_interrupted") throw new InterruptError("lock-acquisition");
      if (acquired.code === "lock_cleanup_failed") {
        // Residual was registered at open when possible; re-attempt if dispose
        // already blocked the first registration, and always keep it on the error.
        if (residualId === null) {
          residualId = tryRegisterResidual(ctx, {
            label: residualLabel,
            residual: acquired.residual,
          });
        }
        throw Object.assign(new Error(acquired.message), {
          code: "lock_cleanup_failed" as const,
          stage: "cleanup" as const,
          boundMs: acquired.boundMs,
          primaryCode: acquired.primaryCode,
          cleanupError: acquired.cleanupError,
          residual: acquired.residual,
        } satisfies Omit<StageLockError, keyof Error>);
      }
      // Abandon closed successfully: residual authority is gone.
      if (residualId !== null) ctx.scope.markDisposed(residualId);
      throw Object.assign(new Error(acquired.message), {
        code: acquired.code,
        stage: acquired.stage,
        boundMs: acquired.boundMs,
      } satisfies Omit<StageLockError, keyof Error>);
    }
    // Stage may have timed out while acquisition was still settling. Never
    // return a handle that the operation can no longer observe.
    if (!ctl.tryCommitEffect()) {
      try {
        await acquired.handle.release({ abortSignal: undefined });
        if (residualId !== null) ctx.scope.markDisposed(residualId);
      } catch (cleanupError: unknown) {
        // Residual was registered at open and remains held after release fault.
        const residual = openResidual ?? {
          path: acquired.handle.path,
          leasePath: acquired.handle.leasePath,
          descriptor: acquired.handle.descriptor,
          handle: acquired.handle,
          state: () => acquired.handle.state(),
          dispose: (disposeOptions?: { abortSignal?: AbortSignal; timeoutMs?: number }) =>
            acquired.handle.release(disposeOptions),
        };
        if (residualId === null) {
          residualId = tryRegisterResidual(ctx, {
            label: residualLabel,
            residual,
          });
        }
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
    // Success: residual registered at open already tracks the upgraded handle.
    // Do not double-register; only ensure registration if open-time register failed.
    if (residualId === null) {
      residualId = tryRegisterResidual(ctx, {
        label: options.label ?? options.resource,
        residual: {
          path: acquired.handle.path,
          leasePath: acquired.handle.leasePath,
          descriptor: acquired.handle.descriptor,
          handle: acquired.handle,
          state: () => acquired.handle.state(),
          dispose: (disposeOptions?: { abortSignal?: AbortSignal; timeoutMs?: number }) =>
            acquired.handle.release(disposeOptions),
        },
      });
      if (residualId === null) {
        // Scope already disposing: still return the handle, but residual must
        // remain reachable through the caller's error/result path if needed.
        throw Object.assign(
          new Error(
            `Lock ${options.resource} could not register residual authority before terminal dispose`,
          ),
          {
            code: "lock_cleanup_failed" as const,
            stage: "cleanup" as const,
            boundMs,
            residual: {
              path: acquired.handle.path,
              leasePath: acquired.handle.leasePath,
              descriptor: acquired.handle.descriptor,
              handle: acquired.handle,
              state: () => acquired.handle.state(),
              dispose: (disposeOptions?: { abortSignal?: AbortSignal; timeoutMs?: number }) =>
                acquired.handle.release(disposeOptions),
            },
          } satisfies Omit<StageLockError, keyof Error>,
        );
      }
    }
    return acquired.handle;
  });
}

function tryRegisterResidual(
  ctx: OperationContext,
  options: { label: string; residual: ResidualLockAuthority },
): string | null {
  try {
    return ctx.scope.register({
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
    return null;
  }
}
