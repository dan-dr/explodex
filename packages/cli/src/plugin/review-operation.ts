import { randomBytes } from "node:crypto";
import type { HostIdentity } from "../host/types.ts";
import type {
  DeclaredRoleEndpoint,
  HostRole,
  VerifiedProcess,
} from "../host/status.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { CdpAdapter } from "../cdp/adapters.ts";
import {
  runExactTargetOperation,
  type PointOfUseIdentity,
} from "../cdp/operation.ts";
import {
  buildMetadataReviewExpression,
  createReviewProtocolContext,
  createReviewSelectionAcceptor,
  type ReviewArtifact,
  type ReviewProtocolContext,
  type ReviewSelectionTuple,
} from "./review-protocol.ts";

export type PluginReviewOperationResult =
  | {
      ok: true;
      operationId: string;
      status: "submitted";
      selected: ReviewSelectionTuple[];
      reviewed: ReviewArtifact[];
      protocol: {
        callbackName: string;
        nonce: string;
        expiresAtMs: number;
        target: ReviewProtocolContext["target"];
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
      sourceDelivered: false;
      authorityChanged: false;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRendererOutcome(value: unknown):
  | {
      status: "submitted";
      payload: unknown;
    }
  | {
      status: "cancelled" | "expired" | "rejected";
      reason: string;
    }
  | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (
    value.status === "submitted" &&
    Object.keys(value).length === 2 &&
    "payload" in value
  ) {
    return { status: "submitted", payload: value.payload };
  }
  if (
    (value.status === "cancelled" ||
      value.status === "expired" ||
      value.status === "rejected") &&
    Object.keys(value).length === 2 &&
    typeof value.reason === "string"
  ) {
    return { status: value.status, reason: value.reason };
  }
  return null;
}

export async function runPluginReviewOperation(options: {
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
  timeoutMs: number;
  nowMs?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<PluginReviewOperationResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      ok: false,
      operationId: options.operationId ?? "plugin-review",
      code: "usage.invalid-value",
      message: "Plugin review timeout must be a finite positive duration.",
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const contextHolder: { value: ReviewProtocolContext | null } = {
    value: null,
  };
  const nowMs = options.nowMs ?? (() => Date.now());
  const entropy = options.randomBytes ?? ((length: number) => randomBytes(length));
  const operation = await runExactTargetOperation({
    runtime: options.runtime,
    operationId: options.operationId,
    operation: "plugin.review",
    role: options.role,
    homeIdentity: options.homeIdentity,
    host: options.host,
    process: options.process,
    endpoint: options.endpoint,
    cdp: options.cdp,
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
        contextHolder.value = createReviewProtocolContext({
          artifacts: options.artifacts,
          target: input.target,
          operationId: input.operationId,
          nowMs: nowMs(),
          ttlMs: options.timeoutMs,
          randomBytes: entropy,
        });
        return contextHolder.value.callbackName;
      },
      expression() {
        if (contextHolder.value === null) {
          throw new Error("Review callback context was not initialized.");
        }
        return buildMetadataReviewExpression({
          sdkRuntimeSource: options.sdkRuntimeSource,
          context: contextHolder.value,
        });
      },
    },
    stageBounds: {
      cdpEvaluationMs: options.timeoutMs,
    },
  });

  if (!operation.ok) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: operation.error.code,
      message: operation.error.message,
      details: {
        stage: operation.error.stage,
        ...(operation.error.boundMs === undefined
          ? {}
          : { boundMs: operation.error.boundMs }),
        residualInventory: operation.residualInventory,
      },
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const context = contextHolder.value;
  if (context === null) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.review.invalid-response",
      message: "Review context was unavailable after renderer completion.",
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const outcome = parseRendererOutcome(operation.result.evaluation.value);
  if (outcome === null) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.review.invalid-response",
      message: "Renderer review returned a malformed outcome.",
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  if (outcome.status !== "submitted") {
    if (outcome.status === "cancelled") {
      return {
        ok: false,
        operationId: operation.operationId,
        code: "plugin.review.cancelled",
        message: "Plugin review was cancelled or dismissed.",
        details: { reason: outcome.reason },
        sourceDelivered: false,
        authorityChanged: false,
      };
    }
    if (outcome.status === "expired") {
      return {
        ok: false,
        operationId: operation.operationId,
        code: "operation.timeout",
        message: "Plugin review expired before a valid response.",
        details: { reason: outcome.reason, boundMs: options.timeoutMs },
        sourceDelivered: false,
        authorityChanged: false,
      };
    }
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.review.invalid-response",
      message: "Renderer review rejected the operation.",
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
      code: accepted.code,
      message: accepted.message,
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
