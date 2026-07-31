import { createHash } from "node:crypto";

import type { TargetIdentity } from "../cdp/types.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CALLBACK_PATTERN = /^__explodexReview_[A-Za-z0-9_]+$/;
const REVIEW_SCHEMA_VERSION = 1 as const;

export type ReviewArtifact = {
  id: string;
  displayName: string;
  description: string;
  version: string;
  payloadSha256: string;
  sdkRange: string;
  sourceLabel: string;
};

export type ReviewSelectionTuple = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type ReviewProtocolContext = {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  operationId: string;
  nonce: string;
  callbackName: string;
  createdAtMs: number;
  expiresAtMs: number;
  target: TargetIdentity;
  artifacts: ReviewArtifact[];
};

export type ReviewSelection = {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  nonce: string;
  selected: ReviewSelectionTuple[];
};

export type ReviewSelectionResult =
  | { ok: true; selected: ReviewSelectionTuple[] }
  | { ok: false; code: string; message: string };

export type ReviewArtifactSelection =
  | { ok: true; artifacts: ReviewArtifact[] }
  | { ok: false; code: string; message: string };

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function tupleKey(value: ReviewSelectionTuple): string {
  return `${value.id}\0${value.version}\0${value.payloadSha256}`;
}

function compareArtifacts(left: ReviewArtifact, right: ReviewArtifact): number {
  return left.id < right.id
    ? -1
    : left.id > right.id
      ? 1
      : left.version < right.version
        ? -1
        : left.version > right.version
          ? 1
          : left.payloadSha256 < right.payloadSha256
            ? -1
            : left.payloadSha256 > right.payloadSha256
              ? 1
              : 0;
}

function copyArtifact(value: ReviewArtifact): ReviewArtifact {
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.displayName) ||
    typeof value.description !== "string" ||
    !isNonEmptyString(value.version) ||
    !SHA256_PATTERN.test(value.payloadSha256) ||
    !isNonEmptyString(value.sdkRange) ||
    !isNonEmptyString(value.sourceLabel)
  ) {
    throw new Error("Review metadata contains an invalid field.");
  }
  return {
    id: value.id,
    displayName: value.displayName,
    description: value.description,
    version: value.version,
    payloadSha256: value.payloadSha256,
    sdkRange: value.sdkRange,
    sourceLabel: value.sourceLabel,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createReviewProtocolContext(options: {
  artifacts: readonly ReviewArtifact[];
  target: TargetIdentity;
  operationId?: string;
  nowMs: number;
  ttlMs: number;
  randomBytes(length: number): Uint8Array;
}): ReviewProtocolContext {
  if (!Number.isFinite(options.nowMs)) {
    throw new Error("Review creation time must be finite.");
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error("Review expiration must be a finite positive duration.");
  }
  const entropy = options.randomBytes(48);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 48) {
    throw new Error("Review entropy adapter must return exactly 48 bytes.");
  }
  const operationId = options.operationId ?? `review_${hex(entropy.slice(0, 12))}`;
  if (!isNonEmptyString(operationId)) {
    throw new Error("Review operation ID must be non-empty.");
  }
  const nonce = hex(entropy.slice(12, 36));
  const callbackName = `__explodexReview_${hex(entropy.slice(36, 48))}`;
  if (!CALLBACK_PATTERN.test(callbackName)) {
    throw new Error("Generated review callback name is invalid.");
  }
  const deduplicated = new Map<string, ReviewArtifact>();
  for (const artifact of options.artifacts) {
    const copied = copyArtifact(artifact);
    deduplicated.set(tupleKey(copied), copied);
  }
  const artifacts = [...deduplicated.values()].sort(compareArtifacts);
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    operationId,
    nonce,
    callbackName,
    createdAtMs: options.nowMs,
    expiresAtMs: options.nowMs + options.ttlMs,
    target: { ...options.target },
    artifacts,
  };
}

export function targetIdentitiesEqual(
  left: TargetIdentity,
  right: TargetIdentity,
): boolean {
  return left.role === right.role &&
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.executablePath === right.executablePath &&
    left.appVersion === right.appVersion &&
    left.appBuild === right.appBuild &&
    left.port === right.port &&
    left.browserIdentity === right.browserIdentity &&
    left.targetId === right.targetId &&
    left.targetType === right.targetType &&
    left.targetUrl === right.targetUrl &&
    left.executionContextId === right.executionContextId &&
    left.executionContextUniqueId === right.executionContextUniqueId &&
    left.frameId === right.frameId;
}

function parseSelection(value: unknown): ReviewSelection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "nonce", "selected"]) ||
    value.schemaVersion !== REVIEW_SCHEMA_VERSION ||
    !isNonEmptyString(value.nonce) ||
    !Array.isArray(value.selected)
  ) {
    return null;
  }
  const selected: ReviewSelectionTuple[] = [];
  for (const candidate of value.selected) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ["id", "version", "payloadSha256"]) ||
      !isNonEmptyString(candidate.id) ||
      !isNonEmptyString(candidate.version) ||
      !isNonEmptyString(candidate.payloadSha256)
    ) {
      return null;
    }
    selected.push({
      id: candidate.id,
      version: candidate.version,
      payloadSha256: candidate.payloadSha256,
    });
  }
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    nonce: value.nonce,
    selected,
  };
}

export function createReviewSelectionAcceptor(
  context: ReviewProtocolContext,
): {
  accept(
    payload: unknown,
    observation: { nowMs: number; target: TargetIdentity },
  ): ReviewSelectionResult;
} {
  let consumed = false;
  const reviewed = new Set(context.artifacts.map(tupleKey));
  return {
    accept(payload, observation) {
      if (consumed) {
        return {
          ok: false,
          code: "plugin.review.replayed",
          message: "The review callback has already been consumed.",
        };
      }
      consumed = true;
      if (!targetIdentitiesEqual(context.target, observation.target)) {
        return {
          ok: false,
          code: "plugin.review.context-mismatch",
          message:
            "The review response did not come from the exact selected target and execution context.",
        };
      }
      if (
        !Number.isFinite(observation.nowMs) ||
        observation.nowMs >= context.expiresAtMs
      ) {
        return {
          ok: false,
          code: "plugin.review.expired",
          message: "The review response arrived after its expiration.",
        };
      }
      const parsed = parseSelection(payload);
      if (parsed === null) {
        return {
          ok: false,
          code: "plugin.review.invalid-response",
          message: "The review response did not match schema version 1.",
        };
      }
      if (parsed.nonce !== context.nonce) {
        return {
          ok: false,
          code: "plugin.review.nonce-mismatch",
          message: "The review response nonce did not match this operation.",
        };
      }
      const selectedKeys = new Set<string>();
      const selectedIds = new Set<string>();
      for (const tuple of parsed.selected) {
        const key = tupleKey(tuple);
        if (selectedKeys.has(key)) {
          return {
            ok: false,
            code: "plugin.review.duplicate-selection",
            message: "The review response repeated one exact identity.",
          };
        }
        selectedKeys.add(key);
        if (selectedIds.has(tuple.id)) {
          return {
            ok: false,
            code: "plugin.review.multiple-identities",
            message: "The review response selected more than one identity for one plugin ID.",
          };
        }
        selectedIds.add(tuple.id);
        if (!reviewed.has(key)) {
          return {
            ok: false,
            code: "plugin.review.unreviewed-selection",
            message: "The review response included an identity not presented by this operation.",
          };
        }
      }
      return {
        ok: true,
        selected: parsed.selected.map((tuple) => ({ ...tuple })),
      };
    },
  };
}

export function selectPendingReviewArtifacts(options: {
  pending: readonly ReviewArtifact[];
  request: {
    id?: string;
    version?: string;
    payloadSha256?: string;
  };
}): ReviewArtifactSelection {
  const pending = [...new Map(
    options.pending.map((artifact) => {
      const copied = copyArtifact(artifact);
      return [tupleKey(copied), copied] as const;
    }),
  ).values()].sort(compareArtifacts);
  const request = options.request;
  if (request.id === undefined) {
    if (request.version !== undefined || request.payloadSha256 !== undefined) {
      return {
        ok: false,
        code: "plugin.review.id-required",
        message: "Artifact identity options require an exact plugin ID.",
      };
    }
    return { ok: true, artifacts: pending };
  }
  const byId = pending.filter((artifact) => artifact.id === request.id);
  if (request.version === undefined && request.payloadSha256 === undefined) {
    if (byId.length > 1) {
      return {
        ok: false,
        code: "plugin.review.exact-selection-required",
        message:
          "Multiple pending identities exist for this plugin ID; specify artifact version and payload SHA-256.",
      };
    }
    if (byId.length === 0) {
      return {
        ok: false,
        code: "plugin.review.identity-not-pending",
        message: "No pending identity matches this plugin ID.",
      };
    }
    return { ok: true, artifacts: byId };
  }
  if (request.version === undefined || request.payloadSha256 === undefined) {
    return {
      ok: false,
      code: "plugin.review.incomplete-identity",
      message:
        "Artifact version and payload SHA-256 must be supplied together.",
    };
  }
  const exact = byId.filter((artifact) =>
    artifact.version === request.version &&
    artifact.payloadSha256 === request.payloadSha256
  );
  if (exact.length !== 1) {
    return {
      ok: false,
      code: "plugin.review.identity-not-pending",
      message: "The exact plugin identity is not pending review.",
    };
  }
  return { ok: true, artifacts: exact };
}

export function buildMetadataReviewExpression(options: {
  sdkRuntimeSource: string;
  context: ReviewProtocolContext;
  activationCommitment: string;
  applicationTtlMs: number;
}): string {
  const request = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    operationId: options.context.operationId,
    nonce: options.context.nonce,
    callbackName: options.context.callbackName,
    expiresAtMs: options.context.expiresAtMs,
    activationCommitment: options.activationCommitment,
    applicationTtlMs: options.applicationTtlMs,
    warning:
      "Enabled plugins are trusted unsandboxed renderer code that can read or modify UI and authenticated renderer state. Confirmation and checksums do not provide sandboxing or publisher authentication.",
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
  if (!runtime || !runtime.review || typeof runtime.review.open !== "function") {
    throw new Error("Explodex runtime review surface is unavailable");
  }
  return await runtime.review.open(${JSON.stringify(request)});
}
)()`;
}
