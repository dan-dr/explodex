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
import { runPluginTeardownOperation } from "./application-operation.ts";
import { loadPluginsState } from "./install-state.ts";
import type {
  PluginTeardownRequest,
  PluginTeardownResult,
} from "./mutation-transaction.ts";
import {
  attemptAutomaticDevelopmentReproof,
  preparePluginApplicationTarget,
} from "./review-target.ts";

function blocked(
  code: string,
  message: string,
): PluginTeardownResult {
  return {
    status: "blocked",
    target: null,
    appliedIdentity: null,
    message,
    error: {
      code,
      message,
      stage: "cleanup",
      possiblePartialEffects: false,
    },
  };
}

function failed(
  code: string,
  message: string,
  possiblePartialEffects: boolean,
): PluginTeardownResult {
  return {
    status: "failed",
    target: null,
    appliedIdentity: null,
    message,
    error: {
      code,
      message,
      stage: "cleanup",
      possiblePartialEffects,
    },
  };
}

export function createDeclaredTargetPluginTeardown(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): (request: PluginTeardownRequest) => Promise<PluginTeardownResult> {
  return async (request) => {
    if (options.role === "main") {
      return blocked(
        "plugin.main-authorization-required",
        "Protected authoring-main teardown requires the later explicit main authorization surface.",
      );
    }
    const hostAdapters = await createDefaultHostAdapters();
    const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
    const inspection = await inspectHost({ adapters: hostAdapters });
    if (!inspection.ok || inspection.host === null) {
      return blocked("host.invalid", inspection.error.message);
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
      return blocked(code, gate.error.message);
    }
    const prepared = await preparePluginApplicationTarget({
      role: options.role,
      explodexHome: options.explodexHome,
      devRoot: options.devRoot,
      env: options.env,
      host: inspection.host,
    });
    if (!prepared.ok) {
      return blocked(prepared.code, prepared.message);
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
        currentSdkRuntime.version !== sdkRuntime.version ||
        currentSdkRuntime.sha256 !== sdkRuntime.sha256 ||
        currentSdkRuntime.sourcePath !== sdkRuntime.sourcePath ||
        !currentCompatibility.matched ||
        !currentCompatibility.allowsCompatibilityDependentWork
      ) {
        throw Object.assign(
          new Error("Host or compatibility authority changed during teardown."),
          { code: "host_identity_drift" as const },
        );
      }
      const state = await loadPluginsState({
        explodexHome: options.explodexHome,
      });
      const currentEnabled = state.status === "valid"
        ? state.state.plugins[request.id]?.enabled ?? null
        : null;
      if (
        state.status !== "valid" ||
        (currentEnabled !== null &&
          currentEnabled.version === request.identity.version &&
          currentEnabled.payloadSha256 === request.identity.payloadSha256)
      ) {
        throw Object.assign(
          new Error(
            "Authoritative plugin intent did not reflect the committed disable or removal.",
          ),
          { code: "plugin_intent_drift" as const },
        );
      }
      const identity = await statusAdapters.process.identify(
        expected.process.pid,
      );
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
          new Error("Plugin teardown process or endpoint identity changed."),
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
    const result = await runPluginTeardownOperation({
      runtime,
      operationId: `plugin-teardown-${request.id}`,
      role: options.role,
      homeIdentity: options.explodexHome,
      host: expectedHost,
      process: expected.process,
      endpoint: roleEndpoint(options.role),
      cdp,
      expectedTargetId: expected.expectedTargetId,
      revalidate,
      identity: {
        id: request.id,
        version: request.identity.version,
        payloadSha256: request.identity.payloadSha256,
      },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (!result.ok) {
      return failed(
        result.code,
        result.message,
        result.details?.stage === "evaluation",
      );
    }
    return result.result;
  };
}
