/**
 * Atomic producer launch-coordination record for explicit no-main launch/attach.
 *
 * The spawning operation writes one complete record while holding main-launch
 * coordination: producer operation/lock generation, frozen host/key, process,
 * 9333 browser/target/frame/context identity, and unconsumed one-shot effect
 * authority. Contenders may attach only to the exact record-bound winner;
 * absence from baseline alone never authorizes attach. Effect evaluation
 * reloads persisted compatibility, revalidates identities, and atomically
 * consumes the one-shot effect before a single declarative evaluation.
 */

import { join } from "node:path";
import type { TargetIdentity } from "../cdp/types.ts";
import { mainLaunchCoordinationPath, stateDirectory } from "../home/paths.ts";
import type { HostAdapters } from "./adapters.ts";
import { compatibilityKeysEqual, parseCompatibilityKey } from "./compatibility-key.ts";
import { MAIN_CDP_HOST, MAIN_CDP_PORT } from "./main-launch-types.ts";
import type { VerifiedProcess } from "./status.ts";
import type { CompatibilityKey, HostIdentity } from "./types.ts";

export const MAIN_LAUNCH_COORDINATION_KIND = "main-launch-coordination" as const;
export const MAIN_LAUNCH_COORDINATION_SCHEMA_VERSION = 1 as const;

export type LaunchCoordinationEffect =
  | { status: "unconsumed" }
  | {
      status: "consumed";
      consumedAt: string;
      consumerOperationId: string;
    };

export type LaunchCoordinationProcess = {
  pid: number;
  processStartedAt: string;
  executablePath: string;
};

export type LaunchCoordinationTarget = {
  targetId: string;
  targetType: "page";
  targetUrl: "app://-/index.html";
  frameId: string;
  executionContextId: number;
  executionContextUniqueId: string;
};

export type LaunchCoordinationRecord = {
  schemaVersion: typeof MAIN_LAUNCH_COORDINATION_SCHEMA_VERSION;
  kind: typeof MAIN_LAUNCH_COORDINATION_KIND;
  producerOperationId: string;
  lockGeneration: string;
  writtenAt: string;
  frozenHost: HostIdentity;
  compatibilityKey: CompatibilityKey;
  process: LaunchCoordinationProcess;
  endpoint: {
    host: typeof MAIN_CDP_HOST;
    port: typeof MAIN_CDP_PORT;
  };
  browserIdentity: string;
  target: LaunchCoordinationTarget;
  effect: LaunchCoordinationEffect;
};

export type CoordinationValidationFailure =
  | "missing"
  | "malformed"
  | "stale_producer"
  | "host_mismatch"
  | "key_mismatch"
  | "process_mismatch"
  | "endpoint_mismatch"
  | "browser_mismatch"
  | "target_mismatch"
  | "effect_consumed"
  | "field_substitution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseHostIdentity(value: unknown): HostIdentity | null {
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
    hostHashes[key] = hash.toLowerCase();
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

function parseEffect(value: unknown): LaunchCoordinationEffect | null {
  if (!isRecord(value)) return null;
  if (value.status === "unconsumed") {
    return { status: "unconsumed" };
  }
  if (value.status === "consumed") {
    if (!isNonEmptyString(value.consumedAt)) return null;
    if (!isNonEmptyString(value.consumerOperationId)) return null;
    return {
      status: "consumed",
      consumedAt: value.consumedAt,
      consumerOperationId: value.consumerOperationId,
    };
  }
  return null;
}

function parseProcess(value: unknown): LaunchCoordinationProcess | null {
  if (!isRecord(value)) return null;
  if (!isPositiveInteger(value.pid)) return null;
  if (!isNonEmptyString(value.processStartedAt)) return null;
  if (!isNonEmptyString(value.executablePath)) return null;
  return {
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    executablePath: value.executablePath,
  };
}

function parseTarget(value: unknown): LaunchCoordinationTarget | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.targetId)) return null;
  if (value.targetType !== "page") return null;
  if (value.targetUrl !== "app://-/index.html") return null;
  if (!isNonEmptyString(value.frameId)) return null;
  if (!isNonNegativeInteger(value.executionContextId)) return null;
  if (!isNonEmptyString(value.executionContextUniqueId)) return null;
  return {
    targetId: value.targetId,
    targetType: "page",
    targetUrl: "app://-/index.html",
    frameId: value.frameId,
    executionContextId: value.executionContextId,
    executionContextUniqueId: value.executionContextUniqueId,
  };
}

/** Parse unknown JSON into a complete coordination record, or null when malformed. */
export function parseLaunchCoordinationRecord(value: unknown): LaunchCoordinationRecord | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== MAIN_LAUNCH_COORDINATION_SCHEMA_VERSION) return null;
  if (value.kind !== MAIN_LAUNCH_COORDINATION_KIND) return null;
  if (!isNonEmptyString(value.producerOperationId)) return null;
  if (!isNonEmptyString(value.lockGeneration)) return null;
  if (!isNonEmptyString(value.writtenAt)) return null;
  if (!isNonEmptyString(value.browserIdentity)) return null;

  const frozenHost = parseHostIdentity(value.frozenHost);
  if (frozenHost === null) return null;
  const compatibilityKey = parseCompatibilityKey(value.compatibilityKey);
  if (compatibilityKey === null) return null;
  const process = parseProcess(value.process);
  if (process === null) return null;
  const target = parseTarget(value.target);
  if (target === null) return null;
  const effect = parseEffect(value.effect);
  if (effect === null) return null;

  if (!isRecord(value.endpoint)) return null;
  if (value.endpoint.host !== MAIN_CDP_HOST) return null;
  if (value.endpoint.port !== MAIN_CDP_PORT) return null;

  return {
    schemaVersion: MAIN_LAUNCH_COORDINATION_SCHEMA_VERSION,
    kind: MAIN_LAUNCH_COORDINATION_KIND,
    producerOperationId: value.producerOperationId,
    lockGeneration: value.lockGeneration,
    writtenAt: value.writtenAt,
    frozenHost,
    compatibilityKey,
    process,
    endpoint: {
      host: MAIN_CDP_HOST,
      port: MAIN_CDP_PORT,
    },
    browserIdentity: value.browserIdentity,
    target,
    effect,
  };
}

export function coordinationRecordPath(explodexHome: string): string {
  return mainLaunchCoordinationPath(explodexHome);
}

export async function loadLaunchCoordinationRecord(options: {
  adapters: HostAdapters;
  explodexHome: string;
}): Promise<LaunchCoordinationRecord | null> {
  const path = coordinationRecordPath(options.explodexHome);
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
  return parseLaunchCoordinationRecord(parsed);
}

export async function writeLaunchCoordinationRecord(options: {
  adapters: HostAdapters;
  explodexHome: string;
  record: LaunchCoordinationRecord;
}): Promise<void> {
  const { adapters, explodexHome, record } = options;
  if (parseLaunchCoordinationRecord(record) === null) {
    throw new Error("Refusing to persist a malformed launch coordination record");
  }
  const dir = stateDirectory(explodexHome);
  const finalPath = coordinationRecordPath(explodexHome);
  const tempPath = join(
    dir,
    `main-launch-coordination.${record.producerOperationId}.${Date.now()}.tmp`,
  );
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = new TextEncoder().encode(payload);

  if (!adapters.fs.mkdir || !adapters.fs.writeFile || !adapters.fs.rename) {
    throw new Error(
      "Filesystem adapter must support mkdir/writeFile/rename to save launch coordination",
    );
  }

  await adapters.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await adapters.fs.writeFile(tempPath, bytes);
  await adapters.fs.rename(tempPath, finalPath);
}

function hostEquals(left: HostIdentity, right: HostIdentity): boolean {
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
  for (const key of leftKeys) {
    if (left.hostHashes[key]?.toLowerCase() !== right.hostHashes[key]?.toLowerCase()) {
      return false;
    }
  }
  return true;
}

export function buildLaunchCoordinationRecord(input: {
  producerOperationId: string;
  lockGeneration: string;
  writtenAt: string;
  frozenHost: HostIdentity;
  compatibilityKey: CompatibilityKey;
  process: VerifiedProcess | LaunchCoordinationProcess;
  browserIdentity: string;
  target: TargetIdentity | LaunchCoordinationTarget;
}): LaunchCoordinationRecord {
  const target: LaunchCoordinationTarget = {
    targetId: input.target.targetId,
    targetType: "page",
    targetUrl: "app://-/index.html",
    frameId: input.target.frameId,
    executionContextId: input.target.executionContextId,
    executionContextUniqueId: input.target.executionContextUniqueId,
  };

  return {
    schemaVersion: MAIN_LAUNCH_COORDINATION_SCHEMA_VERSION,
    kind: MAIN_LAUNCH_COORDINATION_KIND,
    producerOperationId: input.producerOperationId,
    lockGeneration: input.lockGeneration,
    writtenAt: input.writtenAt,
    frozenHost: {
      bundlePath: input.frozenHost.bundlePath,
      executablePath: input.frozenHost.executablePath,
      bundleId: input.frozenHost.bundleId,
      executableName: input.frozenHost.executableName,
      signingTeam: input.frozenHost.signingTeam,
      appVersion: input.frozenHost.appVersion,
      appBuild: input.frozenHost.appBuild,
      hostHashes: { ...input.frozenHost.hostHashes },
    },
    compatibilityKey: {
      ...input.compatibilityKey,
      hostHashes: { ...input.compatibilityKey.hostHashes },
    },
    process: {
      pid: input.process.pid,
      processStartedAt: input.process.processStartedAt,
      executablePath: input.process.executablePath,
    },
    endpoint: {
      host: MAIN_CDP_HOST,
      port: MAIN_CDP_PORT,
    },
    browserIdentity: input.browserIdentity,
    target: {
      targetId: target.targetId,
      targetType: target.targetType,
      targetUrl: target.targetUrl,
      frameId: target.frameId,
      executionContextId: target.executionContextId,
      executionContextUniqueId: target.executionContextUniqueId,
    },
    effect: { status: "unconsumed" },
  };
}

/**
 * Validate that a loaded record still exactly matches the expected producer
 * binding. Any field substitution, consumption, or mismatch fails closed.
 */
export function validateLaunchCoordinationRecord(input: {
  record: LaunchCoordinationRecord | null;
  expectedProducerOperationId?: string;
  expectedLockGeneration?: string;
  frozenHost: HostIdentity;
  compatibilityKey: CompatibilityKey;
  process: Pick<VerifiedProcess, "pid" | "processStartedAt" | "executablePath">;
  browserIdentity?: string;
  target?: Pick<
    TargetIdentity,
    | "targetId"
    | "targetType"
    | "targetUrl"
    | "frameId"
    | "executionContextId"
    | "executionContextUniqueId"
  >;
  requireUnconsumedEffect: boolean;
}): { ok: true; record: LaunchCoordinationRecord } | { ok: false; reason: CoordinationValidationFailure } {
  if (input.record === null) {
    return { ok: false, reason: "missing" };
  }
  const record = parseLaunchCoordinationRecord(input.record);
  if (record === null) {
    return { ok: false, reason: "malformed" };
  }

  if (
    input.expectedProducerOperationId !== undefined &&
    record.producerOperationId !== input.expectedProducerOperationId
  ) {
    return { ok: false, reason: "stale_producer" };
  }
  if (
    input.expectedLockGeneration !== undefined &&
    record.lockGeneration !== input.expectedLockGeneration
  ) {
    return { ok: false, reason: "stale_producer" };
  }
  if (!hostEquals(record.frozenHost, input.frozenHost)) {
    return { ok: false, reason: "host_mismatch" };
  }
  if (!compatibilityKeysEqual(record.compatibilityKey, input.compatibilityKey)) {
    return { ok: false, reason: "key_mismatch" };
  }
  if (
    record.process.pid !== input.process.pid ||
    record.process.processStartedAt !== input.process.processStartedAt ||
    record.process.executablePath !== input.process.executablePath
  ) {
    return { ok: false, reason: "process_mismatch" };
  }
  if (
    record.endpoint.host !== MAIN_CDP_HOST ||
    record.endpoint.port !== MAIN_CDP_PORT
  ) {
    return { ok: false, reason: "endpoint_mismatch" };
  }
  if (
    input.browserIdentity !== undefined &&
    record.browserIdentity !== input.browserIdentity
  ) {
    return { ok: false, reason: "browser_mismatch" };
  }
  if (input.target !== undefined) {
    if (
      record.target.targetId !== input.target.targetId ||
      record.target.targetType !== input.target.targetType ||
      record.target.targetUrl !== input.target.targetUrl ||
      record.target.frameId !== input.target.frameId ||
      record.target.executionContextId !== input.target.executionContextId ||
      record.target.executionContextUniqueId !== input.target.executionContextUniqueId
    ) {
      return { ok: false, reason: "target_mismatch" };
    }
  }
  if (input.requireUnconsumedEffect && record.effect.status !== "unconsumed") {
    return { ok: false, reason: "effect_consumed" };
  }
  return { ok: true, record };
}

/**
 * Atomically consume one-shot effect authority after final barriers pass.
 * Re-reads the record, requires exact match + unconsumed effect, then writes
 * consumed state. Concurrent consumers fail closed.
 */
export async function consumeLaunchCoordinationEffect(options: {
  adapters: HostAdapters;
  explodexHome: string;
  expected: LaunchCoordinationRecord;
  consumerOperationId: string;
  nowIso: string;
}): Promise<
  | { ok: true; record: LaunchCoordinationRecord }
  | { ok: false; reason: CoordinationValidationFailure }
> {
  const loaded = await loadLaunchCoordinationRecord({
    adapters: options.adapters,
    explodexHome: options.explodexHome,
  });
  const validated = validateLaunchCoordinationRecord({
    record: loaded,
    expectedProducerOperationId: options.expected.producerOperationId,
    expectedLockGeneration: options.expected.lockGeneration,
    frozenHost: options.expected.frozenHost,
    compatibilityKey: options.expected.compatibilityKey,
    process: options.expected.process,
    browserIdentity: options.expected.browserIdentity,
    target: options.expected.target,
    requireUnconsumedEffect: true,
  });
  if (!validated.ok) return validated;

  const consumed: LaunchCoordinationRecord = {
    ...validated.record,
    effect: {
      status: "consumed",
      consumedAt: options.nowIso,
      consumerOperationId: options.consumerOperationId,
    },
  };
  await writeLaunchCoordinationRecord({
    adapters: options.adapters,
    explodexHome: options.explodexHome,
    record: consumed,
  });
  return { ok: true, record: consumed };
}

/** Detect attempted field substitution between two candidate records. */
export function detectCoordinationFieldSubstitution(
  original: LaunchCoordinationRecord,
  candidate: unknown,
): CoordinationValidationFailure | null {
  const parsed = parseLaunchCoordinationRecord(candidate);
  if (parsed === null) return "malformed";
  if (parsed.producerOperationId !== original.producerOperationId) return "field_substitution";
  if (parsed.lockGeneration !== original.lockGeneration) return "field_substitution";
  if (!hostEquals(parsed.frozenHost, original.frozenHost)) return "field_substitution";
  if (!compatibilityKeysEqual(parsed.compatibilityKey, original.compatibilityKey)) {
    return "field_substitution";
  }
  if (
    parsed.process.pid !== original.process.pid ||
    parsed.process.processStartedAt !== original.process.processStartedAt ||
    parsed.process.executablePath !== original.process.executablePath
  ) {
    return "field_substitution";
  }
  if (parsed.browserIdentity !== original.browserIdentity) return "field_substitution";
  if (
    parsed.target.targetId !== original.target.targetId ||
    parsed.target.executionContextId !== original.target.executionContextId ||
    parsed.target.executionContextUniqueId !== original.target.executionContextUniqueId ||
    parsed.target.frameId !== original.target.frameId
  ) {
    return "field_substitution";
  }
  return null;
}
