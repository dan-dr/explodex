import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createNodeCdpAdapter, type CdpAdapter } from "../cdp/adapters.ts";
import {
  createDefaultHostAdapters,
  type HostAdapters,
} from "../host/adapters.ts";
import type { HostIdentity } from "../host/types.ts";
import type { SdkRuntimeIdentity } from "../host/types.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { inspectHost } from "../host/identity.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import type { HostStatusAdapters } from "../host/status.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  createDefaultRuntimeAdapters,
  type RuntimeAdapters,
} from "../runtime/adapters.ts";
import type { DevelopmentLifecycleMutation } from "./constants.ts";
import {
  ensureDefaultDevLayout,
} from "./layout.ts";
import {
  createNodeLaunchSpawnAdapter,
  type LaunchSpawnAdapter,
} from "./launch-adapters.ts";
import {
  ensureDevInstance,
  restartDevInstance,
  startDevInstance,
  stopDevInstance,
  type DevLifecycleFailure,
  type DevLifecycleResult,
} from "./lifecycle.ts";
import {
  gateDevelopmentLifecycleMutation,
} from "./lifecycle-gate.ts";
import {
  freezeHostIdentity,
  frozenHostEquals,
  loadPhase0LaunchContract,
} from "./phase0.ts";
import {
  canonicalizeDevRootSelection,
  canonicalizePathForCreation,
  resolveDevRootSelection,
  validateDevRootSelection,
  type DevRootProtectedPaths,
} from "./root-selection.ts";
import {
  createInitialDevInstanceState,
  loadDevInstanceStateResult,
  saveDevInstanceState,
} from "./state.ts";
import {
  inspectDevInstanceStatus,
} from "./status-operation.ts";
import type { DevInstanceState } from "./types.ts";
import { withDevInstanceLock } from "./workflow.ts";
import {
  createProductionDevLaunch,
  createProductionDevTermination,
} from "./lifecycle-system-adapters.ts";
import {
  createNodeReadOnlyCommandRunner,
  type ReadOnlyCommandRunner,
} from "../host/process-adapters.ts";

export type DevLifecycleOperationKind = "start" | "ensure" | "restart" | "stop";

export type DevLifecycleSystemOptions = {
  kind: DevLifecycleOperationKind;
  osHome: string;
  explodexHome?: string;
  explicitRoot?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  hostAdapters?: HostAdapters;
  statusAdapters?: HostStatusAdapters;
  runtimeAdapters?: RuntimeAdapters;
  cdp?: CdpAdapter;
  commands?: ReadOnlyCommandRunner;
  spawn?: LaunchSpawnAdapter;
  requiredHost?: HostIdentity;
  sdkRuntime?: SdkRuntimeIdentity;
  afterLockedTransition?: (
    result: Extract<DevLifecycleResult, { ok: true }>,
  ) => Promise<void>;
};

function mutationFor(
  kind: DevLifecycleOperationKind,
): DevelopmentLifecycleMutation {
  switch (kind) {
    case "start":
      return "dev-start";
    case "ensure":
      return "dev-ensure";
    case "restart":
      return "dev-restart";
    case "stop":
      return "dev-stop";
  }
}

function operationFor(kind: DevLifecycleOperationKind): string {
  return `dev.${kind}`;
}

async function protectedPaths(options: {
  adapters: HostAdapters;
  osHome: string;
  explodexHome: string;
}): Promise<DevRootProtectedPaths> {
  const [chatGptProfile, codexProfile, userCodexHome] = await Promise.all([
    canonicalizePathForCreation(
      options.adapters.fs,
      join(options.osHome, "Library", "Application Support", "ChatGPT"),
    ),
    canonicalizePathForCreation(
      options.adapters.fs,
      join(options.osHome, "Library", "Application Support", "Codex"),
    ),
    canonicalizePathForCreation(
      options.adapters.fs,
      join(options.osHome, ".codex"),
    ),
  ]);
  return {
    mainProfilePaths: [chatGptProfile.path, codexProfile.path],
    userCodexHome: userCodexHome.path,
    explodexHome: options.explodexHome,
  };
}

function refused(options: {
  code: DevLifecycleFailure["code"];
  message: string;
  state?: DevInstanceState | null;
  recoveryRequired?: boolean;
  details?: unknown;
}): DevLifecycleResult {
  return {
    ok: false,
    code: options.code,
    message: options.message,
    state: options.state ?? null,
    recoveryRequired: options.recoveryRequired ?? false,
    partialDisposition: "none",
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

/**
 * Production composition for strict development lifecycle operations.
 * It initializes an absent private root before taking the root-scoped transition
 * lease, then holds that lease through the complete state machine.
 */
export async function runDevLifecycleOperation(
  options: DevLifecycleSystemOptions,
): Promise<DevLifecycleResult> {
  const hostAdapters = options.hostAdapters ?? await createDefaultHostAdapters();
  const runtime = options.runtimeAdapters ?? await createDefaultRuntimeAdapters();
  const statusAdapters =
    options.statusAdapters ?? await createDefaultHostStatusAdapters();
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const commands = options.commands ?? createNodeReadOnlyCommandRunner();
  const spawn = options.spawn ?? await createNodeLaunchSpawnAdapter();
  const explodexHome = resolve(resolveExplodexHome({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
  }));
  const selection = await canonicalizeDevRootSelection({
    fs: hostAdapters.fs,
    selection: resolveDevRootSelection({
      osHome: options.osHome,
      explodexHome,
      explicitRoot: options.explicitRoot,
    }),
  });
  const currentState = await loadDevInstanceStateResult({
    adapters: hostAdapters,
    statePath: selection.layout.statePath,
  });
  const protectedSet = await protectedPaths({
    adapters: hostAdapters,
    osHome: options.osHome,
    explodexHome,
  });
  const rootValidation = await validateDevRootSelection({
    fs: hostAdapters.fs,
    selection,
    existingState: currentState.state,
    stateLoadStatus: currentState.status,
    protectedPaths: protectedSet,
  });
  if (!rootValidation.ok) {
    return refused({
      code: options.kind === "stop"
        ? "dev.stop-refused"
        : options.kind === "restart"
          ? "dev.restart-refused"
          : options.kind === "ensure"
            ? "dev.ensure-refused"
            : "dev.start-refused",
      message: rootValidation.message,
      state: currentState.state,
      details: {
        rootCode: rootValidation.code,
        fallbackUsed: false,
      },
    });
  }
  const host = await inspectHost({
    adapters: hostAdapters,
    signal: options.signal,
  });
  if (!host.ok) {
    return refused({
      code: options.kind === "stop"
        ? "dev.stop-refused"
        : options.kind === "restart"
          ? "dev.restart-refused"
          : options.kind === "ensure"
            ? "dev.ensure-refused"
            : "dev.start-refused",
      message: host.error.message,
      state: currentState.state,
      details: host.error,
    });
  }
  if (
    options.requiredHost !== undefined &&
    !frozenHostEquals(
      freezeHostIdentity(options.requiredHost),
      host.host,
    )
  ) {
    return refused({
      code: options.kind === "stop"
        ? "dev.stop-refused"
        : options.kind === "restart"
          ? "dev.restart-refused"
          : options.kind === "ensure"
            ? "dev.ensure-refused"
            : "dev.start-refused",
      message:
        "Canonical host identity drifted after the active operation freeze.",
      state: currentState.state,
      details: {
        code: "compatibility.drifted",
        activeOperationAborted: true,
        reconnectAttempted: false,
      },
    });
  }
  const frozenHost = freezeHostIdentity(host.host);
  const contract = await loadPhase0LaunchContract({
    adapters: hostAdapters,
    path: selection.layout.phase0ContractPath,
  });
  const gate = gateDevelopmentLifecycleMutation({
    operation: mutationFor(options.kind),
    contract,
    expectedHost: frozenHost,
  });
  if (!gate.allowed) {
    return refused({
      code: options.kind === "stop"
        ? "dev.stop-refused"
        : options.kind === "restart"
          ? "dev.restart-refused"
          : options.kind === "ensure"
            ? "dev.ensure-refused"
            : "dev.start-refused",
      message: gate.error.message,
      state: currentState.state,
      details: gate.error,
    });
  }
  const [persistedCompatibility, resolvedSdkRuntime] = await Promise.all([
    loadCompatibilityRecord({
      adapters: hostAdapters,
      explodexHome,
    }),
    resolveSdkRuntimeIdentityForCli(),
  ]);
  const sdkRuntime = options.sdkRuntime ?? resolvedSdkRuntime;
  const compatibility = evaluateCompatibility({
    host: host.host,
    sdkRuntime,
    persisted: persistedCompatibility,
  });
  if (
    (
      options.kind === "start" ||
      options.kind === "ensure" ||
      options.kind === "restart"
    ) &&
    !compatibility.allowsCompatibilityDependentWork
  ) {
    return refused({
      code: options.kind === "ensure"
        ? "dev.ensure-refused"
        : options.kind === "restart"
          ? "dev.restart-refused"
          : "dev.start-refused",
      message:
        `Exact current compatibility proof is required before development launch: ${compatibility.reason ?? "unproven"}.`,
      state: currentState.state,
      details: compatibility,
    });
  }

  if (
    currentState.status === "absent" &&
    (options.kind === "start" || options.kind === "ensure")
  ) {
    const layout = await ensureDefaultDevLayout({
      fs: hostAdapters.fs,
      rootPath: selection.rootPath,
      protectedPaths: {
        mainProfilePath: protectedSet.mainProfilePaths?.[0],
        userCodexHome: protectedSet.userCodexHome,
        explodexHome,
      },
    });
    if (!layout.ok) {
      return refused({
        code: options.kind === "ensure"
          ? "dev.ensure-refused"
          : "dev.start-refused",
        message: layout.error.message,
        details: layout.error,
      });
    }
  }

  const operationId = `${operationFor(options.kind)}-${randomUUID()}`;
  const outer = await withDevInstanceLock({
    rootPath: selection.rootPath,
    operation: operationFor(options.kind),
    operationId,
    waitBoundMs: Math.min(options.timeoutMs, 2_000),
    signal: options.signal,
    runtimeAdapters: runtime,
    work: async () => {
      const loaded = await loadDevInstanceStateResult({
        adapters: hostAdapters,
        statePath: selection.layout.statePath,
      });
      if (
        loaded.status === "absent" &&
        (options.kind === "start" || options.kind === "ensure")
      ) {
        const initial = createInitialDevInstanceState({
          layout: selection.layout,
          appPath: frozenHost.bundlePath,
          executablePath: frozenHost.executablePath,
          launchMarker: gate.contract.launchMarker!.value,
          frozenHost,
          updatedAt: runtime.clock.nowIso(),
        });
        initial.appVersion = frozenHost.appVersion;
        initial.appBuild = frozenHost.appBuild;
        await saveDevInstanceState({
          adapters: hostAdapters,
          statePath: selection.layout.statePath,
          state: initial,
        });
      } else if (
        loaded.status === "valid" &&
        loaded.state.status === "stopped" &&
        (options.kind === "start" || options.kind === "ensure") &&
        (
          loaded.state.appPath !== frozenHost.bundlePath ||
          loaded.state.executablePath !== frozenHost.executablePath ||
          loaded.state.appVersion !== frozenHost.appVersion ||
          loaded.state.appBuild !== frozenHost.appBuild ||
          loaded.state.frozenHost === null ||
          !frozenHostEquals(loaded.state.frozenHost, frozenHost) ||
          loaded.state.launchMarker !== gate.contract.launchMarker!.value
        )
      ) {
        await saveDevInstanceState({
          adapters: hostAdapters,
          statePath: selection.layout.statePath,
          state: {
            ...loaded.state,
            appPath: frozenHost.bundlePath,
            executablePath: frozenHost.executablePath,
            launchMarker: gate.contract.launchMarker!.value,
            appVersion: frozenHost.appVersion,
            appBuild: frozenHost.appBuild,
            frozenHost,
            updatedAt: runtime.clock.nowIso(),
          },
        });
      }

      const explicitRoot = selection.explicit ? selection.rootPath : null;
      const readStatus = () => inspectDevInstanceStatus({
        osHome: options.osHome,
        explodexHome,
        explicitRoot,
        operation: options.kind,
        signal: options.signal,
        hostAdapters,
        statusAdapters,
        cdp,
      });
      const saveState = (state: DevInstanceState) => saveDevInstanceState({
        adapters: hostAdapters,
        statePath: selection.layout.statePath,
        state,
      });
      const terminate = createProductionDevTermination({
        kind: options.kind,
        osHome: options.osHome,
        explodexHome,
        explicitRoot,
        hostAdapters,
        statusAdapters,
        runtime,
        commands,
        cdp,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      const launch = createProductionDevLaunch({
        hostAdapters,
        runtime,
        statusAdapters,
        cdp,
        spawn,
        contract: gate.contract,
        frozenHost,
        layout: selection.layout,
        explodexHome,
        logsPath: selection.layout.logsPath,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      const common = {
        rootPath: selection.rootPath,
        readStatus,
        saveState,
        runtimeAdapters: runtime,
        waitBoundMs: Math.min(options.timeoutMs, 2_000),
        signal: options.signal,
        operationId,
        lockAlreadyHeld: true,
      };
      let transition: DevLifecycleResult;
      switch (options.kind) {
        case "start":
          transition = await startDevInstance({
            ...common,
            launch,
            terminate,
          });
          break;
        case "ensure":
          transition = await ensureDevInstance({
            ...common,
            launch,
            terminate,
          });
          break;
        case "restart":
          transition = await restartDevInstance({
            ...common,
            launch,
            terminate,
          });
          break;
        case "stop":
          transition = await stopDevInstance({
            ...common,
            terminate,
          });
          break;
      }
      if (transition.ok) {
        await options.afterLockedTransition?.(transition);
      }
      return transition;
    },
  });
  if (!outer.ok) {
    return refused({
      code: outer.code,
      message: outer.message,
      details: outer.details,
    });
  }
  return outer.value;
}
