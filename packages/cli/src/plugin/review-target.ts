import { readFile } from "node:fs/promises";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
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
import {
  roleEndpoint,
  type HostRole,
  type ListenerObservation,
  type VerifiedProcess,
} from "../host/status.ts";
import { createDefaultRuntimeAdapters } from "../runtime/adapters.ts";
import {
  runPluginReviewOperation,
  type PluginReviewOperationResult,
} from "./review-operation.ts";
import type { ReviewArtifact } from "./review-protocol.ts";

type PreparedReviewTarget = {
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
}): PluginReviewOperationResult {
  return {
    ok: false,
    operationId: "plugin-review",
    code: options.code,
    message: options.message,
    details: options.details,
    sourceDelivered: false,
    authorityChanged: false,
  };
}

async function prepareTarget(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  host: HostIdentity;
}): Promise<
  | { ok: true; target: PreparedReviewTarget }
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

export async function runReviewOnDeclaredTarget(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  artifacts: readonly ReviewArtifact[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PluginReviewOperationResult> {
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
  const persisted = await loadCompatibilityRecord({
    adapters: hostAdapters,
    explodexHome: options.explodexHome,
  });
  const compatibility = evaluateCompatibility({
    host: inspection.host,
    sdkRuntime: {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    },
    persisted,
    runningProcess: null,
  });
  const gate = gateCompatibilityDependentOperation({
    operation: "review",
    compatibility,
  });
  if (!gate.allowed) {
    return unavailable({
      code: gate.error.code === "compatibility_stale"
        ? "compatibility.drifted"
        : "compatibility.unproven",
      message: gate.error.message,
      details: { nextAction: gate.error.nextAction },
    });
  }
  const prepared = await prepareTarget({
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
    sdkRuntimeSource = await readFile(sdkRuntime.sourcePath, "utf8");
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
  return runPluginReviewOperation({
    runtime,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: expectedHost,
    process: expected.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    expectedTargetId: expected.expectedTargetId,
    timeoutMs: options.timeoutMs,
    sdkRuntimeSource,
    artifacts: options.artifacts,
    revalidate: async () => {
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
      const currentCompatibility = evaluateCompatibility({
        host: currentInspection.host,
        sdkRuntime: {
          version: sdkRuntime.version,
          sha256: sdkRuntime.sha256,
        },
        persisted: currentPersisted,
        runningProcess: null,
      });
      if (
        !currentCompatibility.matched ||
        !currentCompatibility.allowsCompatibilityDependentWork
      ) {
        throw Object.assign(
          new Error("Compatibility authority changed during plugin review."),
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
          new Error("Review process or endpoint identity changed."),
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
    },
  });
}
