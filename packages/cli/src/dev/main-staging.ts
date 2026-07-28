import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { satisfiesSdkRange } from "@explodex/sdk";
import type { TargetIdentity } from "../cdp/types.ts";
import type { GenerationRecord } from "../plugin/generation.ts";

export type MainStagingArtifactIdentity = {
  id: string;
  version: string;
  payloadSha256: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  sdkRange: string;
};

export type StagedMainArtifactReceipt = {
  schemaVersion: 1;
  id: string;
  version: string;
  payloadSha256: string;
  lifecycle: "dynamic";
  sdkRange: string;
  builtWithPublishableSdk: true;
  generationId: string;
  sdkRuntimeVersion: string;
  sdkRuntimeSha256: string;
  devValidatedTarget: TargetIdentity;
  devValidatedAt: string;
  compatibilityKeyHash: string;
};

export type MainStagingFailure = {
  ok: false;
  code:
    | "develop.local-sdk-not-publishable"
    | "develop.publishable-rebuild-required"
    | "develop.dev-revalidation-required"
    | "main.lifecycle-protected"
    | "main.staged-artifact-changed"
    | "main.sdk-runtime-changed"
    | "compatibility.drifted";
  message: string;
  details?: Record<string, unknown>;
};

export type MainStagingResult =
  | { ok: true; receipt: StagedMainArtifactReceipt }
  | MainStagingFailure;

export type MainStagedArtifactValidation =
  | { ok: true }
  | MainStagingFailure;

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function exactArtifact(
  artifact: MainStagingArtifactIdentity,
  generation: GenerationRecord,
): boolean {
  return artifact.id === generation.pluginId &&
    artifact.version === generation.version &&
    artifact.payloadSha256 === generation.payloadSha256;
}

function validGenerationIdentity(generation: GenerationRecord): boolean {
  return generation.schemaVersion === 1 &&
    generation.generationId.length > 0 &&
    generation.pluginId.length > 0 &&
    generation.version.length > 0 &&
    isSha256(generation.payloadSha256) &&
    generation.sdkInput !== undefined &&
    generation.sdkInput.version.length > 0 &&
    isSha256(generation.sdkInput.runtimeSha256);
}

function receiptFailure(
  code: MainStagingFailure["code"],
  message: string,
  details?: Record<string, unknown>,
): MainStagingFailure {
  return {
    ok: false,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

export function createStagedMainArtifactReceipt(options: {
  artifact: MainStagingArtifactIdentity;
  generation: GenerationRecord | null;
  sdkRuntimeIdentity: { version: string; sha256: string };
  devValidatedTarget: TargetIdentity;
  devValidatedAt: string;
  compatibilityKeyHash: string;
}): MainStagingResult {
  const generation = options.generation;
  if (
    generation === null ||
    generation.sdkInput === undefined ||
    !validGenerationIdentity(generation)
  ) {
    return receiptFailure(
      "develop.publishable-rebuild-required",
      "A complete publishable build generation is required before main staging.",
    );
  }
  if (generation.sdkInput.kind === "local-source") {
    return receiptFailure(
      "develop.local-sdk-not-publishable",
      "Local-SDK-dependent output is dev-only and cannot be staged for the authoring main.",
    );
  }
  if (options.artifact.lifecycle !== "dynamic") {
    return receiptFailure(
      "main.lifecycle-protected",
      "Renderer-start and app-start artifacts cannot be staged for the protected authoring main.",
    );
  }
  if (
    !exactArtifact(options.artifact, generation) ||
    options.devValidatedTarget.role !== "development" ||
    options.devValidatedTarget.port !== 9444
  ) {
    return receiptFailure(
      "develop.dev-revalidation-required",
      "The exact publishable artifact must complete validation on the owned development target.",
    );
  }
  if (
    generation.sdkInput.version !== options.sdkRuntimeIdentity.version ||
    generation.sdkInput.runtimeSha256 !==
      options.sdkRuntimeIdentity.sha256 ||
    !isSha256(options.sdkRuntimeIdentity.sha256) ||
    !isSha256(options.compatibilityKeyHash) ||
    !Number.isFinite(Date.parse(options.devValidatedAt))
  ) {
    return receiptFailure(
      "develop.dev-revalidation-required",
      "The development receipt does not match one exact publishable SDK and compatibility identity.",
    );
  }
  return {
    ok: true,
    receipt: Object.freeze({
      schemaVersion: 1,
      id: options.artifact.id,
      version: options.artifact.version,
      payloadSha256: options.artifact.payloadSha256,
      lifecycle: "dynamic",
      sdkRange: options.artifact.sdkRange,
      builtWithPublishableSdk: true,
      generationId: generation.generationId,
      sdkRuntimeVersion: options.sdkRuntimeIdentity.version,
      sdkRuntimeSha256: options.sdkRuntimeIdentity.sha256,
      devValidatedTarget: Object.freeze({
        ...options.devValidatedTarget,
      }),
      devValidatedAt: options.devValidatedAt,
      compatibilityKeyHash: options.compatibilityKeyHash,
    }),
  };
}

export function validateStagedMainArtifact(options: {
  receipt: StagedMainArtifactReceipt;
  artifact: MainStagingArtifactIdentity;
  generation: GenerationRecord | null;
  mainSdkRuntime: { version: string; sha256: string };
  compatibilityKeyHash: string;
}): MainStagedArtifactValidation {
  if (
    options.receipt.lifecycle !== "dynamic" ||
    options.artifact.lifecycle !== "dynamic"
  ) {
    return receiptFailure(
      "main.lifecycle-protected",
      "Only hot-safe dynamic artifacts may be applied to the protected authoring main.",
    );
  }
  if (
    options.artifact.id !== options.receipt.id ||
    options.artifact.version !== options.receipt.version ||
    options.artifact.payloadSha256 !== options.receipt.payloadSha256 ||
    options.artifact.sdkRange !== options.receipt.sdkRange
  ) {
    return receiptFailure(
      "main.staged-artifact-changed",
      "The staged plugin bytes or exact manifest identity changed after development validation.",
    );
  }
  const generation = options.generation;
  if (
    generation === null ||
    !validGenerationIdentity(generation) ||
    generation.generationId !== options.receipt.generationId ||
    !exactArtifact(options.artifact, generation)
  ) {
    return receiptFailure(
      "develop.publishable-rebuild-required",
      "The current artifact is missing the exact staged publishable build generation.",
    );
  }
  if (generation.sdkInput?.kind === "local-source") {
    return receiptFailure(
      "develop.local-sdk-not-publishable",
      "A local-SDK-dependent generation cannot be transferred to the authoring main.",
    );
  }
  if (
    generation.sdkInput?.kind !== "publishable" ||
    generation.sdkInput.version !== options.receipt.sdkRuntimeVersion ||
    generation.sdkInput.runtimeSha256 !==
      options.receipt.sdkRuntimeSha256
  ) {
    return receiptFailure(
      "develop.publishable-rebuild-required",
      "The staged artifact no longer has the exact publishable SDK build identity.",
    );
  }
  if (
    options.mainSdkRuntime.version !== options.receipt.sdkRuntimeVersion ||
    options.mainSdkRuntime.sha256 !== options.receipt.sdkRuntimeSha256 ||
    !satisfiesSdkRange(
      options.mainSdkRuntime.version,
      options.artifact.sdkRange,
    )
  ) {
    return receiptFailure(
      "main.sdk-runtime-changed",
      "The authoring main does not contain the exact unchanged compatible SDK runtime used for dev validation.",
    );
  }
  if (options.compatibilityKeyHash !== options.receipt.compatibilityKeyHash) {
    return receiptFailure(
      "compatibility.drifted",
      "The current exact compatibility proof differs from the staged dev-validation proof.",
    );
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function parseTarget(value: unknown): TargetIdentity | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, [
      "role",
      "pid",
      "processStartedAt",
      "executablePath",
      "appVersion",
      "appBuild",
      "port",
      "browserIdentity",
      "targetId",
      "targetType",
      "targetUrl",
      "executionContextId",
      "executionContextUniqueId",
      "frameId",
    ]) ||
    value.role !== "development" ||
    value.port !== 9444 ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartedAt !== "string" ||
    value.processStartedAt.length === 0 ||
    typeof value.executablePath !== "string" ||
    value.executablePath.length === 0 ||
    typeof value.appVersion !== "string" ||
    value.appVersion.length === 0 ||
    typeof value.appBuild !== "string" ||
    value.appBuild.length === 0 ||
    typeof value.browserIdentity !== "string" ||
    value.browserIdentity.length === 0 ||
    typeof value.targetId !== "string" ||
    value.targetId.length === 0 ||
    value.targetType !== "page" ||
    value.targetUrl !== "app://-/index.html" ||
    typeof value.executionContextId !== "number" ||
    !Number.isInteger(value.executionContextId) ||
    value.executionContextId <= 0 ||
    typeof value.executionContextUniqueId !== "string" ||
    value.executionContextUniqueId.length === 0 ||
    typeof value.frameId !== "string" ||
    value.frameId.length === 0
  ) {
    return null;
  }
  return value as TargetIdentity;
}

export function parseStagedMainArtifactReceipt(
  value: unknown,
): StagedMainArtifactReceipt | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (
    !exactKeys(value, [
      "schemaVersion",
      "id",
      "version",
      "payloadSha256",
      "lifecycle",
      "sdkRange",
      "builtWithPublishableSdk",
      "generationId",
      "sdkRuntimeVersion",
      "sdkRuntimeSha256",
      "devValidatedTarget",
      "devValidatedAt",
      "compatibilityKeyHash",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    !isSha256(String(value.payloadSha256)) ||
    value.lifecycle !== "dynamic" ||
    typeof value.sdkRange !== "string" ||
    value.sdkRange.length === 0 ||
    value.builtWithPublishableSdk !== true ||
    typeof value.generationId !== "string" ||
    value.generationId.length === 0 ||
    typeof value.sdkRuntimeVersion !== "string" ||
    value.sdkRuntimeVersion.length === 0 ||
    !isSha256(String(value.sdkRuntimeSha256)) ||
    typeof value.devValidatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.devValidatedAt)) ||
    !isSha256(String(value.compatibilityKeyHash))
  ) {
    return null;
  }
  const target = parseTarget(value.devValidatedTarget);
  if (target === null) return null;
  return {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    payloadSha256: String(value.payloadSha256),
    lifecycle: "dynamic",
    sdkRange: value.sdkRange,
    builtWithPublishableSdk: true,
    generationId: value.generationId,
    sdkRuntimeVersion: value.sdkRuntimeVersion,
    sdkRuntimeSha256: String(value.sdkRuntimeSha256),
    devValidatedTarget: target,
    devValidatedAt: value.devValidatedAt,
    compatibilityKeyHash: String(value.compatibilityKeyHash),
  };
}

export function stagedMainArtifactReceiptPath(options: {
  explodexHome: string;
  id: string;
  payloadSha256: string;
}): string {
  return join(
    resolve(options.explodexHome),
    "state",
    "main-staging",
    encodeURIComponent(options.id),
    `${options.payloadSha256}.json`,
  );
}

export async function saveStagedMainArtifactReceipt(options: {
  explodexHome: string;
  receipt: StagedMainArtifactReceipt;
}): Promise<string> {
  const path = stagedMainArtifactReceiptPath({
    explodexHome: options.explodexHome,
    id: options.receipt.id,
    payloadSha256: options.receipt.payloadSha256,
  });
  const parent = dirname(path);
  const tempPath =
    `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  let committed = false;
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(options.receipt, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(tempPath, path);
    committed = true;
    await chmod(path, 0o600);
  } finally {
    if (!committed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
  return path;
}

export async function loadStagedMainArtifactReceipt(options: {
  explodexHome: string;
  id: string;
  payloadSha256: string;
}): Promise<StagedMainArtifactReceipt | null> {
  try {
    const raw = JSON.parse(await readFile(
      stagedMainArtifactReceiptPath(options),
      "utf8",
    )) as unknown;
    return parseStagedMainArtifactReceipt(raw);
  } catch {
    return null;
  }
}
