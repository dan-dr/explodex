import { readFile } from "node:fs/promises";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import { createHash } from "node:crypto";
import { resolveDefaultDevRoot, describeDevLayout } from "../dev/layout.ts";
import { loadDevInstanceState } from "../dev/state.ts";
import { createDefaultHostAdapters } from "../host/adapters.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { gateCompatibilityDependentOperation } from "../host/compatibility-gate.ts";
import { inspectHost } from "../host/identity.ts";
import type { HostIdentity } from "../host/types.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import { runCompatibilityProbe } from "../host/probe-operation.ts";
import {
  roleEndpoint,
  type HostRole,
  type ListenerObservation,
  type VerifiedProcess,
} from "../host/status.ts";
import { createDefaultRuntimeAdapters } from "../runtime/adapters.ts";
import {
  runPluginReviewOperation,
} from "./review-operation.ts";
import type { ReviewArtifact } from "./review-protocol.ts";
import {
  approveSelectedPluginArtifacts,
} from "./approval-transaction.ts";
import {
  runApprovedPluginApplicationOperation,
  type RuntimeApplicationResult,
} from "./application-operation.ts";
import type { PluginMutationResult } from "./reconciliation.ts";

export type PluginReviewApprovalResult =
  | {
      ok: true;
      operationId: string;
      status: "submitted" | "approved";
      selected: Array<{
        id: string;
        version: string;
        payloadSha256: string;
      }>;
      reviewed: ReviewArtifact[];
      protocol: {
        callbackName: string;
        nonce: string;
        expiresAtMs: number;
        target: import("../cdp/types.ts").TargetIdentity;
      };
      stateCommitted: boolean;
      authorityChanged: boolean;
      sourceDelivered: boolean;
      applications: RuntimeApplicationResult[];
      mutations?: PluginMutationResult[];
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
      stateCommitted: boolean;
      sourceDelivered: boolean;
      authorityChanged: boolean;
      applications: RuntimeApplicationResult[];
      mutations?: PluginMutationResult[];
    };

export type PreparedPluginApplicationTarget = {
  role: HostRole;
  process: VerifiedProcess;
  listener: ListenerObservation;
  expectedTargetId?: string;
  expectedLaunchMarker?: string;
};

function unavailable(options: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): PluginReviewApprovalResult {
  return {
    ok: false,
    operationId: "plugin-review",
    code: options.code,
    message: options.message,
    details: options.details,
    stateCommitted: false,
    sourceDelivered: false,
    authorityChanged: false,
    applications: [],
  };
}

function mutationResults(options: {
  approval: {
    selected: Array<{ id: string; version: string; payloadSha256: string }>;
    previousIntents: Array<{
      id: string;
      intent: { version: string; payloadSha256: string } | null;
    }>;
  };
  applications: RuntimeApplicationResult[];
  target: import("../cdp/types.ts").TargetIdentity | null;
}): PluginMutationResult[] {
  const previous = new Map(
    options.approval.previousIntents.map((entry) => [entry.id, entry.intent]),
  );
  const applications = new Map(
    options.applications.map((entry) => [entry.id, entry]),
  );
  return options.approval.selected.map((selected) => {
    const application = applications.get(selected.id);
    const currentIntent = {
      version: selected.version,
      payloadSha256: selected.payloadSha256,
    };
    if (application === undefined) {
      return {
        id: selected.id,
        previousIntent: previous.get(selected.id) ?? null,
        currentIntent,
        stateCommitted: true,
        reviewStatus: "approved",
        application: {
          status: "not-attempted",
          lifecycle: null,
          target: null,
          boundary: "none",
          appliedIdentity: null,
          message: "Application was not attempted after approval committed.",
          error: {
            code: "plugin.application.not-attempted",
            message: "Application was not attempted after approval committed.",
            stage: "evaluation",
            possiblePartialEffects: false,
          },
        },
      };
    }
    const status =
      application.status === "applied" || application.status === "unchanged"
        ? "applied"
        : application.status;
    return {
      id: selected.id,
      previousIntent: previous.get(selected.id) ?? null,
      currentIntent,
      stateCommitted: true,
      reviewStatus: "approved",
      application: {
        status,
        lifecycle: application.boundary === "renderer"
          ? "renderer-start"
          : application.boundary === "app"
            ? "app-start"
            : "dynamic",
        target: options.target,
        boundary: application.boundary,
        appliedIdentity: application.appliedIdentity === null
          ? null
          : {
              version: application.appliedIdentity.version,
              payloadSha256: application.appliedIdentity.payloadSha256,
            },
        ...(application.error === undefined
          ? {}
          : {
              message: application.error.message,
              error: {
                code: application.error.code,
                message: application.error.message,
                stage:
                  application.stage === "setup" ||
                    application.stage === "cleanup" ||
                    application.stage === "evaluation"
                    ? application.stage
                    : "evaluation" as const,
                possiblePartialEffects:
                  application.possiblePartialEffects,
              },
            }),
      },
    };
  });
}

export async function preparePluginApplicationTarget(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  host: HostIdentity;
}): Promise<
  | { ok: true; target: PreparedPluginApplicationTarget }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> }
> {
  const adapters = await createDefaultHostAdapters();
  const statusAdapters = await createDefaultHostStatusAdapters();
  const endpoint = roleEndpoint(options.role);
  const rawListeners = await statusAdapters.port.listenersFor(endpoint.port);
  const listeners: ListenerObservation[] = [];
  for (const candidate of rawListeners) {
    const identity = await statusAdapters.process.identify(candidate.pid);
    listeners.push({
      ...candidate,
      processStartedAt: identity?.pid === candidate.pid
        ? identity.processStartedAt
        : null,
    });
  }
  if (listeners.length !== 1) {
    return {
      ok: false,
      code: "plugin.review.unavailable",
      message:
        `The declared ${options.role} review endpoint is unavailable or ambiguous.`,
      details: {
        endpoint,
        listenerCount: listeners.length,
      },
    };
  }
  const listener = listeners[0]!;
  const processes = await statusAdapters.process.list();
  const observed = processes.filter((candidate) =>
    candidate.pid === listener.pid &&
    candidate.executablePath === options.host.executablePath
  );
  if (observed.length !== 1 || listener.processStartedAt === null) {
    return {
      ok: false,
      code: "cdp.identity-mismatch",
      message:
        "The declared review endpoint owner did not match one exact canonical ChatGPT process.",
    };
  }
  const process: VerifiedProcess = {
    ...observed[0]!,
    processStartedAt: listener.processStartedAt,
  };
  if (options.role === "main") {
    return {
      ok: true,
      target: { role: "main", process, listener },
    };
  }

  const devRoot = resolveDefaultDevRoot({
    osHome: options.env.HOME,
    explodexHome: options.explodexHome,
    explicitRoot: options.devRoot,
  });
  const layout = describeDevLayout(devRoot);
  const state = await loadDevInstanceState({
    adapters,
    statePath: layout.statePath,
  });
  if (
    state === null ||
    state.status !== "ready" ||
    state.pid !== process.pid ||
    state.processStartedAt !== process.processStartedAt ||
    state.executablePath !== process.executablePath ||
    state.cdpHost !== endpoint.host ||
    state.cdpPort !== endpoint.port ||
    state.targetId === null ||
    state.launchMarker.length === 0 ||
    state.appVersion !== options.host.appVersion ||
    state.appBuild !== options.host.appBuild ||
    !process.arguments.includes(state.launchMarker)
  ) {
    return {
      ok: false,
      code: "dev.ownership-uncertain",
      message:
        "The development review target did not match complete exact owned ready-state evidence.",
    };
  }
  return {
    ok: true,
    target: {
      role: "development",
      process,
      listener,
      expectedTargetId: state.targetId,
      expectedLaunchMarker: state.launchMarker,
    },
  };
}

export async function attemptAutomaticDevelopmentReproof(options: {
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  host: HostIdentity;
  hostAdapters: Awaited<ReturnType<typeof createDefaultHostAdapters>>;
  sdkRuntime: Awaited<ReturnType<typeof resolveSdkRuntimeIdentityForCli>>;
  signal?: AbortSignal;
}): Promise<
  | { ok: true }
  | { ok: false; code: string; message: string }
> {
  const prepared = await preparePluginApplicationTarget({
    role: "development",
    explodexHome: options.explodexHome,
    devRoot: options.devRoot,
    env: options.env,
    host: options.host,
  });
  if (!prepared.ok) return prepared;
  const devRoot = resolveDefaultDevRoot({
    osHome: options.env.HOME,
    explodexHome: options.explodexHome,
    explicitRoot: options.devRoot,
  });
  let sdkSource: string;
  try {
    sdkSource = await readVerifiedSdkRuntimeSource(options.sdkRuntime);
  } catch {
    return {
      ok: false,
      code: "compatibility.unproven",
      message:
        "The generated SDK runtime bytes are unavailable for automatic development re-proof.",
    };
  }
  const probe = await runCompatibilityProbe({
    adapters: options.hostAdapters,
    explodexHome: options.explodexHome,
    phase0ContractPath: describeDevLayout(devRoot).phase0ContractPath,
    sdkRuntime: {
      version: options.sdkRuntime.version,
      sha256: options.sdkRuntime.sha256,
    },
    sdkSource,
    cdp: createNodeCdpAdapter(),
    acceptanceProcess: {
      pid: prepared.target.process.pid,
      processStartedAt: prepared.target.process.processStartedAt,
      executablePath: prepared.target.process.executablePath,
      targetId: prepared.target.expectedTargetId ?? null,
    },
    authoringMain: null,
    signal: options.signal,
  });
  return probe.ok && probe.committed
    ? { ok: true }
    : {
        ok: false,
        code: probe.ok ? "compatibility.unproven" : probe.error.code,
        message: probe.ok
          ? "Automatic development compatibility re-proof did not commit authority."
          : probe.error.message,
      };
}

export async function readVerifiedSdkRuntimeSource(
  sdkRuntime: Awaited<ReturnType<typeof resolveSdkRuntimeIdentityForCli>>,
): Promise<string> {
  const source = await readFile(sdkRuntime.sourcePath, "utf8");
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== sdkRuntime.sha256) {
    throw new Error(
      "Generated SDK runtime bytes do not match the compatibility-bound identity.",
    );
  }
  return source;
}

export async function runReviewOnDeclaredTarget(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  artifacts: readonly ReviewArtifact[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PluginReviewApprovalResult> {
  if (options.signal?.aborted) {
    return unavailable({
      code: "operation.interrupted",
      message: "Plugin review was interrupted before target inspection.",
    });
  }
  const hostAdapters = await createDefaultHostAdapters();
  const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
  const inspection = await inspectHost({ adapters: hostAdapters });
  if (!inspection.ok || inspection.host === null) {
    return unavailable({
      code: "host.invalid",
      message: inspection.error.message,
    });
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
    operation: "review",
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
        operation: "review",
        compatibility,
      });
    }
  }
  if (!gate.allowed) {
    return unavailable({
      code: gate.error.code === "compatibility_stale"
        ? "compatibility.drifted"
        : "compatibility.unproven",
      message: gate.error.message,
      details: { nextAction: gate.error.nextAction },
    });
  }
  const prepared = await preparePluginApplicationTarget({
    role: options.role,
    explodexHome: options.explodexHome,
    devRoot: options.devRoot,
    env: options.env,
    host: inspection.host,
  });
  if (!prepared.ok) {
    return unavailable(prepared);
  }
  let sdkRuntimeSource: string;
  try {
    sdkRuntimeSource = await readVerifiedSdkRuntimeSource(sdkRuntime);
  } catch {
    return unavailable({
      code: "compatibility.unproven",
      message: "The exact generated SDK runtime bytes are unavailable for review.",
    });
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
        new Error("Generated SDK runtime identity changed during approval."),
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
        new Error("Compatibility authority changed during plugin approval."),
        { code: "host_identity_drift" as const },
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
        new Error("Approval process or endpoint identity changed."),
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
  const review = await runPluginReviewOperation({
    runtime,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: expectedHost,
    process: expected.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    expectedTargetId: expected.expectedTargetId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    sdkRuntimeSource,
    artifacts: options.artifacts,
    revalidate,
  });
  if (!review.ok) {
    if (review.cleanupProtocol !== undefined) {
      const cleanup = await runApprovedPluginApplicationOperation({
        runtime,
        operationId: review.operationId,
        nonce: review.cleanupProtocol.nonce,
        activationSecret: "",
        role: options.role,
        homeIdentity: options.explodexHome,
        host: expectedHost,
        process: expected.process,
        endpoint: roleEndpoint(options.role),
        cdp,
        expectedTarget: review.cleanupProtocol.target,
        revalidate,
        sdkRuntimeSource,
        snapshots: [],
        timeoutMs: options.timeoutMs,
      });
      if (!cleanup.ok) {
        return {
          ok: false,
          operationId: review.operationId,
          code: "plugin.approval.cleanup-failed",
          message:
            "Rejected plugin review could not remove its pending renderer capability cleanly.",
          details: { review, cleanup },
          stateCommitted: false,
          authorityChanged: false,
          sourceDelivered: false,
          applications: [],
        };
      }
    }
    const { cleanupProtocol: _cleanupProtocol, ...publicReview } = review;
    return {
      ...publicReview,
      stateCommitted: false,
      applications: [],
    };
  }
  const publicReviewProtocol = {
    callbackName: review.protocol.callbackName,
    nonce: review.protocol.nonce,
    expiresAtMs: review.protocol.expiresAtMs,
    target: review.protocol.target,
  };
  if (review.selected.length === 0) {
    return {
      ...review,
      protocol: publicReviewProtocol,
      stateCommitted: false,
      applications: [],
    };
  }
  const finalizeReviewGrant = () => runApprovedPluginApplicationOperation({
    runtime,
    operationId: review.operationId,
    nonce: review.protocol.nonce,
    activationSecret: review.protocol.activationSecret,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: expectedHost,
    process: expected.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    expectedTarget: review.protocol.target,
    revalidate,
    sdkRuntimeSource,
    snapshots: [],
    timeoutMs: options.timeoutMs,
  });

  const approval = await approveSelectedPluginArtifacts({
    explodexHome: options.explodexHome,
    selected: review.selected,
    signal: options.signal,
    runtimeAdapters: runtime,
    operationId: review.operationId,
  });
  const committedApprovalMutations = approval.stateCommitted
    ? mutationResults({
        approval,
        applications: [],
        target: null,
      })
    : undefined;
  if (!approval.ok) {
    const cleanup = await finalizeReviewGrant();
    if (!cleanup.ok) {
      return {
        ok: false,
        operationId: review.operationId,
        code: "plugin.approval.cleanup-failed",
        message:
          "Plugin approval failed and its renderer capability could not be removed cleanly.",
        details: {
          approval,
          cleanup,
          reviewProtocol: publicReviewProtocol,
        },
        stateCommitted: approval.stateCommitted,
        authorityChanged: approval.authorityChanged,
        sourceDelivered: false,
        applications: [],
        ...(committedApprovalMutations === undefined
          ? {}
          : { mutations: committedApprovalMutations }),
      };
    }
    return {
      ok: false,
      operationId: review.operationId,
      code: approval.code,
      message: approval.message,
      details: {
        ...approval.details,
        reviewProtocol: publicReviewProtocol,
        residualLockAuthority: approval.residualLockAuthority,
      },
      stateCommitted: approval.stateCommitted,
      authorityChanged: approval.authorityChanged,
      sourceDelivered: false,
      applications: [],
      ...(committedApprovalMutations === undefined
        ? {}
        : { mutations: committedApprovalMutations }),
    };
  }
  if (options.signal?.aborted) {
    const cleanup = await finalizeReviewGrant();
    if (!cleanup.ok) {
      return {
        ok: false,
        operationId: review.operationId,
        code: "plugin.approval.cleanup-failed",
        message:
          "Interrupted plugin approval could not remove its renderer capability cleanly.",
        details: { cleanup, reviewProtocol: publicReviewProtocol },
        stateCommitted: true,
        authorityChanged: true,
        sourceDelivered: false,
        applications: [],
        mutations: committedApprovalMutations,
      };
    }
    return {
      ok: false,
      operationId: review.operationId,
      code: "operation.interrupted",
      message:
        "Plugin approval was interrupted after authority committed and before source delivery.",
      stateCommitted: true,
      authorityChanged: true,
      sourceDelivered: false,
      applications: [],
      mutations: committedApprovalMutations,
    };
  }

  const application = await runApprovedPluginApplicationOperation({
    runtime,
    operationId: review.operationId,
    nonce: review.protocol.nonce,
    activationSecret: review.protocol.activationSecret,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: expectedHost,
    process: expected.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    expectedTarget: review.protocol.target,
    revalidate,
    sdkRuntimeSource,
    snapshots: approval.snapshots,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!application.ok) {
    return {
      ok: false,
      operationId: review.operationId,
      code: application.code,
      message: application.message,
      details: application.details,
      stateCommitted: true,
      authorityChanged: true,
      sourceDelivered: application.sourceDelivered,
      applications: application.applications,
      mutations: mutationResults({
        approval,
        applications: application.applications,
        target: null,
      }),
    };
  }
  return {
    ...review,
    protocol: publicReviewProtocol,
    status: "approved",
    stateCommitted: true,
    authorityChanged: true,
    sourceDelivered: application.sourceDelivered,
    applications: application.applications,
    mutations: mutationResults({
      approval,
      applications: application.applications,
      target: application.target,
    }),
    residualInventory: {
      callbacks:
        review.residualInventory.callbacks +
        application.residualInventory.callbacks,
      sessions:
        review.residualInventory.sessions +
        application.residualInventory.sessions,
      hasResidentControlPlane:
        review.residualInventory.hasResidentControlPlane ||
        application.residualInventory.hasResidentControlPlane,
    },
  };
}
