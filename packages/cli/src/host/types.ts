import type {
  CompatibilityDependentOperation,
  CompatibilityIndependentOperation,
  HostOperationName,
} from "./constants.ts";

export type CompatibilityStatus = "unproven" | "proven" | "pending";

export type HostValidity =
  | { ok: true }
  | {
      ok: false;
      code: HostFailureCode;
      message: string;
      failedPredicates: string[];
      candidates?: HostCandidateSummary[];
    };

export type HostFailureCode =
  | "host_missing"
  | "host_malformed"
  | "host_wrong_identity"
  | "host_broken_executable_relationship"
  | "host_invalid_signature"
  | "host_unresolved_candidates"
  | "host_not_canonical_path";

export type HostCandidateSummary = {
  path: string;
  bundleId?: string;
  executableName?: string;
  signingTeam?: string;
  reason: string;
};

export type HostIdentity = {
  bundlePath: string;
  executablePath: string;
  bundleId: string;
  executableName: string;
  signingTeam: string;
  appVersion: string;
  appBuild: string;
  hostHashes: Record<string, string>;
};

export type HostInspectionResult =
  | {
      ok: true;
      hostValid: true;
      host: HostIdentity;
      /** Structural validity only; never implies renderer compatibility. */
      compatibility: CompatibilityReport;
      selected: true;
      rejectedAlternates: HostCandidateSummary[];
      readOnly: true;
    }
  | {
      ok: false;
      hostValid: false;
      host: null;
      compatibility: CompatibilityReport;
      selected: false;
      error: {
        code: HostFailureCode;
        message: string;
        failedPredicates: string[];
        candidates: HostCandidateSummary[];
      };
      readOnly: true;
    };

export type CompatibilityKey = {
  schemaVersion: 1;
  appVersion: string;
  appBuild: string;
  hostHashes: Record<string, string>;
  signingTeam: string;
  sdkRuntimeSha256: string;
  probeSchemaVersion: number;
  probeToolVersion: string;
};

export type CompatibilityRecord = {
  key: CompatibilityKey;
  status: "proven";
  probedAt: string;
  target: {
    role: "development";
    pid: number;
    processStartedAt: string;
    port: 9444;
    targetId: string;
  };
  capabilitySummary: unknown;
};

export type CompatibilityReport = {
  status: CompatibilityStatus;
  key: CompatibilityKey | null;
  currentKey: CompatibilityKey | null;
  matched: boolean;
  reason: string | null;
  nextAction: string | null;
  /** True only when a proven record exists and matches the current key exactly. */
  allowsCompatibilityDependentWork: boolean;
};

export type CompatibilityGateResult =
  | {
      allowed: true;
      operation: HostOperationName;
      compatibility: CompatibilityReport;
    }
  | {
      allowed: false;
      operation: CompatibilityDependentOperation;
      compatibility: CompatibilityReport;
      error: {
        code: "compatibility_unproven" | "compatibility_stale";
        message: string;
        nextAction: string;
      };
      /** Guarantees no launch or CDP evaluation was started. */
      blockedBeforeLaunchOrEvaluation: true;
    };

export type OperationGateKind =
  | CompatibilityIndependentOperation
  | CompatibilityDependentOperation;

export type RunningProcessIdentity = {
  /** Optional observed app version of a running process. */
  appVersion?: string;
  /** Optional observed app build of a running process. */
  appBuild?: string;
  /** Optional observed executable path. */
  executablePath?: string;
};

export type SdkRuntimeIdentity = {
  version: string;
  sha256: string;
};

export type ProbeIdentity = {
  schemaVersion: number;
  toolVersion: string;
};
