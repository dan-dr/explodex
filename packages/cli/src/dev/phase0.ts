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
  Phase0EvaluationInput,
  Phase0EvaluationResult,
  Phase0FrozenHost,
  Phase0KnobObservation,
  Phase0KnobVerdict,
  Phase0LaunchContract,
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
}): Phase0LaunchContract {
  return {
    schemaVersion: PHASE0_CONTRACT_SCHEMA_VERSION,
    status: "incomplete",
    frozenHost: options.frozenHost,
    appBuild: options.appBuild,
    appVersion: options.appVersion ?? options.frozenHost?.appVersion ?? null,
    retainedKnobs: options.retainedKnobs ?? [],
    knobMatrix: options.knobMatrix,
    launchMarker: options.launchMarker ?? null,
    isolation: options.isolation ?? {
      electronUserDataPath: null,
      codexHomePath: null,
      explodexHomePath: null,
      cdpHost: DEV_CDP_HOST,
      cdpPort: DEV_CDP_PORT,
    },
    sanitizedLaunchDescriptor: options.sanitizedLaunchDescriptor ?? {
      argv: [],
      envKeys: [],
    },
    provenAt: null,
    reason: options.reason,
  };
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
 * Evaluate independent Phase 0 knob observations into the minimal retained launch contract.
 * Incomplete, ambiguous, or active-operation host-drift evidence keeps mutation disabled.
 * Historical difference from dated observations is not a blocker; only the operation freeze is.
 */
export function evaluatePhase0LaunchContract(
  input: Phase0EvaluationInput,
): Phase0EvaluationResult {
  const frozenHost = freezeHostIdentity(input.frozenHost);

  if (input.recheckedHost !== undefined && input.recheckedHost !== null) {
    const rechecked = freezeHostIdentity(input.recheckedHost);
    if (!frozenHostEquals(frozenHost, rechecked)) {
      const matrix = PHASE0_CANDIDATE_KNOBS.map((knob) =>
        evaluateKnob(knob, observationFor(input.observations, knob)),
      );
      const contract = incompleteContract({
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        reason:
          "Active-operation host identity drifted from the frozen Phase 0 identity; abort without reconnect or authority transfer.",
        knobMatrix: matrix,
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
    const observation = observationFor(input.observations, knob);
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
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

  const markerObservation = observationFor(input.observations, "launch-marker");
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
    });
    return {
      contract,
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
    };
  }

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

  // Prefer explicit isolation paths from observations when present.
  for (const observation of input.observations) {
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

  const descriptor =
    markerObservation?.sanitizedLaunchDescriptor ??
    input.observations.find((entry) => entry.sanitizedLaunchDescriptor)?.sanitizedLaunchDescriptor ?? {
      argv: [],
      envKeys: [],
    };

  const contract: Phase0LaunchContract = {
    schemaVersion: PHASE0_CONTRACT_SCHEMA_VERSION,
    status: "proven",
    frozenHost,
    appBuild: frozenHost.appBuild,
    appVersion: frozenHost.appVersion,
    retainedKnobs,
    knobMatrix,
    launchMarker: markerResult.marker,
    isolation,
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
    launchMarker: null,
    isolation: {
      electronUserDataPath: null,
      codexHomePath: null,
      explodexHomePath: null,
      cdpHost: DEV_CDP_HOST,
      cdpPort: DEV_CDP_PORT,
    },
    sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
    provenAt: null,
    reason: options.reason ?? "Phase 0 launch-isolation proof has not been completed.",
  };
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

export function parsePhase0LaunchContract(value: unknown): Phase0LaunchContract | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== PHASE0_CONTRACT_SCHEMA_VERSION) return null;
  if (value.status !== "proven" && value.status !== "incomplete" && value.status !== "disabled") {
    return null;
  }
  if (!isNonEmptyString(value.appBuild)) return null;
  if (!(value.appVersion === null || typeof value.appVersion === "string")) return null;
  if (!Array.isArray(value.retainedKnobs)) return null;
  if (!Array.isArray(value.knobMatrix)) return null;
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
    knobMatrix.push({
      name: entry.name,
      status: entry.status,
      effect: entry.effect,
      evidence: entry.evidence,
    });
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

  return {
    schemaVersion: 1,
    status: value.status,
    frozenHost,
    appBuild: value.appBuild,
    appVersion: value.appVersion,
    retainedKnobs,
    knobMatrix,
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
