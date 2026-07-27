import type { HostIdentity } from "../host/types.ts";
import { createHash } from "node:crypto";
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
import type { TargetIdentity } from "../cdp/types.ts";
import type {
  PluginPayloadIdentity,
  PluginPayloadSnapshot,
} from "./approval-transaction.ts";
import { targetIdentitiesEqual } from "./review-protocol.ts";

export type RuntimeApplicationResult = {
  schemaVersion: 1;
  id: string;
  version: string;
  payloadSha256: string;
  status:
    | "unchanged"
    | "applied"
    | "boundary-required"
    | "failed"
    | "not-attempted";
  boundary: "none" | "renderer" | "app";
  setupCount: number;
  previousAppliedIdentity: PluginPayloadIdentity | null;
  appliedIdentity: PluginPayloadIdentity | null;
  stage: "authorization" | "evaluation" | "setup" | "cleanup" | "none";
  possiblePartialEffects: boolean;
  error?: { code: string; message: string };
};

export type PluginApplicationOperationResult =
  | {
      ok: true;
      operationId: string;
      target: TargetIdentity;
      applications: RuntimeApplicationResult[];
      sourceDelivered: boolean;
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
      applications: RuntimeApplicationResult[];
      sourceDelivered: boolean;
      residualInventory?: {
        callbacks: number;
        sessions: number;
        hasResidentControlPlane: boolean;
      };
    };

export type PluginTeardownOperationResult =
  | {
      ok: true;
      operationId: string;
      target: TargetIdentity;
      result: {
        status: "applied" | "failed";
        target: TargetIdentity;
        appliedIdentity: PluginPayloadIdentity | null;
        message: string;
        error?: {
          code: string;
          message: string;
          stage: "cleanup";
          possiblePartialEffects: boolean;
        };
      };
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
      residualInventory?: {
        callbacks: number;
        sessions: number;
        hasResidentControlPlane: boolean;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityEquals(
  result: RuntimeApplicationResult,
  expected: PluginPayloadIdentity,
): boolean {
  return result.id === expected.id &&
    result.version === expected.version &&
    result.payloadSha256 === expected.payloadSha256;
}

function parseIdentity(value: unknown): PluginPayloadIdentity | null | false {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.payloadSha256 !== "string"
  ) {
    return false;
  }
  return {
    id: value.id,
    version: value.version,
    payloadSha256: value.payloadSha256,
  };
}

function parseRuntimeResult(
  value: unknown,
  expected: readonly PluginPayloadIdentity[],
): RuntimeApplicationResult[] | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.applications) ||
    value.applications.length !== expected.length
  ) {
    return null;
  }
  const applications: RuntimeApplicationResult[] = [];
  for (let index = 0; index < value.applications.length; index += 1) {
    const candidate = value.applications[index];
    const identity = expected[index];
    if (
      identity === undefined ||
      !isRecord(candidate) ||
      candidate.schemaVersion !== 1 ||
      typeof candidate.id !== "string" ||
      typeof candidate.version !== "string" ||
      typeof candidate.payloadSha256 !== "string" ||
      (candidate.status !== "unchanged" &&
        candidate.status !== "applied" &&
        candidate.status !== "boundary-required" &&
        candidate.status !== "not-attempted" &&
        candidate.status !== "failed") ||
      (candidate.boundary !== "none" &&
        candidate.boundary !== "renderer" &&
        candidate.boundary !== "app") ||
      !Number.isInteger(candidate.setupCount) ||
      Number(candidate.setupCount) < 0
    ) {
      return null;
    }
    const previousAppliedIdentity = parseIdentity(
      candidate.previousAppliedIdentity,
    );
    const appliedIdentity = parseIdentity(candidate.appliedIdentity);
    if (
      previousAppliedIdentity === false ||
      appliedIdentity === false ||
      (candidate.stage !== undefined &&
        candidate.stage !== "authorization" &&
        candidate.stage !== "evaluation" &&
        candidate.stage !== "setup" &&
        candidate.stage !== "cleanup" &&
        candidate.stage !== "none") ||
      (candidate.possiblePartialEffects !== undefined &&
        typeof candidate.possiblePartialEffects !== "boolean")
    ) {
      return null;
    }
    let error: RuntimeApplicationResult["error"];
    if (candidate.error !== undefined) {
      if (
        !isRecord(candidate.error) ||
        typeof candidate.error.code !== "string" ||
        typeof candidate.error.message !== "string"
      ) {
        return null;
      }
      error = {
        code: candidate.error.code,
        message: candidate.error.message,
      };
    }
    const status = candidate.status;
    const boundary = candidate.boundary;
    const setupCount = Number(candidate.setupCount);
    const normalizedAppliedIdentity = candidate.appliedIdentity === undefined
      ? status === "applied" || status === "unchanged"
        ? {
            id: candidate.id,
            version: candidate.version,
            payloadSha256: candidate.payloadSha256,
          }
        : null
      : appliedIdentity;
    const normalizedStage =
      candidate.stage as RuntimeApplicationResult["stage"] | undefined ??
        (status === "failed" ? "setup" : status === "applied" ? "setup" : "none");
    const normalizedPartial = candidate.possiblePartialEffects === true;
    if (
      ((status === "applied" || status === "unchanged") &&
        boundary !== "none") ||
      (status === "unchanged" &&
        (setupCount !== 0 || error !== undefined ||
          normalizedAppliedIdentity === null)) ||
      (status === "boundary-required" &&
        (boundary === "none" || setupCount !== 0 || error !== undefined ||
          normalizedPartial)) ||
      (status === "not-attempted" &&
        (boundary !== "none" || setupCount !== 0 || error === undefined ||
          normalizedPartial)) ||
      (status === "failed" &&
        (boundary !== "none" || error === undefined)) ||
      (status === "applied" &&
        error !== undefined &&
        normalizedStage !== "cleanup")
    ) {
      return null;
    }
    const parsed: RuntimeApplicationResult = {
      schemaVersion: 1,
      id: candidate.id,
      version: candidate.version,
      payloadSha256: candidate.payloadSha256,
      status,
      boundary,
      setupCount,
      previousAppliedIdentity,
      appliedIdentity: normalizedAppliedIdentity,
      stage: normalizedStage,
      possiblePartialEffects: normalizedPartial,
      ...(error === undefined ? {} : { error }),
    };
    if (!identityEquals(parsed, identity)) return null;
    applications.push(parsed);
  }
  return applications;
}

function parseObservedApplications(
  value: unknown,
  expectedIds: readonly string[],
): Map<string, PluginPayloadIdentity | null> | null {
  if (expectedIds.length === 0 && isRecord(value) && value.observed === undefined) {
    return new Map();
  }
  if (!isRecord(value) || !Array.isArray(value.observed)) return null;
  if (value.observed.length !== expectedIds.length) return null;
  const observed = new Map<string, PluginPayloadIdentity | null>();
  for (let index = 0; index < value.observed.length; index += 1) {
    const candidate = value.observed[index];
    const expectedId = expectedIds[index];
    if (
      expectedId === undefined ||
      !isRecord(candidate) ||
      candidate.id !== expectedId ||
      observed.has(expectedId)
    ) {
      return null;
    }
    if (candidate.status === null) {
      observed.set(expectedId, null);
      continue;
    }
    if (!isRecord(candidate.status)) return null;
    const identity = parseIdentity(candidate.status.identity);
    if (identity === false || identity === null || identity.id !== expectedId) {
      return null;
    }
    observed.set(expectedId, identity);
  }
  return observed;
}

export function buildApprovedApplicationExpression(options: {
  sdkRuntimeSource: string;
  operationId: string;
  nonce: string;
  activationSecret: string;
  snapshots: readonly PluginPayloadSnapshot[];
  mode?: "approved" | "enabled";
  observedPluginIds?: readonly string[];
}): string {
  const mode = options.mode ?? "approved";
  const operations = options.snapshots.map((snapshot) => ({
    input: {
      schemaVersion: 1,
      operationId: options.operationId,
      nonce: options.nonce,
      id: snapshot.identity.id,
      version: snapshot.identity.version,
      payloadSha256: snapshot.identity.payloadSha256,
      lifecycle: snapshot.manifest.lifecycle,
      assets: snapshot.manifest.assets.map((path) => ({
        path,
        bytes: [...snapshot.read(path)],
      })),
    },
    source: new TextDecoder("utf-8", { fatal: true }).decode(
      snapshot.read("index.js"),
    ),
  }));
  const operationSource = operations.map((operation) => `
    if (rendererUnavailable === null) {
      try {
        applications.push(await apply(
          ${JSON.stringify(operation.input)},
          () => {
${operation.source}
          }${mode === "approved"
            ? `,
          ${JSON.stringify(options.activationSecret)}`
            : ""},
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const observed = status(${JSON.stringify(operation.input.id)});
        const observedIdentity = observed && observed.identity
          ? observed.identity
          : null;
        rendererUnavailable = message;
        applications.push({
          schemaVersion: 1,
          id: ${JSON.stringify(operation.input.id)},
          version: ${JSON.stringify(operation.input.version)},
          payloadSha256: ${JSON.stringify(operation.input.payloadSha256)},
          status: "failed",
          boundary: "none",
          setupCount: 0,
          previousAppliedIdentity: observedIdentity,
          appliedIdentity: observedIdentity,
          stage: "evaluation",
          possiblePartialEffects: true,
          error: {
            code: "plugin.application.runtime-unusable",
            message,
          },
        });
      }
    } else {
      const observed = status(${JSON.stringify(operation.input.id)});
      const observedIdentity = observed && observed.identity
        ? observed.identity
        : null;
      applications.push({
        schemaVersion: 1,
        id: ${JSON.stringify(operation.input.id)},
        version: ${JSON.stringify(operation.input.version)},
        payloadSha256: ${JSON.stringify(operation.input.payloadSha256)},
        status: "not-attempted",
        boundary: "none",
        setupCount: 0,
        previousAppliedIdentity: observedIdentity,
        appliedIdentity: observedIdentity,
        stage: "none",
        possiblePartialEffects: false,
        error: {
          code: "plugin.application.runtime-unusable",
          message: rendererUnavailable,
        },
      });
    }`).join("\n");
  const applyName = mode === "approved"
    ? "__explodexApplyApprovedPayload"
    : "__explodexReconcileEnabledPayload";
  const finalizeSource = mode === "approved"
    ? `
  const finalize = runtime && runtime["__explodexFinalizeApprovedOperation"];
  if (typeof apply !== "function" || typeof finalize !== "function") {
    throw new Error("Explodex approved-payload application surface is unavailable");
  }`
    : `
  if (typeof apply !== "function") {
    throw new Error("Explodex enabled-payload reconciliation surface is unavailable");
  }`;
  const finallySource = mode === "approved"
    ? `
  } finally {
    finalize(${JSON.stringify(options.operationId)}, ${JSON.stringify(options.nonce)});
  }`
    : `
  } finally {
    // Enabled reconciliation is one-shot and holds no renderer callback grant.
  }`;
  const observedPluginIds = options.observedPluginIds ?? [];
  const sdkRequestIdentity = `${
    createHash("sha256").update(options.sdkRuntimeSource).digest("hex")
  }:${options.operationId}`;
  return `(
async () => {
const previousRuntime = globalThis.Explodex;
if (
  previousRuntime &&
  previousRuntime["__explodexSdkRuntimeRequestMark"] !== ${
    JSON.stringify(sdkRequestIdentity)
  }
) {
  const destroyAndWait = previousRuntime["__explodexDestroyRuntimeAndWait"];
  if (typeof destroyAndWait !== "function") {
    throw new Error("Previous Explodex runtime cannot be replaced safely");
  }
  await destroyAndWait({ reason: "operation-replacement" });
}
globalThis.__explodexSdkRuntimeRequestIdentity = ${
    JSON.stringify(sdkRequestIdentity)
  };
${options.sdkRuntimeSource}
  const runtime = globalThis.Explodex;
  const apply = runtime && runtime[${JSON.stringify(applyName)}];${finalizeSource}
  const status = runtime && runtime["__explodexPluginApplicationStatus"];
  if (typeof status !== "function") {
    throw new Error("Explodex plugin application status surface is unavailable");
  }
  const applications = [];
  let rendererUnavailable = null;
  try {
${operationSource}
    return {
      schemaVersion: 1,
      applications,
      observed: ${JSON.stringify(observedPluginIds)}.map((id) => ({
        id,
        status: status(id),
      })),
    };
${finallySource}
}
)()`;
}

export async function runApprovedPluginApplicationOperation(options: {
  runtime: RuntimeAdapters;
  operationId: string;
  nonce: string;
  activationSecret: string;
  role: HostRole;
  homeIdentity: string;
  host: HostIdentity;
  process: VerifiedProcess;
  endpoint: DeclaredRoleEndpoint;
  cdp: CdpAdapter;
  expectedTarget?: TargetIdentity;
  expectedTargetId?: string;
  revalidate(): Promise<PointOfUseIdentity>;
  sdkRuntimeSource: string;
  snapshots: readonly PluginPayloadSnapshot[];
  observedBoundaries?: readonly {
    identity: PluginPayloadIdentity;
    lifecycle: "renderer-start" | "app-start";
  }[];
  timeoutMs: number;
  signal?: AbortSignal;
  mode?: "approved" | "enabled";
}): Promise<PluginApplicationOperationResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      operationId: options.operationId,
      code: "operation_interrupted",
      message: "Plugin application was interrupted before source delivery.",
      applications: [],
      sourceDelivered: false,
    };
  }
  const dynamicSnapshots = options.snapshots.filter((snapshot) =>
    snapshot.manifest.lifecycle === "dynamic"
  );
  const boundarySnapshots = [
    ...options.snapshots.flatMap((snapshot) =>
      snapshot.manifest.lifecycle === "dynamic"
        ? []
        : [{
            identity: snapshot.identity,
            lifecycle: snapshot.manifest.lifecycle,
          }]
    ),
    ...(options.observedBoundaries ?? []),
  ];
  const expectedIdentities = dynamicSnapshots.map((snapshot) => ({
    ...snapshot.identity,
  }));
  const notAttempted = (
    code: string,
    message: string,
    possiblePartialEffects: boolean,
  ): RuntimeApplicationResult[] =>
    expectedIdentities.map((identity) => ({
      schemaVersion: 1,
      ...identity,
      status: "not-attempted",
      boundary: "none",
      setupCount: 0,
      previousAppliedIdentity: null,
      appliedIdentity: null,
      stage: "evaluation",
      possiblePartialEffects,
      error: { code, message },
    }));
  let deliveryStarted = false;
  const operation = await runExactTargetOperation({
    runtime: options.runtime,
    operationId: options.operationId,
    operation: options.mode === "enabled"
      ? "plugin.reconcile.apply"
      : "plugin.approval.apply",
    role: options.role,
    homeIdentity: options.homeIdentity,
    host: options.host,
    process: options.process,
    endpoint: options.endpoint,
    cdp: options.cdp,
    signal: options.signal,
    revalidate: options.revalidate,
    evaluate: {
      expression(input) {
        if (
          (options.expectedTarget !== undefined &&
            !targetIdentitiesEqual(input.target, options.expectedTarget)) ||
          (options.expectedTargetId !== undefined &&
            input.target.targetId !== options.expectedTargetId)
        ) {
          throw Object.assign(
            new Error(
              "Approval application target did not match the exact reviewed context.",
            ),
            { code: "context_identity_drift" as const },
          );
        }
        if (dynamicSnapshots.length > 0) {
          return buildApprovedApplicationExpression({
            sdkRuntimeSource: options.sdkRuntimeSource,
            operationId: options.operationId,
            nonce: options.nonce,
            activationSecret: options.activationSecret,
            snapshots: dynamicSnapshots,
            mode: options.mode,
            observedPluginIds: boundarySnapshots.map((boundary) =>
              boundary.identity.id
            ),
          });
        }
        if (options.mode === "enabled") {
          return `(async () => {
  const runtime = globalThis.Explodex;
  const status = runtime && runtime["__explodexPluginApplicationStatus"];
  if (typeof status !== "function") {
    throw new Error("Explodex plugin application status surface is unavailable");
  }
  return {
    schemaVersion: 1,
    applications: [],
    observed: ${JSON.stringify(
      boundarySnapshots.map((boundary) => boundary.identity.id),
    )}.map((id) => ({ id, status: status(id) })),
  };
})()`;
        }
        return `(async () => {
  const runtime = globalThis.Explodex;
  const finalize = runtime && runtime["__explodexFinalizeApprovedOperation"];
  const status = runtime && runtime["__explodexPluginApplicationStatus"];
  if (typeof finalize !== "function" || typeof status !== "function") {
    throw new Error("Explodex approval capability finalizer is unavailable");
  }
  finalize(${JSON.stringify(options.operationId)}, ${JSON.stringify(options.nonce)});
  return {
    schemaVersion: 1,
    applications: [],
    observed: ${JSON.stringify(
      boundarySnapshots.map((boundary) => boundary.identity.id),
    )}.map((id) => ({ id, status: status(id) })),
  };
})()`;
      },
      onBeforeEvaluation() {
        if (dynamicSnapshots.length > 0) deliveryStarted = true;
      },
      ...(options.mode === "enabled"
        ? {}
        : { terminalCleanupExpression: `(() => {
  const runtime = globalThis.Explodex;
  const finalize = runtime && runtime["__explodexFinalizeApprovedOperation"];
  if (typeof finalize === "function") {
    finalize(${JSON.stringify(options.operationId)}, ${JSON.stringify(options.nonce)});
  }
  return true;
})()` }),
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
        residualInventory: operation.residualInventory,
      },
      applications: notAttempted(
        operation.error.code,
        operation.error.message,
        deliveryStarted,
      ),
      sourceDelivered: deliveryStarted,
      residualInventory: operation.residualInventory,
    };
  }
  const applications = parseRuntimeResult(
    operation.result.evaluation.value,
    expectedIdentities,
  );
  if (applications === null) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.approval.invalid-application-response",
      message: "Renderer returned a malformed plugin application result.",
      applications: notAttempted(
        "plugin.approval.invalid-application-response",
        "Renderer returned a malformed plugin application result.",
        deliveryStarted,
      ),
      sourceDelivered: deliveryStarted,
      residualInventory: operation.residualInventory,
    };
  }
  const observed = parseObservedApplications(
    operation.result.evaluation.value,
    boundarySnapshots.map((boundary) => boundary.identity.id),
  );
  if (observed === null) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.approval.invalid-application-response",
      message: "Renderer returned malformed plugin application status.",
      applications: notAttempted(
        "plugin.approval.invalid-application-response",
        "Renderer returned malformed plugin application status.",
        deliveryStarted,
      ),
      sourceDelivered: deliveryStarted,
      residualInventory: operation.residualInventory,
    };
  }
  const boundaryApplications: RuntimeApplicationResult[] =
    boundarySnapshots.map((boundary) => {
      const appliedIdentity = observed.get(boundary.identity.id) ?? null;
      return {
        schemaVersion: 1,
        ...boundary.identity,
        status: "boundary-required",
        boundary: boundary.lifecycle === "renderer-start"
          ? "renderer"
          : "app",
        setupCount: 0,
        previousAppliedIdentity: appliedIdentity,
        appliedIdentity,
        stage: "none",
        possiblePartialEffects: false,
      };
    });
  return {
    ok: true,
    operationId: operation.operationId,
    target: operation.result.target,
    applications: [...applications, ...boundaryApplications].sort(
      (left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    sourceDelivered: deliveryStarted,
    residualInventory: operation.residualInventory,
  };
}

export function runEnabledPluginApplicationOperation(options: {
  runtime: RuntimeAdapters;
  operationId: string;
  role: HostRole;
  homeIdentity: string;
  host: HostIdentity;
  process: VerifiedProcess;
  endpoint: DeclaredRoleEndpoint;
  cdp: CdpAdapter;
  expectedTarget?: TargetIdentity;
  expectedTargetId?: string;
  revalidate(): Promise<PointOfUseIdentity>;
  sdkRuntimeSource: string;
  snapshots: readonly PluginPayloadSnapshot[];
  observedBoundaries?: readonly {
    identity: PluginPayloadIdentity;
    lifecycle: "renderer-start" | "app-start";
  }[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PluginApplicationOperationResult> {
  return runApprovedPluginApplicationOperation({
    ...options,
    nonce: `${options.operationId}-enabled`,
    activationSecret: "",
    mode: "enabled",
  });
}

function buildPluginTeardownExpression(options: {
  identity: PluginPayloadIdentity;
}): string {
  return `(async () => {
  const runtime = globalThis.Explodex;
  const status = runtime && runtime["__explodexPluginApplicationStatus"];
  const unload = runtime && runtime["__explodexUnloadPlugin"];
  if (typeof status !== "function" || typeof unload !== "function") {
    throw new Error("Explodex exact plugin teardown surface is unavailable");
  }
  const before = status(${JSON.stringify(options.identity.id)});
  if (before !== null) {
    const identity = before.identity;
    if (
      !identity ||
      identity.id !== ${JSON.stringify(options.identity.id)} ||
      identity.version !== ${JSON.stringify(options.identity.version)} ||
      identity.payloadSha256 !== ${JSON.stringify(options.identity.payloadSha256)}
    ) {
      throw new Error("The live plugin identity did not match the exact requested teardown identity");
    }
  }
  const unloaded = await unload(${JSON.stringify(options.identity.id)});
  const after = status(${JSON.stringify(options.identity.id)});
  const cleanupFailures = unloaded && unloaded.disposed &&
    Array.isArray(unloaded.disposed.failures)
    ? unloaded.disposed.failures
    : [];
  return {
    schemaVersion: 1,
    id: ${JSON.stringify(options.identity.id)},
    version: ${JSON.stringify(options.identity.version)},
    payloadSha256: ${JSON.stringify(options.identity.payloadSha256)},
    status: cleanupFailures.length === 0 && after === null
      ? "applied"
      : "failed",
    appliedIdentity: after && after.identity ? after.identity : null,
    teardownInvoked: unloaded ? unloaded.teardownInvoked === true : false,
    cleanupFailures: cleanupFailures.map((failure) => ({
      kind: String(failure.kind || "unknown"),
      message: String(failure.message || "Tracked cleanup failed"),
    })),
  };
})()`;
}

function parsePluginTeardownResponse(value: unknown): {
  status: "applied" | "failed";
  appliedIdentity: PluginPayloadIdentity | null;
  teardownInvoked: boolean;
  cleanupFailures: Array<{ kind: string; message: string }>;
} | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.status !== "applied" && value.status !== "failed") ||
    typeof value.teardownInvoked !== "boolean" ||
    !Array.isArray(value.cleanupFailures)
  ) {
    return null;
  }
  const appliedIdentity = parseIdentity(value.appliedIdentity);
  if (appliedIdentity === false) return null;
  const cleanupFailures: Array<{ kind: string; message: string }> = [];
  for (const failure of value.cleanupFailures) {
    if (
      !isRecord(failure) ||
      typeof failure.kind !== "string" ||
      typeof failure.message !== "string"
    ) {
      return null;
    }
    cleanupFailures.push({
      kind: failure.kind,
      message: failure.message,
    });
  }
  if (
    (value.status === "applied" &&
      (appliedIdentity !== null || cleanupFailures.length !== 0)) ||
    (value.status === "failed" && cleanupFailures.length === 0)
  ) {
    return null;
  }
  return {
    status: value.status,
    appliedIdentity,
    teardownInvoked: value.teardownInvoked,
    cleanupFailures,
  };
}

export async function runPluginTeardownOperation(options: {
  runtime: RuntimeAdapters;
  operationId: string;
  role: HostRole;
  homeIdentity: string;
  host: HostIdentity;
  process: VerifiedProcess;
  endpoint: DeclaredRoleEndpoint;
  cdp: CdpAdapter;
  expectedTarget?: TargetIdentity;
  expectedTargetId?: string;
  revalidate(): Promise<PointOfUseIdentity>;
  identity: PluginPayloadIdentity;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PluginTeardownOperationResult> {
  const operation = await runExactTargetOperation({
    runtime: options.runtime,
    operationId: options.operationId,
    operation: "plugin.mutation.teardown",
    role: options.role,
    homeIdentity: options.homeIdentity,
    host: options.host,
    process: options.process,
    endpoint: options.endpoint,
    cdp: options.cdp,
    signal: options.signal,
    revalidate: options.revalidate,
    evaluate: {
      expression(input) {
        if (
          (options.expectedTarget !== undefined &&
            !targetIdentitiesEqual(input.target, options.expectedTarget)) ||
          (options.expectedTargetId !== undefined &&
            input.target.targetId !== options.expectedTargetId)
        ) {
          throw Object.assign(
            new Error(
              "Plugin teardown target did not match the exact requested context.",
            ),
            { code: "context_identity_drift" as const },
          );
        }
        return buildPluginTeardownExpression({
          identity: options.identity,
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
        residualInventory: operation.residualInventory,
      },
      residualInventory: operation.residualInventory,
    };
  }
  const result = parsePluginTeardownResponse(
    operation.result.evaluation.value,
  );
  const raw = operation.result.evaluation.value;
  if (
    result === null ||
    !isRecord(raw) ||
    raw.id !== options.identity.id ||
    raw.version !== options.identity.version ||
    raw.payloadSha256 !== options.identity.payloadSha256
  ) {
    return {
      ok: false,
      operationId: operation.operationId,
      code: "plugin.mutation.invalid-teardown-response",
      message: "Renderer returned a malformed exact plugin teardown result.",
      residualInventory: operation.residualInventory,
    };
  }
  const message = result.status === "applied"
    ? result.teardownInvoked
      ? "Exact dynamic teardown completed."
      : "The exact plugin identity was not live in the inspected renderer."
    : result.cleanupFailures.map((failure) =>
        `${failure.kind}: ${failure.message}`
      ).join("; ");
  return {
    ok: true,
    operationId: operation.operationId,
    target: operation.result.target,
    result: {
      status: result.status,
      target: operation.result.target,
      appliedIdentity: result.appliedIdentity,
      message,
      ...(result.status === "applied"
        ? {}
        : {
            error: {
              code: "plugin.mutation.teardown-cleanup-failed",
              message,
              stage: "cleanup" as const,
              possiblePartialEffects: true,
            },
          }),
    },
    residualInventory: operation.residualInventory,
  };
}
