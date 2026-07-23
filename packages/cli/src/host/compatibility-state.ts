import type { HostAdapters } from "./adapters.ts";
import { PUBLIC_COMPATIBILITY_PROBE_HINT } from "./constants.ts";
import {
  compatibilityKeysEqual,
  deriveCompatibilityKey,
  parseCompatibilityKey,
} from "./compatibility-key.ts";
import { compatibilityStatePath, stateDirectory } from "../home/paths.ts";
import type {
  CompatibilityKey,
  CompatibilityRecord,
  CompatibilityReport,
  CompatibilityStatus,
  HostIdentity,
  ProbeIdentity,
  RunningProcessIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCompatibilityRecord(value: unknown): CompatibilityRecord | null {
  if (!isRecord(value)) return null;
  if (value.status !== "proven") return null;
  if (!isNonEmptyString(value.probedAt)) return null;
  const key = parseCompatibilityKey(value.key);
  if (key === null) return null;
  if (!isRecord(value.target)) return null;
  if (value.target.role !== "development") return null;
  if (typeof value.target.pid !== "number" || !Number.isInteger(value.target.pid)) return null;
  if (!isNonEmptyString(value.target.processStartedAt)) return null;
  if (value.target.port !== 9444) return null;
  if (!isNonEmptyString(value.target.targetId)) return null;

  return {
    key,
    status: "proven",
    probedAt: value.probedAt,
    target: {
      role: "development",
      pid: value.target.pid,
      processStartedAt: value.target.processStartedAt,
      port: 9444,
      targetId: value.target.targetId,
    },
    capabilitySummary: value.capabilitySummary,
  };
}

export type LoadCompatibilityOptions = {
  adapters: HostAdapters;
  explodexHome: string;
};

/** Load a proven record from disk, or null when absent/malformed (treated as unproven). */
export async function loadCompatibilityRecord(
  options: LoadCompatibilityOptions,
): Promise<CompatibilityRecord | null> {
  const path = compatibilityStatePath(options.explodexHome);
  const exists = await options.adapters.fs.exists(path);
  if (!exists) return null;

  let text: string;
  try {
    if (options.adapters.fs.readText) {
      text = await options.adapters.fs.readText(path);
    } else {
      const bytes = await options.adapters.fs.readFile(path);
      text = new TextDecoder().decode(bytes);
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return parseCompatibilityRecord(parsed);
}

/**
 * Atomically persist a proven compatibility record.
 * Only used after a complete probe (later M1 feature); exposed for tests and probe commit.
 */
export async function saveCompatibilityRecord(options: {
  adapters: HostAdapters;
  explodexHome: string;
  record: CompatibilityRecord;
}): Promise<void> {
  const { adapters, explodexHome, record } = options;
  if (record.status !== "proven") {
    throw new Error("Only proven compatibility records may be persisted");
  }
  const dir = stateDirectory(explodexHome);
  const finalPath = compatibilityStatePath(explodexHome);
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = new TextEncoder().encode(payload);

  if (!adapters.fs.mkdir || !adapters.fs.writeFile || !adapters.fs.rename) {
    throw new Error("Filesystem adapter must support mkdir/writeFile/rename to save compatibility");
  }

  await adapters.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await adapters.fs.writeFile(tempPath, bytes);
  await adapters.fs.rename(tempPath, finalPath);
}

export type EvaluateCompatibilityOptions = {
  host: HostIdentity;
  sdkRuntime: SdkRuntimeIdentity;
  probe?: ProbeIdentity;
  persisted: CompatibilityRecord | null;
  /**
   * Optional identity of a currently observed running process.
   * When provided and it disagrees with the host/key, proof is rejected.
   */
  runningProcess?: RunningProcessIdentity | null;
};

function mismatchReason(field: string): string {
  return `compatibility_key_mismatch:${field}`;
}

/** Compare a persisted proven record against the current exact key. */
export function evaluateCompatibility(
  options: EvaluateCompatibilityOptions,
): CompatibilityReport {
  const currentKey = deriveCompatibilityKey({
    host: options.host,
    sdkRuntime: options.sdkRuntime,
    probe: options.probe,
  });

  const persisted = options.persisted;
  if (persisted === null) {
    return {
      status: "unproven",
      key: null,
      currentKey,
      matched: false,
      reason: "no_compatibility_record",
      nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
      allowsCompatibilityDependentWork: false,
    };
  }

  if (persisted.status !== "proven") {
    return {
      status: "unproven",
      key: null,
      currentKey,
      matched: false,
      reason: "record_not_proven",
      nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
      allowsCompatibilityDependentWork: false,
    };
  }

  if (!compatibilityKeysEqual(persisted.key, currentKey)) {
    const field = firstMismatchedField(persisted.key, currentKey);
    return {
      status: "unproven",
      key: persisted.key,
      currentKey,
      matched: false,
      reason: mismatchReason(field),
      nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
      allowsCompatibilityDependentWork: false,
    };
  }

  const running = options.runningProcess;
  if (running) {
    if (
      running.appVersion !== undefined &&
      running.appVersion !== currentKey.appVersion
    ) {
      return {
        status: "unproven",
        key: persisted.key,
        currentKey,
        matched: false,
        reason: mismatchReason("running_app_version"),
        nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
        allowsCompatibilityDependentWork: false,
      };
    }
    if (running.appBuild !== undefined && running.appBuild !== currentKey.appBuild) {
      return {
        status: "unproven",
        key: persisted.key,
        currentKey,
        matched: false,
        reason: mismatchReason("running_app_build"),
        nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
        allowsCompatibilityDependentWork: false,
      };
    }
    if (
      running.executablePath !== undefined &&
      running.executablePath !== options.host.executablePath
    ) {
      return {
        status: "unproven",
        key: persisted.key,
        currentKey,
        matched: false,
        reason: mismatchReason("running_executable_path"),
        nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
        allowsCompatibilityDependentWork: false,
      };
    }
  }

  return {
    status: "proven",
    key: persisted.key,
    currentKey,
    matched: true,
    reason: null,
    nextAction: null,
    allowsCompatibilityDependentWork: true,
  };
}

function firstMismatchedField(a: CompatibilityKey, b: CompatibilityKey): string {
  if (a.schemaVersion !== b.schemaVersion) return "schemaVersion";
  if (a.appVersion !== b.appVersion) return "appVersion";
  if (a.appBuild !== b.appBuild) return "appBuild";
  if (a.signingTeam !== b.signingTeam) return "signingTeam";
  if (a.sdkRuntimeSha256.toLowerCase() !== b.sdkRuntimeSha256.toLowerCase()) {
    return "sdkRuntimeSha256";
  }
  if (a.probeSchemaVersion !== b.probeSchemaVersion) return "probeSchemaVersion";
  if (a.probeToolVersion !== b.probeToolVersion) return "probeToolVersion";

  const aKeys = Object.keys(a.hostHashes).sort();
  const bKeys = Object.keys(b.hostHashes).sort();
  if (aKeys.join("\0") !== bKeys.join("\0")) return "hostHashes.keys";
  for (const key of aKeys) {
    if (a.hostHashes[key]?.toLowerCase() !== b.hostHashes[key]?.toLowerCase()) {
      return `hostHashes.${key}`;
    }
  }
  return "unknown";
}

export type ReportCompatibilityOptions = EvaluateCompatibilityOptions & {
  /** Optional explicit status override for pending probe results. */
  pendingReason?: string | null;
};

/**
 * Build a compatibility report. Pending is reserved for incomplete probe outcomes
 * that later features may surface; clean homes and key drift remain unproven.
 */
export function reportCompatibility(
  options: ReportCompatibilityOptions,
): CompatibilityReport {
  if (options.pendingReason) {
    const currentKey = deriveCompatibilityKey({
      host: options.host,
      sdkRuntime: options.sdkRuntime,
      probe: options.probe,
    });
    return {
      status: "pending" satisfies CompatibilityStatus,
      key: options.persisted?.key ?? null,
      currentKey,
      matched: false,
      reason: options.pendingReason,
      nextAction: PUBLIC_COMPATIBILITY_PROBE_HINT,
      allowsCompatibilityDependentWork: false,
    };
  }
  return evaluateCompatibility(options);
}
