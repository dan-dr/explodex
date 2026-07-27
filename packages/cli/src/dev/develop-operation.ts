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
  pluginIdentity: DevelopPluginIdentity | null;
  sdkRuntimeIdentity: DevelopSdkRuntimeIdentity;
  distPath: string;
  usesLocalSdk?: boolean;
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

export type DevelopBuildResult =
  | {
      ok: true;
      pluginIdentity: DevelopPluginIdentity;
      sdkRuntimeIdentity?: DevelopSdkRuntimeIdentity;
    }
  | {
      ok: false;
      code: string;
      message: string;
      priorDistFingerprint: string | null;
      distFingerprintAfter: string | null;
      failureKind?: "plugin" | "sdk";
      sdkContamination?: boolean;
      details?: unknown;
    };

export type DevelopApplyFailure = {
  ok: false;
  code: string;
  message: string;
  blocked: boolean;
  details?: unknown;
  liveDisposition?:
    | "previous-preserved"
    | "requested-live"
    | "plugin-absent"
    | "unknown";
  liveIdentity?: DevelopPluginIdentity | null;
  stage?: "authorization" | "evaluation" | "setup" | "cleanup" | "none";
  possiblePartialEffects?: boolean;
  sdkContamination?: boolean;
};

export type DevelopApplyResult =
  | Extract<DevelopInitialApplyResult, { ok: true }>
  | DevelopApplyFailure;

export type DevelopOwnedResource = {
  close(signal?: AbortSignal): void | Promise<void>;
};

export type DevelopRuntimeAdapters = {
  nowIso(): string;
  debounceMs?: number;
  preflight(): Promise<DevelopPreflightResult>;
  openWatcher(options: {
    preflight: DevelopPreflightSuccess;
    onChange: () => void;
    onStop: () => void;
  }): Promise<DevelopOwnedResource>;
  openTargetMonitor(options: {
    preflight: DevelopPreflightSuccess;
    onTargetLost: () => void;
  }): Promise<DevelopOwnedResource>;
  buildGeneration(options: {
    generation: number;
    preflight: DevelopPreflightSuccess;
    signal?: AbortSignal;
  }): Promise<DevelopBuildResult>;
  applyGeneration(options: {
    generation: number;
    preflight: DevelopPreflightSuccess;
    pluginIdentity: DevelopPluginIdentity;
    sdkRuntimeIdentity: DevelopSdkRuntimeIdentity;
    previousLastGood: DevelopProtocolWriter["lastGood"];
    signal?: AbortSignal;
  }): Promise<DevelopApplyResult>;
  recoverSdkContamination?(options: {
    generation: number;
    preflight: DevelopPreflightSuccess;
    failure: DevelopApplyFailure;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; target: TargetIdentity }
    | {
        ok: false;
        code: string;
        message: string;
        details?: unknown;
      }
  >;
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
  | { kind: "target-lost" }
  | { kind: "blocked"; error: DevelopError }
  | { kind: "runtime-failed"; error: DevelopError };

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
  failure: DevelopApplyFailure;
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
      ...(options.failure.liveDisposition === undefined
        ? {}
        : { liveDisposition: options.failure.liveDisposition }),
      ...(options.failure.liveIdentity === undefined
        ? {}
        : { liveIdentity: options.failure.liveIdentity }),
      ...(options.failure.stage === undefined
        ? {}
        : { stage: options.failure.stage }),
      ...(options.failure.possiblePartialEffects === undefined
        ? {}
        : { possiblePartialEffects: options.failure.possiblePartialEffects }),
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
  let closing = false;
  const workAbort = new AbortController();
  const generationControllers = new Map<number, AbortController>();
  const generationTasks = new Set<Promise<void>>();
  let newestGeneration = 1;
  let nextGeneration = 2;
  let queuedGeneration: number | null = null;
  let generationWake: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let sdkRecoveryAttempted = false;
  let sdkRecoveryInProgress = false;
  let stopResolve: ((value: StopDisposition) => void) | null = null;
  const stop = new Promise<StopDisposition>((resolve) => {
    stopResolve = resolve;
  });
  const onAbort = (): void => {
    workAbort.abort();
    for (const controller of generationControllers.values()) {
      controller.abort();
    }
    stopResolve?.({ kind: "interrupted" });
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const generationIsCurrent = (
    generation: number,
    controller: AbortController,
  ): boolean =>
    !closing &&
    !targetLost &&
    generation === newestGeneration &&
    !controller.signal.aborted &&
    !workAbort.signal.aborted;

  const emitBuildFailure = (
    generation: number,
    failure: Extract<DevelopBuildResult, { ok: false }>,
  ): boolean => {
    const priorDistPreserved =
      failure.priorDistFingerprint === failure.distFingerprintAfter;
    protocol.event({
      generation,
      type: "build-failed",
      details: {
        code: failure.code,
        failureKind: failure.failureKind ?? "plugin",
        priorDistPreserved,
        priorDistFingerprint: failure.priorDistFingerprint,
        distFingerprintAfter: failure.distFingerprintAfter,
        ...(failure.details === undefined ? {} : { cause: failure.details }),
      },
    });
    if (!priorDistPreserved) {
      closing = true;
      workAbort.abort();
      stopResolve?.({
        kind: "runtime-failed",
        error: {
          code: "develop.prior-dist-changed",
          message:
            "A failed plugin build changed the prior committed dist output.",
        },
      });
    }
    return priorDistPreserved;
  };

  const runGeneration = async (input: {
    generation: number;
    pluginIdentity?: DevelopPluginIdentity;
    initial: boolean;
  }): Promise<void> => {
    const controller = new AbortController();
    generationControllers.set(input.generation, controller);
    if (workAbort.signal.aborted) controller.abort();
    const onWorkAbort = (): void => controller.abort();
    workAbort.signal.addEventListener("abort", onWorkAbort, { once: true });
    try {
      protocol.event({
        generation: input.generation,
        type: "build-started",
      });
      let pluginIdentity = input.pluginIdentity;
      let sdkRuntimeIdentity = preflight.sdkRuntimeIdentity;
      if (pluginIdentity === undefined) {
        const built = await options.adapters.buildGeneration({
          generation: input.generation,
          preflight,
          signal: controller.signal,
        });
        if (!generationIsCurrent(input.generation, controller)) return;
        if (!built.ok) {
          emitBuildFailure(input.generation, built);
          if (
            built.sdkContamination === true &&
            preflight.usesLocalSdk === true
          ) {
            if (sdkRecoveryAttempted) {
              protocol.event({
                generation: input.generation,
                type: "blocked",
                target: preflight.target,
                details: {
                  code: "develop.sdk-recovery-exhausted",
                  recoveryAttempted: true,
                },
              });
              closing = true;
              workAbort.abort();
              stopResolve?.({
                kind: "blocked",
                error: {
                  code: "develop.sdk-recovery-exhausted",
                  message:
                    "The one permitted SDK contamination restart was already used.",
                },
              });
              return;
            }
            sdkRecoveryAttempted = true;
            sdkRecoveryInProgress = true;
            const recovery = options.adapters.recoverSdkContamination ===
                undefined
              ? {
                  ok: false as const,
                  code: "develop.sdk-recovery-unavailable",
                  message:
                    "SDK contamination recovery is unavailable for this develop operation.",
                }
              : await options.adapters.recoverSdkContamination({
                  generation: input.generation,
                  preflight,
                  failure: {
                    ok: false,
                    code: built.code,
                    message: built.message,
                    blocked: false,
                    sdkContamination: true,
                    stage: "evaluation",
                    possiblePartialEffects: true,
                    details: built.details,
                  },
                  signal: controller.signal,
                });
            sdkRecoveryInProgress = false;
            if (!generationIsCurrent(input.generation, controller)) return;
            if (!recovery.ok) {
              protocol.event({
                generation: input.generation,
                type: "blocked",
                target: preflight.target,
                details: {
                  code: recovery.code,
                  recoveryAttempted: true,
                  ...(recovery.details === undefined
                    ? {}
                    : { cause: recovery.details }),
                },
              });
              closing = true;
              workAbort.abort();
              stopResolve?.({
                kind: "blocked",
                error: {
                  code: recovery.code,
                  message: recovery.message,
                  ...(recovery.details === undefined
                    ? {}
                    : { details: recovery.details }),
                },
              });
              return;
            }
            preflight.target = recovery.target;
          }
          return;
        }
        pluginIdentity = built.pluginIdentity;
        sdkRuntimeIdentity =
          built.sdkRuntimeIdentity ?? preflight.sdkRuntimeIdentity;
      }
      if (!generationIsCurrent(input.generation, controller)) return;
      protocol.event({
        generation: input.generation,
        type: "build-succeeded",
        pluginIdentity,
        sdkRuntimeIdentity,
      });
      protocol.event({
        generation: input.generation,
        type: "apply-started",
        pluginIdentity,
        sdkRuntimeIdentity,
        target: preflight.target,
      });
      const applied = await options.adapters.applyGeneration({
        generation: input.generation,
        preflight,
        pluginIdentity,
        sdkRuntimeIdentity,
        previousLastGood: protocol.lastGood,
        signal: controller.signal,
      });
      if (!generationIsCurrent(input.generation, controller)) return;
      if (!applied.ok) {
        finalEventForFailure({
          protocol,
          generation: input.generation,
          preflight,
          failure: applied,
        });
        if (
          applied.sdkContamination === true &&
          preflight.usesLocalSdk === true
        ) {
          if (sdkRecoveryAttempted) {
            protocol.event({
              generation: input.generation,
              type: "blocked",
              target: preflight.target,
              details: {
                code: "develop.sdk-recovery-exhausted",
                recoveryAttempted: true,
              },
            });
            closing = true;
            workAbort.abort();
            stopResolve?.({
              kind: "blocked",
              error: {
                code: "develop.sdk-recovery-exhausted",
                message:
                  "The one permitted SDK contamination restart was already used.",
              },
            });
            return;
          }
          sdkRecoveryAttempted = true;
          sdkRecoveryInProgress = true;
          const recovery = options.adapters.recoverSdkContamination === undefined
            ? {
                ok: false as const,
                code: "develop.sdk-recovery-unavailable",
                message:
                  "SDK contamination recovery is unavailable for this develop operation.",
              }
            : await options.adapters.recoverSdkContamination({
                generation: input.generation,
                preflight,
                failure: applied,
                signal: controller.signal,
              });
          sdkRecoveryInProgress = false;
          if (!generationIsCurrent(input.generation, controller)) return;
          if (!recovery.ok) {
            protocol.event({
              generation: input.generation,
              type: "blocked",
              target: preflight.target,
              details: {
                code: recovery.code,
                recoveryAttempted: true,
                ...(recovery.details === undefined
                  ? {}
                  : { cause: recovery.details }),
              },
            });
            closing = true;
            workAbort.abort();
            stopResolve?.({
              kind: "blocked",
              error: {
                code: recovery.code,
                message: recovery.message,
                ...(recovery.details === undefined
                  ? {}
                  : { details: recovery.details }),
              },
            });
            return;
          }
          preflight.target = recovery.target;
          return;
        }
        if (applied.blocked) {
          closing = true;
          workAbort.abort();
          stopResolve?.({
            kind: "blocked",
            error: {
              code: applied.code,
              message: applied.message,
              ...(applied.details === undefined
                ? {}
                : { details: applied.details }),
            },
          });
        } else if (input.initial) {
          closing = true;
          workAbort.abort();
          stopResolve?.({
            kind: "runtime-failed",
            error: {
              code: applied.code,
              message: applied.message,
              ...(applied.details === undefined
                ? {}
                : { details: applied.details }),
            },
          });
        }
        return;
      }
      if (
        applied.pluginIdentity.id !== pluginIdentity.id ||
        applied.pluginIdentity.version !== pluginIdentity.version ||
        applied.pluginIdentity.payloadSha256 !==
          pluginIdentity.payloadSha256 ||
        applied.target.targetId !== preflight.target.targetId ||
        applied.target.executionContextUniqueId !==
          preflight.target.executionContextUniqueId
      ) {
        const failure: DevelopApplyFailure = {
          ok: false,
          code: "operation.state-changed",
          message:
            "Plugin artifact or exact target identity changed during foreground apply.",
          blocked: false,
          liveDisposition: "unknown",
        };
        finalEventForFailure({
          protocol,
          generation: input.generation,
          preflight,
          failure,
        });
        if (input.initial) {
          closing = true;
          workAbort.abort();
          stopResolve?.({
            kind: "runtime-failed",
            error: { code: failure.code, message: failure.message },
          });
        }
        return;
      }
      protocol.applySucceeded({
        generation: input.generation,
        pluginIdentity: applied.pluginIdentity,
        sdkRuntimeIdentity,
        target: applied.target,
        appliedAt: options.adapters.nowIso(),
      });
    } catch (error: unknown) {
      if (!generationIsCurrent(input.generation, controller)) return;
      const failure = errorFromUnknown(error);
      protocol.event({
        generation: input.generation,
        type: "build-failed",
        details: { code: failure.code },
      });
      if (input.initial) {
        closing = true;
        workAbort.abort();
        stopResolve?.({ kind: "runtime-failed", error: failure });
      }
    } finally {
      workAbort.signal.removeEventListener("abort", onWorkAbort);
      generationControllers.delete(input.generation);
    }
  };

  const startGeneration = (input: {
    generation: number;
    pluginIdentity?: DevelopPluginIdentity;
    initial: boolean;
  }): Promise<void> => {
    newestGeneration = input.generation;
    for (const [generation, controller] of generationControllers) {
      if (generation < input.generation) controller.abort();
    }
    const task = runGeneration(input);
    generationTasks.add(task);
    void task.finally(() => generationTasks.delete(task));
    return task;
  };

  const queueGeneration = (): void => {
    if (closing || targetLost || workAbort.signal.aborted) return;
    if (sdkRecoveryInProgress) {
      protocol.event({
        generation: newestGeneration,
        type: "blocked",
        target: preflight.target,
        details: {
          code: "develop.sdk-recovery-superseded",
          recoveryAttempted: true,
        },
      });
      closing = true;
      workAbort.abort();
      for (const controller of generationControllers.values()) {
        controller.abort();
      }
      stopResolve?.({
        kind: "blocked",
        error: {
          code: "develop.sdk-recovery-superseded",
          message:
            "A corrected generation arrived before SDK recovery completed; start a new develop operation.",
        },
      });
      return;
    }
    for (const controller of generationControllers.values()) controller.abort();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closing || targetLost || workAbort.signal.aborted) return;
      queuedGeneration = nextGeneration;
      nextGeneration += 1;
      generationWake?.();
      generationWake = null;
    }, options.adapters.debounceMs ?? 75);
  };

  const takeQueuedGeneration = async (): Promise<number> => {
    if (queuedGeneration !== null) {
      const generation = queuedGeneration;
      queuedGeneration = null;
      return generation;
    }
    await new Promise<void>((resolve) => {
      generationWake = resolve;
    });
    const generation = queuedGeneration;
    queuedGeneration = null;
    if (generation === null) {
      throw new Error("Generation wake completed without queued work.");
    }
    return generation;
  };

  try {
    watcher = await options.adapters.openWatcher({
      preflight,
      onChange: queueGeneration,
      onStop: () => stopResolve?.({ kind: "completed" }),
    });
    monitor = await options.adapters.openTargetMonitor({
      preflight,
      onTargetLost: () => {
        if (sdkRecoveryInProgress) return;
        if (targetLost) return;
        targetLost = true;
        workAbort.abort();
        for (const controller of generationControllers.values()) {
          controller.abort();
        }
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

    void startGeneration({
      generation: 1,
      ...(preflight.pluginIdentity === null
        ? {}
        : { pluginIdentity: preflight.pluginIdentity }),
      initial: true,
    });

    const waitAbort = new AbortController();
    const externalStop = options.adapters.waitForStop({
      signal: waitAbort.signal,
    }).then((reason): StopDisposition => ({ kind: reason }));
    let disposition: StopDisposition | null = null;
    while (disposition === null) {
      const outcome = await Promise.race([
        stop.then((value) => ({ kind: "stop" as const, value })),
        externalStop.then((value) => ({ kind: "stop" as const, value })),
        takeQueuedGeneration().then((generation) => ({
          kind: "generation" as const,
          generation,
        })),
      ]);
      if (outcome.kind === "stop") {
        disposition = outcome.value;
        continue;
      }
      if (closing || targetLost || workAbort.signal.aborted) continue;
      void startGeneration({
        generation: outcome.generation,
        initial: false,
      });
    }
    waitAbort.abort();
    closing = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    generationWake = null;
    for (const controller of generationControllers.values()) controller.abort();
    if (disposition.kind === "target-lost") {
      protocol.event({
        generation: newestGeneration + 1,
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
    } else if (disposition.kind === "blocked") {
      terminalReason = "blocked";
      terminalError = disposition.error;
    } else if (disposition.kind === "runtime-failed") {
      terminalReason = "runtime-failed";
      terminalError = disposition.error;
    } else {
      terminalReason = "completed";
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
  if (generationTasks.size > 0) {
    const remainingMs = Math.max(0, cleanupDeadline - Date.now());
    let generationTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.allSettled([...generationTasks]),
        new Promise<never>((_resolve, reject) => {
          generationTimer = setTimeout(
            () => reject(new Error("Generation cleanup timed out.")),
            remainingMs,
          );
        }),
      ]);
    } catch {
      residuals.push("generation-work");
    } finally {
      if (generationTimer !== null) clearTimeout(generationTimer);
    }
  }
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
