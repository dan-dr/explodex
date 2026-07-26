import {
  DEVELOPMENT_LIFECYCLE_MUTATIONS,
  PUBLIC_PHASE0_PROOF_HINT,
  type DevelopmentLifecycleMutation,
} from "./constants.ts";
import { frozenHostEquals, parsePhase0LaunchContract } from "./phase0.ts";
import type {
  DevelopmentLifecycleGateResult,
  Phase0FrozenHost,
  Phase0LaunchContract,
} from "./types.ts";

const lifecycleMutations = new Set<string>(DEVELOPMENT_LIFECYCLE_MUTATIONS);

export function isDevelopmentLifecycleMutation(
  operation: string,
): operation is DevelopmentLifecycleMutation {
  return lifecycleMutations.has(operation);
}

/**
 * Gate development lifecycle mutation and compatibility probing on a proven Phase 0 contract.
 * Layout creation, status, and host inspection remain available without Phase 0 proof.
 * When expectedHost is supplied, the contract's frozen identity must match exactly.
 *
 * Every authorization entry point applies the same strict semantic proof validator used for
 * persisted input: any object rejected by parsePhase0LaunchContract is also rejected here,
 * even when supplied as an in-memory JavaScript object.
 */
export function gateDevelopmentLifecycleMutation(options: {
  operation: DevelopmentLifecycleMutation | string;
  contract: Phase0LaunchContract | null;
  /**
   * Optional exact host freeze that must match the contract.
   * Prefer this over expectedBuild for rolling-current-host operations.
   */
  expectedHost?: Phase0FrozenHost | null;
  /** @deprecated Prefer expectedHost. Retained for narrow build-only checks. */
  expectedBuild?: string;
}): DevelopmentLifecycleGateResult {
  const operation = options.operation;
  if (!isDevelopmentLifecycleMutation(operation)) {
    return {
      allowed: false,
      operation: operation as DevelopmentLifecycleMutation,
      contract: options.contract,
      error: {
        code: "phase0_unproven",
        message: `Unknown development lifecycle operation '${operation}' is blocked.`,
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  const rawContract = options.contract;
  if (rawContract === null) {
    return {
      allowed: false,
      operation,
      contract: null,
      error: {
        code: "phase0_unproven",
        message: `Phase 0 launch-isolation proof is missing for operation '${operation}'.`,
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  // Strict semantic parity with persisted-input validation. An in-memory object that
  // fails parsePhase0LaunchContract cannot authorize lifecycle mutation.
  const contract = parsePhase0LaunchContract(rawContract);
  if (contract === null) {
    return {
      allowed: false,
      operation,
      contract: rawContract,
      error: {
        code: "phase0_incomplete",
        message: `Phase 0 contract for operation '${operation}' failed strict semantic validation and cannot authorize lifecycle mutation.`,
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  if (contract.status !== "proven") {
    return {
      allowed: false,
      operation,
      contract,
      error: {
        code: contract.status === "incomplete" ? "phase0_incomplete" : "phase0_unproven",
        message:
          contract.reason ??
          `Phase 0 launch-isolation proof is ${contract.status} for operation '${operation}'.`,
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  // Rolling-current-host consumers must supply the freshly inspected expected host.
  // Without it, automatic re-proof is required rather than authorizing mutation.
  if (options.expectedHost === undefined || options.expectedHost === null) {
    if (
      options.expectedBuild !== undefined &&
      options.expectedBuild !== "" &&
      contract.appBuild !== options.expectedBuild
    ) {
      return {
        allowed: false,
        operation,
        contract,
        error: {
          code: "phase0_build_mismatch",
          message: `Phase 0 contract build '${contract.appBuild}' does not match expected '${options.expectedBuild}'.`,
          nextAction: PUBLIC_PHASE0_PROOF_HINT,
        },
        blockedBeforeLaunchOrEvaluation: true,
      };
    }
    return {
      allowed: false,
      operation,
      contract,
      error: {
        code: "phase0_host_mismatch",
        message:
          "Rolling-current-host consumers must supply the freshly inspected expected host; automatic Phase 0 re-proof is required before lifecycle mutation.",
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  if (!frozenHostEquals(contract.frozenHost, options.expectedHost)) {
    return {
      allowed: false,
      operation,
      contract,
      error: {
        code: "phase0_host_mismatch",
        message:
          "Phase 0 contract frozen host identity does not match the current operation's frozen host; re-run Phase 0 on the current identity.",
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  if (
    contract.frozenHost === null ||
    contract.launchMarker === null ||
    contract.retainedKnobs.length === 0 ||
    contract.readiness === null ||
    contract.ownership === null ||
    contract.comparativeExperiments.length === 0 ||
    contract.acceptanceAuthority === null
  ) {
    return {
      allowed: false,
      operation,
      contract,
      error: {
        code: "phase0_incomplete",
        message: `Phase 0 contract is marked proven but lacks retained marker/isolation/readiness/ownership/acceptance evidence for '${operation}'.`,
        nextAction: PUBLIC_PHASE0_PROOF_HINT,
      },
      blockedBeforeLaunchOrEvaluation: true,
    };
  }

  return {
    allowed: true,
    operation,
    contract,
  };
}

/**
 * Run a lifecycle mutation only when Phase 0 is proven. On block, never invokes `run`.
 */
export function runIfPhase0Allows<T>(options: {
  operation: DevelopmentLifecycleMutation | string;
  contract: Phase0LaunchContract | null;
  expectedHost?: Phase0FrozenHost | null;
  expectedBuild?: string;
  run: () => T;
}): { gate: DevelopmentLifecycleGateResult; result?: T } {
  const gate = gateDevelopmentLifecycleMutation({
    operation: options.operation,
    contract: options.contract,
    expectedHost: options.expectedHost,
    expectedBuild: options.expectedBuild,
  });
  if (!gate.allowed) {
    return { gate };
  }
  return { gate, result: options.run() };
}
