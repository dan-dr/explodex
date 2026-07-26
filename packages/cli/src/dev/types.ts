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
  /**
   * Non-secret environment values bound to this launch (for example CODEX_HOME and
   * CODEX_ELECTRON_USER_DATA_PATH). Secrets are never persisted.
   */
  envValues?: Record<string, string>;
};

/** Cleanup method that must truthfully record how acceptance authority was stopped. */
export type Phase0CleanupMethod =
  | "browser-close-only"
  | "exact-signal-only"
  | "browser-close-then-signal"
  | "none";

/**
 * Attested protected-main inventory entry with the exact classifier inputs observed
 * read-only before spawn, plus the expected pure-classifier verdict.
 */
export type Phase0ProtectedMainObservation = {
  pid: number;
  processStartedAt: string;
  executablePath: string;
  arguments: string[];
  expectedVerdict: {
    owned: false;
    code: string;
  };
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

/** Factual per-side observation inside a comparative Phase 0 experiment. */
export type Phase0ExperimentSideObservation = {
  launched: boolean;
  privateRoot: string | null;
  descriptor: SanitizedLaunchDescriptor;
  pid: number | null;
  processStartedAt: string | null;
  portOwnerPid: number | null;
  browserIdentity: string | null;
  targetId: string | null;
  executionContextId: number | null;
  pathSeparation?: {
    userDataDistinctFromMain: boolean;
    codexHomeDistinctFromUserCodex: boolean;
    explodexStateDistinctFromMainHome: boolean;
    credentialsInspected: false;
  };
  exactMarkerPresent: boolean;
  ownershipAccepted: boolean;
};

/**
 * Factual comparative experiment record for one candidate knob.
 * Conclusions must be derived from treatment vs control observations, not
 * caller-supplied synthetic booleans.
 */
export type Phase0ComparativeExperiment = {
  knob: Phase0CandidateKnob;
  experimentId: string;
  treatmentLabel: string;
  controlLabel: string;
  treatment: Phase0ExperimentSideObservation;
  control: Phase0ExperimentSideObservation | null;
  conclusion: Phase0KnobEffect;
  evidence: string;
};

/** Bounded non-mutating renderer evaluation recorded with benign readiness. */
export type Phase0RendererEvaluationEvidence = {
  expression: string;
  result: unknown;
  evaluatedAt: string;
};

/** Complete readiness identity required before a proven Phase 0 contract. */
export type Phase0ReadinessEvidence = {
  pid: number;
  processStartedAt: string;
  executablePath: string;
  portOwnerPid: number;
  cdpHost: typeof DEV_CDP_HOST;
  cdpPort: typeof DEV_CDP_PORT;
  browserIdentity: string;
  /** Published PID from /json/version when present; must match the launched PID. */
  endpointPublishedPid: number | null;
  targetId: string;
  targetUrl: "app://-/index.html";
  executionContextId: number;
  executionContextUniqueId: string;
  frameId: string;
  /** Real bounded non-mutating renderer evaluation on the selected default context. */
  rendererEvaluation: Phase0RendererEvaluationEvidence;
  readiness: "benign";
};

/** Ownership classifier outcomes retained with a proven or incomplete contract. */
export type Phase0OwnershipEvidence = {
  positive: {
    owned: boolean;
    code: string;
    reasons: string[];
  };
  negatives: Array<{
    role: string;
    owned: false;
    code: string;
    reasons: string[];
  }>;
};

/**
 * Acceptance-correlated authority facts that must be persisted and re-derived with a proven contract.
 * Comparative experiment records remain separate causal evidence.
 *
 * `mode` distinguishes stopped acceptance (port released) from intentional keep-alive
 * acceptance used by the exact-current-host compatibility probe. Keep-alive never
 * pretends the process stopped; it records residual owned 9444 authority explicitly.
 */
export type Phase0AcceptanceAuthority = {
  /** One acceptance operation identity binding readiness, descriptor, ownership, and cleanup. */
  operationId: string;
  readinessPid: number;
  readinessProcessStartedAt: string;
  /**
   * Always true when the inventory was collected. Distinguishes an attested zero inventory
   * (empty protectedMainBefore with this flag) from omission of inventory evidence.
   */
  protectedMainInventoryAttested: true;
  /**
   * Every pre-existing exact canonical ChatGPT process identity captured before spawn,
   * including classifier inputs (executable/argv) and expected pure-classifier verdict.
   * Empty array means attested zero protected mains, never an omitted inventory.
   */
  protectedMainBefore: Phase0ProtectedMainObservation[];
  /** Post-cleanup survival of each protected-main identity. */
  protectedMainAfter: Array<{
    pid: number;
    processStartedAt: string;
    survived: boolean;
  }>;
  /** Final frozen-host recheck identity that must equal the operation freeze. */
  finalHostRecheck: Phase0FrozenHost;
  cleanupDisposition: {
    method: Phase0CleanupMethod;
    stopped: boolean;
    portReleased: boolean;
    uncertain: boolean;
    reason?: string;
  };
  /**
   * True only when 9444 is free after acceptance cleanup (zero remaining listeners).
   * Keep-alive acceptance intentionally leaves this false.
   */
  port9444Released: boolean;
  /**
   * Acceptance mode. Omitted or `"stopped"` requires exact stop + 9444 release.
   * `"keep-alive"` authorizes residual owned process authority for the compatibility probe.
   */
  mode?: "stopped" | "keep-alive";
};

/**
 * Minimal retained isolation/marker set for development launches.
 * Incomplete contracts keep lifecycle mutation and compatibility probing disabled.
 * Schema 2 requires factual comparative experiments and complete readiness for proven.
 */
export type Phase0LaunchContract = {
  schemaVersion: 2;
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
  /** Factual comparative experiment records (empty only for pre-spawn incomplete). */
  comparativeExperiments: Phase0ComparativeExperiment[];
  launchMarker: LaunchMarkerContract | null;
  isolation: {
    electronUserDataPath: string | null;
    codexHomePath: string | null;
    explodexHomePath: string | null;
    cdpHost: typeof DEV_CDP_HOST;
    cdpPort: typeof DEV_CDP_PORT;
  };
  readiness: Phase0ReadinessEvidence | null;
  ownership: Phase0OwnershipEvidence | null;
  sanitizedLaunchDescriptor: SanitizedLaunchDescriptor;
  /**
   * Acceptance-correlated survivors/cleanup/host recheck. Required non-null for proven.
   * Null for incomplete/disabled non-authorizing contracts.
   */
  acceptanceAuthority: Phase0AcceptanceAuthority | null;
  /**
   * Independently persisted enclosing acceptance operation identity.
   * Outside acceptanceAuthority and required for proven contracts. Must equal
   * acceptanceAuthority.operationId during construction, evaluation, parsing,
   * round-trip, and lifecycle authorization; changing either alone fails closed.
   */
  acceptanceOperationId: string | null;
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
  /**
   * @deprecated Prefer comparativeExperiments. Retained only for unit evaluation
   * of marker/path predicates when experiments are already reduced to observations.
   */
  observations?: Phase0KnobObservation[];
  /** Factual comparative experiment records required for production proof. */
  comparativeExperiments?: Phase0ComparativeExperiment[];
  proposedMarker: LaunchMarkerContract | null;
  layout: DevLayoutPaths;
  clockIso: string;
  /** Required for proven contracts; missing readiness keeps status incomplete. */
  readiness?: Phase0ReadinessEvidence | null;
  /** Required for proven contracts; positive must be owned with all negatives rejected. */
  ownership?: Phase0OwnershipEvidence | null;
  /**
   * Acceptance-launch sanitized descriptor correlated to the exact readiness PID.
   * Comparative experiment descriptors remain separate causal evidence.
   */
  acceptanceLaunchDescriptor?: SanitizedLaunchDescriptor;
  /**
   * Acceptance-correlated survivors/cleanup/final host recheck required for proven.
   */
  acceptanceAuthority?: Phase0AcceptanceAuthority | null;
  /**
   * Independently generated enclosing acceptance operation identity. Required when
   * complete proof includes acceptance authority; must equal acceptanceAuthority.operationId.
   */
  acceptanceOperationId?: string | null;
  /**
   * When true, require comparative experiments + readiness + ownership for proof.
   * Operation-level evaluation always sets this. Pure unit knob tests may omit it.
   */
  requireCompleteProof?: boolean;
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
  executionContextId: number | null;
  executionContextUniqueId: string | null;
  frameId: string | null;
  readiness: "benign" | "incomplete";
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
