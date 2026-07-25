import type {
  DEV_CDP_HOST,
  DEV_CDP_PORT,
  DevelopmentLifecycleMutation,
  Phase0CandidateKnob,
} from "./constants.ts";

export type DevInstanceStatus =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "stale"
  | "failed";

export type DevInstanceError = {
  code: string;
  message: string;
  phase: string;
};

/**
 * Private, secret-free development instance state.
 * Path presence never implies process ownership.
 */
export type DevInstanceState = {
  schemaVersion: 1;
  instanceId: string;
  role: "development";
  status: DevInstanceStatus;
  rootPath: string;
  appPath: string;
  executablePath: string;
  pid: number | null;
  processStartedAt: string | null;
  launchMarker: string;
  electronUserDataPath: string;
  codexHomePath: string;
  explodexStatePath: string;
  logsPath: string;
  cdpHost: typeof DEV_CDP_HOST;
  cdpPort: typeof DEV_CDP_PORT;
  targetId: string | null;
  appVersion: string | null;
  appBuild: string | null;
  lastError?: DevInstanceError;
  startedAt: string | null;
  updatedAt: string;
};

export type DevLayoutPaths = {
  rootPath: string;
  electronUserDataPath: string;
  codexHomePath: string;
  explodexStatePath: string;
  logsPath: string;
  locksPath: string;
  statePath: string;
  phase0ContractPath: string;
};

export type DevLayoutEnsureResult =
  | {
      ok: true;
      layout: DevLayoutPaths;
      created: string[];
      alreadyPresent: string[];
      /** Path creation alone never grants process ownership. */
      grantsOwnership: false;
    }
  | {
      ok: false;
      error: {
        code:
          | "root_symlink"
          | "path_escape"
          | "protected_path"
          | "filesystem_error"
          | "not_directory";
        message: string;
        path?: string;
      };
      grantsOwnership: false;
    };

export type Phase0KnobEffect =
  | "demonstrated"
  | "not-necessary"
  | "ambiguous"
  | "missing";

export type Phase0KnobVerdict = {
  name: Phase0CandidateKnob;
  status: "retained" | "omitted";
  effect: Phase0KnobEffect;
  evidence: string;
};

export type LaunchMarkerKind = "exact-argv-token" | "exact-env-value";

export type LaunchMarkerContract = {
  kind: LaunchMarkerKind;
  /** Exact full token/value. Substring matching is never accepted. */
  value: string;
  sourceKey?: string;
};

export type Phase0ContractStatus = "proven" | "incomplete" | "disabled";

export type SanitizedLaunchDescriptor = {
  argv: string[];
  envKeys: string[];
};

/**
 * Exact host identity frozen at Phase 0 operation start.
 * Historical observations never substitute for this freeze.
 */
export type Phase0FrozenHost = {
  bundlePath: string;
  executablePath: string;
  bundleId: string;
  executableName: string;
  signingTeam: string;
  appVersion: string;
  appBuild: string;
  hostHashes: Record<string, string>;
};

/**
 * Minimal retained isolation/marker set for development launches.
 * Incomplete contracts keep lifecycle mutation and compatibility probing disabled.
 */
export type Phase0LaunchContract = {
  schemaVersion: 1;
  status: Phase0ContractStatus;
  /**
   * Exact host identity frozen for this operation.
   * Null only for pre-inspection disabled stubs.
   */
  frozenHost: Phase0FrozenHost | null;
  /** Convenience mirror of frozenHost.appBuild (or disabled stub). */
  appBuild: string;
  /** Convenience mirror of frozenHost.appVersion when known. */
  appVersion: string | null;
  retainedKnobs: Phase0CandidateKnob[];
  knobMatrix: Phase0KnobVerdict[];
  launchMarker: LaunchMarkerContract | null;
  isolation: {
    electronUserDataPath: string | null;
    codexHomePath: string | null;
    explodexHomePath: string | null;
    cdpHost: typeof DEV_CDP_HOST;
    cdpPort: typeof DEV_CDP_PORT;
  };
  sanitizedLaunchDescriptor: SanitizedLaunchDescriptor;
  provenAt: string | null;
  reason: string | null;
};

/**
 * Independent observation of one candidate knob or combined retained set.
 * Production live evidence or controlled fixtures supply this; path creation does not.
 */
export type Phase0KnobObservation = {
  knob: Phase0CandidateKnob;
  /** True when the knob demonstrably isolated profile/home/endpoint/marker. */
  demonstratedEffect: boolean;
  /** True when the system remains correctly isolated without this knob. */
  notNecessary: boolean;
  /** Exact marker observability evidence when evaluating the marker knob. */
  marker?: {
    exactMatch: boolean;
    observedValue: string | null;
    source: "argv" | "env" | "endpoint" | null;
    /** Positive development identity accepts exact marker. */
    acceptedForDevelopment: boolean;
    /** Protected main must reject the marker as ownership proof. */
    rejectedForProtectedMain: boolean;
    /** Unrelated process must reject the marker. */
    rejectedForUnrelatedProcess: boolean;
    /** Arbitrary substring of the marker must not pass exact matching. */
    rejectedForArbitrarySubstring: boolean;
    secretFree: boolean;
  };
  pathSeparation?: {
    userDataDistinctFromMain: boolean;
    codexHomeDistinctFromUserCodex: boolean;
    explodexStateDistinctFromMainHome: boolean;
    /** Credentials/profile contents must never be inspected. */
    credentialsInspected: false;
  };
  sanitizedLaunchDescriptor?: SanitizedLaunchDescriptor;
  isolationPaths?: {
    electronUserDataPath?: string | null;
    codexHomePath?: string | null;
    explodexHomePath?: string | null;
  };
  notes?: string;
};

export type Phase0EvaluationInput = {
  /** Exact host identity frozen at operation start. */
  frozenHost: Phase0FrozenHost;
  /**
   * Optional recheck after launch/evidence. When present and different from
   * frozenHost, Phase 0 aborts as active-operation drift without reconnect.
   */
  recheckedHost?: Phase0FrozenHost | null;
  observations: Phase0KnobObservation[];
  proposedMarker: LaunchMarkerContract | null;
  layout: DevLayoutPaths;
  clockIso: string;
};

export type Phase0EvaluationResult = {
  contract: Phase0LaunchContract;
  /** True only when status is proven and every retained knob has demonstrated effect. */
  allowsLifecycleMutation: boolean;
  allowsCompatibilityProbe: boolean;
};

export type DevelopmentLifecycleGateResult =
  | {
      allowed: true;
      operation: DevelopmentLifecycleMutation;
      contract: Phase0LaunchContract;
    }
  | {
      allowed: false;
      operation: DevelopmentLifecycleMutation;
      contract: Phase0LaunchContract | null;
      error: {
        code:
          | "phase0_unproven"
          | "phase0_incomplete"
          | "phase0_host_mismatch"
          | "phase0_build_mismatch";
        message: string;
        nextAction: string;
      };
      blockedBeforeLaunchOrEvaluation: true;
    };

export type Phase0OperationProcessEvidence = {
  pid: number;
  processStartedAt: string;
  executablePath: string;
  arguments: string[];
  env: Record<string, string | undefined>;
  portOwnerPid: number | null;
  browserIdentity: string | null;
  targetId: string | null;
};

export type Phase0OperationResult =
  | {
      ok: true;
      contract: Phase0LaunchContract;
      allowsLifecycleMutation: true;
      allowsCompatibilityProbe: true;
      layout: DevLayoutPaths;
      frozenHost: Phase0FrozenHost;
      process: Phase0OperationProcessEvidence;
      protectedMainSurvived: boolean;
      grantsOwnershipFromPathsOnly: false;
    }
  | {
      ok: false;
      contract: Phase0LaunchContract;
      allowsLifecycleMutation: false;
      allowsCompatibilityProbe: false;
      layout: DevLayoutPaths | null;
      frozenHost: Phase0FrozenHost | null;
      process: Phase0OperationProcessEvidence | null;
      protectedMainSurvived: boolean;
      grantsOwnershipFromPathsOnly: false;
      error: {
        code: string;
        message: string;
      };
    };

export type OwnershipFromLayoutResult = {
  owned: false;
  reason: "paths_only_insufficient";
  message: string;
};
