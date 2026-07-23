import {
  COMPATIBILITY_DEPENDENT_OPERATIONS,
  COMPATIBILITY_INDEPENDENT_OPERATIONS,
  PUBLIC_COMPATIBILITY_PROBE_HINT,
  type CompatibilityDependentOperation,
  type HostOperationName,
} from "./constants.ts";
import type { CompatibilityGateResult, CompatibilityReport } from "./types.ts";

const independent = new Set<string>(COMPATIBILITY_INDEPENDENT_OPERATIONS);
const dependent = new Set<string>(COMPATIBILITY_DEPENDENT_OPERATIONS);

export function isCompatibilityIndependentOperation(
  operation: string,
): operation is (typeof COMPATIBILITY_INDEPENDENT_OPERATIONS)[number] {
  return independent.has(operation);
}

export function isCompatibilityDependentOperation(
  operation: string,
): operation is CompatibilityDependentOperation {
  return dependent.has(operation);
}

/**
 * Gate compatibility-dependent work before any launch or CDP evaluation.
 * Independent operations always pass the compatibility gate (host validity is separate).
 */
export function gateCompatibilityDependentOperation(options: {
  operation: HostOperationName | string;
  compatibility: CompatibilityReport;
}): CompatibilityGateResult {
  const { operation, compatibility } = options;

  if (isCompatibilityIndependentOperation(operation)) {
    return {
      allowed: true,
      operation,
      compatibility,
    };
  }

  if (!isCompatibilityDependentOperation(operation)) {
    // Unknown operations are treated as dependent: fail closed.
    return block(operation as CompatibilityDependentOperation, compatibility, "compatibility_unproven");
  }

  if (
    compatibility.status === "proven" &&
    compatibility.matched &&
    compatibility.allowsCompatibilityDependentWork
  ) {
    return {
      allowed: true,
      operation,
      compatibility,
    };
  }

  const code =
    compatibility.reason?.startsWith("compatibility_key_mismatch") ||
    compatibility.reason === "running_app_version" ||
    compatibility.reason === "running_app_build" ||
    (compatibility.key !== null && !compatibility.matched)
      ? "compatibility_stale"
      : "compatibility_unproven";

  return block(operation, compatibility, code);
}

function block(
  operation: CompatibilityDependentOperation,
  compatibility: CompatibilityReport,
  code: "compatibility_unproven" | "compatibility_stale",
): CompatibilityGateResult {
  const nextAction = compatibility.nextAction ?? PUBLIC_COMPATIBILITY_PROBE_HINT;
  const message =
    code === "compatibility_stale"
      ? `Compatibility proof is stale for operation '${operation}'. ${nextAction}`
      : `Compatibility is unproven for operation '${operation}'. ${nextAction}`;

  return {
    allowed: false,
    operation,
    compatibility: {
      ...compatibility,
      allowsCompatibilityDependentWork: false,
      nextAction,
    },
    error: {
      code,
      message,
      nextAction,
    },
    blockedBeforeLaunchOrEvaluation: true,
  };
}

/**
 * Sentinel used by tests and future command wiring to prove no launch/CDP started.
 * Callers must check the gate and return before invoking this on a blocked path.
 */
export type LaunchOrEvaluationAttempt = {
  kind: "launch" | "cdp-evaluate";
  started: boolean;
};

export function createLaunchOrEvaluationGuard(): {
  attempts: LaunchOrEvaluationAttempt[];
  tryLaunch: () => void;
  tryEvaluate: () => void;
} {
  const attempts: LaunchOrEvaluationAttempt[] = [];
  return {
    attempts,
    tryLaunch() {
      attempts.push({ kind: "launch", started: true });
    },
    tryEvaluate() {
      attempts.push({ kind: "cdp-evaluate", started: true });
    },
  };
}

/**
 * Run a dependent operation only when the gate allows it.
 * On block, returns the gate result and never invokes `run`.
 */
export function runIfCompatibilityAllows<T>(options: {
  operation: HostOperationName | string;
  compatibility: CompatibilityReport;
  run: () => T;
}): { gate: CompatibilityGateResult; result?: T } {
  const gate = gateCompatibilityDependentOperation({
    operation: options.operation,
    compatibility: options.compatibility,
  });
  if (!gate.allowed) {
    return { gate };
  }
  return { gate, result: options.run() };
}
