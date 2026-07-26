import type { HostAdapters } from "../host/adapters.ts";
import type { HostIdentity } from "../host/types.ts";
import {
  DEV_CDP_HOST,
  DEV_CDP_PORT,
  DEV_DIRECTORY_MODE,
  PHASE0_CANDIDATE_KNOBS,
  PHASE0_CONTRACT_SCHEMA_VERSION,
  type Phase0CandidateKnob,
} from "./constants.ts";
import type {
  DevLayoutPaths,
  LaunchMarkerContract,
  Phase0ComparativeExperiment,
  Phase0EvaluationInput,
  Phase0EvaluationResult,
  Phase0FrozenHost,
  Phase0KnobObservation,
  Phase0KnobVerdict,
  Phase0LaunchContract,
  Phase0OwnershipEvidence,
  Phase0ReadinessEvidence,
  SanitizedLaunchDescriptor,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Normalize host identity into the secret-free Phase 0 freeze shape. */
export function freezeHostIdentity(host: HostIdentity | Phase0FrozenHost): Phase0FrozenHost {
  return {
    bundlePath: host.bundlePath,
    executablePath: host.executablePath,
    bundleId: host.bundleId,
    executableName: host.executableName,
    signingTeam: host.signingTeam,
    appVersion: host.appVersion,
    appBuild: host.appBuild,
    hostHashes: { ...host.hostHashes },
  };
}

/** Exact equality of frozen host identity fields (including relevant hashes). */
export function frozenHostEquals(
  left: Phase0FrozenHost | null | undefined,
  right: Phase0FrozenHost | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  if (
    left.bundlePath !== right.bundlePath ||
    left.executablePath !== right.executablePath ||
    left.bundleId !== right.bundleId ||
    left.executableName !== right.executableName ||
    left.signingTeam !== right.signingTeam ||
    left.appVersion !== right.appVersion ||
    left.appBuild !== right.appBuild
  ) {
    return false;
  }
  const leftKeys = Object.keys(left.hostHashes).sort();
  const rightKeys = Object.keys(right.hostHashes).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!;
    if (key !== rightKeys[index]) return false;
    if (left.hostHashes[key] !== right.hostHashes[key]) return false;
  }
  return true;
}

function incompleteContract(options: {
  frozenHost: Phase0FrozenHost | null;
  appBuild: string;
  appVersion?: string | null;
  reason: string;
  knobMatrix: Phase0KnobVerdict[];
  retainedKnobs?: Phase0CandidateKnob[];
  launchMarker?: LaunchMarkerContract | null;
  isolation?: Phase0LaunchContract["isolation"];
  sanitizedLaunchDescriptor?: SanitizedLaunchDescriptor;
  comparativeExperiments?: Phase0ComparativeExperiment[];
  readiness?: Phase0ReadinessEvidence | null;
  ownership?: Phase0OwnershipEvidence | null;
}): Phase0LaunchContract {
  return {
    schemaVersion: PHASE0_CONTRACT_SCHEMA_VERSION,
    status: "incomplete",
    frozenHost: options.frozenHost,
    appBuild: options.appBuild,
    appVersion: options.appVersion ?? options.frozenHost?.appVersion ?? null,
    retainedKnobs: options.retainedKnobs ?? [],
    knobMatrix: options.knobMatrix,
    comparativeExperiments: options.comparativeExperiments ?? [],
    launchMarker: options.launchMarker ?? null,
    isolation: options.isolation ?? {
      electronUserDataPath: null,
      codexHomePath: null,
      explodexHomePath: null,
      cdpHost: DEV_CDP_HOST,
      cdpPort: DEV_CDP_PORT,
    },
    readiness: options.readiness ?? null,
    ownership: options.ownership ?? null,
    sanitizedLaunchDescriptor: options.sanitizedLaunchDescriptor ?? {
      argv: [],
      envKeys: [],
    },
    provenAt: null,
    reason: options.reason,
  };
}

/** Validate complete readiness identity; any gap leaves proof incomplete. */
export function validatePhase0Readiness(
  readiness: Phase0ReadinessEvidence | null | undefined,
  frozenHost: Phase0FrozenHost,
): { ok: true; readiness: Phase0ReadinessEvidence } | { ok: false; reason: string } {
  if (readiness === null || readiness === undefined) {
    return { ok: false, reason: "Phase 0 readiness evidence is missing." };
  }
  if (!Number.isInteger(readiness.pid) || readiness.pid <= 0) {
    return { ok: false, reason: "Phase 0 readiness requires an exact positive PID." };
  }
  if (!isNonEmptyString(readiness.processStartedAt)) {
    return { ok: false, reason: "Phase 0 readiness requires kernel process start identity." };
  }
  if (readiness.executablePath !== frozenHost.executablePath) {
    return {
      ok: false,
      reason: "Phase 0 readiness executable does not match the frozen host executable.",
    };
  }
  if (readiness.portOwnerPid !== readiness.pid) {
    return {
      ok: false,
      reason: "Phase 0 readiness requires the unique 127.0.0.1:9444 listener owner to match the launched PID.",
    };
  }
  if (readiness.cdpHost !== DEV_CDP_HOST || readiness.cdpPort !== DEV_CDP_PORT) {
    return {
      ok: false,
      reason: "Phase 0 readiness endpoint must be exactly 127.0.0.1:9444.",
    };
  }
  if (!isNonEmptyString(readiness.browserIdentity)) {
    return { ok: false, reason: "Phase 0 readiness requires /json/version browser identity." };
  }
  if (
    readiness.endpointPublishedPid !== null &&
    readiness.endpointPublishedPid !== readiness.pid
  ) {
    return {
      ok: false,
      reason:
        "Phase 0 readiness rejects /json/version published PID disagreement with the launched process.",
    };
  }
  if (!isNonEmptyString(readiness.targetId) || readiness.targetUrl !== "app://-/index.html") {
    return {
      ok: false,
      reason: "Phase 0 readiness requires exactly one app://-/index.html target identity.",
    };
  }
  if (!Number.isInteger(readiness.executionContextId) || readiness.executionContextId < 0) {
    return { ok: false, reason: "Phase 0 readiness requires one default execution context id." };
  }
  if (!isNonEmptyString(readiness.executionContextUniqueId)) {
    return {
      ok: false,
      reason: "Phase 0 readiness requires a non-empty execution context unique id.",
    };
  }
  if (!isNonEmptyString(readiness.frameId)) {
    return { ok: false, reason: "Phase 0 readiness requires a frame id for the default context." };
  }
  if (
    readiness.rendererEvaluation === undefined ||
    readiness.rendererEvaluation === null ||
    !isNonEmptyString(readiness.rendererEvaluation.expression) ||
    !isNonEmptyString(readiness.rendererEvaluation.evaluatedAt) ||
    readiness.rendererEvaluation.result === undefined
  ) {
    return {
      ok: false,
      reason:
        "Phase 0 readiness requires a real bounded non-mutating renderer evaluation on the selected default context.",
    };
  }
  if (readiness.readiness !== "benign") {
    return { ok: false, reason: "Phase 0 readiness evidence must report benign readiness." };
  }
  return { ok: true, readiness };
}

/** Validate ownership evidence: positive owned, all controlled negatives rejected. */
export function validatePhase0Ownership(
  ownership: Phase0OwnershipEvidence | null | undefined,
): { ok: true; ownership: Phase0OwnershipEvidence } | { ok: false; reason: string } {
  if (ownership === null || ownership === undefined) {
    return { ok: false, reason: "Phase 0 ownership classifier evidence is missing." };
  }
  if (!ownership.positive.owned || ownership.positive.code !== "owned") {
    return {
      ok: false,
      reason: "Phase 0 positive ownership classifier did not accept the development process.",
    };
  }
  if (ownership.negatives.length === 0) {
    return {
      ok: false,
      reason: "Phase 0 must record controlled ownership negatives from the pure classifier.",
    };
  }
  for (const negative of ownership.negatives) {
    if (negative.owned !== false) {
      return {
        ok: false,
        reason: `Ownership negative for role '${negative.role}' incorrectly reports owned.`,
      };
    }
  }
  const requiredRoles = new Set([
    "protected-main",
    "unrelated",
    "arbitrary-substring",
    "pid-reuse",
    "wrong-endpoint",
    "conflicting-source",
  ]);
  for (const role of requiredRoles) {
    if (!ownership.negatives.some((entry) => entry.role === role)) {
      return {
        ok: false,
        reason: `Phase 0 ownership negatives omit controlled role '${role}'.`,
      };
    }
  }
  return { ok: true, ownership };
}

/**
 * Derive a knob verdict from a factual comparative experiment record.
 * Caller-supplied conclusions are cross-checked against treatment/control facts.
 */
export function deriveKnobVerdictFromExperiment(
  experiment: Phase0ComparativeExperiment,
): Phase0KnobVerdict {
  const treatment = experiment.treatment;
  const control = experiment.control;

  if (!treatment.launched && experiment.knob !== "explodex-home") {
    return {
      name: experiment.knob,
      status: "omitted",
      effect: "missing",
      evidence: experiment.evidence || `No treatment launch for knob '${experiment.knob}'.`,
    };
  }

  if (experiment.knob === "electron-user-data") {
    const sep = treatment.pathSeparation;
    const demonstrated =
      treatment.launched &&
      sep !== undefined &&
      sep.userDataDistinctFromMain &&
      sep.credentialsInspected === false &&
      (control === null ||
        control.launched === false ||
        control.pathSeparation?.userDataDistinctFromMain === false ||
        !control.ownershipAccepted);
    if (demonstrated) {
      return {
        name: experiment.knob,
        status: "retained",
        effect: "demonstrated",
        evidence:
          experiment.evidence ||
          "Treatment user-data root is distinct from the protected main profile; control without the carrier fails isolation/ownership comparison.",
      };
    }
    return {
      name: experiment.knob,
      status: "omitted",
      effect: demonstrated === false && treatment.launched ? "ambiguous" : "missing",
      evidence: experiment.evidence || "electron-user-data comparison did not demonstrate isolation.",
    };
  }

  if (experiment.knob === "codex-home") {
    const sep = treatment.pathSeparation;
    const demonstrated =
      treatment.launched &&
      sep !== undefined &&
      sep.codexHomeDistinctFromUserCodex &&
      sep.credentialsInspected === false &&
      (control === null ||
        control.launched === false ||
        control.pathSeparation?.codexHomeDistinctFromUserCodex === false ||
        !control.ownershipAccepted);
    if (demonstrated) {
      return {
        name: experiment.knob,
        status: "retained",
        effect: "demonstrated",
        evidence:
          experiment.evidence ||
          "Treatment CODEX_HOME is distinct from ~/.codex; control comparison demonstrates the effect.",
      };
    }
    return {
      name: experiment.knob,
      status: "omitted",
      effect: treatment.launched ? "ambiguous" : "missing",
      evidence: experiment.evidence || "CODEX_HOME comparison did not demonstrate isolation.",
    };
  }

  if (experiment.knob === "explodex-home") {
    // Non-necessity: treatment without EXPLODEX_HOME still isolates via private explodex-state.
    const notNecessary =
      treatment.launched &&
      treatment.ownershipAccepted &&
      treatment.pathSeparation?.explodexStateDistinctFromMainHome === true &&
      (control === null ||
        !control.launched ||
        control.ownershipAccepted === treatment.ownershipAccepted);
    if (notNecessary) {
      return {
        name: experiment.knob,
        status: "omitted",
        effect: "not-necessary",
        evidence:
          experiment.evidence ||
          "Instance-private explodex-state isolates without EXPLODEX_HOME; comparator does not require the env knob.",
      };
    }
    if (treatment.launched && treatment.ownershipAccepted === false && control?.ownershipAccepted) {
      return {
        name: experiment.knob,
        status: "retained",
        effect: "demonstrated",
        evidence:
          experiment.evidence ||
          "EXPLODEX_HOME demonstrated an isolation effect relative to the private-state control.",
      };
    }
    return {
      name: experiment.knob,
      status: "omitted",
      effect: treatment.launched ? "ambiguous" : "missing",
      evidence: experiment.evidence || "EXPLODEX_HOME comparison is incomplete or ambiguous.",
    };
  }

  if (experiment.knob === "cdp-port") {
    const demonstrated =
      treatment.launched &&
      treatment.portOwnerPid !== null &&
      treatment.pid !== null &&
      treatment.portOwnerPid === treatment.pid &&
      treatment.browserIdentity !== null &&
      (control === null ||
        !control.launched ||
        control.portOwnerPid !== control.pid ||
        control.browserIdentity === null);
    if (demonstrated) {
      return {
        name: experiment.knob,
        status: "retained",
        effect: "demonstrated",
        evidence:
          experiment.evidence ||
          "Treatment owns unique 127.0.0.1:9444 with browser identity; control without the declared port fails ownership.",
      };
    }
    return {
      name: experiment.knob,
      status: "omitted",
      effect: treatment.launched ? "ambiguous" : "missing",
      evidence: experiment.evidence || "Declared CDP port comparison did not demonstrate ownership.",
    };
  }

  // launch-marker
  const demonstrated =
    treatment.launched &&
    treatment.exactMarkerPresent &&
    treatment.ownershipAccepted &&
    (control === null ||
      !control.launched ||
      !control.exactMarkerPresent ||
      !control.ownershipAccepted);
  if (demonstrated) {
    return {
      name: experiment.knob,
      status: "retained",
      effect: "demonstrated",
      evidence:
        experiment.evidence ||
        "Exact marker present in treatment process evidence and required for ownership; control without exact marker is rejected.",
    };
  }
  return {
    name: experiment.knob,
    status: "omitted",
    effect: treatment.launched ? "ambiguous" : "missing",
    evidence: experiment.evidence || "Launch-marker comparison did not demonstrate exact ownership.",
  };
}

function observationsFromExperiments(
  experiments: Phase0ComparativeExperiment[],
): Phase0KnobObservation[] {
  const observations: Phase0KnobObservation[] = [];
  for (const experiment of experiments) {
    const verdict = deriveKnobVerdictFromExperiment(experiment);
    const treatment = experiment.treatment;
    observations.push({
      knob: experiment.knob,
      demonstratedEffect: verdict.effect === "demonstrated",
      notNecessary: verdict.effect === "not-necessary",
      pathSeparation: treatment.pathSeparation,
      marker:
        experiment.knob === "launch-marker"
          ? {
              exactMatch: treatment.exactMarkerPresent,
              observedValue: treatment.exactMarkerPresent
                ? treatment.descriptor.argv.find((token) =>
                    token.startsWith("--explodex-dev-instance="),
                  ) ?? null
                : null,
              source: "argv",
              acceptedForDevelopment: treatment.ownershipAccepted && treatment.exactMarkerPresent,
              // Controlled classifier negatives supply protected-main / unrelated / substring.
              rejectedForProtectedMain: true,
              rejectedForUnrelatedProcess: true,
              rejectedForArbitrarySubstring: controlRejectsSubstring(experiment),
              secretFree: true,
            }
          : undefined,
      sanitizedLaunchDescriptor: treatment.descriptor,
      isolationPaths: {
        electronUserDataPath: treatment.privateRoot
          ? `${treatment.privateRoot}/electron-user-data`
          : null,
        codexHomePath: treatment.privateRoot ? `${treatment.privateRoot}/codex-home` : null,
        explodexHomePath: treatment.privateRoot ? `${treatment.privateRoot}/explodex-state` : null,
      },
      notes: experiment.evidence,
    });
  }
  return observations;
}

function controlRejectsSubstring(experiment: Phase0ComparativeExperiment): boolean {
  if (experiment.control === null) return true;
  return (
    experiment.control.launched &&
    !experiment.control.exactMarkerPresent &&
    !experiment.control.ownershipAccepted
  );
}

/**
 * Semantically re-derive comparative matrix conclusions and require a unique complete set.
 * Structurally valid but forged or round-trip-inconsistent evidence fails closed.
 */
export function validateCompleteComparativeMatrix(
  experiments: readonly Phase0ComparativeExperiment[],
  knobMatrix: readonly Phase0KnobVerdict[],
): { ok: true } | { ok: false; reason: string } {
  if (experiments.length !== PHASE0_CANDIDATE_KNOBS.length) {
    return {
      ok: false,
      reason:
        "Phase 0 complete proof requires exactly one factual comparative experiment for every candidate knob.",
    };
  }
  const seenKnobs = new Set<Phase0CandidateKnob>();
  const experimentIds = new Set<string>();
  const privateRoots = new Set<string>();
  for (const experiment of experiments) {
    if (seenKnobs.has(experiment.knob)) {
      return {
        ok: false,
        reason: `Phase 0 comparative matrix has a duplicate experiment for knob '${experiment.knob}'.`,
      };
    }
    seenKnobs.add(experiment.knob);
    if (experimentIds.has(experiment.experimentId)) {
      return {
        ok: false,
        reason: `Phase 0 comparative matrix has a duplicate experimentId '${experiment.experimentId}'.`,
      };
    }
    experimentIds.add(experiment.experimentId);

    const rederived = deriveKnobVerdictFromExperiment(experiment);
    if (rederived.effect !== experiment.conclusion) {
      return {
        ok: false,
        reason: `Phase 0 experiment for '${experiment.knob}' conclusion '${experiment.conclusion}' does not survive round-trip re-derivation (got '${rederived.effect}').`,
      };
    }

    for (const side of [experiment.treatment, experiment.control] as const) {
      if (side === null || side.privateRoot === null || side.privateRoot.length === 0) continue;
      if (privateRoots.has(side.privateRoot)) {
        return {
          ok: false,
          reason:
            "Phase 0 comparative sides must use distinct private roots; cached/replayed launch identities are rejected.",
        };
      }
      privateRoots.add(side.privateRoot);
    }
  }
  for (const knob of PHASE0_CANDIDATE_KNOBS) {
    if (!seenKnobs.has(knob)) {
      return {
        ok: false,
        reason: `Phase 0 comparative matrix is missing candidate knob '${knob}'.`,
      };
    }
  }

  const matrixNames = new Set(knobMatrix.map((entry) => entry.name));
  if (matrixNames.size !== PHASE0_CANDIDATE_KNOBS.length) {
    return {
      ok: false,
      reason: "Phase 0 knob matrix must contain each candidate knob exactly once.",
    };
  }
  for (const knob of PHASE0_CANDIDATE_KNOBS) {
    if (!matrixNames.has(knob)) {
      return {
        ok: false,
        reason: `Phase 0 knob matrix is missing candidate knob '${knob}'.`,
      };
    }
  }

  const retainedFromMatrix = new Set(
    knobMatrix.filter((entry) => entry.status === "retained").map((entry) => entry.name),
  );
  const retainedFromConclusions = new Set(
    experiments
      .filter((entry) => entry.conclusion === "demonstrated")
      .map((entry) => entry.knob),
  );
  if (retainedFromMatrix.size !== retainedFromConclusions.size) {
    return {
      ok: false,
      reason:
        "Phase 0 retained knobs and comparative demonstrated conclusions disagree in size.",
    };
  }
  for (const knob of retainedFromMatrix) {
    if (!retainedFromConclusions.has(knob)) {
      return {
        ok: false,
        reason: `Phase 0 retained set and comparative conclusions disagree on knob '${knob}'.`,
      };
    }
  }
  for (const entry of knobMatrix) {
    const experiment = experiments.find((item) => item.knob === entry.name);
    if (experiment === undefined) {
      return {
        ok: false,
        reason: `Phase 0 knob matrix entry '${entry.name}' has no comparative experiment.`,
      };
    }
    const rederived = deriveKnobVerdictFromExperiment(experiment);
    if (entry.status !== rederived.status || entry.effect !== rederived.effect) {
      return {
        ok: false,
        reason: `Phase 0 knob matrix entry for '${entry.name}' does not match re-derived comparative verdict.`,
      };
    }
  }
  return { ok: true };
}

function observationFor(
  observations: Phase0KnobObservation[],
  knob: Phase0CandidateKnob,
): Phase0KnobObservation | undefined {
  return observations.find((entry) => entry.knob === knob);
}

function evaluateKnob(
  knob: Phase0CandidateKnob,
  observation: Phase0KnobObservation | undefined,
): Phase0KnobVerdict {
  if (observation === undefined) {
    return {
      name: knob,
      status: "omitted",
      effect: "missing",
      evidence: `No independent observation for candidate knob '${knob}'.`,
    };
  }

  if (observation.demonstratedEffect && observation.notNecessary) {
    return {
      name: knob,
      status: "omitted",
      effect: "ambiguous",
      evidence:
        observation.notes ??
        `Knob '${knob}' reported both demonstrated effect and non-necessity; treat as ambiguous.`,
    };
  }

  if (observation.demonstratedEffect) {
    return {
      name: knob,
      status: "retained",
      effect: "demonstrated",
      evidence: observation.notes ?? `Knob '${knob}' demonstrated isolation/ownership effect.`,
    };
  }

  if (observation.notNecessary) {
    return {
      name: knob,
      status: "omitted",
      effect: "not-necessary",
      evidence: observation.notes ?? `Knob '${knob}' is not necessary for isolation/ownership.`,
    };
  }

  return {
    name: knob,
    status: "omitted",
    effect: "ambiguous",
    evidence:
      observation.notes ??
      `Knob '${knob}' observation neither demonstrated effect nor non-necessity.`,
  };
}

function validateMarker(
  observation: Phase0KnobObservation | undefined,
  proposed: LaunchMarkerContract | null,
): { ok: true; marker: LaunchMarkerContract } | { ok: false; reason: string } {
  if (proposed === null) {
    return { ok: false, reason: "Launch marker is required in the retained Phase 0 set." };
  }
  if (!isNonEmptyString(proposed.value)) {
    return { ok: false, reason: "Launch marker value must be a non-empty exact token." };
  }
  // Secret-like marker values are rejected (no tokens/passwords).
  if (/token|secret|password|cookie|authorization/i.test(proposed.value)) {
    return { ok: false, reason: "Launch marker must be secret-free." };
  }
  if (observation === undefined || observation.marker === undefined) {
    return {
      ok: false,
      reason: "Launch marker lacks independent exact observability evidence.",
    };
  }
  const marker = observation.marker;
  if (!marker.secretFree) {
    return { ok: false, reason: "Launch marker evidence reports secret-bearing content." };
  }
  if (!marker.exactMatch || marker.observedValue !== proposed.value) {
    return {
      ok: false,
      reason: "Launch marker must be exact-matched in process/endpoint evidence, not substring-matched.",
    };
  }
  if (!marker.acceptedForDevelopment) {
    return {
      ok: false,
      reason: "Launch marker was not accepted for the development role identity.",
    };
  }
  if (!marker.rejectedForProtectedMain) {
    return {
      ok: false,
      reason: "Launch marker must be rejected as ownership proof for the protected main.",
    };
  }
  if (!marker.rejectedForUnrelatedProcess) {
    return {
      ok: false,
      reason: "Launch marker must be rejected for controlled unrelated processes.",
    };
  }
  if (!marker.rejectedForArbitrarySubstring) {
    return {
      ok: false,
      reason: "Launch marker must reject arbitrary-substring positive matches.",
    };
  }
  return { ok: true, marker: proposed };
}

function validatePathSeparation(
  observation: Phase0KnobObservation | undefined,
  knob: Phase0CandidateKnob,
): string | null {
  if (observation?.pathSeparation === undefined) return null;
  const paths = observation.pathSeparation;
  if (paths.credentialsInspected !== false) {
    return `Knob '${knob}' path evidence must never inspect credential contents.`;
  }
  if (
    knob === "electron-user-data" &&
    observation.demonstratedEffect &&
    !paths.userDataDistinctFromMain
  ) {
    return "electron-user-data isolation must prove separation from the protected main profile.";
  }
  if (knob === "codex-home" && observation.demonstratedEffect && !paths.codexHomeDistinctFromUserCodex) {
    return "CODEX_HOME isolation must prove separation from ~/.codex.";
  }
  if (
    knob === "explodex-home" &&
    observation.demonstratedEffect &&
    !paths.explodexStateDistinctFromMainHome
  ) {
    return "EXPLODEX_HOME isolation must prove separation from the normal Explodex home.";
  }
  return null;
}

/**
 * Evaluate independent Phase 0 knob observations / comparative experiments into
 * the minimal retained launch contract. Incomplete, ambiguous, or active-operation
 * host-drift evidence keeps mutation disabled. Historical difference from dated
 * observations is not a blocker; only the operation freeze is.
 */
export function evaluatePhase0LaunchContract(
  input: Phase0EvaluationInput,
): Phase0EvaluationResult {
  const frozenHost = freezeHostIdentity(input.frozenHost);
  const comparativeExperiments = input.comparativeExperiments ?? [];
  const observations =
    input.observations ??
    (comparativeExperiments.length > 0
      ? observationsFromExperiments(comparativeExperiments)
      : []);

  if (input.recheckedHost !== undefined && input.recheckedHost !== null) {
    const rechecked = freezeHostIdentity(input.recheckedHost);
    if (!frozenHostEquals(frozenHost, rechecked)) {
      const matrix =
        comparativeExperiments.length > 0
          ? PHASE0_CANDIDATE_KNOBS.map((knob) => {
              const experiment = comparativeExperiments.find((entry) => entry.knob === knob);
              return experiment
                ? deriveKnobVerdictFromExperiment(experiment)
                : evaluateKnob(knob, undefined);
            })
          : PHASE0_CANDIDATE_KNOBS.map((knob) =>
              evaluateKnob(knob, observationFor(observations, knob)),
            );
      const contract = incompleteContract({
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        reason:
          "Active-operation host identity drifted from the frozen Phase 0 identity; abort without reconnect or authority transfer.",
        knobMatrix: matrix,
        comparativeExperiments,
        readiness: input.readiness ?? null,
        ownership: input.ownership ?? null,
      });
      return {
        contract,
        allowsLifecycleMutation: false,
        allowsCompatibilityProbe: false,
      };
    }
  }

  const knobMatrix: Phase0KnobVerdict[] = [];
  for (const knob of PHASE0_CANDIDATE_KNOBS) {
    const experiment = comparativeExperiments.find((entry) => entry.knob === knob);
    if (experiment !== undefined) {
      knobMatrix.push(deriveKnobVerdictFromExperiment(experiment));
      continue;
    }
    const observation = observationFor(observations, knob);
    const separationError = validatePathSeparation(observation, knob);
    if (separationError !== null) {
      knobMatrix.push({
        name: knob,
        status: "omitted",
        effect: "ambiguous",
        evidence: separationError,
      });
      continue;
    }
    knobMatrix.push(evaluateKnob(knob, observation));
  }

  const missingOrAmbiguous = knobMatrix.filter(
    (verdict) => verdict.effect === "missing" || verdict.effect === "ambiguous",
  );
  if (missingOrAmbiguous.length > 0) {
    const contract = incompleteContract({
      frozenHost,
      appBuild: frozenHost.appBuild,
      appVersion: frozenHost.appVersion,
      reason: `Incomplete or ambiguous Phase 0 knob evidence: ${missingOrAmbiguous
        .map((entry) => entry.name)
        .join(", ")}.`,
      knobMatrix,
      comparativeExperiments,
      readiness: input.readiness ?? null,
      ownership: input.ownership ?? null,
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

  const retainedKnobs = knobMatrix
    .filter((verdict) => verdict.status === "retained")
    .map((verdict) => verdict.name);

  // Marker is always required for exact ownership (architecture §15.2 / VAL-HOST-007).
  if (!retainedKnobs.includes("launch-marker")) {
    const contract = incompleteContract({
      frozenHost,
      appBuild: frozenHost.appBuild,
      appVersion: frozenHost.appVersion,
      reason: "Phase 0 must retain an exact secret-free launch marker with independent observability.",
      knobMatrix,
      retainedKnobs,
      comparativeExperiments,
      readiness: input.readiness ?? null,
      ownership: input.ownership ?? null,
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

  // CDP port is always required for the exact development-role endpoint.
  if (!retainedKnobs.includes("cdp-port")) {
    const contract = incompleteContract({
      frozenHost,
      appBuild: frozenHost.appBuild,
      appVersion: frozenHost.appVersion,
      reason: "Phase 0 must retain the declared development CDP port 9444 as the role endpoint.",
      knobMatrix,
      retainedKnobs,
      comparativeExperiments,
      readiness: input.readiness ?? null,
      ownership: input.ownership ?? null,
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

  // At least one home/profile isolation knob must be retained.
  const isolationHomeKnobs = retainedKnobs.filter(
    (name) =>
      name === "electron-user-data" || name === "codex-home" || name === "explodex-home",
  );
  if (isolationHomeKnobs.length === 0) {
    const contract = incompleteContract({
      frozenHost,
      appBuild: frozenHost.appBuild,
      appVersion: frozenHost.appVersion,
      reason:
        "Phase 0 must retain at least one demonstrated profile/home isolation knob (electron-user-data, CODEX_HOME, or EXPLODEX_HOME).",
      knobMatrix,
      retainedKnobs,
      comparativeExperiments,
      readiness: input.readiness ?? null,
      ownership: input.ownership ?? null,
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

  const markerObservation = observationFor(observations, "launch-marker");
  const markerResult = validateMarker(markerObservation, input.proposedMarker);
  if (!markerResult.ok) {
    const contract = incompleteContract({
      frozenHost,
      appBuild: frozenHost.appBuild,
      appVersion: frozenHost.appVersion,
      reason: markerResult.reason,
      knobMatrix,
      retainedKnobs,
      launchMarker: input.proposedMarker,
      comparativeExperiments,
      readiness: input.readiness ?? null,
      ownership: input.ownership ?? null,
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

  // Proven isolation paths and the sanitized launch descriptor must correlate to the
  // acceptance layout / launch identity. Comparative experiment private roots remain
  // separate causal evidence and must never become persisted acceptance authority.
  const isolation = {
    electronUserDataPath: retainedKnobs.includes("electron-user-data")
      ? input.layout.electronUserDataPath
      : null,
    codexHomePath: retainedKnobs.includes("codex-home") ? input.layout.codexHomePath : null,
    explodexHomePath: retainedKnobs.includes("explodex-home")
      ? input.layout.explodexStatePath
      : null,
    cdpHost: DEV_CDP_HOST as typeof DEV_CDP_HOST,
    cdpPort: DEV_CDP_PORT as typeof DEV_CDP_PORT,
  };

  // Only non-complete unit paths may fall back to observation paths, and never when
  // those paths are experiment private roots under an acceptance layout.
  if (input.requireCompleteProof !== true) {
    for (const observation of observations) {
      if (observation.isolationPaths === undefined) continue;
      if (
        retainedKnobs.includes("electron-user-data") &&
        observation.isolationPaths.electronUserDataPath
      ) {
        isolation.electronUserDataPath = observation.isolationPaths.electronUserDataPath;
      }
      if (retainedKnobs.includes("codex-home") && observation.isolationPaths.codexHomePath) {
        isolation.codexHomePath = observation.isolationPaths.codexHomePath;
      }
      if (retainedKnobs.includes("explodex-home") && observation.isolationPaths.explodexHomePath) {
        isolation.explodexHomePath = observation.isolationPaths.explodexHomePath;
      }
    }
  }

  const descriptor =
    input.acceptanceLaunchDescriptor ??
    markerObservation?.sanitizedLaunchDescriptor ??
    observations.find((entry) => entry.sanitizedLaunchDescriptor)?.sanitizedLaunchDescriptor ?? {
      argv: [],
      envKeys: [],
    };

  // Operation-level proof requires comparative experiments, readiness, and ownership.
  if (input.requireCompleteProof === true) {
    const matrixValidation = validateCompleteComparativeMatrix(comparativeExperiments, knobMatrix);
    if (!matrixValidation.ok) {
      const contract = incompleteContract({
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        reason: matrixValidation.reason,
        knobMatrix,
        retainedKnobs,
        launchMarker: markerResult.marker,
        isolation,
        sanitizedLaunchDescriptor: descriptor,
        comparativeExperiments,
        readiness: input.readiness ?? null,
        ownership: input.ownership ?? null,
      });
      return {
        contract,
        allowsLifecycleMutation: false,
        allowsCompatibilityProbe: false,
      };
    }

    // Acceptance isolation must never name deleted experiment private roots.
    for (const experiment of comparativeExperiments) {
      for (const side of [experiment.treatment, experiment.control]) {
        if (side === null || side.privateRoot === null) continue;
        const root = side.privateRoot;
        if (
          isolation.electronUserDataPath?.startsWith(`${root}/`) ||
          isolation.codexHomePath?.startsWith(`${root}/`) ||
          isolation.explodexHomePath?.startsWith(`${root}/`)
        ) {
          const contract = incompleteContract({
            frozenHost,
            appBuild: frozenHost.appBuild,
            appVersion: frozenHost.appVersion,
            reason:
              "Proven isolation paths must correlate to the acceptance layout, not experiment private roots.",
            knobMatrix,
            retainedKnobs,
            launchMarker: markerResult.marker,
            isolation,
            sanitizedLaunchDescriptor: descriptor,
            comparativeExperiments,
            readiness: input.readiness ?? null,
            ownership: input.ownership ?? null,
          });
          return {
            contract,
            allowsLifecycleMutation: false,
            allowsCompatibilityProbe: false,
          };
        }
      }
    }

    const readinessResult = validatePhase0Readiness(input.readiness, frozenHost);
    if (!readinessResult.ok) {
      const contract = incompleteContract({
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        reason: readinessResult.reason,
        knobMatrix,
        retainedKnobs,
        launchMarker: markerResult.marker,
        isolation,
        sanitizedLaunchDescriptor: descriptor,
        comparativeExperiments,
        readiness: input.readiness ?? null,
        ownership: input.ownership ?? null,
      });
      return {
        contract,
        allowsLifecycleMutation: false,
        allowsCompatibilityProbe: false,
      };
    }

    // Acceptance descriptor and readiness must describe the same operation identity.
    if (input.acceptanceLaunchDescriptor !== undefined) {
      if (
        input.acceptanceLaunchDescriptor.argv.length === 0 ||
        !input.acceptanceLaunchDescriptor.argv.includes(markerResult.marker.value)
      ) {
        const contract = incompleteContract({
          frozenHost,
          appBuild: frozenHost.appBuild,
          appVersion: frozenHost.appVersion,
          reason:
            "Acceptance sanitized launch descriptor must include the exact retained marker for the acceptance launch.",
          knobMatrix,
          retainedKnobs,
          launchMarker: markerResult.marker,
          isolation,
          sanitizedLaunchDescriptor: descriptor,
          comparativeExperiments,
          readiness: readinessResult.readiness,
          ownership: input.ownership ?? null,
        });
        return {
          contract,
          allowsLifecycleMutation: false,
          allowsCompatibilityProbe: false,
        };
      }
    }

    const ownershipResult = validatePhase0Ownership(input.ownership);
    if (!ownershipResult.ok) {
      const contract = incompleteContract({
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        reason: ownershipResult.reason,
        knobMatrix,
        retainedKnobs,
        launchMarker: markerResult.marker,
        isolation,
        sanitizedLaunchDescriptor: descriptor,
        comparativeExperiments,
        readiness: readinessResult.readiness,
        ownership: input.ownership ?? null,
      });
      return {
        contract,
        allowsLifecycleMutation: false,
        allowsCompatibilityProbe: false,
      };
    }

    const contract: Phase0LaunchContract = {
      schemaVersion: PHASE0_CONTRACT_SCHEMA_VERSION,
      status: "proven",
      frozenHost,
      appBuild: frozenHost.appBuild,
      appVersion: frozenHost.appVersion,
      retainedKnobs,
      knobMatrix,
      comparativeExperiments,
      launchMarker: markerResult.marker,
      isolation,
      readiness: readinessResult.readiness,
      ownership: ownershipResult.ownership,
      sanitizedLaunchDescriptor: descriptor,
      provenAt: input.clockIso,
      reason: null,
    };
    return {
      contract,
      allowsLifecycleMutation: true,
      allowsCompatibilityProbe: true,
    };
  }

  // Unit-level evaluation path: observations alone may prove for fixture tests.
  const contract: Phase0LaunchContract = {
    schemaVersion: PHASE0_CONTRACT_SCHEMA_VERSION,
    status: "proven",
    frozenHost,
    appBuild: frozenHost.appBuild,
    appVersion: frozenHost.appVersion,
    retainedKnobs,
    knobMatrix,
    comparativeExperiments,
    launchMarker: markerResult.marker,
    isolation,
    readiness: input.readiness ?? null,
    ownership: input.ownership ?? null,
    sanitizedLaunchDescriptor: descriptor,
    provenAt: input.clockIso,
    reason: null,
  };

  return {
    contract,
    allowsLifecycleMutation: true,
    allowsCompatibilityProbe: true,
  };
}

/** Create a disabled contract used before any Phase 0 evidence is collected. */
export function createDisabledPhase0Contract(options: {
  appBuild?: string;
  appVersion?: string | null;
  frozenHost?: Phase0FrozenHost | null;
  reason?: string;
}): Phase0LaunchContract {
  const frozenHost = options.frozenHost ?? null;
  return {
    schemaVersion: PHASE0_CONTRACT_SCHEMA_VERSION,
    status: "disabled",
    frozenHost,
    appBuild: frozenHost?.appBuild ?? options.appBuild ?? "unknown",
    appVersion: frozenHost?.appVersion ?? options.appVersion ?? null,
    retainedKnobs: [],
    knobMatrix: PHASE0_CANDIDATE_KNOBS.map((name) => ({
      name,
      status: "omitted" as const,
      effect: "missing" as const,
      evidence: "No Phase 0 observation collected yet.",
    })),
    comparativeExperiments: [],
    launchMarker: null,
    isolation: {
      electronUserDataPath: null,
      codexHomePath: null,
      explodexHomePath: null,
      cdpHost: DEV_CDP_HOST,
      cdpPort: DEV_CDP_PORT,
    },
    readiness: null,
    ownership: null,
    sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
    provenAt: null,
    reason: options.reason ?? "Phase 0 launch-isolation proof has not been completed.",
  };
}

/** Pre-spawn incomplete contract: non-authorizing authority written before any launch. */
export function createPreSpawnIncompleteContract(options: {
  frozenHost: Phase0FrozenHost;
  reason?: string;
}): Phase0LaunchContract {
  return incompleteContract({
    frozenHost: options.frozenHost,
    appBuild: options.frozenHost.appBuild,
    appVersion: options.frozenHost.appVersion,
    reason:
      options.reason ??
      "Phase 0 authority is incomplete and non-authorizing until factual comparative experiments, readiness, ownership, cleanup, and protected-main survival complete.",
    knobMatrix: PHASE0_CANDIDATE_KNOBS.map((name) => ({
      name,
      status: "omitted" as const,
      effect: "missing" as const,
      evidence: "Pre-spawn incomplete contract; no experiment has run yet.",
    })),
  });
}
function parseFrozenHost(value: unknown): Phase0FrozenHost | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.bundlePath)) return null;
  if (!isNonEmptyString(value.executablePath)) return null;
  if (!isNonEmptyString(value.bundleId)) return null;
  if (!isNonEmptyString(value.executableName)) return null;
  if (!isNonEmptyString(value.signingTeam)) return null;
  if (!isNonEmptyString(value.appVersion)) return null;
  if (!isNonEmptyString(value.appBuild)) return null;
  if (!isRecord(value.hostHashes)) return null;
  const hostHashes: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value.hostHashes)) {
    if (!isNonEmptyString(hash)) return null;
    hostHashes[key] = hash;
  }
  return {
    bundlePath: value.bundlePath,
    executablePath: value.executablePath,
    bundleId: value.bundleId,
    executableName: value.executableName,
    signingTeam: value.signingTeam,
    appVersion: value.appVersion,
    appBuild: value.appBuild,
    hostHashes,
  };
}

function parseComparativeExperiment(value: unknown): Phase0ComparativeExperiment | null {
  if (!isRecord(value)) return null;
  if (
    value.knob !== "electron-user-data" &&
    value.knob !== "codex-home" &&
    value.knob !== "explodex-home" &&
    value.knob !== "cdp-port" &&
    value.knob !== "launch-marker"
  ) {
    return null;
  }
  if (!isNonEmptyString(value.experimentId)) return null;
  if (!isNonEmptyString(value.treatmentLabel)) return null;
  if (!isNonEmptyString(value.controlLabel)) return null;
  if (
    value.conclusion !== "demonstrated" &&
    value.conclusion !== "not-necessary" &&
    value.conclusion !== "ambiguous" &&
    value.conclusion !== "missing"
  ) {
    return null;
  }
  if (!isNonEmptyString(value.evidence)) return null;
  if (!isRecord(value.treatment)) return null;
  if (typeof value.treatment.launched !== "boolean") return null;
  if (!isRecord(value.treatment.descriptor)) return null;
  if (!Array.isArray(value.treatment.descriptor.argv)) return null;
  if (!Array.isArray(value.treatment.descriptor.envKeys)) return null;
  if (typeof value.treatment.exactMarkerPresent !== "boolean") return null;
  if (typeof value.treatment.ownershipAccepted !== "boolean") return null;

  const treatment: Phase0ComparativeExperiment["treatment"] = {
    launched: value.treatment.launched,
    privateRoot:
      value.treatment.privateRoot === null || typeof value.treatment.privateRoot === "string"
        ? (value.treatment.privateRoot as string | null)
        : null,
    descriptor: {
      argv: value.treatment.descriptor.argv.filter(
        (entry: unknown): entry is string => typeof entry === "string",
      ),
      envKeys: value.treatment.descriptor.envKeys.filter(
        (entry: unknown): entry is string => typeof entry === "string",
      ),
    },
    pid:
      value.treatment.pid === null ||
      (typeof value.treatment.pid === "number" && Number.isInteger(value.treatment.pid))
        ? (value.treatment.pid as number | null)
        : null,
    processStartedAt:
      value.treatment.processStartedAt === null ||
      typeof value.treatment.processStartedAt === "string"
        ? (value.treatment.processStartedAt as string | null)
        : null,
    portOwnerPid:
      value.treatment.portOwnerPid === null ||
      (typeof value.treatment.portOwnerPid === "number" &&
        Number.isInteger(value.treatment.portOwnerPid))
        ? (value.treatment.portOwnerPid as number | null)
        : null,
    browserIdentity:
      value.treatment.browserIdentity === null ||
      typeof value.treatment.browserIdentity === "string"
        ? (value.treatment.browserIdentity as string | null)
        : null,
    targetId:
      value.treatment.targetId === null || typeof value.treatment.targetId === "string"
        ? (value.treatment.targetId as string | null)
        : null,
    executionContextId:
      value.treatment.executionContextId === null ||
      (typeof value.treatment.executionContextId === "number" &&
        Number.isInteger(value.treatment.executionContextId))
        ? (value.treatment.executionContextId as number | null)
        : null,
    exactMarkerPresent: value.treatment.exactMarkerPresent,
    ownershipAccepted: value.treatment.ownershipAccepted,
  };
  if (isRecord(value.treatment.pathSeparation)) {
    const sep = value.treatment.pathSeparation;
    if (
      typeof sep.userDataDistinctFromMain === "boolean" &&
      typeof sep.codexHomeDistinctFromUserCodex === "boolean" &&
      typeof sep.explodexStateDistinctFromMainHome === "boolean" &&
      sep.credentialsInspected === false
    ) {
      treatment.pathSeparation = {
        userDataDistinctFromMain: sep.userDataDistinctFromMain,
        codexHomeDistinctFromUserCodex: sep.codexHomeDistinctFromUserCodex,
        explodexStateDistinctFromMainHome: sep.explodexStateDistinctFromMainHome,
        credentialsInspected: false,
      };
    }
  }

  let control: Phase0ComparativeExperiment["control"] = null;
  if (value.control !== null && value.control !== undefined) {
    if (!isRecord(value.control)) return null;
    if (typeof value.control.launched !== "boolean") return null;
    if (!isRecord(value.control.descriptor)) return null;
    control = {
      launched: value.control.launched,
      privateRoot:
        value.control.privateRoot === null || typeof value.control.privateRoot === "string"
          ? (value.control.privateRoot as string | null)
          : null,
      descriptor: {
        argv: Array.isArray(value.control.descriptor.argv)
          ? value.control.descriptor.argv.filter(
              (entry: unknown): entry is string => typeof entry === "string",
            )
          : [],
        envKeys: Array.isArray(value.control.descriptor.envKeys)
          ? value.control.descriptor.envKeys.filter(
              (entry: unknown): entry is string => typeof entry === "string",
            )
          : [],
      },
      pid:
        value.control.pid === null ||
        (typeof value.control.pid === "number" && Number.isInteger(value.control.pid))
          ? (value.control.pid as number | null)
          : null,
      processStartedAt:
        value.control.processStartedAt === null ||
        typeof value.control.processStartedAt === "string"
          ? (value.control.processStartedAt as string | null)
          : null,
      portOwnerPid:
        value.control.portOwnerPid === null ||
        (typeof value.control.portOwnerPid === "number" &&
          Number.isInteger(value.control.portOwnerPid))
          ? (value.control.portOwnerPid as number | null)
          : null,
      browserIdentity:
        value.control.browserIdentity === null ||
        typeof value.control.browserIdentity === "string"
          ? (value.control.browserIdentity as string | null)
          : null,
      targetId:
        value.control.targetId === null || typeof value.control.targetId === "string"
          ? (value.control.targetId as string | null)
          : null,
      executionContextId:
        value.control.executionContextId === null ||
        (typeof value.control.executionContextId === "number" &&
          Number.isInteger(value.control.executionContextId))
          ? (value.control.executionContextId as number | null)
          : null,
      exactMarkerPresent: Boolean(value.control.exactMarkerPresent),
      ownershipAccepted: Boolean(value.control.ownershipAccepted),
    };
    if (isRecord(value.control.pathSeparation)) {
      const sep = value.control.pathSeparation;
      if (
        typeof sep.userDataDistinctFromMain === "boolean" &&
        typeof sep.codexHomeDistinctFromUserCodex === "boolean" &&
        typeof sep.explodexStateDistinctFromMainHome === "boolean" &&
        sep.credentialsInspected === false
      ) {
        control.pathSeparation = {
          userDataDistinctFromMain: sep.userDataDistinctFromMain,
          codexHomeDistinctFromUserCodex: sep.codexHomeDistinctFromUserCodex,
          explodexStateDistinctFromMainHome: sep.explodexStateDistinctFromMainHome,
          credentialsInspected: false,
        };
      }
    }
  }

  return {
    knob: value.knob,
    experimentId: value.experimentId,
    treatmentLabel: value.treatmentLabel,
    controlLabel: value.controlLabel,
    treatment,
    control,
    conclusion: value.conclusion,
    evidence: value.evidence,
  };
}

function parseReadiness(
  value: unknown,
  frozenHost: Phase0FrozenHost | null,
  status: Phase0LaunchContract["status"],
): Phase0ReadinessEvidence | null | undefined {
  if (value === null) {
    // Proven contracts cannot have null readiness.
    return status === "proven" ? undefined : null;
  }
  if (value === undefined) {
    return status === "proven" ? undefined : null;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    return undefined;
  }
  if (!isNonEmptyString(value.processStartedAt)) return undefined;
  if (!isNonEmptyString(value.executablePath)) return undefined;
  if (
    typeof value.portOwnerPid !== "number" ||
    !Number.isInteger(value.portOwnerPid) ||
    value.portOwnerPid <= 0
  ) {
    return undefined;
  }
  if (value.cdpHost !== DEV_CDP_HOST || value.cdpPort !== DEV_CDP_PORT) return undefined;
  if (!isNonEmptyString(value.browserIdentity)) return undefined;
  if (
    !(
      value.endpointPublishedPid === null ||
      (typeof value.endpointPublishedPid === "number" &&
        Number.isInteger(value.endpointPublishedPid) &&
        value.endpointPublishedPid > 0)
    )
  ) {
    return undefined;
  }
  if (
    value.endpointPublishedPid !== null &&
    value.endpointPublishedPid !== value.pid
  ) {
    return undefined;
  }
  if (!isNonEmptyString(value.targetId)) return undefined;
  if (value.targetUrl !== "app://-/index.html") return undefined;
  if (typeof value.executionContextId !== "number" || !Number.isInteger(value.executionContextId)) {
    return undefined;
  }
  if (!isNonEmptyString(value.executionContextUniqueId)) return undefined;
  if (!isNonEmptyString(value.frameId)) return undefined;
  if (!isRecord(value.rendererEvaluation)) return undefined;
  if (!isNonEmptyString(value.rendererEvaluation.expression)) return undefined;
  if (!isNonEmptyString(value.rendererEvaluation.evaluatedAt)) return undefined;
  if (value.rendererEvaluation.result === undefined) return undefined;
  if (value.readiness !== "benign") return undefined;
  if (value.portOwnerPid !== value.pid) return undefined;
  if (frozenHost !== null && value.executablePath !== frozenHost.executablePath) return undefined;
  return {
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    executablePath: value.executablePath,
    portOwnerPid: value.portOwnerPid,
    cdpHost: DEV_CDP_HOST,
    cdpPort: DEV_CDP_PORT,
    browserIdentity: value.browserIdentity,
    endpointPublishedPid: value.endpointPublishedPid as number | null,
    targetId: value.targetId,
    targetUrl: "app://-/index.html",
    executionContextId: value.executionContextId,
    executionContextUniqueId: value.executionContextUniqueId,
    frameId: value.frameId,
    rendererEvaluation: {
      expression: value.rendererEvaluation.expression,
      result: value.rendererEvaluation.result,
      evaluatedAt: value.rendererEvaluation.evaluatedAt,
    },
    readiness: "benign",
  };
}

function parseOwnership(
  value: unknown,
  status: Phase0LaunchContract["status"],
): Phase0OwnershipEvidence | null | undefined {
  if (value === null) return status === "proven" ? undefined : null;
  if (value === undefined) return status === "proven" ? undefined : null;
  if (!isRecord(value) || !isRecord(value.positive) || !Array.isArray(value.negatives)) {
    return undefined;
  }
  if (typeof value.positive.owned !== "boolean" || !isNonEmptyString(value.positive.code)) {
    return undefined;
  }
  if (!Array.isArray(value.positive.reasons)) return undefined;
  if (status === "proven" && (value.positive.owned !== true || value.positive.code !== "owned")) {
    return undefined;
  }
  const negatives: Phase0OwnershipEvidence["negatives"] = [];
  for (const entry of value.negatives) {
    if (!isRecord(entry)) return undefined;
    if (entry.owned !== false) return undefined;
    if (!isNonEmptyString(entry.role) || !isNonEmptyString(entry.code)) return undefined;
    if (!Array.isArray(entry.reasons)) return undefined;
    negatives.push({
      role: entry.role,
      owned: false,
      code: entry.code,
      reasons: entry.reasons.filter((reason: unknown): reason is string => typeof reason === "string"),
    });
  }
  return {
    positive: {
      owned: value.positive.owned,
      code: value.positive.code,
      reasons: value.positive.reasons.filter(
        (reason: unknown): reason is string => typeof reason === "string",
      ),
    },
    negatives,
  };
}

/**
 * Parse a Phase 0 contract from unknown.
 * Schema 1 (and any non-current schema) is rejected as non-authorizing.
 * Impossible proven/incomplete identity combinations fail closed.
 */
export function parsePhase0LaunchContract(value: unknown): Phase0LaunchContract | null {
  if (!isRecord(value)) return null;
  // Obsolete schema-1 M1-F04 proofs cannot authorize lifecycle mutation.
  if (value.schemaVersion !== PHASE0_CONTRACT_SCHEMA_VERSION) return null;
  if (value.status !== "proven" && value.status !== "incomplete" && value.status !== "disabled") {
    return null;
  }
  if (!isNonEmptyString(value.appBuild)) return null;
  if (!(value.appVersion === null || typeof value.appVersion === "string")) return null;
  if (!Array.isArray(value.retainedKnobs)) return null;
  if (!Array.isArray(value.knobMatrix)) return null;
  if (!Array.isArray(value.comparativeExperiments)) return null;
  if (!isRecord(value.isolation)) return null;
  if (value.isolation.cdpHost !== DEV_CDP_HOST) return null;
  if (value.isolation.cdpPort !== DEV_CDP_PORT) return null;
  if (!isRecord(value.sanitizedLaunchDescriptor)) return null;
  if (!Array.isArray(value.sanitizedLaunchDescriptor.argv)) return null;
  if (!Array.isArray(value.sanitizedLaunchDescriptor.envKeys)) return null;

  const frozenHost =
    value.frozenHost === undefined ? null : parseFrozenHost(value.frozenHost);
  if (value.frozenHost !== undefined && value.frozenHost !== null && frozenHost === null) {
    return null;
  }
  // Proven contracts must carry a complete frozen host identity.
  if (value.status === "proven" && frozenHost === null) return null;
  if (frozenHost !== null && frozenHost.appBuild !== value.appBuild) return null;

  // Impossible: proven without marker/retained knobs.
  if (
    value.status === "proven" &&
    (value.launchMarker === null ||
      value.launchMarker === undefined ||
      value.retainedKnobs.length === 0)
  ) {
    return null;
  }

  const retainedKnobs: Phase0CandidateKnob[] = [];
  for (const knob of value.retainedKnobs) {
    if (
      knob === "electron-user-data" ||
      knob === "codex-home" ||
      knob === "explodex-home" ||
      knob === "cdp-port" ||
      knob === "launch-marker"
    ) {
      retainedKnobs.push(knob);
    } else {
      return null;
    }
  }

  const knobMatrix: Phase0KnobVerdict[] = [];
  for (const entry of value.knobMatrix) {
    if (!isRecord(entry)) return null;
    if (
      entry.name !== "electron-user-data" &&
      entry.name !== "codex-home" &&
      entry.name !== "explodex-home" &&
      entry.name !== "cdp-port" &&
      entry.name !== "launch-marker"
    ) {
      return null;
    }
    if (entry.status !== "retained" && entry.status !== "omitted") return null;
    if (
      entry.effect !== "demonstrated" &&
      entry.effect !== "not-necessary" &&
      entry.effect !== "ambiguous" &&
      entry.effect !== "missing"
    ) {
      return null;
    }
    if (!isNonEmptyString(entry.evidence)) return null;
    // Impossible: retained with non-demonstrated effect.
    if (entry.status === "retained" && entry.effect !== "demonstrated") return null;
    knobMatrix.push({
      name: entry.name,
      status: entry.status,
      effect: entry.effect,
      evidence: entry.evidence,
    });
  }

  const comparativeExperiments: Phase0ComparativeExperiment[] = [];
  for (const entry of value.comparativeExperiments) {
    const parsed = parseComparativeExperiment(entry);
    if (parsed === null) return null;
    comparativeExperiments.push(parsed);
  }

  let launchMarker: LaunchMarkerContract | null = null;
  if (value.launchMarker !== null && value.launchMarker !== undefined) {
    if (!isRecord(value.launchMarker)) return null;
    if (
      value.launchMarker.kind !== "exact-argv-token" &&
      value.launchMarker.kind !== "exact-env-value"
    ) {
      return null;
    }
    if (!isNonEmptyString(value.launchMarker.value)) return null;
    launchMarker = {
      kind: value.launchMarker.kind,
      value: value.launchMarker.value,
      ...(isNonEmptyString(value.launchMarker.sourceKey)
        ? { sourceKey: value.launchMarker.sourceKey }
        : {}),
    };
  }

  const readiness = parseReadiness(value.readiness, frozenHost, value.status);
  if (readiness === undefined) return null;
  const ownership = parseOwnership(value.ownership, value.status);
  if (ownership === undefined) return null;

  // Proven contracts require complete readiness + ownership + semantic re-derivation.
  if (value.status === "proven") {
    if (readiness === null || ownership === null) return null;
    if (comparativeExperiments.length === 0) return null;
    if (typeof value.provenAt !== "string" || value.provenAt.length === 0) return null;
    if (launchMarker === null) return null;
    if (frozenHost === null) return null;

    const readinessCheck = validatePhase0Readiness(readiness, frozenHost);
    if (!readinessCheck.ok) return null;
    const ownershipCheck = validatePhase0Ownership(ownership);
    if (!ownershipCheck.ok) return null;
    const matrixCheck = validateCompleteComparativeMatrix(comparativeExperiments, knobMatrix);
    if (!matrixCheck.ok) return null;

    // Retained set must agree with matrix/conclusions uniquely.
    const retainedFromMatrix = knobMatrix
      .filter((entry) => entry.status === "retained")
      .map((entry) => entry.name)
      .sort();
    const retainedDeclared = [...retainedKnobs].sort();
    if (
      retainedFromMatrix.length !== retainedDeclared.length ||
      retainedFromMatrix.some((name, index) => name !== retainedDeclared[index])
    ) {
      return null;
    }

    // Proven isolation must not name experiment private roots.
    for (const experiment of comparativeExperiments) {
      for (const side of [experiment.treatment, experiment.control]) {
        if (side === null || side.privateRoot === null) continue;
        const root = side.privateRoot;
        const electron = value.isolation.electronUserDataPath;
        const codex = value.isolation.codexHomePath;
        const explodex = value.isolation.explodexHomePath;
        if (
          (typeof electron === "string" && electron.startsWith(`${root}/`)) ||
          (typeof codex === "string" && codex.startsWith(`${root}/`)) ||
          (typeof explodex === "string" && explodex.startsWith(`${root}/`))
        ) {
          return null;
        }
      }
    }

    const acceptanceArgv = value.sanitizedLaunchDescriptor.argv.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (!acceptanceArgv.includes(launchMarker.value)) return null;
  }

  // Impossible: provenAt set on non-proven, or proven without provenAt.
  if (value.status === "proven" && typeof value.provenAt !== "string") return null;
  if (value.status !== "proven" && value.provenAt !== null && value.provenAt !== undefined) {
    return null;
  }

  return {
    schemaVersion: 2,
    status: value.status,
    frozenHost,
    appBuild: value.appBuild,
    appVersion: value.appVersion,
    retainedKnobs,
    knobMatrix,
    comparativeExperiments,
    launchMarker,
    isolation: {
      electronUserDataPath:
        value.isolation.electronUserDataPath === null ||
        typeof value.isolation.electronUserDataPath === "string"
          ? (value.isolation.electronUserDataPath as string | null)
          : null,
      codexHomePath:
        value.isolation.codexHomePath === null || typeof value.isolation.codexHomePath === "string"
          ? (value.isolation.codexHomePath as string | null)
          : null,
      explodexHomePath:
        value.isolation.explodexHomePath === null ||
        typeof value.isolation.explodexHomePath === "string"
          ? (value.isolation.explodexHomePath as string | null)
          : null,
      cdpHost: DEV_CDP_HOST,
      cdpPort: DEV_CDP_PORT,
    },
    readiness,
    ownership,
    sanitizedLaunchDescriptor: {
      argv: value.sanitizedLaunchDescriptor.argv.filter(
        (entry): entry is string => typeof entry === "string",
      ),
      envKeys: value.sanitizedLaunchDescriptor.envKeys.filter(
        (entry): entry is string => typeof entry === "string",
      ),
    },
    provenAt: typeof value.provenAt === "string" || value.provenAt === null ? value.provenAt : null,
    reason: typeof value.reason === "string" || value.reason === null ? value.reason : null,
  };
}

export async function loadPhase0LaunchContract(options: {
  adapters: HostAdapters;
  path: string;
}): Promise<Phase0LaunchContract | null> {
  const exists = await options.adapters.fs.exists(options.path);
  if (!exists) return null;
  let text: string;
  try {
    if (options.adapters.fs.readText) {
      text = await options.adapters.fs.readText(options.path);
    } else {
      const bytes = await options.adapters.fs.readFile(options.path);
      text = new TextDecoder().decode(bytes);
    }
  } catch {
    return null;
  }
  try {
    return parsePhase0LaunchContract(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * Persist a Phase 0 contract. Proven contracts enable lifecycle/probe; incomplete/disabled do not.
 * Path creation alone never writes a proven contract.
 */
export async function savePhase0LaunchContract(options: {
  adapters: HostAdapters;
  path: string;
  contract: Phase0LaunchContract;
}): Promise<void> {
  const parsed = parsePhase0LaunchContract(options.contract);
  if (parsed === null) {
    throw new Error("Refusing to persist invalid Phase 0 launch contract");
  }
  const { adapters, path } = options;
  if (!adapters.fs.mkdir || !adapters.fs.writeFile || !adapters.fs.rename) {
    throw new Error("Filesystem adapter must support mkdir/writeFile/rename to save Phase 0 contract");
  }
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(parsed, null, 2)}\n`;
  await adapters.fs.mkdir(parent, { recursive: true, mode: DEV_DIRECTORY_MODE });
  await adapters.fs.writeFile(tempPath, new TextEncoder().encode(payload));
  await adapters.fs.rename(tempPath, path);
}

/**
 * Exact marker match helper used by ownership predicates.
 * Substring containment is never sufficient.
 */
export function markerMatchesExactly(options: {
  contract: Phase0LaunchContract;
  observedArgv?: readonly string[];
  observedEnv?: Record<string, string | undefined>;
}): boolean {
  const marker = options.contract.launchMarker;
  if (marker === null || options.contract.status !== "proven") return false;
  if (marker.kind === "exact-argv-token") {
    return (options.observedArgv ?? []).some((token) => token === marker.value);
  }
  if (marker.kind === "exact-env-value") {
    const key = marker.sourceKey;
    if (key === undefined) return false;
    return options.observedEnv?.[key] === marker.value;
  }
  return false;
}

export function buildSanitizedLaunchDescriptor(options: {
  argv: readonly string[];
  envKeys: readonly string[];
}): SanitizedLaunchDescriptor {
  return {
    argv: [...options.argv],
    envKeys: [...options.envKeys],
  };
}

export function layoutForPhase0(layout: DevLayoutPaths): DevLayoutPaths {
  return layout;
}
