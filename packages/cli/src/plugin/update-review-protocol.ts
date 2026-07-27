import { createHash } from "node:crypto";
import type { TargetIdentity } from "../cdp/types.ts";
import {
  createReviewProtocolContext,
  type ReviewArtifact,
  type ReviewProtocolContext,
} from "./review-protocol.ts";

export type UpdateReviewProtocolContext = ReviewProtocolContext & {
  callbackName: `__explodexUpdate_${string}`;
};

export function createUpdateReviewProtocolContext(options: {
  artifacts: readonly ReviewArtifact[];
  target: TargetIdentity;
  operationId?: string;
  nowMs: number;
  ttlMs: number;
  randomBytes(length: number): Uint8Array;
}): UpdateReviewProtocolContext {
  const context = createReviewProtocolContext(options);
  const suffix = context.callbackName.slice("__explodexReview_".length);
  return {
    ...context,
    callbackName: `__explodexUpdate_${suffix}`,
  };
}

export function buildMetadataUpdateExpression(options: {
  sdkRuntimeSource: string;
  context: UpdateReviewProtocolContext;
  enabledPluginIdentities: readonly {
    id: string;
    version: string;
    payloadSha256: string;
  }[];
  activationCommitment: string;
  applicationTtlMs: number;
}): string {
  const enabledPluginIdentities = options.enabledPluginIdentities
    .map((identity) => ({ ...identity }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 :
      left.version < right.version ? -1 : left.version > right.version ? 1 :
      left.payloadSha256 < right.payloadSha256 ? -1 :
      left.payloadSha256 > right.payloadSha256 ? 1 : 0
    );
  const request = {
    schemaVersion: 1,
    surface: "update",
    operationId: options.context.operationId,
    nonce: options.context.nonce,
    callbackName: options.context.callbackName,
    expiresAtMs: options.context.expiresAtMs,
    activationCommitment: options.activationCommitment,
    applicationTtlMs: options.applicationTtlMs,
    warning:
      "Enabled plugins are trusted unsandboxed renderer code that can read or modify UI and authenticated renderer state. Confirmation and checksums do not provide sandboxing or publisher authentication.",
    enabledPluginIdentities,
    artifacts: options.context.artifacts,
  };
  const sdkRequestIdentity = `${
    createHash("sha256").update(options.sdkRuntimeSource).digest("hex")
  }:${options.context.operationId}`;
  return `(
async () => {
const previousRuntime = globalThis.Explodex;
if (
  previousRuntime &&
  previousRuntime["__explodexSdkRuntimeRequestMark"] !== ${
    JSON.stringify(sdkRequestIdentity)
  }
) {
  const adoptRequest = previousRuntime["__explodexAdoptRuntimeRequest"];
  const adopted = typeof adoptRequest === "function" &&
    adoptRequest(${JSON.stringify(sdkRequestIdentity)}) === true;
  if (!adopted) {
    const destroyAndWait = previousRuntime["__explodexDestroyRuntimeAndWait"];
    if (typeof destroyAndWait !== "function") {
      throw new Error("Previous Explodex runtime cannot be replaced safely");
    }
    await destroyAndWait({ reason: "operation-replacement" });
  }
}
globalThis.__explodexSdkRuntimeRequestIdentity = ${
    JSON.stringify(sdkRequestIdentity)
  };
${options.sdkRuntimeSource}
  const runtime = globalThis.Explodex;
  if (!runtime || !runtime.updates || typeof runtime.updates.open !== "function") {
    throw new Error("Explodex runtime update review surface is unavailable");
  }
  return await runtime.updates.open(${JSON.stringify(request)});
}
)()`;
}
