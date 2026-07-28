import {
  satisfiesSdkRange,
} from "@explodex/sdk";
import type { TargetIdentity } from "../cdp/types.ts";
import type { GenerationRecord } from "../plugin/generation.ts";

type ArtifactCandidate = {
  id: string;
  version: string;
  payloadSha256: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  sdkRange: string;
};

type DevValidationReceipt = {
  generationId?: string;
  validationOperationId?: string;
  pluginIdentity: {
    id: string;
    version: string;
    payloadSha256: string;
  };
  sdkRuntimeIdentity: {
    version: string;
    sha256: string;
  };
  target: TargetIdentity;
};

export type PublishableGraduationResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "develop.local-sdk-not-publishable"
        | "develop.publishable-rebuild-required"
        | "develop.dev-revalidation-required"
        | "develop.main-transfer-ineligible";
      message: string;
    };

function identitiesEqual(
  artifact: ArtifactCandidate,
  validation: DevValidationReceipt,
): boolean {
  return artifact.id === validation.pluginIdentity.id &&
    artifact.version === validation.pluginIdentity.version &&
    artifact.payloadSha256 === validation.pluginIdentity.payloadSha256;
}

/**
 * Pure graduation predicate shared by release/main staging features. Local-SDK
 * generations are always dev-only. A clean publishable rebuild must be
 * revalidated on dev whenever its exact payload identity differs.
 */
export function evaluatePublishableGraduation(options: {
  generation: GenerationRecord | null;
  artifact: ArtifactCandidate | null;
  devValidation: DevValidationReceipt | null;
  mainSdkRuntime: { version: string; sha256: string };
}): PublishableGraduationResult {
  if (options.generation === null || options.generation.sdkInput === undefined) {
    return {
      ok: false,
      code: "develop.publishable-rebuild-required",
      message: "A clean publishable plugin rebuild is required.",
    };
  }
  if (options.generation.sdkInput.kind === "local-source") {
    return {
      ok: false,
      code: "develop.local-sdk-not-publishable",
      message:
        "Local-SDK-dependent output is dev-only. Publish or declare the SDK, or revise the plugin to the published API.",
    };
  }
  if (options.artifact === null) {
    return {
      ok: false,
      code: "develop.publishable-rebuild-required",
      message: "A clean publishable plugin rebuild is required.",
    };
  }
  if (
    options.devValidation === null ||
    !identitiesEqual(options.artifact, options.devValidation) ||
    options.devValidation.validationOperationId === undefined ||
    options.devValidation.validationOperationId.length === 0 ||
    options.devValidation.target.role !== "development" ||
    options.devValidation.target.port !== 9444 ||
    options.devValidation.generationId === undefined ||
    options.generation.generationId !==
      options.devValidation.generationId ||
    options.generation.pluginId !== options.artifact.id ||
    options.generation.version !== options.artifact.version ||
    options.generation.payloadSha256 !==
      options.artifact.payloadSha256 ||
    options.generation.sdkInput.kind !== "publishable" ||
    options.generation.sdkInput.version !==
      options.devValidation.sdkRuntimeIdentity.version ||
    options.generation.sdkInput.runtimeSha256 !==
      options.devValidation.sdkRuntimeIdentity.sha256
  ) {
    return {
      ok: false,
      code: "develop.dev-revalidation-required",
      message:
        "The exact publishable artifact must be validated again on owned development before graduation.",
    };
  }
  if (
    options.artifact.lifecycle !== "dynamic" ||
    options.devValidation.sdkRuntimeIdentity.version !==
      options.mainSdkRuntime.version ||
    options.devValidation.sdkRuntimeIdentity.sha256 !==
      options.mainSdkRuntime.sha256 ||
    !satisfiesSdkRange(
      options.mainSdkRuntime.version,
      options.artifact.sdkRange,
    )
  ) {
    return {
      ok: false,
      code: "develop.main-transfer-ineligible",
      message:
        "Only a dynamic artifact compatible with the exact unchanged main SDK runtime may advance.",
    };
  }
  return { ok: true };
}
