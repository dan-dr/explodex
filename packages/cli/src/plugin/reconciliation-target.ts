import { randomUUID } from "node:crypto";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import { createDefaultHostAdapters } from "../host/adapters.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { gateCompatibilityDependentOperation } from "../host/compatibility-gate.ts";
import { inspectHost } from "../host/identity.ts";
import { createDefaultHostStatusAdapters } from "../host/process-adapters.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import {
  roleEndpoint,
  type HostRole,
} from "../host/status.ts";
import { createDefaultRuntimeAdapters } from "../runtime/adapters.ts";
import {
  runEnabledPluginApplicationOperation,
  type RuntimeApplicationResult,
} from "./application-operation.ts";
import {
  revalidateEnabledPluginArtifacts,
  type EnabledPluginRevalidationResult,
  type PluginMutationResult,
} from "./reconciliation.ts";
import { loadPluginsState } from "./install-state.ts";
import {
  attemptAutomaticDevelopmentReproof,
  preparePluginApplicationTarget,
  readVerifiedSdkRuntimeSource,
} from "./review-target.ts";

export type DeclaredTargetReconciliationResult =
  | {
      ok: true;
      operationId: string;
      stateCommitted: false;
      sourceDelivered: boolean;
      results: PluginMutationResult[];
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
      stateCommitted: false;
      sourceDelivered: boolean;
      results: PluginMutationResult[];
      residualInventory?: {
        callbacks: number;
        sessions: number;
        hasResidentControlPlane: boolean;
      };
    };

function mapBlocked(
  result: PluginMutationResult,
  code: string,
  message: string,
): PluginMutationResult {
  if (result.application.status !== "apply-pending") return result;
  return {
    ...result,
    application: {
      ...result.application,
      status: "blocked",
      message,
      error: {
        code,
        message,
        stage: "evaluation",
        possiblePartialEffects: false,
      },
    },
  };
}

function appliedIntent(
  result: RuntimeApplicationResult,
): { version: string; payloadSha256: string } | null {
  return result.appliedIdentity === null
    ? null
    : {
        version: result.appliedIdentity.version,
        payloadSha256: result.appliedIdentity.payloadSha256,
      };
}

function mergeApplication(
  prepared: PluginMutationResult[],
  applications: RuntimeApplicationResult[],
  target: import("../cdp/types.ts").TargetIdentity | null,
): PluginMutationResult[] {
  const byId = new Map(applications.map((result) => [result.id, result]));
  return prepared.map((result) => {
    if (result.application.status !== "apply-pending") return result;
    const runtime = byId.get(result.id);
    if (runtime === undefined) {
      return mapBlocked(
        result,
        "plugin.reconciliation.application-missing",
        "Renderer did not return an application result for enabled intent.",
      );
    }
    const status = runtime.status === "applied" || runtime.status === "unchanged"
      ? "applied"
      : runtime.status;
    return {
      ...result,
      application: {
        status,
        lifecycle: result.application.lifecycle,
        target,
        boundary: runtime.boundary,
        appliedIdentity: appliedIntent(runtime),
        ...(runtime.status === "unchanged"
          ? { message: "The exact enabled identity was already applied." }
          : runtime.error === undefined
            ? {}
            : {
                message: runtime.error.message,
                error: {
                  code: runtime.error.code,
                  message: runtime.error.message,
                  stage:
                    runtime.stage === "setup" ||
                      runtime.stage === "cleanup" ||
                      runtime.stage === "evaluation"
                      ? runtime.stage
                      : "evaluation",
                  possiblePartialEffects: runtime.possiblePartialEffects,
                },
              }),
      },
    };
  });
}

function revalidationFailure(
  result: Extract<EnabledPluginRevalidationResult, { ok: false }>,
): DeclaredTargetReconciliationResult {
  return {
    ok: false,
    operationId: result.operationId,
    code: result.code,
    message: result.message,
    details: result.details,
    stateCommitted: false,
    sourceDelivered: false,
    results: result.results,
  };
}

export async function runReconciliationOnDeclaredTarget(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<DeclaredTargetReconciliationResult> {
  const operationId =
    `plugin-reconciliation-${options.role}-${randomUUID()}`;
  const revalidated = await revalidateEnabledPluginArtifacts({
    explodexHome: options.explodexHome,
    operationId,
    signal: options.signal,
  });
  if (!revalidated.ok) return revalidationFailure(revalidated);
  if (revalidated.results.length === 0) {
    return {
      ok: true,
      operationId,
      stateCommitted: false,
      sourceDelivered: false,
      results: [],
      residualInventory: {
        callbacks: 0,
        sessions: 0,
        hasResidentControlPlane: false,
      },
    };
  }
  if (options.role === "main") {
    const code = "plugin.main-authorization-required";
    const message =
      "Protected authoring-main reconciliation requires the later explicit main authorization surface.";
    return {
      ok: false,
      operationId,
      code,
      message,
      stateCommitted: false,
      sourceDelivered: false,
      results: revalidated.results.map((result) =>
        mapBlocked(result, code, message)
      ),
    };
  }
  const hostAdapters = await createDefaultHostAdapters();
  const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
  const inspection = await inspectHost({ adapters: hostAdapters });
  if (!inspection.ok || inspection.host === null) {
    const message = inspection.error.message;
    return {
      ok: false,
      operationId,
      code: "host.invalid",
      message,
      stateCommitted: false,
      sourceDelivered: false,
      results: revalidated.results.map((result) =>
        mapBlocked(result, "host.invalid", message)
      ),
    };
  }
  let persisted = await loadCompatibilityRecord({
    adapters: hostAdapters,
    explodexHome: options.explodexHome,
  });
  let compatibility = evaluateCompatibility({
    host: inspection.host,
    sdkRuntime: {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    },
    persisted,
    runningProcess: null,
  });
  let gate = gateCompatibilityDependentOperation({
    operation: "refresh",
    compatibility,
  });
  if (!gate.allowed && gate.error.code === "compatibility_stale") {
    const reproved = await attemptAutomaticDevelopmentReproof({
      explodexHome: options.explodexHome,
      devRoot: options.devRoot,
      env: options.env,
      host: inspection.host,
      hostAdapters,
      sdkRuntime,
      signal: options.signal,
    });
    if (reproved.ok) {
      persisted = await loadCompatibilityRecord({
        adapters: hostAdapters,
        explodexHome: options.explodexHome,
      });
      compatibility = evaluateCompatibility({
        host: inspection.host,
        sdkRuntime: {
          version: sdkRuntime.version,
          sha256: sdkRuntime.sha256,
        },
        persisted,
      });
      gate = gateCompatibilityDependentOperation({
        operation: "refresh",
        compatibility,
      });
    }
  }
  if (!gate.allowed) {
    const code = gate.error.code === "compatibility_stale"
      ? "compatibility.drifted"
      : "compatibility.unproven";
    return {
      ok: false,
      operationId,
      code,
      message: gate.error.message,
      details: { nextAction: gate.error.nextAction },
      stateCommitted: false,
      sourceDelivered: false,
      results: revalidated.results.map((result) =>
        mapBlocked(result, code, gate.error.message)
      ),
    };
  }
  const prepared = await preparePluginApplicationTarget({
    role: options.role,
    explodexHome: options.explodexHome,
    devRoot: options.devRoot,
    env: options.env,
    host: inspection.host,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      operationId,
      code: prepared.code,
      message: prepared.message,
      details: prepared.details,
      stateCommitted: false,
      sourceDelivered: false,
      results: revalidated.results.map((result) =>
        mapBlocked(result, prepared.code, prepared.message)
      ),
    };
  }

  let sdkRuntimeSource: string;
  try {
    sdkRuntimeSource = await readVerifiedSdkRuntimeSource(sdkRuntime);
  } catch {
    const message =
      "The exact generated SDK runtime bytes are unavailable for reconciliation.";
    return {
      ok: false,
      operationId,
      code: "compatibility.unproven",
      message,
      stateCommitted: false,
      sourceDelivered: false,
      results: revalidated.results.map((result) =>
        mapBlocked(result, "compatibility.unproven", message)
      ),
    };
  }

  const runtime = await createDefaultRuntimeAdapters();
  const cdp = createNodeCdpAdapter();
  const statusAdapters = await createDefaultHostStatusAdapters();
  const expectedHost = inspection.host;
  const expected = prepared.target;
  const revalidate = async () => {
    const currentInspection = await inspectHost({ adapters: hostAdapters });
    if (!currentInspection.ok || currentInspection.host === null) {
      throw Object.assign(new Error("Canonical host identity became invalid."), {
        code: "host_identity_drift" as const,
      });
    }
    const currentPersisted = await loadCompatibilityRecord({
      adapters: hostAdapters,
      explodexHome: options.explodexHome,
    });
    const currentSdkRuntime = await resolveSdkRuntimeIdentityForCli();
    if (
      currentSdkRuntime.version !== sdkRuntime.version ||
      currentSdkRuntime.sha256 !== sdkRuntime.sha256 ||
      currentSdkRuntime.sourcePath !== sdkRuntime.sourcePath
    ) {
      throw Object.assign(
        new Error(
          "Generated SDK runtime identity changed during reconciliation.",
        ),
        { code: "host_identity_drift" as const },
      );
    }
    const currentCompatibility = evaluateCompatibility({
      host: currentInspection.host,
      sdkRuntime: {
        version: currentSdkRuntime.version,
        sha256: currentSdkRuntime.sha256,
      },
      persisted: currentPersisted,
      runningProcess: null,
    });
    if (
      !currentCompatibility.matched ||
      !currentCompatibility.allowsCompatibilityDependentWork
    ) {
      throw Object.assign(
        new Error("Compatibility authority changed during reconciliation."),
        { code: "host_identity_drift" as const },
      );
    }
    const currentState = await loadPluginsState({
      explodexHome: options.explodexHome,
    });
    const expectedEnabled = new Map(
      revalidated.results.flatMap((result) =>
        result.currentIntent === null
          ? []
          : [[result.id, result.currentIntent] as const]
      ),
    );
    const currentEnabled = Object.entries(
      currentState.status === "valid" ? currentState.state.plugins : {},
    ).flatMap(([id, entry]) =>
      entry.enabled === null ? [] : [[id, entry.enabled] as const]
    );
    if (
      currentState.status !== "valid" ||
      currentEnabled.length !== expectedEnabled.size ||
      currentEnabled.some(([id, enabled]) => {
        const expectedIntent = expectedEnabled.get(id);
        return expectedIntent === undefined ||
          expectedIntent.version !== enabled.version ||
          expectedIntent.payloadSha256 !== enabled.payloadSha256;
      })
    ) {
      throw Object.assign(
        new Error(
          "Authoritative enabled plugin intent changed during reconciliation.",
        ),
        { code: "plugin_intent_drift" as const },
      );
    }
    const identity = await statusAdapters.process.identify(expected.process.pid);
    const listeners = await statusAdapters.port.listenersFor(
      roleEndpoint(options.role).port,
    );
    const listener = listeners.find((candidate) =>
      candidate.pid === expected.process.pid
    );
    const rawProcesses = await statusAdapters.process.list();
    const rawProcess = rawProcesses.find((candidate) =>
      candidate.pid === expected.process.pid
    );
    if (
      identity === null ||
      identity.processStartedAt !== expected.process.processStartedAt ||
      listener === undefined ||
      rawProcess === undefined ||
      rawProcess.executablePath !== expected.process.executablePath ||
      (expected.expectedLaunchMarker !== undefined &&
        !rawProcess.arguments.includes(expected.expectedLaunchMarker))
    ) {
      throw Object.assign(
        new Error("Reconciliation process or endpoint identity changed."),
        { code: "process_identity_drift" as const },
      );
    }
    return {
      host: currentInspection.host,
      process: {
        ...rawProcess,
        processStartedAt: identity.processStartedAt,
      },
      listener: {
        ...listener,
        processStartedAt: identity.processStartedAt,
      },
    };
  };

  const application = await runEnabledPluginApplicationOperation({
    runtime,
    operationId,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: expectedHost,
    process: expected.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    expectedTargetId: expected.expectedTargetId,
    revalidate,
    sdkRuntimeSource,
    snapshots: revalidated.snapshots,
    observedBoundaries: revalidated.results.flatMap((result) =>
      result.application.status === "boundary-required" &&
        (result.application.lifecycle === "renderer-start" ||
          result.application.lifecycle === "app-start") &&
        result.currentIntent !== null
        ? [{
            identity: {
              id: result.id,
              ...result.currentIntent,
            },
            lifecycle: result.application.lifecycle,
          }]
        : []
    ),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!application.ok) {
    return {
      ok: false,
      operationId,
      code: application.code,
      message: application.message,
      details: application.details,
      stateCommitted: false,
      sourceDelivered: application.sourceDelivered,
      results: application.applications.length === 0
        ? revalidated.results.map((result) =>
            mapBlocked(result, application.code, application.message)
          )
        : mergeApplication(
            revalidated.results,
            application.applications,
            null,
          ),
      residualInventory: application.residualInventory,
    };
  }
  return {
    ok: true,
    operationId,
    stateCommitted: false,
    sourceDelivered: application.sourceDelivered,
    results: mergeApplication(
      revalidated.results,
      application.applications,
      application.target,
    ),
    residualInventory: application.residualInventory,
  };
}
