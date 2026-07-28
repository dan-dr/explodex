import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createNodeCdpAdapter, type CdpAdapter } from "../cdp/adapters.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import {
  createDefaultHostAdapters,
  type HostAdapters,
} from "../host/adapters.ts";
import { inspectHost } from "../host/identity.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import type {
  HostStatusAdapters,
  ListenerObservation,
  VerifiedProcess,
} from "../host/status.ts";
import type { HostIdentity } from "../host/types.ts";
import type { SdkRuntimeIdentity } from "../host/types.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  runEnabledPluginApplicationOperation,
  type RuntimeApplicationResult,
} from "../plugin/application-operation.ts";
import { readVerifiedSdkRuntimeSource } from "../plugin/review-target.ts";
import {
  pluginAuthorityFingerprint,
  revalidateEnabledPluginArtifacts,
} from "../plugin/reconciliation.ts";
import { loadPluginsState } from "../plugin/install-state.ts";
import { withPluginStateLock } from "../plugin/state-lock.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { compatibilityKeyHash } from "../host/compatibility-key.ts";
import {
  createDefaultRuntimeAdapters,
  type RuntimeAdapters,
} from "../runtime/adapters.ts";
import { captureEphemeralPluginArtifact } from "./ephemeral-artifact.ts";
import {
  executeDevArtifactRoute,
  type DevArtifactRouteAction,
} from "./injection-routing.ts";
import {
  runDevLifecycleOperation,
} from "./lifecycle-operation.ts";
import {
  inspectDevInstanceStatus,
} from "./status-operation.ts";
import { classifyOwnedListenerAuthority } from "./listener-authority.ts";
import type { DevOwnershipOperation, DevStatusSnapshot } from "./workflow.ts";
import { withDevInstanceLock } from "./workflow.ts";
import {
  loadDevInstanceStateResult,
  saveDevInstanceState,
} from "./state.ts";
import { readVerifiedGenerationOutput } from "../plugin/generation.ts";
import {
  createStagedMainArtifactReceipt,
  saveStagedMainArtifactReceipt,
  type StagedMainArtifactReceipt,
} from "./main-staging.ts";

export type DevInjectSuccess = {
  ok: true;
  operationId: string;
  route: DevArtifactRouteAction;
  rootPath: string;
  identity: {
    id: string;
    version: string;
    payloadSha256: string;
    lifecycle: "dynamic" | "renderer-start" | "app-start";
  };
  ownership: {
    proven: true;
    pid: number;
    processStartedAt: string;
    port: 9444;
    targetId: string;
    executionContextId: number;
  };
  compatibility: {
    proven: true;
  };
  sdkRuntimeIdentity: {
    version: string;
    sha256: string;
  };
  target: TargetIdentity;
  applications: RuntimeApplicationResult[];
  sourceDelivered: boolean;
  authority: {
    installed: false;
    enabled: false;
    pendingReview: false;
  };
  devSurvived: true;
  mainStaging:
    | {
        status: "staged";
        receiptPath: string;
        receipt: StagedMainArtifactReceipt;
      }
    | {
        status: "ineligible";
        code: string;
        message: string;
      };
  residualInventory: {
    callbacks: number;
    sessions: number;
    hasResidentControlPlane: boolean;
  };
};

export type DevInjectFailure = {
  ok: false;
  operationId: string;
  code: string;
  message: string;
  route: DevArtifactRouteAction | null;
  ownershipProven: boolean;
  compatibilityProven: boolean;
  sourceDelivered: boolean;
  applications: RuntimeApplicationResult[];
  details?: unknown;
};

export type DevInjectResult = DevInjectSuccess | DevInjectFailure;

export type PreparedOwnedDevTarget = {
  snapshot: DevStatusSnapshot;
  host: HostIdentity;
  process: VerifiedProcess;
  listener: ListenerObservation;
  target: TargetIdentity;
};

function failure(options: {
  operationId: string;
  code: string;
  message: string;
  route?: DevArtifactRouteAction | null;
  ownershipProven?: boolean;
  compatibilityProven?: boolean;
  sourceDelivered?: boolean;
  applications?: RuntimeApplicationResult[];
  details?: unknown;
}): DevInjectFailure {
  return {
    ok: false,
    operationId: options.operationId,
    code: options.code,
    message: options.message,
    route: options.route ?? null,
    ownershipProven: options.ownershipProven ?? false,
    compatibilityProven: options.compatibilityProven ?? false,
    sourceDelivered: options.sourceDelivered ?? false,
    applications: options.applications ?? [],
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

export async function prepareOwnedDevTarget(options: {
  operation: DevOwnershipOperation;
  osHome: string;
  explodexHome: string;
  explicitRoot?: string | null;
  signal?: AbortSignal;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  cdp: CdpAdapter;
  sdkRuntime?: SdkRuntimeIdentity;
  requireCompatibility?: boolean;
}): Promise<
  | { ok: true; value: PreparedOwnedDevTarget }
  | { ok: false; code: string; message: string; details?: unknown }
> {
  const host = await inspectHost({
    adapters: options.hostAdapters,
    signal: options.signal,
  });
  if (!host.ok) {
    return {
      ok: false,
      code: host.error.code,
      message: host.error.message,
      details: host.error,
    };
  }
  const snapshot = await inspectDevInstanceStatus({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
    explicitRoot: options.explicitRoot,
    operation: options.operation,
    signal: options.signal,
    hostAdapters: options.hostAdapters,
    statusAdapters: options.statusAdapters,
    cdp: options.cdp,
    sdkRuntime: options.sdkRuntime,
  });
  const state = snapshot.state;
  const target = snapshot.assessment.selectedTarget;
  const requireCompatibility = options.requireCompatibility ?? true;
  if (
    state === null ||
    target === null ||
    state.pid === null ||
    state.processStartedAt === null ||
    !snapshot.assessment.owned ||
    (requireCompatibility && !snapshot.assessment.mutationAllowed)
  ) {
    return {
      ok: false,
      code: requireCompatibility &&
          snapshot.assessment.failures.some((entry) =>
          entry.code === "compatibility_unproven"
        )
        ? "compatibility.unproven"
        : "dev.ownership-uncertain",
      message:
        snapshot.assessment.failures[0]?.message ??
        "Exact development ownership was not proven.",
      details: {
        rootPath: snapshot.rootPath,
        failures: snapshot.assessment.failures,
      },
    };
  }
  const processes = await options.statusAdapters.process.list({
    signal: options.signal,
  });
  const observed = processes.find((candidate) => candidate.pid === state.pid);
  const processIdentity = await options.statusAdapters.process.identify(
    state.pid,
    { signal: options.signal },
  );
  const listeners = await options.statusAdapters.port.listenersFor(9444, {
    signal: options.signal,
  });
  const withIdentity: ListenerObservation[] = [];
  for (const listener of listeners) {
    const identity = await options.statusAdapters.process.identify(
      listener.pid,
      { signal: options.signal },
    );
    withIdentity.push({
      ...listener,
      processStartedAt: identity?.processStartedAt ?? null,
    });
  }
  const authority = classifyOwnedListenerAuthority({
    rootPid: state.pid,
    rootProcessStartedAt: state.processStartedAt,
    listeners: withIdentity,
    processes,
    privateRoots: [
      state.electronUserDataPath,
      state.codexHomePath,
      state.explodexStatePath,
    ],
  });
  if (
    observed === undefined ||
    processIdentity === null ||
    processIdentity.processStartedAt !== state.processStartedAt ||
    !authority.ok ||
    authority.rootListener === null
  ) {
    return {
      ok: false,
      code: "dev.ownership-uncertain",
      message:
        "Development process or exact 9444 ownership changed after the ownership snapshot.",
    };
  }
  return {
    ok: true,
    value: {
      snapshot,
      host: host.host,
      process: {
        ...observed,
        processStartedAt: processIdentity.processStartedAt,
      },
      listener: {
        ...authority.rootListener,
        processStartedAt: processIdentity.processStartedAt,
      },
      target,
    },
  };
}

async function applySnapshot(options: {
  operationId: string;
  boundary: "current" | "renderer" | "app";
  prepared: PreparedOwnedDevTarget;
  snapshot: Parameters<
    typeof runEnabledPluginApplicationOperation
  >[0]["snapshots"][number];
  enabledSnapshots: Parameters<
    typeof runEnabledPluginApplicationOperation
  >[0]["snapshots"];
  osHome: string;
  explodexHome: string;
  explicitRoot?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  runtimeAdapters: RuntimeAdapters;
  cdp: CdpAdapter;
  sdkRuntimeSource: string;
  sdkRuntime: {
    version: string;
    sha256: string;
    sourcePath: string;
  };
  authorityFingerprint: string;
}) {
  const revalidate = async () => {
    const currentPluginState = await loadPluginsState({
      explodexHome: options.explodexHome,
    });
    if (
      currentPluginState.status !== "valid" ||
      pluginAuthorityFingerprint(currentPluginState.state) !==
        options.authorityFingerprint
    ) {
      throw Object.assign(
        new Error("Authoritative enabled plugin intent changed during injection."),
        { code: "host_identity_drift" as const },
      );
    }
    const currentSdkRuntimeSource = await readFile(
      options.sdkRuntime.sourcePath,
      "utf8",
    );
    const currentSdkRuntime = {
      version: options.sdkRuntime.version,
      sha256: createHash("sha256")
        .update(currentSdkRuntimeSource)
        .digest("hex"),
      sourcePath: options.sdkRuntime.sourcePath,
    };
    if (
      currentSdkRuntime.version !== options.sdkRuntime.version ||
      currentSdkRuntime.sha256 !== options.sdkRuntime.sha256 ||
      currentSdkRuntime.sourcePath !== options.sdkRuntime.sourcePath
    ) {
      throw Object.assign(
        new Error("Generated SDK runtime identity changed during dev injection."),
        { code: "host_identity_drift" as const },
      );
    }
    const current = await prepareOwnedDevTarget({
      operation: options.boundary === "renderer"
        ? "renderer-boundary"
        : options.boundary === "app"
          ? "app-boundary"
          : "inject",
      osHome: options.osHome,
      explodexHome: options.explodexHome,
      explicitRoot: options.explicitRoot,
      signal: options.signal,
      hostAdapters: options.hostAdapters,
      statusAdapters: options.statusAdapters,
      cdp: options.cdp,
      sdkRuntime: options.sdkRuntime,
    });
    if (!current.ok) {
      throw Object.assign(new Error(current.message), {
        code: current.code.includes("compatibility")
          ? "host_identity_drift"
          : "process_identity_drift",
        details: current.details,
      });
    }
    return {
      host: current.value.host,
      process: current.value.process,
      listener: current.value.listener,
    };
  };
  return runEnabledPluginApplicationOperation({
    runtime: options.runtimeAdapters,
    operationId: options.operationId,
    role: "development",
    homeIdentity: options.explodexHome,
    host: options.prepared.host,
    process: options.prepared.process,
    endpoint: { host: "127.0.0.1", port: 9444 },
    cdp: options.cdp,
    expectedTargetId: options.prepared.target.targetId,
    revalidate,
    sdkRuntimeSource: options.sdkRuntimeSource,
    snapshots: [
      ...options.enabledSnapshots.filter((snapshot) =>
        snapshot.identity.id !== options.snapshot.identity.id
      ),
      options.snapshot,
    ].sort((left, right) =>
      left.identity.id < right.identity.id
        ? -1
        : left.identity.id > right.identity.id
          ? 1
          : 0
    ),
    lifecycleBoundary: options.boundary,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

async function persistRendererBoundaryTarget(options: {
  prepared: PreparedOwnedDevTarget;
  target: TargetIdentity;
  osHome: string;
  explodexHome: string;
  explicitRoot?: string | null;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  cdp: CdpAdapter;
}): Promise<
  | { ok: true }
  | { ok: false; code: string; message: string }
> {
  const finalObservation = await prepareOwnedDevTarget({
    operation: "inject",
    osHome: options.osHome,
    explodexHome: options.explodexHome,
    explicitRoot: options.explicitRoot,
    signal: undefined,
    hostAdapters: options.hostAdapters,
    statusAdapters: options.statusAdapters,
    cdp: options.cdp,
  });
  if (
    !finalObservation.ok ||
    finalObservation.value.process.pid !== options.prepared.process.pid ||
    finalObservation.value.process.processStartedAt !==
      options.prepared.process.processStartedAt ||
    finalObservation.value.listener.pid !== options.prepared.listener.pid ||
    finalObservation.value.target.targetId !== options.target.targetId ||
    finalObservation.value.target.executionContextId !==
      options.target.executionContextId ||
    finalObservation.value.target.executionContextUniqueId !==
      options.target.executionContextUniqueId
  ) {
    return {
      ok: false,
      code: "operation.state-changed",
      message:
        "Development process, listener, target, or default context changed before renderer boundary identity commit.",
    };
  }
  const statePath = `${options.prepared.snapshot.rootPath}/state.json`;
  const loaded = await loadDevInstanceStateResult({
    adapters: options.hostAdapters,
    statePath,
  });
  if (
    loaded.status !== "valid" ||
    loaded.state.status !== "ready" ||
    loaded.state.pid !== options.prepared.process.pid ||
    loaded.state.processStartedAt !==
      options.prepared.process.processStartedAt ||
    loaded.state.targetId !== options.prepared.target.targetId
  ) {
    return {
      ok: false,
      code: "operation.state-changed",
      message:
        "Development ownership state changed before renderer boundary identity commit.",
    };
  }
  try {
    await saveDevInstanceState({
      adapters: options.hostAdapters,
      statePath,
      state: {
        ...loaded.state,
        browserIdentity: options.target.browserIdentity,
        targetId: options.target.targetId,
        executionContextId: options.target.executionContextId,
        executionContextUniqueId:
          options.target.executionContextUniqueId,
        frameId: options.target.frameId,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error: unknown) {
    return {
      ok: false,
      code: "dev.boundary-state-write-failed",
      message: error instanceof Error
        ? error.message
        : "Renderer boundary identity could not be persisted.",
    };
  }
  return { ok: true };
}

export async function runDevInjectOperation(options: {
  artifactPath: string;
  osHome: string;
  explodexHome?: string;
  explicitRoot?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  operationId?: string;
  hostAdapters?: HostAdapters;
  statusAdapters?: HostStatusAdapters;
  runtimeAdapters?: RuntimeAdapters;
  cdp?: CdpAdapter;
  sdkRuntimeOverride?: {
    version: string;
    sha256: string;
    sourcePath: string;
    source?: string;
  };
}): Promise<DevInjectResult> {
  const operationId = options.operationId ?? "dev-inject";
  const explodexHome = resolve(resolveExplodexHome({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
  }));
  const artifact = await captureEphemeralPluginArtifact({
    artifactPath: options.artifactPath,
    signal: options.signal,
  });
  if (!artifact.ok) {
    return failure({
      operationId,
      code: artifact.code,
      message: artifact.message,
      details: artifact.details,
    });
  }
  const hostAdapters = options.hostAdapters ?? await createDefaultHostAdapters();
  const statusAdapters =
    options.statusAdapters ?? await createDefaultHostStatusAdapters();
  const runtimeAdapters =
    options.runtimeAdapters ?? await createDefaultRuntimeAdapters();
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const sdkRuntime =
    options.sdkRuntimeOverride ?? await resolveSdkRuntimeIdentityForCli();
  let sdkRuntimeSource: string;
  try {
    sdkRuntimeSource = options.sdkRuntimeOverride?.source ??
      await readVerifiedSdkRuntimeSource(sdkRuntime);
    if (
      createHash("sha256").update(sdkRuntimeSource).digest("hex") !==
        sdkRuntime.sha256
    ) {
      throw new Error(
        "Generated SDK runtime bytes do not match the requested local identity.",
      );
    }
  } catch (error: unknown) {
    return failure({
      operationId,
      code: "compatibility.unproven",
      message: options.sdkRuntimeOverride === undefined &&
          error instanceof Error
        ? error.message
        : "The exact generated local SDK runtime bytes are unavailable or mismatched.",
    });
  }
  const enabled = await revalidateEnabledPluginArtifacts({
    explodexHome,
    operationId: `${operationId}-enabled`,
    boundary: artifact.snapshot.manifest.lifecycle === "dynamic"
      ? "current"
      : artifact.snapshot.manifest.lifecycle === "renderer-start"
        ? "renderer"
        : "app",
    signal: options.signal,
  });
  if (!enabled.ok) {
    return failure({
      operationId,
      code: enabled.code,
      message: enabled.message,
      details: enabled.details,
    });
  }
  const routeAuthority = await withPluginStateLock({
    explodexHome,
    operation: "dev.inject",
    operationId: `${operationId}-authority`,
    signal: options.signal,
    waitBoundMs: Math.min(options.timeoutMs, 2_000),
    runtimeAdapters,
    work: async () => {
      const current = await loadPluginsState({ explodexHome });
      if (
        current.status !== "valid" ||
        pluginAuthorityFingerprint(current.state) !==
          enabled.authorityFingerprint
      ) {
        return failure({
          operationId,
          code: "operation.state-changed",
          message:
            "Authoritative enabled plugin intent changed before injection authority was acquired.",
        });
      }
      return executeDevArtifactRoute({
    lifecycle: artifact.validation.lifecycle,
    actions: {
      dynamic: async () => {
        const initial = await prepareOwnedDevTarget({
          operation: "inject",
          osHome: options.osHome,
          explodexHome,
          explicitRoot: options.explicitRoot,
          signal: options.signal,
          hostAdapters,
          statusAdapters,
          cdp,
          sdkRuntime,
        });
        if (!initial.ok) throw Object.assign(new Error(initial.message), initial);
        const locked = await withDevInstanceLock({
          rootPath: initial.value.snapshot.rootPath,
          operation: "dev.inject",
          operationId,
          waitBoundMs: Math.min(options.timeoutMs, 2_000),
          signal: options.signal,
          runtimeAdapters,
          work: async () => {
            const prepared = await prepareOwnedDevTarget({
              operation: "inject",
              osHome: options.osHome,
              explodexHome,
              explicitRoot: options.explicitRoot,
              signal: options.signal,
              hostAdapters,
              statusAdapters,
              cdp,
              sdkRuntime,
            });
            if (!prepared.ok) {
              throw Object.assign(new Error(prepared.message), prepared);
            }
            const application = await applySnapshot({
                operationId,
                boundary: "current",
                prepared: prepared.value,
                snapshot: artifact.snapshot,
                enabledSnapshots: enabled.snapshots,
                osHome: options.osHome,
                explodexHome,
                explicitRoot: options.explicitRoot,
                timeoutMs: options.timeoutMs,
                signal: options.signal,
                hostAdapters,
                statusAdapters,
                runtimeAdapters,
                cdp,
                sdkRuntimeSource,
                sdkRuntime,
                authorityFingerprint: enabled.authorityFingerprint,
              });
            return {
              prepared: prepared.value,
              application,
              boundaryPersistenceError: null,
            };
          },
        });
        if (!locked.ok) {
          throw Object.assign(new Error(locked.message), {
            code: locked.code,
            details: locked.details,
          });
        }
        return locked.value;
      },
      "renderer-boundary": async () => {
        const initial = await prepareOwnedDevTarget({
          operation: "renderer-boundary",
          osHome: options.osHome,
          explodexHome,
          explicitRoot: options.explicitRoot,
          signal: options.signal,
          hostAdapters,
          statusAdapters,
          cdp,
          sdkRuntime,
        });
        if (!initial.ok) throw Object.assign(new Error(initial.message), initial);
        const locked = await withDevInstanceLock({
          rootPath: initial.value.snapshot.rootPath,
          operation: "dev.renderer-boundary",
          operationId,
          waitBoundMs: Math.min(options.timeoutMs, 2_000),
          signal: options.signal,
          runtimeAdapters,
          work: async () => {
            const prepared = await prepareOwnedDevTarget({
              operation: "renderer-boundary",
              osHome: options.osHome,
              explodexHome,
              explicitRoot: options.explicitRoot,
              signal: options.signal,
              hostAdapters,
              statusAdapters,
              cdp,
              sdkRuntime,
            });
            if (!prepared.ok) {
              throw Object.assign(new Error(prepared.message), prepared);
            }
            const application = await applySnapshot({
                operationId,
                boundary: "renderer",
                prepared: prepared.value,
                snapshot: artifact.snapshot,
                enabledSnapshots: enabled.snapshots,
                osHome: options.osHome,
                explodexHome,
                explicitRoot: options.explicitRoot,
                timeoutMs: options.timeoutMs,
                signal: options.signal,
                hostAdapters,
                statusAdapters,
                runtimeAdapters,
                cdp,
                sdkRuntimeSource,
                sdkRuntime,
                authorityFingerprint: enabled.authorityFingerprint,
              });
            const persistence = application.target === undefined
              ? null
              : await persistRendererBoundaryTarget({
                  prepared: prepared.value,
                  target: application.target,
                  osHome: options.osHome,
                  explodexHome,
                  explicitRoot: options.explicitRoot,
                  hostAdapters,
                  statusAdapters,
                  cdp,
                });
            return {
              prepared: prepared.value,
              application,
              boundaryPersistenceError:
                persistence === null || persistence.ok ? null : persistence,
            };
          },
        });
        if (!locked.ok) {
          throw Object.assign(new Error(locked.message), {
            code: locked.code,
            details: locked.details,
          });
        }
        return locked.value;
      },
      "app-boundary": async () => {
        const initial = await prepareOwnedDevTarget({
          operation: "app-boundary",
          osHome: options.osHome,
          explodexHome,
          explicitRoot: options.explicitRoot,
          signal: options.signal,
          hostAdapters,
          statusAdapters,
          cdp,
          sdkRuntime,
        });
        if (!initial.ok) throw Object.assign(new Error(initial.message), initial);
        let boundary:
          | {
              prepared: PreparedOwnedDevTarget;
              application: Awaited<ReturnType<typeof applySnapshot>>;
              boundaryPersistenceError: null;
            }
          | {
              error: unknown;
            }
          | null = null;
        const restarted = await runDevLifecycleOperation({
          kind: "restart",
          osHome: options.osHome,
          explodexHome,
          explicitRoot: options.explicitRoot,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          hostAdapters,
          statusAdapters,
          runtimeAdapters,
          cdp,
          requiredHost: initial.value.host,
          afterLockedTransition: async () => {
            try {
              const prepared = await prepareOwnedDevTarget({
                operation: "app-boundary",
                osHome: options.osHome,
                explodexHome,
                explicitRoot: options.explicitRoot,
                signal: options.signal,
                hostAdapters,
                statusAdapters,
                cdp,
                sdkRuntime,
              });
              if (!prepared.ok) {
                boundary = {
                  error: Object.assign(
                    new Error(prepared.message),
                    prepared,
                  ),
                };
                return;
              }
              boundary = {
                prepared: prepared.value,
                application: await applySnapshot({
                  operationId,
                  boundary: "app",
                  prepared: prepared.value,
                  snapshot: artifact.snapshot,
                  enabledSnapshots: enabled.snapshots,
                  osHome: options.osHome,
                  explodexHome,
                  explicitRoot: options.explicitRoot,
                  timeoutMs: options.timeoutMs,
                  signal: options.signal,
                  hostAdapters,
                  statusAdapters,
                  runtimeAdapters,
                  cdp,
                  sdkRuntimeSource,
                  sdkRuntime,
                  authorityFingerprint: enabled.authorityFingerprint,
                }),
                boundaryPersistenceError: null,
              };
            } catch (error: unknown) {
              boundary = { error };
            }
          },
        });
        if (!restarted.ok) {
          throw Object.assign(new Error(restarted.message), {
            code: restarted.code,
            details: restarted.details,
          });
        }
        const completed = boundary as
          | {
              prepared: PreparedOwnedDevTarget;
              application: Awaited<ReturnType<typeof applySnapshot>>;
              boundaryPersistenceError: {
                code: string;
                message: string;
              } | null;
            }
          | { error: unknown }
          | null;
        if (completed === null) {
          throw Object.assign(
            new Error("App boundary completed without application evidence."),
            { code: "dev.boundary-incomplete" },
          );
        }
        if ("error" in completed) throw completed.error;
        return completed;
      },
    },
      });
    },
  });
  if (!routeAuthority.ok) {
    return failure({
      operationId,
      code: routeAuthority.code,
      message: routeAuthority.message,
      details: routeAuthority.details,
    });
  }
  const route = routeAuthority.value;
  if (!route.ok) {
    return failure({
      operationId,
      code: route.code,
      message: route.message,
      route: route.route,
      details:
        typeof route === "object" && "details" in route
          ? (route as { details?: unknown }).details
          : undefined,
    });
  }
  const { prepared, application, boundaryPersistenceError } = route.value;
  if (boundaryPersistenceError !== null) {
    return failure({
      operationId,
      code: boundaryPersistenceError.code,
      message: boundaryPersistenceError.message,
      route: route.route,
      ownershipProven: true,
      compatibilityProven: true,
      sourceDelivered: application.sourceDelivered,
      applications: application.applications,
    });
  }
  if (!application.ok) {
    return failure({
      operationId,
      code: application.code,
      message: application.message,
      route: route.route,
      ownershipProven: true,
      compatibilityProven: true,
      sourceDelivered: application.sourceDelivered,
      applications: application.applications,
      details: application.details,
    });
  }
  let mainStaging: DevInjectSuccess["mainStaging"];
  const stagedApplication = application.applications.find((candidate) =>
    candidate.id === artifact.validation.id &&
    candidate.version === artifact.validation.version &&
    candidate.payloadSha256 === artifact.validation.payloadSha256
  );
  const exactDevValidation =
    stagedApplication !== undefined &&
    (stagedApplication.status === "applied" ||
      stagedApplication.status === "unchanged") &&
    stagedApplication.error === undefined &&
    stagedApplication.appliedIdentity?.id === artifact.validation.id &&
    stagedApplication.appliedIdentity.version === artifact.validation.version &&
    stagedApplication.appliedIdentity.payloadSha256 ===
      artifact.validation.payloadSha256;
  if (!exactDevValidation) {
    mainStaging = {
      status: "ineligible",
      code: "develop.dev-revalidation-required",
      message:
        "The exact artifact was not confirmed as fully applied on owned development.",
    };
  } else if (options.sdkRuntimeOverride !== undefined) {
    mainStaging = {
      status: "ineligible",
      code: "develop.local-sdk-not-publishable",
      message:
        "Local-SDK-dependent development output cannot be staged for the authoring main.",
    };
  } else {
    const generation = await readVerifiedGenerationOutput(
      resolve(options.artifactPath),
    );
    const persistedCompatibility = await loadCompatibilityRecord({
      adapters: hostAdapters,
      explodexHome,
    });
    const compatibility = evaluateCompatibility({
      host: prepared.host,
      sdkRuntime,
      persisted: persistedCompatibility,
      runningProcess: {
        appVersion: application.target.appVersion,
        appBuild: application.target.appBuild,
        executablePath: application.target.executablePath,
      },
    });
    const staged = compatibility.allowsCompatibilityDependentWork &&
        compatibility.currentKey !== null
      ? createStagedMainArtifactReceipt({
          artifact: {
            id: artifact.validation.id,
            version: artifact.validation.version,
            payloadSha256: artifact.validation.payloadSha256,
            lifecycle: artifact.validation.lifecycle,
            sdkRange: artifact.validation.sdkRange,
          },
          generation,
          sdkRuntimeIdentity: sdkRuntime,
          devValidatedTarget: application.target,
          devValidatedAt: new Date().toISOString(),
          validationOperationId: operationId,
          compatibilityKeyHash: compatibilityKeyHash(
            compatibility.currentKey,
          ),
        })
      : {
          ok: false as const,
          code: "compatibility.drifted" as const,
          message:
            "The exact compatibility proof changed before the main staging receipt could be recorded.",
        };
    if (staged.ok) {
      try {
        mainStaging = {
          status: "staged",
          receiptPath: await saveStagedMainArtifactReceipt({
            explodexHome,
            receipt: staged.receipt,
          }),
          receipt: staged.receipt,
        };
      } catch (error: unknown) {
        mainStaging = {
          status: "ineligible",
          code: "main.staging-write-failed",
          message: error instanceof Error
            ? error.message
            : "The exact main staging receipt could not be recorded.",
        };
      }
    } else {
      mainStaging = {
        status: "ineligible",
        code: staged.code,
        message: staged.message,
      };
    }
  }
  return {
    ok: true,
    operationId,
    route: route.route,
    rootPath: prepared.snapshot.rootPath,
    identity: {
      id: artifact.validation.id,
      version: artifact.validation.version,
      payloadSha256: artifact.validation.payloadSha256,
      lifecycle: artifact.validation.lifecycle,
    },
    ownership: {
      proven: true,
      pid: application.target.pid,
      processStartedAt: application.target.processStartedAt,
      port: 9444,
      targetId: application.target.targetId,
      executionContextId: application.target.executionContextId,
    },
    compatibility: { proven: true },
    sdkRuntimeIdentity: {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    },
    target: application.target,
    applications: application.applications,
    sourceDelivered: application.sourceDelivered,
    authority: {
      installed: false,
      enabled: false,
      pendingReview: false,
    },
    devSurvived: true,
    mainStaging,
    residualInventory: application.residualInventory,
  };
}
