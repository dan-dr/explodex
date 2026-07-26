/**
 * Internal helpers for explicit main launch/attach (failures, stage tracking,
 * identity comparison, and protected process registration).
 */

import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { OperationContext } from "../runtime/operation.ts";
import type { BoundedOperationResult, OperationStage } from "../runtime/types.ts";
import type { HostAdapters } from "./adapters.ts";
import { evaluateCompatibility, loadCompatibilityRecord } from "./compatibility-state.ts";
import { inspectHost } from "./identity.ts";
import { MAIN_HOT_PATH_UNAVAILABLE_CODE } from "./main-hot-path.ts";
import {
  asFailureDetails,
  CANONICAL_EXECUTABLE_PATH,
  MAIN_CDP_HOST,
  MAIN_CDP_PORT,
  type LaunchedMainIdentity,
  type MainLaunchErrorCode,
  type MainLaunchFailureDetails,
  type MainLaunchPath,
  type MainLaunchStage,
  type MainLaunchSuccess,
} from "./main-launch-types.ts";
import type { HostStatusResult, VerifiedProcess } from "./status.ts";
import type {
  CompatibilityReport,
  HostIdentity,
  ProbeIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";

export type LaunchFailure = Error & {
  code: MainLaunchErrorCode;
  stage: OperationStage | null;
  details: MainLaunchFailureDetails;
};

export function launchFailure(input: {
  code: MainLaunchErrorCode;
  message: string;
  path: MainLaunchPath;
  mainState?: HostStatusResult["mainState"];
  endpointObstruction?: HostStatusResult["endpointObstruction"];
  recoveryGuidance?: string;
  survivingChatGpt?: LaunchedMainIdentity;
  lastCompletedStage: MainLaunchStage | null;
  stalledStage: MainLaunchStage | null;
  details?: unknown;
}): LaunchFailure {
  const details: MainLaunchFailureDetails = {
    code: input.code,
    message: input.message,
    path: input.path,
    mainState: input.mainState,
    endpointObstruction: input.endpointObstruction,
    recoveryGuidance: input.recoveryGuidance,
    survivingChatGpt: input.survivingChatGpt,
    lastCompletedStage: input.lastCompletedStage,
    stalledStage: input.stalledStage,
    injectionClaimed: false,
    autoResume: false,
    details: input.details,
  };
  return Object.assign(new Error(input.message), {
    code: input.code,
    stage: mapStage(input.stalledStage),
    details,
  });
}

export function isLaunchFailure(error: unknown): error is LaunchFailure {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "details" in error &&
    typeof (error as { details?: unknown }).details === "object";
}

export function normalizeLaunchResult(
  result: BoundedOperationResult<MainLaunchSuccess>,
): BoundedOperationResult<MainLaunchSuccess> {
  if (result.ok) return result;
  const details = asFailureDetails(result.error.details);
  const code = (details?.code ?? mapBoundedCode(result.error.code)) as MainLaunchErrorCode;
  const surviving = details?.survivingChatGpt ??
    (result.partial.survivingChatGpt !== undefined
      ? {
          pid: result.partial.survivingChatGpt.pid,
          processStartedAt: result.partial.survivingChatGpt.processStartedAt,
          executablePath: CANONICAL_EXECUTABLE_PATH,
          port: MAIN_CDP_PORT,
          host: MAIN_CDP_HOST,
        }
      : undefined);
  return {
    ...result,
    error: {
      ...result.error,
      code: code as typeof result.error.code,
      details: {
        code,
        message: result.error.message,
        path: details?.path ?? (surviving !== undefined ? "failed" : "refused"),
        mainState: details?.mainState,
        endpointObstruction: details?.endpointObstruction,
        recoveryGuidance: details?.recoveryGuidance,
        survivingChatGpt: surviving,
        lastCompletedStage: details?.lastCompletedStage ??
          (result.partial.lastCompletedStage as MainLaunchStage | null) ??
          null,
        stalledStage: details?.stalledStage ??
          (result.partial.stalledStage as MainLaunchStage | null) ??
          null,
        injectionClaimed: false as const,
        autoResume: false as const,
        details: details?.details,
      } satisfies MainLaunchFailureDetails,
    },
    partial: {
      ...result.partial,
      survivingChatGpt: surviving !== undefined
        ? {
            pid: surviving.pid,
            processStartedAt: surviving.processStartedAt,
            port: MAIN_CDP_PORT,
          }
        : result.partial.survivingChatGpt,
    },
  };
}

export function mapBoundedCode(code: string): MainLaunchErrorCode {
  if (code === "operation_timeout") return "operation_timeout";
  if (code === "operation_interrupted") return "operation_interrupted";
  if (code === "lock_busy") return "lock_busy";
  if (code === "host_identity_drift") return "host_identity_drift";
  if (code === "process_identity_drift") return "process_identity_drift";
  if (code === "port_owner_drift") return "port_owner_drift";
  if (code === "target_not_found") return "target_not_found";
  if (code === "target_ambiguous") return "target_ambiguous";
  if (code === "context_not_found") return "context_not_found";
  if (code === "context_ambiguous") return "context_ambiguous";
  if (code === "endpoint_identity_mismatch") return "endpoint_identity_mismatch";
  if (code === MAIN_HOT_PATH_UNAVAILABLE_CODE) return MAIN_HOT_PATH_UNAVAILABLE_CODE;
  if (code === "compatibility_unproven" || code === "compatibility_stale") {
    return code;
  }
  return "operation_failed";
}

export function mapTargetCode(
  code: "target_not_found" | "target_ambiguous" | "context_not_found" | "context_ambiguous",
): MainLaunchErrorCode {
  return code;
}

export function mapStage(stage: MainLaunchStage | null): OperationStage | null {
  if (stage === null) return null;
  if (stage === "launch-readiness") return "launch-readiness";
  if (stage === "cdp-discovery") return "cdp-discovery";
  if (stage === "requested-work") return "cdp-evaluation";
  if (stage === "lock-acquisition") return "lock-acquisition";
  if (stage === "cleanup") return "cleanup";
  return "local-work";
}

export function markLaunchStage(ctx: OperationContext, stage: MainLaunchStage): void {
  const partial = ctx.getPartial();
  const completed = readLaunchStages(ctx);
  if (!completed.includes(stage) && stage !== "cleanup") {
    completed.push(stage);
  }
  ctx.setPartial({
    ...partial,
    lastCompletedStage: mapStage(stage),
    details: {
      ...(typeof partial.details === "object" && partial.details !== null
        ? partial.details as Record<string, unknown>
        : {}),
      mainLaunchStages: completed,
      mainLaunchLastStage: stage,
    },
  });
}

export function readLaunchStages(ctx: OperationContext): MainLaunchStage[] {
  const partial = ctx.getPartial();
  const details = partial.details;
  if (
    typeof details === "object" &&
    details !== null &&
    Array.isArray((details as { mainLaunchStages?: unknown }).mainLaunchStages)
  ) {
    return [...(details as { mainLaunchStages: MainLaunchStage[] }).mainLaunchStages];
  }
  return [];
}

export function setSurviving(ctx: OperationContext, surviving: LaunchedMainIdentity): void {
  ctx.setPartial({
    survivingChatGpt: {
      pid: surviving.pid,
      processStartedAt: surviving.processStartedAt,
      port: MAIN_CDP_PORT,
    },
  });
}

export function registerProtectedChatGpt(
  ctx: OperationContext,
  surviving: LaunchedMainIdentity,
  signalsSent: Array<{ pid: number; signal: string }>,
): void {
  ctx.scope.register({
    kind: "child-process",
    label: `protected-chatgpt:${surviving.pid}`,
    disposition: "protected-chatgpt",
    pid: surviving.pid,
    processStartedAt: surviving.processStartedAt,
    dispose: () => {
      // Intentionally empty: never signal, close, restart, or replace.
      void signalsSent;
    },
  });
}

export async function freezeHostOrThrow(adapters: HostAdapters): Promise<HostIdentity> {
  const inspection = await inspectHost({ adapters });
  if (!inspection.ok || inspection.host === null) {
    throw launchFailure({
      code: "host_invalid",
      message: inspection.ok
        ? "Host inspection returned no host"
        : inspection.error.message,
      path: "refused",
      lastCompletedStage: null,
      stalledStage: "preflight",
      details: inspection.ok ? undefined : inspection.error,
    });
  }
  return inspection.host;
}

export async function loadCurrentCompatibility(options: {
  hostAdapters: HostAdapters;
  host: HostIdentity;
  explodexHome: string;
  sdkRuntime: SdkRuntimeIdentity;
  probe?: ProbeIdentity;
}): Promise<CompatibilityReport> {
  const persisted = await loadCompatibilityRecord({
    adapters: options.hostAdapters,
    explodexHome: options.explodexHome,
  });
  return evaluateCompatibility({
    host: options.host,
    sdkRuntime: options.sdkRuntime,
    probe: options.probe,
    persisted,
  });
}

export function hostIdentityEqual(a: HostIdentity, b: HostIdentity): boolean {
  if (
    a.bundlePath !== b.bundlePath ||
    a.executablePath !== b.executablePath ||
    a.bundleId !== b.bundleId ||
    a.signingTeam !== b.signingTeam ||
    a.appVersion !== b.appVersion ||
    a.appBuild !== b.appBuild
  ) {
    return false;
  }
  const aEntries = Object.entries(a.hostHashes).sort(([l], [r]) => l.localeCompare(r));
  const bEntries = Object.entries(b.hostHashes).sort(([l], [r]) => l.localeCompare(r));
  return JSON.stringify(aEntries) === JSON.stringify(bEntries);
}

export function summarizeHost(host: HostIdentity): unknown {
  return {
    bundlePath: host.bundlePath,
    executablePath: host.executablePath,
    appVersion: host.appVersion,
    appBuild: host.appBuild,
    signingTeam: host.signingTeam,
  };
}

export function summarizeProcess(process: VerifiedProcess): unknown {
  return {
    pid: process.pid,
    processStartedAt: process.processStartedAt,
    executablePath: process.executablePath,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sleep(
  runtime: RuntimeAdapters,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw Object.assign(new Error("Aborted"), { code: "ABORT_ERR" });
  }
  await new Promise<void>((resolve, reject) => {
    const handle = runtime.timers.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("Aborted"), { code: "ABORT_ERR" }));
    };
    const cleanup = () => {
      handle.clear();
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
