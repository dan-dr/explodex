import type { TargetIdentity } from "../cdp/types.ts";
import type { HostIdentity } from "./types.ts";

export type MainAuthorizationArtifactIdentity = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type MainAuthorizationBinding = {
  operationId: string;
  target: TargetIdentity;
  host: HostIdentity;
  compatibilityKeyHash: string;
  sdkRuntimeIdentity: {
    version: string;
    sha256: string;
  };
  artifact: MainAuthorizationArtifactIdentity;
};

export type MainAuthorization = {
  schemaVersion: 1;
  operationId: string;
  issuedAt: string;
  expiresAt: string;
  pid: number;
  processStartedAt: string;
  port: 9333;
  browserIdentity: string;
  targetId: string;
  targetType: "page";
  targetUrl: "app://-/index.html";
  executionContextId: number;
  executionContextUniqueId: string;
  frameId: string;
  appVersion: string;
  appBuild: string;
  bundlePath: string;
  executablePath: string;
  bundleId: string;
  executableName: string;
  signingTeam: string;
  hostHashes: Readonly<Record<string, string>>;
  compatibilityKeyHash: string;
  sdkRuntimeVersion: string;
  sdkRuntimeSha256: string;
  artifact: Readonly<MainAuthorizationArtifactIdentity>;
};

export type MainAuthorizationFailureCode =
  | "main.authorization-expired"
  | "main.authorization-mismatch"
  | "main.authorization-replayed";

export type MainAuthorizationValidation =
  | { ok: true }
  | {
      ok: false;
      code: MainAuthorizationFailureCode;
      message: string;
      mismatch?: string;
    };

export type MainAuthorizationLease = {
  readonly record: MainAuthorization;
  readonly consumed: boolean;
  validateAndConsume(options: {
    binding: MainAuthorizationBinding;
    nowMs: number;
  }): MainAuthorizationValidation;
};

function exactRecord(value: Record<string, string>): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = value[key]!;
  }
  return Object.freeze(output);
}

function hashesEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && left[key] === right[key]
    );
}

function mismatch(
  record: MainAuthorization,
  binding: MainAuthorizationBinding,
): string | null {
  if (record.operationId !== binding.operationId) return "operationId";
  if (binding.target.role !== "main") return "target.role";
  if (record.pid !== binding.target.pid) return "pid";
  if (record.processStartedAt !== binding.target.processStartedAt) {
    return "processStartedAt";
  }
  if (binding.target.port !== 9333 || record.port !== binding.target.port) {
    return "port";
  }
  if (record.browserIdentity !== binding.target.browserIdentity) {
    return "browserIdentity";
  }
  if (record.targetId !== binding.target.targetId) return "targetId";
  if (record.targetType !== binding.target.targetType) return "targetType";
  if (record.targetUrl !== binding.target.targetUrl) return "targetUrl";
  if (record.executionContextId !== binding.target.executionContextId) {
    return "executionContextId";
  }
  if (
    record.executionContextUniqueId !==
      binding.target.executionContextUniqueId
  ) {
    return "executionContextUniqueId";
  }
  if (record.frameId !== binding.target.frameId) return "frameId";
  if (record.appVersion !== binding.target.appVersion) {
    return "target.appVersion";
  }
  if (record.appBuild !== binding.target.appBuild) return "target.appBuild";
  if (record.executablePath !== binding.target.executablePath) {
    return "target.executablePath";
  }
  if (record.appVersion !== binding.host.appVersion) return "appVersion";
  if (record.appBuild !== binding.host.appBuild) return "appBuild";
  if (record.bundlePath !== binding.host.bundlePath) return "bundlePath";
  if (record.executablePath !== binding.host.executablePath) {
    return "executablePath";
  }
  if (record.bundleId !== binding.host.bundleId) return "bundleId";
  if (record.executableName !== binding.host.executableName) {
    return "executableName";
  }
  if (record.signingTeam !== binding.host.signingTeam) return "signingTeam";
  if (!hashesEqual(record.hostHashes, binding.host.hostHashes)) {
    return "hostHashes";
  }
  if (record.compatibilityKeyHash !== binding.compatibilityKeyHash) {
    return "compatibilityKeyHash";
  }
  if (record.sdkRuntimeVersion !== binding.sdkRuntimeIdentity.version) {
    return "sdkRuntimeVersion";
  }
  if (record.sdkRuntimeSha256 !== binding.sdkRuntimeIdentity.sha256) {
    return "sdkRuntimeSha256";
  }
  if (record.artifact.id !== binding.artifact.id) return "artifact.id";
  if (record.artifact.version !== binding.artifact.version) {
    return "artifact.version";
  }
  if (
    record.artifact.payloadSha256 !== binding.artifact.payloadSha256
  ) {
    return "artifact.payloadSha256";
  }
  return null;
}

export function validateMainAuthorization(options: {
  record: MainAuthorization;
  binding: MainAuthorizationBinding;
  nowMs: number;
}): MainAuthorizationValidation {
  if (
    !Number.isFinite(options.nowMs) ||
    options.nowMs >= Date.parse(options.record.expiresAt)
  ) {
    return {
      ok: false,
      code: "main.authorization-expired",
      message:
        "The authoring-main authorization expired before final apply.",
    };
  }
  const field = mismatch(options.record, options.binding);
  if (field !== null) {
    return {
      ok: false,
      code: "main.authorization-mismatch",
      message:
        "The exact authoring-main, compatibility, operation, SDK runtime, or staged artifact identity changed.",
      mismatch: field,
    };
  }
  return { ok: true };
}

export function createMainAuthorization(options: {
  binding: MainAuthorizationBinding;
  issuedAtMs: number;
  ttlMs: number;
}): MainAuthorizationLease {
  if (
    !Number.isFinite(options.issuedAtMs) ||
    !Number.isFinite(options.ttlMs) ||
    options.ttlMs <= 0
  ) {
    throw new Error("Main authorization requires finite issue and expiry bounds.");
  }
  if (options.binding.target.role !== "main" || options.binding.target.port !== 9333) {
    throw new Error("Main authorization requires one exact main target on port 9333.");
  }
  const record: MainAuthorization = Object.freeze({
    schemaVersion: 1,
    operationId: options.binding.operationId,
    issuedAt: new Date(options.issuedAtMs).toISOString(),
    expiresAt: new Date(options.issuedAtMs + options.ttlMs).toISOString(),
    pid: options.binding.target.pid,
    processStartedAt: options.binding.target.processStartedAt,
    port: 9333,
    browserIdentity: options.binding.target.browserIdentity,
    targetId: options.binding.target.targetId,
    targetType: options.binding.target.targetType,
    targetUrl: options.binding.target.targetUrl,
    executionContextId: options.binding.target.executionContextId,
    executionContextUniqueId:
      options.binding.target.executionContextUniqueId,
    frameId: options.binding.target.frameId,
    appVersion: options.binding.host.appVersion,
    appBuild: options.binding.host.appBuild,
    bundlePath: options.binding.host.bundlePath,
    executablePath: options.binding.host.executablePath,
    bundleId: options.binding.host.bundleId,
    executableName: options.binding.host.executableName,
    signingTeam: options.binding.host.signingTeam,
    hostHashes: exactRecord(options.binding.host.hostHashes),
    compatibilityKeyHash: options.binding.compatibilityKeyHash,
    sdkRuntimeVersion: options.binding.sdkRuntimeIdentity.version,
    sdkRuntimeSha256: options.binding.sdkRuntimeIdentity.sha256,
    artifact: Object.freeze({ ...options.binding.artifact }),
  });
  let consumed = false;
  return {
    record,
    get consumed() {
      return consumed;
    },
    validateAndConsume(input): MainAuthorizationValidation {
      if (consumed) {
        return {
          ok: false,
          code: "main.authorization-replayed",
          message:
            "The authoring-main authorization was already consumed and cannot be replayed.",
        };
      }
      const validation = validateMainAuthorization({
        record,
        binding: input.binding,
        nowMs: input.nowMs,
      });
      if (!validation.ok) return validation;
      consumed = true;
      return { ok: true };
    },
  };
}
