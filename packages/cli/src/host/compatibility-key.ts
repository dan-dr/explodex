import { createHash } from "node:crypto";
import {
  COMPATIBILITY_HOST_HASH_RELATIVE_PATHS,
  COMPATIBILITY_SCHEMA_VERSION,
  DEFAULT_PROBE_TOOL_VERSION,
  PROBE_SCHEMA_VERSION,
} from "./constants.ts";
import type { CompatibilityKey, HostIdentity, ProbeIdentity, SdkRuntimeIdentity } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeHostHashes(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(input).sort();
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value.toLowerCase();
    }
  }
  return out;
}

function validateRequiredHostHashes(input: Record<string, string>): Record<string, string> {
  const normalized = normalizeHostHashes(input);
  const required = new Set<string>(COMPATIBILITY_HOST_HASH_RELATIVE_PATHS);
  const keys = Object.keys(normalized);
  if (keys.length !== required.size || keys.some((key) => !required.has(key))) {
    throw new Error("compatibility key requires exactly every required host hash");
  }
  for (const path of COMPATIBILITY_HOST_HASH_RELATIVE_PATHS) {
    if (!isSha256Hex(normalized[path])) {
      throw new Error(`required host hash '${path}' must be a SHA-256 digest`);
    }
  }
  return normalized;
}

/** Build the exact current compatibility key from host + SDK + probe identities. */
export function deriveCompatibilityKey(input: {
  host: Pick<HostIdentity, "appVersion" | "appBuild" | "hostHashes" | "signingTeam">;
  sdkRuntime: SdkRuntimeIdentity;
  probe?: ProbeIdentity;
}): CompatibilityKey {
  const probe = input.probe ?? {
    schemaVersion: PROBE_SCHEMA_VERSION,
    toolVersion: DEFAULT_PROBE_TOOL_VERSION,
  };

  if (!isSha256Hex(input.sdkRuntime.sha256)) {
    throw new Error("sdkRuntime.sha256 must be a SHA-256 digest");
  }
  if (!isNonEmptyString(input.sdkRuntime.version)) {
    throw new Error("sdkRuntime.version is required to derive a compatibility key");
  }
  if (!isNonEmptyString(input.host.appVersion) || !isNonEmptyString(input.host.appBuild)) {
    throw new Error("host application version and build are required");
  }
  if (!isNonEmptyString(input.host.signingTeam)) {
    throw new Error("host signing team is required");
  }
  if (!isPositiveInteger(probe.schemaVersion)) {
    throw new Error("probe schema version must be a positive integer");
  }
  if (!isNonEmptyString(probe.toolVersion)) {
    throw new Error("probe tool version is required");
  }

  return {
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    appVersion: input.host.appVersion,
    appBuild: input.host.appBuild,
    hostHashes: validateRequiredHostHashes(input.host.hostHashes),
    signingTeam: input.host.signingTeam,
    sdkRuntimeSha256: input.sdkRuntime.sha256.toLowerCase(),
    probeSchemaVersion: probe.schemaVersion,
    probeToolVersion: probe.toolVersion,
  };
}

/** Deep equality for compatibility keys (order-independent hostHashes). */
export function compatibilityKeysEqual(a: CompatibilityKey, b: CompatibilityKey): boolean {
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.appVersion !== b.appVersion) return false;
  if (a.appBuild !== b.appBuild) return false;
  if (a.signingTeam !== b.signingTeam) return false;
  if (a.sdkRuntimeSha256.toLowerCase() !== b.sdkRuntimeSha256.toLowerCase()) return false;
  if (a.probeSchemaVersion !== b.probeSchemaVersion) return false;
  if (a.probeToolVersion !== b.probeToolVersion) return false;

  const aHashes = normalizeHostHashes(a.hostHashes);
  const bHashes = normalizeHostHashes(b.hostHashes);
  const aKeys = Object.keys(aHashes);
  const bKeys = Object.keys(bHashes);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (aHashes[key] !== bHashes[key]) return false;
  }
  return true;
}

/** Stable exact-key digest used by one-operation authoring-main authorization. */
export function compatibilityKeyHash(key: CompatibilityKey): string {
  const normalized = {
    schemaVersion: key.schemaVersion,
    appVersion: key.appVersion,
    appBuild: key.appBuild,
    hostHashes: Object.fromEntries(
      Object.keys(key.hostHashes)
        .sort()
        .map((path) => [path, key.hostHashes[path]]),
    ),
    signingTeam: key.signingTeam,
    sdkRuntimeSha256: key.sdkRuntimeSha256,
    probeSchemaVersion: key.probeSchemaVersion,
    probeToolVersion: key.probeToolVersion,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Parse unknown JSON into a CompatibilityKey or return null. */
export function parseCompatibilityKey(value: unknown): CompatibilityKey | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!isNonEmptyString(value.appVersion)) return null;
  if (!isNonEmptyString(value.appBuild)) return null;
  if (!isNonEmptyString(value.signingTeam)) return null;
  if (!isSha256Hex(value.sdkRuntimeSha256)) return null;
  if (!isPositiveInteger(value.probeSchemaVersion)) return null;
  if (!isNonEmptyString(value.probeToolVersion)) return null;
  if (!isRecord(value.hostHashes)) return null;

  const requiredPaths = new Set<string>(COMPATIBILITY_HOST_HASH_RELATIVE_PATHS);
  const rawHashKeys = Object.keys(value.hostHashes);
  if (
    rawHashKeys.length !== requiredPaths.size ||
    rawHashKeys.some((key) => !requiredPaths.has(key))
  ) {
    return null;
  }

  const hostHashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of rawHashKeys) {
    const hash = value.hostHashes[key];
    if (!isSha256Hex(hash)) return null;
    hostHashes[key] = hash.toLowerCase();
  }

  let validatedHostHashes: Record<string, string>;
  try {
    validatedHostHashes = validateRequiredHostHashes(hostHashes);
  } catch {
    return null;
  }

  return {
    schemaVersion: 1,
    appVersion: value.appVersion,
    appBuild: value.appBuild,
    hostHashes: validatedHostHashes,
    signingTeam: value.signingTeam,
    sdkRuntimeSha256: value.sdkRuntimeSha256.toLowerCase(),
    probeSchemaVersion: value.probeSchemaVersion,
    probeToolVersion: value.probeToolVersion,
  };
}

/** Required relative paths that must appear in hostHashes for a complete key. */
export function requiredHostHashPaths(): readonly string[] {
  return COMPATIBILITY_HOST_HASH_RELATIVE_PATHS;
}
