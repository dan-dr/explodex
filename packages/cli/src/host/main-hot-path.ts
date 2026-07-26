/**
 * Protected authoring-main hot-path refusal and manual recovery guidance.
 * VAL-HOST-015: plain/user-owned main is never shadowed, restarted, reloaded,
 * navigated, closed, stopped, or automatically debug-relaunched.
 */

import type { CompatibilityReport } from "./types.ts";
import type { HostStatusResult, MainClassification } from "./status.ts";

/** Operations that require a debug-enabled main or owned development target. */
export const MAIN_HOT_PATH_OPERATIONS = [
  "inject",
  "refresh",
  "review",
  "load",
  "unload",
  "dynamic-apply",
  "enabled-plugin-apply",
  "final-main-apply",
  "launch-with-injection",
  "attach",
] as const;

export type MainHotPathOperation = (typeof MAIN_HOT_PATH_OPERATIONS)[number];

/** Non-hot read-only / local operations that remain usable with plain-main. */
export const MAIN_NON_HOT_OPERATIONS = [
  "help",
  "host-inspect",
  "status",
  "compatibility-report",
  "local-build",
  "validate",
  "package",
] as const;

export type MainNonHotOperation = (typeof MAIN_NON_HOT_OPERATIONS)[number];

export const MAIN_HOT_PATH_UNAVAILABLE_CODE = "main_hot_path_unavailable" as const;

/**
 * Actionable recovery guidance. Public help and operation results share this text.
 * Never implies auto-resume, polling, or automatic debug relaunch.
 */
export const MAIN_HOT_PATH_RECOVERY_GUIDANCE =
  "Main hot path unavailable for the current authoring process. Manually provide or relaunch a debug-enabled ChatGPT main listening on 127.0.0.1:9333, then invoke a new exact operation. Restart-required work may use the exact owned development instance on 127.0.0.1:9444. Explodex will not automatically resume, poll, shadow, restart, reload, navigate, close, or debug-relaunch the authoring main.";

export type MainHotPathAssessment =
  | {
      allowed: true;
      operation: string;
      mainState: MainClassification;
      reason: "cdp-main-available" | "non-hot-operation" | "no-main-may-launch";
    }
  | {
      allowed: false;
      operation: string;
      mainState: MainClassification;
      code: typeof MAIN_HOT_PATH_UNAVAILABLE_CODE;
      message: string;
      recoveryGuidance: string;
      nextAction: string;
      /** Guarantees no launch, attach, CDP evaluation, or process mutation. */
      blockedBeforeLaunchOrEvaluation: true;
      /** Guarantees no automatic resume/polling. */
      autoResume: false;
    };

const hotOps = new Set<string>(MAIN_HOT_PATH_OPERATIONS);
const nonHotOps = new Set<string>(MAIN_NON_HOT_OPERATIONS);

export function isMainHotPathOperation(operation: string): boolean {
  return hotOps.has(operation);
}

export function isMainNonHotOperation(operation: string): boolean {
  return nonHotOps.has(operation);
}

/**
 * Decide whether an operation may proceed against the observed main state.
 * Plain-main always refuses hot operations with stable recovery guidance.
 * no-main allows only the explicit launch-with-injection path (handled separately).
 * cdp-main availability alone does not grant mutation authority (separate auth).
 */
export function assessMainHotPath(options: {
  operation: string;
  mainState: MainClassification;
  endpointObstruction?: HostStatusResult["endpointObstruction"];
  compatibility?: CompatibilityReport | null;
}): MainHotPathAssessment {
  const { operation, mainState } = options;

  if (isMainNonHotOperation(operation)) {
    return {
      allowed: true,
      operation,
      mainState,
      reason: "non-hot-operation",
    };
  }

  if (mainState === "plain-main") {
    return refuse(operation, mainState);
  }

  if (mainState === "ambiguous-main") {
    return refuse(operation, mainState, "Main process/renderer state is ambiguous.");
  }

  if (mainState === "no-main") {
    if (operation === "launch-with-injection") {
      return {
        allowed: true,
        operation,
        mainState,
        reason: "no-main-may-launch",
      };
    }
    return refuse(
      operation,
      mainState,
      "No authoring main is present. Use explicit normal launch only from a free 9333, or route restart-required work to exact owned development.",
    );
  }

  // cdp-main: hot operations are not auto-authorized here; availability is reported.
  // Callers still need separate mutation authorization (VAL-HOST-021+). For M1-F06 we
  // only prove that hot-path refusal does not fire for cdp-main classification itself
  // and that plain-main remains protected.
  if (mainState === "cdp-main") {
    return {
      allowed: true,
      operation,
      mainState,
      reason: "cdp-main-available",
    };
  }

  return refuse(operation, mainState);
}

function refuse(
  operation: string,
  mainState: MainClassification,
  detail?: string,
): MainHotPathAssessment {
  const message = detail === undefined
    ? `Operation '${operation}' cannot use the authoring main while mainState is '${mainState}'.`
    : `Operation '${operation}' cannot use the authoring main while mainState is '${mainState}'. ${detail}`;
  return {
    allowed: false,
    operation,
    mainState,
    code: MAIN_HOT_PATH_UNAVAILABLE_CODE,
    message,
    recoveryGuidance: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
    nextAction: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
    blockedBeforeLaunchOrEvaluation: true,
    autoResume: false,
  };
}

export function formatMainHotPathHuman(assessment: MainHotPathAssessment): string {
  if (assessment.allowed) {
    return [
      "Explodex main hot path",
      `operation: ${assessment.operation}`,
      `mainState: ${assessment.mainState}`,
      `allowed: true`,
      `reason: ${assessment.reason}`,
    ].join("\n") + "\n";
  }
  return [
    "Explodex main hot path",
    `operation: ${assessment.operation}`,
    `mainState: ${assessment.mainState}`,
    `allowed: false`,
    `code: ${assessment.code}`,
    `message: ${assessment.message}`,
    `recovery: ${assessment.recoveryGuidance}`,
    "autoResume: false",
  ].join("\n") + "\n";
}

export function formatMainHotPathJson(assessment: MainHotPathAssessment): unknown {
  if (assessment.allowed) {
    return {
      schemaVersion: 1,
      ok: true,
      operation: assessment.operation,
      result: {
        allowed: true,
        mainState: assessment.mainState,
        reason: assessment.reason,
      },
      warnings: [],
    };
  }
  return {
    schemaVersion: 1,
    ok: false,
    operation: assessment.operation,
    error: {
      code: assessment.code,
      message: assessment.message,
      details: {
        mainState: assessment.mainState,
        recoveryGuidance: assessment.recoveryGuidance,
        nextAction: assessment.nextAction,
        blockedBeforeLaunchOrEvaluation: true,
        autoResume: false,
      },
    },
    warnings: [],
  };
}
