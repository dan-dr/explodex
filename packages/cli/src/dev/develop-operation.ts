import type { TargetIdentity } from "../cdp/types.ts";
import type { DevArtifactRouteAction } from "./injection-routing.ts";
import {
  DevelopProtocolWriter,
  type DevelopError,
  type DevelopPluginIdentity,
  type DevelopSdkRuntimeIdentity,
  type DevelopTerminalReason,
  type DevelopTerminalResult,
} from "./develop-protocol.ts";

export type DevelopPreflightSuccess = {
  workspacePath: string;
  watchedPaths: string[];
  excludedPaths: string[];
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  route: DevArtifactRouteAction;
  target: TargetIdentity;
  pluginIdentity: DevelopPluginIdentity;
  sdkRuntimeIdentity: DevelopSdkRuntimeIdentity;
  distPath: string;
};

export type DevelopPreflightResult =
  | { ok: true; value: DevelopPreflightSuccess }
  | { ok: false; code: string; message: string; details?: unknown };

export type DevelopInitialApplyResult =
  | {
      ok: true;
      pluginIdentity: DevelopPluginIdentity;
      target: TargetIdentity;
    }
  | {
      ok: false;
      code: string;
      message: string;
      blocked: boolean;
      details?: unknown;
    };

export type DevelopOwnedResource = {
  close(signal?: AbortSignal): void | Promise<void>;
};

export type DevelopRuntimeAdapters = {
  nowIso(): string;
  preflight(): Promise<DevelopPreflightResult>;
  openWatcher(options: {
    preflight: DevelopPreflightSuccess;
    onStop: () => void;
  }): Promise<DevelopOwnedResource>;
  openTargetMonitor(options: {
    preflight: DevelopPreflightSuccess;
    onTargetLost: () => void;
  }): Promise<DevelopOwnedResource>;
  applyInitial(options: {
    preflight: DevelopPreflightSuccess;
    signal?: AbortSignal;
  }): Promise<DevelopInitialApplyResult>;
  waitForStop(options: {
    signal?: AbortSignal;
  }): Promise<"completed" | "interrupted">;
  cleanup(options?: {
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; residuals: string[] }>;
  cleanupBoundMs?: number;
  writeLine(line: string): void;
};

export type ForegroundDevelopResult = DevelopTerminalResult;

type StopDisposition =
  | { kind: "completed" }
  | { kind: "interrupted" }
  | { kind: "target-lost" };

function errorFromUnknown(error: unknown): DevelopError {
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown };
    const code = typeof coded.code === "string"
      ? coded.code
      : "develop.runtime-failed";
    return { code, message: error.message };
  }
  return {
    code: "develop.runtime-failed",
    message: "Foreground development failed.",
  };
}

async function closeResource(
  resource: DevelopOwnedResource | null,
  residuals: string[],
  label: string,
  deadline: number,
): Promise<void> {
  if (resource === null) return;
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    residuals.push(label);
    return;
  }
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve(resource.close(abort.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`${label} cleanup timed out.`));
        }, remainingMs);
      }),
    ]);
  } catch {
    residuals.push(label);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function finalEventForFailure(options: {
  protocol: DevelopProtocolWriter;
  generation: number;
  preflight: DevelopPreflightSuccess;
  failure: Extract<DevelopInitialApplyResult, { ok: false }>;
}): void {
  if (options.failure.blocked) {
    options.protocol.event({
      generation: options.generation,
      type: "blocked",
      target: options.preflight.target,
      details: {
        code: options.failure.code,
        ...(options.failure.details === undefined
          ? {}
          : { cause: options.failure.details }),
      },
    });
    return;
  }
  options.protocol.event({
    generation: options.generation,
    type: "apply-failed",
    target: options.preflight.target,
    details: {
      code: options.failure.code,
      ...(options.failure.details === undefined
        ? {}
        : { cause: options.failure.details }),
    },
  });
}

/**
 * Protocol/lifecycle core for one foreground development command.
 *
 * Preflight owns no watcher, target monitor, session, lock, or child. Once
 * resources open, every path closes them before cleanup and terminal output.
 */
export async function runForegroundDevelop(options: {
  operationId: string;
  signal?: AbortSignal;
  adapters: DevelopRuntimeAdapters;
}): Promise<ForegroundDevelopResult> {
  const protocol = new DevelopProtocolWriter({
    operationId: options.operationId,
    writeLine: options.adapters.writeLine,
  });
  let preflight: DevelopPreflightSuccess;
  try {
    const result = await options.adapters.preflight();
    if (!result.ok) {
      return protocol.terminal({
        ok: false,
        reason:
          result.code === "operation.interrupted" || options.signal?.aborted
            ? "interrupted"
            : "preflight-failed",
        error: {
          code: result.code,
          message: result.message,
          ...(result.details === undefined ? {} : { details: result.details }),
        },
      });
    }
    preflight = result.value;
  } catch (error: unknown) {
    const interrupted = options.signal?.aborted;
    return protocol.terminal({
      ok: false,
      reason: interrupted ? "interrupted" : "preflight-failed",
      error: interrupted
        ? {
            code: "operation.interrupted",
            message: "Foreground development was interrupted.",
          }
        : errorFromUnknown(error),
    });
  }

  let watcher: DevelopOwnedResource | null = null;
  let monitor: DevelopOwnedResource | null = null;
  let terminalReason: DevelopTerminalReason = "runtime-failed";
  let terminalError: DevelopError | undefined;
  let targetLost = false;
  const workAbort = new AbortController();
  let stopResolve: ((value: StopDisposition) => void) | null = null;
  const stop = new Promise<StopDisposition>((resolve) => {
    stopResolve = resolve;
  });
  const onAbort = (): void => {
    workAbort.abort();
    stopResolve?.({ kind: "interrupted" });
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    watcher = await options.adapters.openWatcher({
      preflight,
      onStop: () => stopResolve?.({ kind: "completed" }),
    });
    monitor = await options.adapters.openTargetMonitor({
      preflight,
      onTargetLost: () => {
        if (targetLost) return;
        targetLost = true;
        workAbort.abort();
        stopResolve?.({ kind: "target-lost" });
      },
    });
    protocol.event({
      generation: 0,
      type: "watch-ready",
      target: preflight.target,
      sdkRuntimeIdentity: preflight.sdkRuntimeIdentity,
      details: {
        lifecycle: preflight.lifecycle,
        route: preflight.route,
        watchedPathCount: preflight.watchedPaths.length,
        excludedPathCount: preflight.excludedPaths.length,
      },
    });

    const generation = 1;
    protocol.event({ generation, type: "build-started" });
    protocol.event({
      generation,
      type: "build-succeeded",
      pluginIdentity: preflight.pluginIdentity,
      sdkRuntimeIdentity: preflight.sdkRuntimeIdentity,
    });
    protocol.event({
      generation,
      type: "apply-started",
      pluginIdentity: preflight.pluginIdentity,
      sdkRuntimeIdentity: preflight.sdkRuntimeIdentity,
      target: preflight.target,
    });
    const applied = await options.adapters.applyInitial({
      preflight,
      signal: workAbort.signal,
    });
    if (targetLost) {
      protocol.event({
        generation,
        type: "target-lost",
        target: preflight.target,
        details: { code: "cdp.target-lost" },
      });
      terminalReason = "blocked";
      terminalError = {
        code: "cdp.target-lost",
        message: "The exact development target was lost.",
      };
    } else if (!applied.ok) {
      finalEventForFailure({
        protocol,
        generation,
        preflight,
        failure: applied,
      });
      terminalReason =
        applied.code === "operation.interrupted" || options.signal?.aborted
          ? "interrupted"
          : applied.blocked
            ? "blocked"
            : "runtime-failed";
      terminalError = {
        code: applied.code,
        message: applied.message,
        ...(applied.details === undefined ? {} : { details: applied.details }),
      };
    } else if (
      applied.pluginIdentity.id !== preflight.pluginIdentity.id ||
      applied.pluginIdentity.version !== preflight.pluginIdentity.version ||
      applied.pluginIdentity.payloadSha256 !==
        preflight.pluginIdentity.payloadSha256
    ) {
      protocol.event({
        generation,
        type: "apply-failed",
        target: preflight.target,
        details: { code: "operation.state-changed" },
      });
      terminalReason = "runtime-failed";
      terminalError = {
        code: "operation.state-changed",
        message: "Plugin artifact identity changed after foreground preflight.",
      };
    } else {
      protocol.applySucceeded({
        generation,
        pluginIdentity: applied.pluginIdentity,
        sdkRuntimeIdentity: preflight.sdkRuntimeIdentity,
        target: applied.target,
        appliedAt: options.adapters.nowIso(),
      });

      const waitAbort = new AbortController();
      const disposition = await Promise.race([
        stop,
        options.adapters.waitForStop({ signal: waitAbort.signal }).then(
          (reason): StopDisposition => ({ kind: reason }),
        ),
      ]);
      waitAbort.abort();
      if (disposition.kind === "target-lost") {
        protocol.event({
          generation: generation + 1,
          type: "target-lost",
          target: preflight.target,
          details: { code: "cdp.target-lost" },
        });
        terminalReason = "blocked";
        terminalError = {
          code: "cdp.target-lost",
          message: "The exact development target was lost.",
        };
      } else if (
        disposition.kind === "interrupted" ||
        options.signal?.aborted
      ) {
        terminalReason = "interrupted";
        terminalError = {
          code: "operation.interrupted",
          message: "Foreground development was interrupted.",
        };
      } else {
        terminalReason = "completed";
      }
    }
  } catch (error: unknown) {
    terminalReason = options.signal?.aborted ? "interrupted" : "runtime-failed";
    terminalError = options.signal?.aborted
      ? {
          code: "operation.interrupted",
          message: "Foreground development was interrupted.",
        }
      : errorFromUnknown(error);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  const residuals: string[] = [];
  const cleanupBoundMs = options.adapters.cleanupBoundMs ?? 5_000;
  const cleanupDeadline = Date.now() + cleanupBoundMs;
  await Promise.all([
    closeResource(monitor, residuals, "target-monitor", cleanupDeadline),
    closeResource(watcher, residuals, "watcher", cleanupDeadline),
    (async () => {
      const cleanupAbort = new AbortController();
      let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const remainingMs = Math.max(0, cleanupDeadline - Date.now());
        const cleanup = await Promise.race([
          options.adapters.cleanup({ signal: cleanupAbort.signal }),
          new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(() => {
              cleanupAbort.abort();
              reject(new Error("Foreground cleanup timed out."));
            }, remainingMs);
          }),
        ]);
        residuals.push(...cleanup.residuals);
        if (!cleanup.ok && cleanup.residuals.length === 0) {
          residuals.push("unknown-cleanup-residue");
        }
      } catch {
        residuals.push("cleanup-adapter");
      } finally {
        if (cleanupTimer !== null) clearTimeout(cleanupTimer);
      }
    })(),
  ]);
  if (residuals.length > 0) {
    terminalReason = "runtime-failed";
    terminalError = {
      code: "develop.cleanup-failed",
      message: "Foreground development cleanup left command-owned residue.",
      details: { residuals },
    };
  }

  return protocol.terminal({
    ok: terminalReason === "completed",
    reason: terminalReason,
    ...(terminalError === undefined ? {} : { error: terminalError }),
  });
}
