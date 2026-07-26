/**
 * Pure exact ownership classifier for Phase 0 development launches.
 * Positive and negative verdicts are derived from controlled observations only.
 * Negative fixtures never mutate or signal a protected process.
 */

import { DEV_CDP_HOST, DEV_CDP_PORT } from "./constants.ts";

export type OwnershipRole =
  | "development"
  | "protected-main"
  | "unrelated"
  | "pid-reuse"
  | "wrong-endpoint"
  | "conflicting-source"
  | "arbitrary-substring";

export type OwnershipExpected = {
  marker: string;
  executablePath: string;
  cdpHost: typeof DEV_CDP_HOST;
  cdpPort: typeof DEV_CDP_PORT;
  /** When set, PID must match exactly. */
  expectedPid?: number;
  /** When set, kernel start identity must match exactly. */
  expectedProcessStartedAt?: string;
};

export type OwnershipCandidate = {
  role: OwnershipRole;
  pid: number;
  processStartedAt: string;
  executablePath: string;
  arguments: readonly string[];
  env?: Record<string, string | undefined>;
  /** Observed loopback port owner, or null when free/unknown. */
  portOwnerPid: number | null;
  port: number;
  endpointHost: string;
  browserIdentity: string | null;
  /** Page targets matching app://-/index.html (ids only). */
  targetIds: readonly string[];
  defaultExecutionContextCount: number;
  /** Optional alternate marker source that conflicts with argv. */
  conflictingSourceValue?: string | null;
  expected: OwnershipExpected;
};

export type OwnershipVerdictCode =
  | "owned"
  | "protected_main"
  | "unrelated_marker"
  | "arbitrary_substring"
  | "pid_reuse"
  | "wrong_endpoint"
  | "conflicting_source"
  | "missing_identity"
  | "ambiguous_targets"
  | "executable_mismatch"
  | "marker_absent";

export type OwnershipVerdict = {
  owned: boolean;
  code: OwnershipVerdictCode;
  role: OwnershipRole;
  reasons: string[];
};

function exactArgvMarker(argumentsList: readonly string[], marker: string): boolean {
  return argumentsList.some((token) => token === marker);
}

function arbitrarySubstringOnly(argumentsList: readonly string[], marker: string): boolean {
  if (exactArgvMarker(argumentsList, marker)) return false;
  return argumentsList.some(
    (token) => token.includes(marker) || marker.includes(token) && token.length > 0,
  );
}

/**
 * Classify whether a process observation is the exact owned development instance.
 * Pure and side-effect free: never signals, connects, or mutates candidates.
 */
export function classifyDevelopmentOwnership(
  candidate: OwnershipCandidate,
): OwnershipVerdict {
  const reasons: string[] = [];
  const expected = candidate.expected;

  if (!Number.isInteger(candidate.pid) || candidate.pid <= 0) {
    return {
      owned: false,
      code: "missing_identity",
      role: candidate.role,
      reasons: ["PID is missing or invalid."],
    };
  }
  if (candidate.processStartedAt.length === 0) {
    return {
      owned: false,
      code: "missing_identity",
      role: candidate.role,
      reasons: ["Kernel process start identity is missing."],
    };
  }
  if (candidate.executablePath !== expected.executablePath) {
    return {
      owned: false,
      code: "executable_mismatch",
      role: candidate.role,
      reasons: [
        `Executable '${candidate.executablePath}' does not match expected '${expected.executablePath}'.`,
      ],
    };
  }

  const exactMarker = exactArgvMarker(candidate.arguments, expected.marker);
  const substringOnly = arbitrarySubstringOnly(candidate.arguments, expected.marker);

  // Role-driven negatives first so controlled fixtures map to distinct codes.
  if (candidate.role === "protected-main") {
    reasons.push("Candidate is the protected authoring main role.");
    if (exactMarker) {
      reasons.push("Even an exact marker token is insufficient ownership for protected main.");
    }
    return {
      owned: false,
      code: "protected_main",
      role: candidate.role,
      reasons,
    };
  }

  if (candidate.role === "arbitrary-substring") {
    reasons.push("Marker evidence is substring-only and fails exact token matching.");
    return {
      owned: false,
      code: "arbitrary_substring",
      role: candidate.role,
      reasons,
    };
  }

  if (candidate.role === "pid-reuse") {
    reasons.push("Numeric PID matches a prior record but kernel start identity does not.");
    return {
      owned: false,
      code: "pid_reuse",
      role: candidate.role,
      reasons,
    };
  }

  if (candidate.role === "wrong-endpoint") {
    reasons.push(
      `Endpoint ${candidate.endpointHost}:${candidate.port} is not the declared development role ${expected.cdpHost}:${expected.cdpPort}.`,
    );
    return {
      owned: false,
      code: "wrong_endpoint",
      role: candidate.role,
      reasons,
    };
  }

  if (candidate.role === "conflicting-source") {
    reasons.push("Marker evidence conflicts across independent sources.");
    return {
      owned: false,
      code: "conflicting_source",
      role: candidate.role,
      reasons,
    };
  }

  if (candidate.role === "unrelated") {
    reasons.push("Process is an unrelated exact-marker or non-development identity.");
    if (!exactMarker) {
      reasons.push("Exact launch marker is absent.");
    }
    return {
      owned: false,
      code: "unrelated_marker",
      role: candidate.role,
      reasons,
    };
  }

  // Positive development role: all identity fields must align exactly.
  if (expected.expectedPid !== undefined && candidate.pid !== expected.expectedPid) {
    return {
      owned: false,
      code: "pid_reuse",
      role: candidate.role,
      reasons: [
        `Observed PID ${candidate.pid} does not match expected PID ${expected.expectedPid}.`,
      ],
    };
  }
  if (
    expected.expectedProcessStartedAt !== undefined &&
    candidate.processStartedAt !== expected.expectedProcessStartedAt
  ) {
    return {
      owned: false,
      code: "pid_reuse",
      role: candidate.role,
      reasons: ["Process start identity does not match the expected kernel start identity."],
    };
  }

  if (!exactMarker) {
    if (substringOnly) {
      return {
        owned: false,
        code: "arbitrary_substring",
        role: candidate.role,
        reasons: ["Marker is present only as a substring; exact token match is required."],
      };
    }
    return {
      owned: false,
      code: "marker_absent",
      role: candidate.role,
      reasons: ["Exact launch marker is absent from process evidence."],
    };
  }

  if (
    candidate.port !== expected.cdpPort ||
    candidate.endpointHost !== expected.cdpHost
  ) {
    return {
      owned: false,
      code: "wrong_endpoint",
      role: candidate.role,
      reasons: [
        `Observed endpoint ${candidate.endpointHost}:${candidate.port} is not ${expected.cdpHost}:${expected.cdpPort}.`,
      ],
    };
  }

  if (candidate.portOwnerPid !== candidate.pid) {
    return {
      owned: false,
      code: "wrong_endpoint",
      role: candidate.role,
      reasons: [
        candidate.portOwnerPid === null
          ? "Declared development port has no owner."
          : `Declared development port is owned by foreign PID ${candidate.portOwnerPid}.`,
      ],
    };
  }

  if (candidate.browserIdentity === null || candidate.browserIdentity.length === 0) {
    return {
      owned: false,
      code: "missing_identity",
      role: candidate.role,
      reasons: ["Browser /json/version identity is missing."],
    };
  }

  if (candidate.targetIds.length === 0) {
    return {
      owned: false,
      code: "missing_identity",
      role: candidate.role,
      reasons: ["No app://-/index.html page target is present."],
    };
  }
  if (candidate.targetIds.length > 1) {
    return {
      owned: false,
      code: "ambiguous_targets",
      role: candidate.role,
      reasons: [`Expected one app://-/index.html target; found ${candidate.targetIds.length}.`],
    };
  }

  if (candidate.defaultExecutionContextCount !== 1) {
    return {
      owned: false,
      code:
        candidate.defaultExecutionContextCount === 0
          ? "missing_identity"
          : "ambiguous_targets",
      role: candidate.role,
      reasons: [
        `Expected exactly one default execution context; found ${candidate.defaultExecutionContextCount}.`,
      ],
    };
  }

  if (
    typeof candidate.conflictingSourceValue === "string" &&
    candidate.conflictingSourceValue.length > 0 &&
    candidate.conflictingSourceValue !== expected.marker
  ) {
    return {
      owned: false,
      code: "conflicting_source",
      role: candidate.role,
      reasons: ["Secondary marker source conflicts with the exact argv marker."],
    };
  }

  return {
    owned: true,
    code: "owned",
    role: "development",
    reasons: [
      "Exact PID/start/executable, marker, unique 127.0.0.1:9444 owner, browser identity, one app://-/index.html target, and one default execution context all match.",
    ],
  };
}

/** Controlled negative fixtures for classifier matrix tests (no live process mutation). */
export function controlledOwnershipNegatives(options: {
  expected: OwnershipExpected;
  developmentPid: number;
  developmentStartedAt: string;
}): OwnershipCandidate[] {
  const baseArgs = [
    options.expected.executablePath,
    `--user-data-dir=/tmp/dev-user-data`,
    `--remote-debugging-port=${DEV_CDP_PORT}`,
    options.expected.marker,
  ];
  return [
    {
      role: "protected-main",
      pid: 1001,
      processStartedAt: "main-start",
      executablePath: options.expected.executablePath,
      arguments: [options.expected.executablePath],
      portOwnerPid: null,
      port: 9333,
      endpointHost: DEV_CDP_HOST,
      browserIdentity: null,
      targetIds: [],
      defaultExecutionContextCount: 0,
      expected: options.expected,
    },
    {
      role: "unrelated",
      pid: 2002,
      processStartedAt: "unrelated-start",
      executablePath: options.expected.executablePath,
      arguments: [
        options.expected.executablePath,
        options.expected.marker,
        "--remote-debugging-port=9555",
      ],
      portOwnerPid: 2002,
      port: 9555,
      endpointHost: DEV_CDP_HOST,
      browserIdentity: "Chrome/unrelated",
      targetIds: ["t-unrelated"],
      defaultExecutionContextCount: 1,
      expected: options.expected,
    },
    {
      role: "arbitrary-substring",
      pid: 3003,
      processStartedAt: "sub-start",
      executablePath: options.expected.executablePath,
      arguments: [
        options.expected.executablePath,
        `prefix-${options.expected.marker}-suffix`,
        `--remote-debugging-port=${DEV_CDP_PORT}`,
      ],
      portOwnerPid: 3003,
      port: DEV_CDP_PORT,
      endpointHost: DEV_CDP_HOST,
      browserIdentity: "Chrome/sub",
      targetIds: ["t-sub"],
      defaultExecutionContextCount: 1,
      expected: options.expected,
    },
    {
      role: "pid-reuse",
      pid: options.developmentPid,
      processStartedAt: "reused-different-start",
      executablePath: options.expected.executablePath,
      arguments: baseArgs,
      portOwnerPid: options.developmentPid,
      port: DEV_CDP_PORT,
      endpointHost: DEV_CDP_HOST,
      browserIdentity: "Chrome/reuse",
      targetIds: ["t-reuse"],
      defaultExecutionContextCount: 1,
      expected: {
        ...options.expected,
        expectedPid: options.developmentPid,
        expectedProcessStartedAt: options.developmentStartedAt,
      },
    },
    {
      role: "wrong-endpoint",
      pid: 4004,
      processStartedAt: "wrong-ep-start",
      executablePath: options.expected.executablePath,
      arguments: baseArgs,
      portOwnerPid: 4004,
      port: 9333,
      endpointHost: DEV_CDP_HOST,
      browserIdentity: "Chrome/wrong",
      targetIds: ["t-wrong"],
      defaultExecutionContextCount: 1,
      expected: options.expected,
    },
    {
      role: "conflicting-source",
      pid: 5005,
      processStartedAt: "conflict-start",
      executablePath: options.expected.executablePath,
      arguments: baseArgs,
      portOwnerPid: 5005,
      port: DEV_CDP_PORT,
      endpointHost: DEV_CDP_HOST,
      browserIdentity: "Chrome/conflict",
      targetIds: ["t-conflict"],
      defaultExecutionContextCount: 1,
      conflictingSourceValue: `${options.expected.marker}-other`,
      expected: options.expected,
    },
  ];
}
