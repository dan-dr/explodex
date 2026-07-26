/**
 * Types, constants, and result formatting for explicit main launch/attach.
 */

import type { CdpAdapter, CdpEvaluationResult } from "../cdp/adapters.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import type { LaunchSpawnAdapter } from "../dev/launch-adapters.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { BoundedOperationResult } from "../runtime/types.ts";
import type { HostAdapters } from "./adapters.ts";
import {
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  DECLARED_ROLE_ENDPOINTS,
} from "./constants.ts";
import { MAIN_HOT_PATH_UNAVAILABLE_CODE } from "./main-hot-path.ts";
import type { HostStatusAdapters, HostStatusResult } from "./status.ts";
import type {
  CompatibilityReport,
  HostIdentity,
  ProbeIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";

export const MAIN_CDP_HOST = DECLARED_ROLE_ENDPOINTS.main.host;
export const MAIN_CDP_PORT = DECLARED_ROLE_ENDPOINTS.main.port;

export const CANONICAL_EXECUTABLE_PATH =
  `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`;

export const DEFAULT_BENIGN_MAIN_EXPRESSION =
  "(() => ({ explodexMainLaunchReadiness: true, readyState: document.readyState, href: location.href }))()";

export type MainLaunchPath = "spawn" | "attach" | "refused" | "failed";

export type MainLaunchStage =
  | "preflight"
  | "lock-acquisition"
  | "pre-spawn-recheck"
  | "spawn"
  | "launch-readiness"
  | "cdp-discovery"
  | "requested-work"
  | "cleanup";

export type MainLaunchErrorCode =
  | "compatibility_unproven"
  | "compatibility_stale"
  | typeof MAIN_HOT_PATH_UNAVAILABLE_CODE
  | "state_changed"
  | "port_obstructed"
  | "lock_busy"
  | "host_invalid"
  | "host_identity_drift"
  | "process_identity_drift"
  | "port_owner_drift"
  | "browser_identity_drift"
  | "target_identity_drift"
  | "context_identity_drift"
  | "compatibility_identity_drift"
  | "same_operation_authority_mismatch"
  | "preexisting_cdp_main"
  | "launch_failed"
  | "readiness_failed"
  | "target_not_found"
  | "target_ambiguous"
  | "context_not_found"
  | "context_ambiguous"
  | "endpoint_identity_mismatch"
  | "operation_timeout"
  | "operation_interrupted"
  | "operation_failed"
  | "requested_work_failed";

export type LaunchedMainIdentity = {
  pid: number;
  processStartedAt: string;
  executablePath: string;
  port: typeof MAIN_CDP_PORT;
  host: typeof MAIN_CDP_HOST;
};

export type MainLaunchSuccess = {
  path: "spawn" | "attach";
  host: HostIdentity;
  process: LaunchedMainIdentity;
  target: TargetIdentity;
  work: unknown;
  stagesCompleted: MainLaunchStage[];
  /** True when this operation created the ChatGPT process. */
  spawnedByThisOperation: boolean;
  /** ChatGPT remains running after CLI exit. */
  chatgptSurvives: true;
  injectionClaimed: boolean;
};

export type MainLaunchFailureDetails = {
  code: MainLaunchErrorCode;
  message: string;
  path: MainLaunchPath;
  mainState?: HostStatusResult["mainState"];
  endpointObstruction?: HostStatusResult["endpointObstruction"];
  recoveryGuidance?: string;
  survivingChatGpt?: LaunchedMainIdentity;
  lastCompletedStage: MainLaunchStage | null;
  stalledStage: MainLaunchStage | null;
  injectionClaimed: false;
  autoResume: false;
  details?: unknown;
};

export type MainLaunchWorkContext = {
  operationId: string;
  host: HostIdentity;
  process: LaunchedMainIdentity;
  target: TargetIdentity;
  path: "spawn" | "attach";
  signal: AbortSignal;
  evaluate(expression: string): Promise<CdpEvaluationResult>;
  throwIfInterrupted(): void;
};

export type MainLaunchOptions = {
  runtime: RuntimeAdapters;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  spawn: LaunchSpawnAdapter;
  cdp: CdpAdapter;
  explodexHome?: string;
  osHome?: string;
  sdkRuntime: SdkRuntimeIdentity;
  probe?: ProbeIdentity;
  operationId?: string;
  /**
   * Requested bounded work. Defaults to a benign readiness sentinel evaluation.
   * Must not claim injection success unless the caller sets that explicitly via
   * the return value's `injectionPerformed` flag.
   */
  work?: (ctx: MainLaunchWorkContext) => Promise<{
    result: unknown;
    injectionPerformed?: boolean;
  }>;
  /** Controlled fixtures may inject host/status/compatibility snapshots. */
  freezeHost?: () => Promise<HostIdentity>;
  loadCompatibility?: () => Promise<CompatibilityReport>;
  collectStatus?: (signal?: AbortSignal) => Promise<HostStatusResult>;
  /** Poll interval for readiness. */
  readinessPollMs?: number;
  /** Optional stage bound overrides (tests). */
  stageBounds?: Partial<
    Record<"launch-readiness" | "cdp-discovery" | "cdp-evaluation" | "lock-acquisition", number>
  >;
};

export function buildMainLaunchArgv(): readonly string[] {
  return [`--remote-debugging-port=${MAIN_CDP_PORT}`];
}

export function asFailureDetails(value: unknown): MainLaunchFailureDetails | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<MainLaunchFailureDetails>;
  if (typeof record.code !== "string" || typeof record.message !== "string") {
    if ("details" in record && typeof record.details === "object" && record.details !== null) {
      return asFailureDetails(record.details);
    }
    return null;
  }
  return value as MainLaunchFailureDetails;
}

export function formatMainLaunchHuman(
  result: BoundedOperationResult<MainLaunchSuccess>,
): string {
  if (result.ok) {
    const r = result.result;
    return [
      "Explodex main launch",
      `ok: true`,
      `path: ${r.path}`,
      `pid: ${r.process.pid}`,
      `processStartedAt: ${r.process.processStartedAt}`,
      `port: ${r.process.host}:${r.process.port}`,
      `target: ${r.target.targetId}`,
      `spawnedByThisOperation: ${r.spawnedByThisOperation}`,
      `chatgptSurvives: true`,
      `injectionClaimed: ${r.injectionClaimed}`,
      `stagesCompleted: ${r.stagesCompleted.join(",")}`,
    ].join("\n") + "\n";
  }

  const partial = result.partial;
  const details = asFailureDetails(result.error.details);
  const surviving = details?.survivingChatGpt ?? partial.survivingChatGpt;
  const lines = [
    "Explodex main launch",
    `ok: false`,
    `code: ${result.error.code}`,
    `message: ${result.error.message}`,
    `lastCompletedStage: ${details?.lastCompletedStage ?? partial.lastCompletedStage ?? "null"}`,
    `stalledStage: ${details?.stalledStage ?? partial.stalledStage ?? "null"}`,
    `injectionClaimed: false`,
    `autoResume: false`,
  ];
  if (surviving !== undefined) {
    lines.push(
      `survivingChatGpt: ${surviving.pid}@${surviving.processStartedAt} ${MAIN_CDP_HOST}:${surviving.port ?? MAIN_CDP_PORT}`,
    );
  }
  if (details?.recoveryGuidance !== undefined) {
    lines.push(`recovery: ${details.recoveryGuidance}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatMainLaunchJson(
  result: BoundedOperationResult<MainLaunchSuccess>,
): unknown {
  if (result.ok) {
    return {
      schemaVersion: 1,
      ok: true,
      operation: "launch-with-injection",
      result: result.result,
      warnings: result.warnings,
    };
  }
  const details = asFailureDetails(result.error.details);
  return {
    schemaVersion: 1,
    ok: false,
    operation: "launch-with-injection",
    error: {
      code: result.error.code,
      message: result.error.message,
      details: {
        ...details,
        partial: result.partial,
        stagesCompleted: result.stagesCompleted,
        injectionClaimed: false,
        autoResume: false,
      },
    },
    warnings: result.warnings,
  };
}
