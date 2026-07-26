/**
 * Pre-registers CDP session-opening authority in ResourceScope before an
 * asynchronous adapter open can outlive the stage settlement fence.
 *
 * A delayed session is adopted by the existing guard and receives a bounded
 * close even after timeout/SIGINT disposal begins. Close rejection or
 * never-CLOSED keeps truthful pending/open inventory plus a reachable
 * idempotent dispose handle; no terminal result is false-clean while detached
 * work can still publish a session.
 */

import type { ResourceScope } from "../runtime/resource-scope.ts";
import type { CdpTargetSession } from "./adapters.ts";
import { REGISTRATION_SESSION_CLOSE_BOUND_MS } from "./adapters.ts";

export type SessionLike = Pick<CdpTargetSession, "targetId" | "isOpen" | "close">;

export type ResidualSessionHandle = {
  targetId: string;
  isOpen(): boolean;
  dispose(options?: { timeoutMs?: number }): Promise<void>;
};

export type SessionOpeningGuard = {
  readonly resourceId: string;
  /** True while open may still publish a session or residual is open. */
  holdsAuthority(): boolean;
  hasAdoptedSession(): boolean;
  /** Adopt a session created by the adapter (exactly once per guard). */
  adopt(session: SessionLike): void;
  /** Adopt residual authority created by adapter registration-cleanup failure. */
  adoptResidual(residual: ResidualSessionHandle & { session?: SessionLike }): void;
  /**
   * Clear authority only when open settled without creating a session.
   * Never call this while a delayed open may still publish a session.
   */
  releaseWithoutSession(): void;
  /** Secret-free residual diagnostics snapshot. */
  diagnostics(): { targetId: string; isOpen: boolean; boundMs: number } | null;
  /** Reachable in-process dispose/retry handle while authority remains. */
  residualHandle(): ResidualSessionHandle | null;
};

type GuardState = "opening" | "open" | "residual" | "closed" | "abandoned";

/**
 * Register session-opening authority before adapter open begins.
 * Counts as one session in inventory while pending or open.
 */
export function registerSessionOpeningGuard(
  scope: ResourceScope,
  options: {
    label: string;
    closeBoundMs?: number;
  },
): SessionOpeningGuard {
  const closeBoundMs = options.closeBoundMs ?? REGISTRATION_SESSION_CLOSE_BOUND_MS;
  let state: GuardState = "opening";
  let session: SessionLike | null = null;
  let disposalRequested = false;
  let closePromise: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    const resolver = wake;
    wake = null;
    resolver?.();
  };

  const waitForStateChange = (signal: AbortSignal): Promise<void> => {
    if (state !== "opening") return Promise.resolve();
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const previous = wake;
      wake = () => {
        previous?.();
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        wake = previous;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const isTerminalState = (): boolean => state === "closed" || state === "abandoned";

  const closeOnce = async (timeoutMs: number): Promise<void> => {
    if (session === null) {
      if (state === "opening") {
        throw new Error("CDP session opening still pending; no session to close");
      }
      return;
    }
    if (isTerminalState()) return;
    if (closePromise !== null) {
      await closePromise;
      return;
    }
    const target = session;
    closePromise = (async () => {
      try {
        // A resolved close() is success even if a fixture keeps isOpen() sticky.
        // Residual is only preserved when close rejects/times out while open.
        await target.close({ timeoutMs });
        state = "closed";
        session = null;
      } catch (error: unknown) {
        if (target.isOpen()) {
          state = "residual";
        } else {
          state = "closed";
          session = null;
        }
        // Allow a later dispose/retry to attempt close again.
        closePromise = null;
        throw error;
      }
    })();
    await closePromise;
  };

  const resourceId = scope.register({
    kind: "session",
    label: options.label,
    disposition: "command-owned",
    dispose: async (control) => {
      disposalRequested = true;
      if (isTerminalState()) return;

      // While opening, wait for adopt/release until the cleanup control expires.
      // Never mark clean while detached work can still publish a session.
      while (state === "opening" && control.isActive()) {
        await waitForStateChange(control.signal);
      }

      if (state === "opening") {
        // Cleanup bound elapsed; keep pending authority in inventory for late adopt.
        throw new Error(
          "CDP session-opening guard still pending after cleanup bound; residual authority retained",
        );
      }

      if (isTerminalState()) return;

      if (state === "open" || state === "residual") {
        await closeOnce(closeBoundMs);
      }
    },
  });

  const handle: ResidualSessionHandle = {
    get targetId() {
      return session?.targetId ?? "pending";
    },
    isOpen() {
      if (state === "opening") return true;
      if (isTerminalState()) return false;
      return session?.isOpen() ?? false;
    },
    async dispose(disposeOptions) {
      const timeoutMs = disposeOptions?.timeoutMs ?? closeBoundMs;
      if (isTerminalState()) return;
      if (state === "opening") {
        // Wait briefly for a late adopt, then close if present.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        try {
          while (state === "opening" && !abort.signal.aborted) {
            await waitForStateChange(abort.signal);
          }
        } finally {
          clearTimeout(timer);
        }
        if (state === "opening") {
          throw new Error(
            "CDP session-opening guard still pending; delayed open has not published a session",
          );
        }
      }
      if (isTerminalState()) return;
      await closeOnce(timeoutMs);
    },
  };

  return {
    resourceId,

    holdsAuthority() {
      return state === "opening" || state === "open" || state === "residual";
    },

    hasAdoptedSession() {
      return session !== null;
    },

    adopt(next) {
      if (state === "abandoned") {
        // Should not abandon while open may still publish; still close the late session.
        void next.close({ timeoutMs: closeBoundMs }).catch(() => undefined);
        return;
      }
      if (session !== null) {
        if (session === next || session.targetId === next.targetId) {
          // Idempotent re-adopt of the same session.
          if (disposalRequested && next.isOpen()) {
            void closeOnce(closeBoundMs).catch(() => undefined);
          }
          return;
        }
        // Unexpected second session: close the duplicate without replacing authority.
        void next.close({ timeoutMs: closeBoundMs }).catch(() => undefined);
        return;
      }
      session = next;
      state = next.isOpen() ? "open" : "closed";
      notify();
      // After timeout/SIGINT disposal begins, adopt immediately bounds close.
      if (disposalRequested && state === "open") {
        void closeOnce(closeBoundMs).catch(() => undefined);
      }
    },

    adoptResidual(residual) {
      const residualSession = residual.session ?? {
        targetId: residual.targetId,
        isOpen: () => residual.isOpen(),
        close: (options?: { timeoutMs?: number }) => residual.dispose(options),
      };
      this.adopt(residualSession);
      if (session !== null && session.isOpen()) {
        state = "residual";
      }
    },

    releaseWithoutSession() {
      if (session !== null) return;
      state = "abandoned";
      notify();
      scope.markDisposed(resourceId);
    },

    diagnostics() {
      if (!this.holdsAuthority()) return null;
      return {
        targetId: session?.targetId ?? "pending",
        isOpen: handle.isOpen(),
        boundMs: closeBoundMs,
      };
    },

    residualHandle() {
      if (!this.holdsAuthority()) return null;
      return handle;
    },
  };
}
