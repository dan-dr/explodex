import { createHash, randomBytes } from "node:crypto";
import type { CdpAdapter } from "../cdp/adapters.ts";
import {
  runExactTargetOperation,
  type PointOfUseIdentity,
} from "../cdp/operation.ts";
import type { HostIdentity } from "../host/types.ts";
import type {
  DeclaredRoleEndpoint,
  HostRole,
  VerifiedProcess,
} from "../host/status.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import {
  createReviewSelectionAcceptor,
  type ReviewArtifact,
  type ReviewSelectionTuple,
} from "./review-protocol.ts";
import {
  buildMetadataUpdateExpression,
  createUpdateReviewProtocolContext,
  type UpdateReviewProtocolContext,
} from "./update-review-protocol.ts";

export type PluginUpdateReviewOperationResult =
  | {
      ok: true;
      operationId: string;
      status: "submitted";
      selected: ReviewSelectionTuple[];
      reviewed: ReviewArtifact[];
      protocol: {
        callbackName: string;
        nonce: string;
        activationSecret: string;
        expiresAtMs: number;
        target: UpdateReviewProtocolContext["target"];
      };
      sourceDelivered: false;
      authorityChanged: false;
      residualInventory: {
        callbacks: number;
        sessions: number;
        hasResidentControlPlane: boolean;
      };
    }
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      cleanupProtocol?: {
        nonce: string;
        target: UpdateReviewProtocolContext["target"];
      };
      sourceDelivered: false;
      authorityChanged: false;
    };

function parseRendererOutcome(value: unknown):
  | { status: "submitted"; payload: unknown }
  | { status: "cancelled" | "expired" | "rejected"; reason: string }
  | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) return null;
  const record = value as Record<string, unknown>;
  if (
    record["status"] === "submitted" &&
    Object.keys(record).length === 2 &&
    "payload" in record
  ) {
    return { status: "submitted", payload: record["payload"] };
  }
  if (
    (
      record["status"] === "cancelled" ||
      record["status"] === "expired" ||
      record["status"] === "rejected"
    ) &&
    Object.keys(record).length === 2 &&
    typeof record["reason"] === "string"
  ) {
    return { status: record["status"], reason: record["reason"] };
  }
  return null;
}

export async function runPluginUpdateReviewOperation(options: {
  runtime: RuntimeAdapters;
  operationId?: string;
  role: HostRole;
  homeIdentity: string;
  host: HostIdentity;
  process: VerifiedProcess;
  endpoint: DeclaredRoleEndpoint;
  cdp: CdpAdapter;
  expectedTargetId?: string;
  revalidate(): Promise<PointOfUseIdentity>;
  sdkRuntimeSource: string;
  artifacts: readonly ReviewArtifact[];
  enabledPluginIdentities: readonly ReviewSelectionTuple[];
  timeoutMs: number;
  signal?: AbortSignal;
  nowMs?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<PluginUpdateReviewOperationResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      ok: false,
      operationId: options.operationId ?? "plugin-update-review",
      code: "usage.invalid-value",
      message: "Plugin update review timeout must be a finite positive duration.",
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const holder: { value: UpdateReviewProtocolContext | null } = {
    value: null,
  };
  let activationSecret = "";
  let activationCommitment = "";
  const nowMs = options.nowMs ?? (() => Date.now());
  const entropy = options.randomBytes ??
    ((length: number) => randomBytes(length));
  const operation = await runExactTargetOperation({
    runtime: options.runtime,
    operationId: options.operationId,
    operation: "plugin.update.review",
    role: options.role,
    homeIdentity: options.homeIdentity,
    host: options.host,
    process: options.process,
    endpoint: options.endpoint,
    cdp: options.cdp,
    signal: options.signal,
    revalidate: options.revalidate,
    evaluate: {
      callbackIdentity(input) {
        if (
          options.expectedTargetId !== undefined &&
          input.target.targetId !== options.expectedTargetId
        ) {
          throw Object.assign(
            new Error("Selected renderer target does not match owned target state."),
            { code: "target_identity_drift" as const },
          );
        }
        holder.value = createUpdateReviewProtocolContext({
          artifacts: options.artifacts,
          target: input.target,
          operationId: input.operationId,
          nowMs: nowMs(),
          ttlMs: options.timeoutMs,
          randomBytes: entropy,
        });
        activationSecret = [...entropy(32)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        activationCommitment = createHash("sha256")
          .update(activationSecret, "utf8")
          .digest("hex");
        return holder.value.callbackName;
      },
      expression() {
        if (holder.value === null) {
          throw new Error("Update callback context was not initialized.");
        }
        return buildMetadataUpdateExpression({
          sdkRuntimeSource: options.sdkRuntimeSource,
          context: holder.value,
          enabledPluginIdentities: options.enabledPluginIdentities,
          activationCommitment,
          applicationTtlMs: options.timeoutMs,
        });
      },
    },
    stageBounds: { cdpEvaluationMs: options.timeoutMs },
  });
  if (!operation.ok) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: operation.error.code,
      message: operation.error.message,
      details: {
        stage: operation.error.stage,
        residualInventory: operation.residualInventory,
      },
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const context = holder.value;
  if (context === null) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.update.invalid-response",
      message: "Update review context was unavailable after renderer completion.",
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const outcome = parseRendererOutcome(operation.result.evaluation.value);
  if (outcome === null) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.update.invalid-response",
      message: "Renderer update review returned a malformed outcome.",
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  if (outcome.status !== "submitted") {
    const code = outcome.status === "cancelled"
      ? "plugin.update.cancelled"
      : outcome.status === "expired"
        ? "operation.timeout"
        : "plugin.update.invalid-response";
    return {
      ok: false,
      operationId: operation.operationId,
      code,
      message: outcome.status === "cancelled"
        ? "Plugin update review was cancelled or dismissed."
        : outcome.status === "expired"
          ? "Plugin update review expired before a valid response."
          : "Renderer update review rejected the operation.",
      details: { reason: outcome.reason },
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const accepted = createReviewSelectionAcceptor(context).accept(
    outcome.payload,
    {
      nowMs: nowMs(),
      target: operation.result.target,
    },
  );
  if (!accepted.ok) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: accepted.code.replace("plugin.review.", "plugin.update."),
      message: accepted.message,
      cleanupProtocol: {
        nonce: context.nonce,
        target: context.target,
      },
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  return {
    ok: true,
    operationId: operation.operationId,
    status: "submitted",
    selected: accepted.selected,
    reviewed: context.artifacts,
    protocol: {
      callbackName: context.callbackName,
      nonce: context.nonce,
      activationSecret,
      expiresAtMs: context.expiresAtMs,
      target: context.target,
    },
    sourceDelivered: false,
    authorityChanged: false,
    residualInventory: {
      callbacks: operation.residualInventory.callbacks,
      sessions: operation.residualInventory.sessions,
      hasResidentControlPlane:
        operation.residualInventory.hasResidentControlPlane,
    },
  };
}
