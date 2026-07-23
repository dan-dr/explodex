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

  if (!isNonEmptyString(input.sdkRuntime.sha256)) {
    throw new Error("sdkRuntime.sha256 is required to derive a compatibility key");
  }
  if (!isNonEmptyString(input.sdkRuntime.version)) {
    throw new Error("sdkRuntime.version is required to derive a compatibility key");
  }

  return {
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    appVersion: input.host.appVersion,
    appBuild: input.host.appBuild,
    hostHashes: normalizeHostHashes(input.host.hostHashes),
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

/** Parse unknown JSON into a CompatibilityKey or return null. */
export function parseCompatibilityKey(value: unknown): CompatibilityKey | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!isNonEmptyString(value.appVersion)) return null;
  if (!isNonEmptyString(value.appBuild)) return null;
  if (!isNonEmptyString(value.signingTeam)) return null;
  if (!isNonEmptyString(value.sdkRuntimeSha256)) return null;
  if (typeof value.probeSchemaVersion !== "number" || !Number.isFinite(value.probeSchemaVersion)) {
    return null;
  }
  if (!isNonEmptyString(value.probeToolVersion)) return null;
  if (!isRecord(value.hostHashes)) return null;

  const hostHashes: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value.hostHashes)) {
    if (!isNonEmptyString(hash)) return null;
    hostHashes[key] = hash.toLowerCase();
  }

  return {
    schemaVersion: 1,
    appVersion: value.appVersion,
    appBuild: value.appBuild,
    hostHashes: normalizeHostHashes(hostHashes),
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
