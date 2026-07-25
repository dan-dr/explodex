/**
 * Injectable adapters for the bounded-operation runtime.
 * Production uses Node timers/signals/process; tests supply controlled fixtures.
 */

import type { LockFileSystem } from "./lock-adapter.ts";
export type {
  AdvisoryLease,
  DirectoryPublishResult,
  LeaseIdentity,
  LeaseOpenResult,
  LockFileSystem,
  LockPathKind,
  LockPathStat,
} from "./lock-adapter.ts";

export type RuntimeClock = {
  /** Monotonic-ish milliseconds for deadline math (Date.now is acceptable). */
  nowMs(): number;
  nowIso(): string;
};

export type RuntimeTimerHandle = {
  clear(): void;
};

export type RuntimeTimers = {
  /**
   * Schedule a one-shot callback after `ms` milliseconds.
   * Tests may advance a fake clock and flush pending timers.
   */
  setTimeout(callback: () => void, ms: number): RuntimeTimerHandle;
};

export type SignalName = "SIGINT" | "SIGTERM";

export type RuntimeSignals = {
  /**
   * Register a listener for cooperative interruption.
   * Returns an unsubscribe function.
   */
  on(signal: SignalName, listener: () => void): () => void;
};

export type ProcessIdentity = {
  pid: number;
  processStartedAt: string;
};

export type RuntimeProcess = {
  /** Current CLI process identity (for lock ownership). */
  self(): ProcessIdentity;
  /** Exact current identity for the PID, or null when it is independently proven absent. */
  identify(
    pid: number,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProcessIdentity | null>;
  /** True only when both PID and kernel-derived start identity still match. */
  isAlive(
    pid: number,
    processStartedAt: string,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<boolean>;
  /**
   * Send a signal only if the PID still has the exact expected start identity.
   * Production may fail closed when the platform cannot make verification and
   * signaling one atomic identity-bound operation.
   */
  signalExact(
    identity: ProcessIdentity,
    signal: "SIGTERM" | "SIGINT",
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<boolean>;
};

export type RuntimeAdapters = {
  clock: RuntimeClock;
  timers: RuntimeTimers;
  signals: RuntimeSignals;
  process: RuntimeProcess;
  fs: LockFileSystem;
};

export function createSystemRuntimeClock(): RuntimeClock {
  return {
    nowMs() {
      return Date.now();
    },
    nowIso() {
      return new Date().toISOString();
    },
  };
}

export function createNodeRuntimeTimers(): RuntimeTimers {
  return {
    setTimeout(callback, ms) {
      const handle = globalThis.setTimeout(callback, ms);
      return {
        clear() {
          globalThis.clearTimeout(handle);
        },
      };
    },
  };
}

export function createNodeRuntimeSignals(): RuntimeSignals {
  return {
    on(signal, listener) {
      const handler = (): void => {
        listener();
      };
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
  };
}

const RUNTIME_HELPER_PATH = new URL("./bin/explodex-runtime-helper", import.meta.url);

type HelperResult = { stdout: string; stderr: string };

type HelperError = Error & { code?: number | string | null };

async function runDarwinHelper(
  args: string[],
  options: { timeoutMs: number; abortSignal?: AbortSignal },
): Promise<HelperResult> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  return new Promise((resolve, reject) => {
    const child = spawn(fileURLToPath(RUNTIME_HELPER_PATH), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        EXPLODEX_RUNTIME_HELPER_TIMEOUT_MS: String(options.timeoutMs),
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: HelperError | null = null;

    const cleanupListeners = (): void => {
      options.abortSignal?.removeEventListener("abort", onAbort);
    };

    const finishAfterTermination = (error: HelperError): void => {
      if (settled || terminationError !== null) return;
      terminationError = error;
      child.kill("SIGTERM");
    };

    const onAbort = (): void => {
      finishAfterTermination(Object.assign(new Error("Darwin helper was aborted"), {
        code: "ABORT_ERR",
      }));
    };

    // The helper carries an independent watchdog for kernel stalls. Give it a
    // short grace period to self-exit after the advertised operation deadline.
    const timeoutHandle = globalThis.setTimeout(() => {
      finishAfterTermination(Object.assign(
        new Error(`Darwin helper timed out after ${options.timeoutMs}ms`),
        { code: "ETIMEDOUT" },
      ));
    }, options.timeoutMs + 50);
    if (options.abortSignal?.aborted) onAbort();
    else options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutHandle);
      cleanupListeners();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutHandle);
      cleanupListeners();
      if (terminationError !== null) {
        reject(terminationError);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (code === 124) {
        reject(Object.assign(
          new Error(`Darwin helper timed out after ${options.timeoutMs}ms`),
          { code: "ETIMEDOUT" } satisfies Partial<HelperError>,
        ));
        return;
      }
      const message = stderr.trim() || `Darwin helper exited with status ${code}`;
      reject(Object.assign(new Error(message), { code } satisfies Partial<HelperError>));
    });
  });
}

function helperStatus(error: unknown): number | string | null | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as HelperError).code;
  return typeof code === "number" || typeof code === "string" || code === null
    ? code
    : undefined;
}

export async function createNodeRuntimeProcess(): Promise<RuntimeProcess> {
  const identify = async (
    pid: number,
    identifyOptions?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProcessIdentity | null> => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const result = await runDarwinHelper(["identify", String(pid)], {
        timeoutMs: identifyOptions?.timeoutMs ?? 1_000,
        abortSignal: identifyOptions?.abortSignal,
      });
      const processStartedAt = result.stdout.trim();
      if (processStartedAt === "") {
        throw new Error("Darwin process helper returned an empty start identity");
      }
      return { pid, processStartedAt };
    } catch (error: unknown) {
      if (helperStatus(error) === 3) return null;
      throw error;
    }
  };

  const selfIdentity = await identify(process.pid);
  if (selfIdentity === null) {
    throw new Error("Unable to determine current process start identity");
  }

  return {
    self() {
      return { ...selfIdentity };
    },
    identify,
    async isAlive(pid, processStartedAt, aliveOptions) {
      const current = await identify(pid, aliveOptions);
      return current?.processStartedAt === processStartedAt;
    },
    async signalExact(identity, signal, signalOptions) {
      try {
        await runDarwinHelper(
          ["signal", String(identity.pid), identity.processStartedAt, signal],
          {
            timeoutMs: signalOptions?.timeoutMs ?? 1_000,
            abortSignal: signalOptions?.abortSignal,
          },
        );
        return true;
      } catch (error: unknown) {
        if (helperStatus(error) === 3) return false;
        throw error;
      }
    },
  };
}

export async function createDefaultRuntimeAdapters(): Promise<RuntimeAdapters> {
  const [{ createNodeLockFileSystem }, processAdapter] = await Promise.all([
    import("./lock-adapter.ts"),
    createNodeRuntimeProcess(),
  ]);
  const fs = await createNodeLockFileSystem();
  return {
    clock: createSystemRuntimeClock(),
    timers: createNodeRuntimeTimers(),
    signals: createNodeRuntimeSignals(),
    process: processAdapter,
    fs,
  };
}
