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
  status: "applied" | "boundary-required" | "failed";
  boundary: "none" | "renderer" | "app";
  setupCount: number;
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
      (candidate.status !== "applied" &&
        candidate.status !== "boundary-required" &&
        candidate.status !== "failed") ||
      (candidate.boundary !== "none" &&
        candidate.boundary !== "renderer" &&
        candidate.boundary !== "app") ||
      !Number.isInteger(candidate.setupCount) ||
      Number(candidate.setupCount) < 0
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
    const parsed: RuntimeApplicationResult = {
      schemaVersion: 1,
      id: candidate.id,
      version: candidate.version,
      payloadSha256: candidate.payloadSha256,
      status: candidate.status,
      boundary: candidate.boundary,
      setupCount: Number(candidate.setupCount),
      ...(error === undefined ? {} : { error }),
    };
    if (!identityEquals(parsed, identity)) return null;
    applications.push(parsed);
  }
  return applications;
}

export function buildApprovedApplicationExpression(options: {
  sdkRuntimeSource: string;
  operationId: string;
  nonce: string;
  activationSecret: string;
  snapshots: readonly PluginPayloadSnapshot[];
}): string {
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
    applications.push(await apply(
      ${JSON.stringify(operation.input)},
      () => {
${operation.source}
      },
      ${JSON.stringify(options.activationSecret)},
    ));`).join("\n");
  return `(
async () => {
${options.sdkRuntimeSource}
  const runtime = globalThis.Explodex;
  const apply = runtime && runtime["__explodexApplyApprovedPayload"];
  const finalize = runtime && runtime["__explodexFinalizeApprovedOperation"];
  if (typeof apply !== "function" || typeof finalize !== "function") {
    throw new Error("Explodex approved-payload application surface is unavailable");
  }
  const applications = [];
  try {
${operationSource}
    return { schemaVersion: 1, applications };
  } finally {
    finalize(${JSON.stringify(options.operationId)}, ${JSON.stringify(options.nonce)});
  }
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
  expectedTarget: TargetIdentity;
  revalidate(): Promise<PointOfUseIdentity>;
  sdkRuntimeSource: string;
  snapshots: readonly PluginPayloadSnapshot[];
  timeoutMs: number;
  signal?: AbortSignal;
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
  const boundaryApplications = options.snapshots.flatMap((snapshot) =>
    snapshot.manifest.lifecycle === "dynamic"
      ? []
      : [{
          schemaVersion: 1 as const,
          ...snapshot.identity,
          status: "boundary-required" as const,
          boundary: snapshot.manifest.lifecycle === "renderer-start"
            ? "renderer" as const
            : "app" as const,
          setupCount: 0,
        }]
  );
  const expectedIdentities = dynamicSnapshots.map((snapshot) => ({
    ...snapshot.identity,
  }));
  let deliveryStarted = false;
  const operation = await runExactTargetOperation({
    runtime: options.runtime,
    operationId: options.operationId,
    operation: "plugin.approval.apply",
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
        if (!targetIdentitiesEqual(input.target, options.expectedTarget)) {
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
          });
        }
        return `(async () => {
  const runtime = globalThis.Explodex;
  const finalize = runtime && runtime["__explodexFinalizeApprovedOperation"];
  if (typeof finalize !== "function") {
    throw new Error("Explodex approval capability finalizer is unavailable");
  }
  finalize(${JSON.stringify(options.operationId)}, ${JSON.stringify(options.nonce)});
  return { schemaVersion: 1, applications: [] };
})()`;
      },
      onBeforeEvaluation() {
        if (dynamicSnapshots.length > 0) deliveryStarted = true;
      },
      terminalCleanupExpression: `(() => {
  const runtime = globalThis.Explodex;
  const finalize = runtime && runtime["__explodexFinalizeApprovedOperation"];
  if (typeof finalize === "function") {
    finalize(${JSON.stringify(options.operationId)}, ${JSON.stringify(options.nonce)});
  }
  return true;
})()`,
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
      applications: [],
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
      applications: [],
      sourceDelivered: deliveryStarted,
      residualInventory: operation.residualInventory,
    };
  }
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
