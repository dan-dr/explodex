import { join, sep } from "node:path";
import { createNodeCdpAdapter, type CdpAdapter } from "../cdp/adapters.ts";
import { inspectCompatibleEndpoint } from "../cdp/endpoint.ts";
import type { EndpointInspectionResult } from "../cdp/types.ts";
import {
  createDefaultHostAdapters,
  type HostAdapters,
} from "../host/adapters.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { inspectHost } from "../host/identity.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import {
  roleEndpoint,
  type HostStatusAdapters,
  type ListenerObservation,
  type ProcessObservation,
  type VerifiedProcess,
} from "../host/status.ts";
import type { HostIdentity } from "../host/types.ts";
import type { SdkRuntimeIdentity } from "../host/types.ts";
import type { ProcessIdentity, RuntimeAdapters } from "../runtime/adapters.ts";
import { DEV_CDP_PORT } from "./constants.ts";
import {
  loadDevInstanceStateResult,
  saveDevInstanceState,
} from "./state.ts";
import {
  loadPhase0LaunchContract,
} from "./phase0.ts";
import {
  canonicalizeDevRootSelection,
  canonicalizePathForCreation,
  resolveDevRootSelection,
  validateDevRootSelection,
  type DevRootProtectedPaths,
  type DevRootSelection,
} from "./root-selection.ts";
import {
  evaluateDevOwnership,
  recoverDevInstance,
  type DevCompatibilityEvidence,
  type DevOwnershipEvidence,
  type DevOwnershipOperation,
  type DevPathEvidence,
  type DevRecoverFailure,
  type DevRecoverSuccess,
  type DevStatusSnapshot,
  type DevTerminationResult,
} from "./workflow.ts";
import { classifyOwnedListenerAuthority } from "./listener-authority.ts";

export type DevStatusOperationOptions = {
  osHome: string;
  explodexHome?: string;
  explicitRoot?: string | null;
  operation?: DevOwnershipOperation;
  signal?: AbortSignal;
  hostAdapters?: HostAdapters;
  statusAdapters?: HostStatusAdapters;
  cdp?: CdpAdapter;
  sdkRuntime?: SdkRuntimeIdentity;
};

function normalized(path: string): string {
  return path.length > 1 && path.endsWith(sep)
    ? path.slice(0, -1)
    : path;
}

async function defaultProtectedPaths(
  adapters: HostAdapters,
  osHome: string,
  explodexHome: string,
): Promise<DevRootProtectedPaths> {
  const [chatGptProfile, codexProfile, userCodexHome] = await Promise.all([
    canonicalizePathForCreation(
      adapters.fs,
      join(osHome, "Library", "Application Support", "ChatGPT"),
    ),
    canonicalizePathForCreation(
      adapters.fs,
      join(osHome, "Library", "Application Support", "Codex"),
    ),
    canonicalizePathForCreation(adapters.fs, join(osHome, ".codex")),
  ]);
  return {
    mainProfilePaths: [
      chatGptProfile.path,
      codexProfile.path,
    ],
    userCodexHome: userCodexHome.path,
    explodexHome,
  };
}

async function pathEvidence(options: {
  adapters: HostAdapters;
  selection: DevRootSelection;
  state: DevStatusSnapshot["state"];
  protectedPaths: DevRootProtectedPaths;
}): Promise<DevPathEvidence> {
  const failures: string[] = [];
  const rootStat = await options.adapters.fs.stat(options.selection.rootPath);
  if (rootStat.kind === "symlink") failures.push("root_symlink");
  if (rootStat.kind === "file" || rootStat.kind === "other") {
    failures.push("root_not_directory");
  }

  let canonicalRoot: string | null = null;
  if (rootStat.kind === "directory") {
    try {
      canonicalRoot = normalized(
        await options.adapters.fs.realpath(options.selection.rootPath),
      );
      if (canonicalRoot !== options.selection.rootPath) {
        failures.push("root_alias");
      }
    } catch {
      failures.push("root_realpath_failed");
    }
  } else if (rootStat.kind === "missing") {
    canonicalRoot = options.selection.rootPath;
  }

  const state = options.state;
  if (state !== null) {
    const expected = options.selection.layout;
    const recorded = [
      ["electron-user-data", state.electronUserDataPath, expected.electronUserDataPath],
      ["codex-home", state.codexHomePath, expected.codexHomePath],
      ["explodex-state", state.explodexStatePath, expected.explodexStatePath],
      ["logs", state.logsPath, expected.logsPath],
    ] as const;
    for (const [name, actual, expectedPath] of recorded) {
      if (actual !== expectedPath) failures.push(`${name}_layout_mismatch`);
      const stat = await options.adapters.fs.stat(actual);
      if (stat.kind !== "directory") {
        failures.push(`${name}_missing_or_not_directory`);
        continue;
      }
      if (stat.mode !== undefined && (stat.mode & 0o077) !== 0) {
        failures.push(`${name}_not_private`);
      }
      try {
        const real = normalized(await options.adapters.fs.realpath(actual));
        if (
          canonicalRoot === null ||
          !(real === canonicalRoot || real.startsWith(`${canonicalRoot}${sep}`))
        ) {
          failures.push(`${name}_escape`);
        }
      } catch {
        failures.push(`${name}_realpath_failed`);
      }
    }
  }

  const rootValidation = await validateDevRootSelection({
    fs: options.adapters.fs,
    selection: options.selection,
    existingState: state,
    stateLoadStatus: state === null ? "absent" : "valid",
    protectedPaths: options.protectedPaths,
  });
  if (!rootValidation.ok) failures.push(rootValidation.code);

  return {
    ok: failures.length === 0,
    canonicalRoot,
    failures,
  };
}

async function verifiedProcesses(options: {
  adapters: HostStatusAdapters;
  signal?: AbortSignal;
}): Promise<{
  raw: ProcessObservation[];
  verified: Array<ProcessObservation & ProcessIdentity>;
}> {
  const raw = await options.adapters.process.list({ signal: options.signal });
  const verified: Array<ProcessObservation & ProcessIdentity> = [];
  for (const process of raw) {
    const identity = await options.adapters.process.identify(process.pid, {
      signal: options.signal,
    });
    if (identity?.pid === process.pid) {
      verified.push({ ...process, ...identity });
    }
  }
  return { raw, verified };
}

async function listeners(options: {
  adapters: HostStatusAdapters;
  signal?: AbortSignal;
}): Promise<ListenerObservation[]> {
  const raw = await options.adapters.port.listenersFor(DEV_CDP_PORT, {
    signal: options.signal,
  });
  const result: ListenerObservation[] = [];
  for (const listener of raw) {
    const identity = await options.adapters.process.identify(listener.pid, {
      signal: options.signal,
    });
    result.push({
      ...listener,
      processStartedAt: identity?.pid === listener.pid
        ? identity.processStartedAt
        : null,
    });
  }
  return result;
}

function findRecordedProcess(
  state: DevStatusSnapshot["state"],
  processes: Array<ProcessObservation & ProcessIdentity>,
): (ProcessObservation & ProcessIdentity) | null {
  if (state?.pid === null || state?.pid === undefined) return null;
  return processes.find((process) => process.pid === state.pid) ?? null;
}

function asVerifiedProcess(
  process: ProcessObservation & ProcessIdentity,
): VerifiedProcess {
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    executablePath: process.executablePath,
    arguments: [...process.arguments],
    processStartedAt: process.processStartedAt,
  };
}

async function safeEndpointInspection(options: {
  state: DevStatusSnapshot["state"];
  process: (ProcessObservation & ProcessIdentity) | null;
  listeners: ListenerObservation[];
  operationOwnedCompanionPids: readonly number[];
  host: HostIdentity | null;
  cdp: CdpAdapter;
  signal?: AbortSignal;
}): Promise<EndpointInspectionResult | null> {
  const state = options.state;
  const process = options.process;
  if (
    state === null ||
    state.pid === null ||
    state.processStartedAt === null ||
    process === null ||
    process.processStartedAt !== state.processStartedAt ||
    process.executablePath !== state.executablePath ||
    options.host === null
  ) {
    return null;
  }
  const exact = options.listeners.filter((listener) =>
    listener.pid === state.pid &&
    listener.processStartedAt === state.processStartedAt &&
    listener.host === "127.0.0.1" &&
    listener.port === 9444
  );
  const companions = new Set(options.operationOwnedCompanionPids);
  if (
    exact.length !== 1 ||
    options.listeners.some((listener) =>
      listener.pid !== state.pid && !companions.has(listener.pid)
    )
  ) return null;
  return inspectCompatibleEndpoint({
    role: "development",
    endpoint: roleEndpoint("development"),
    process: asVerifiedProcess(process),
    host: options.host,
    cdp: options.cdp,
    signal: options.signal,
  });
}

async function compatibilityEvidence(options: {
  adapters: HostAdapters;
  explodexHome: string;
  host: HostIdentity | null;
  process: (ProcessObservation & ProcessIdentity) | null;
  sdkRuntime?: SdkRuntimeIdentity;
}): Promise<DevCompatibilityEvidence> {
  if (options.host === null) {
    return { status: "unproven", matched: false, reason: "host_invalid" };
  }
  const [persisted, resolvedSdkRuntime] = await Promise.all([
    loadCompatibilityRecord({
      adapters: options.adapters,
      explodexHome: options.explodexHome,
    }),
    resolveSdkRuntimeIdentityForCli(),
  ]);
  const sdkRuntime = options.sdkRuntime ?? resolvedSdkRuntime;
  const report = evaluateCompatibility({
    host: options.host,
    sdkRuntime,
    persisted,
    runningProcess: options.process === null
      ? null
      : {
          executablePath: options.process.executablePath,
          appVersion: options.host.appVersion,
          appBuild: options.host.appBuild,
        },
  });
  return {
    status: report.status,
    matched: report.matched,
    reason: report.reason,
  };
}

/**
 * Read-only development status. It inventories only the requested root and exact
 * declared 9444 endpoint, and never promotes or rewrites state.
 */
export async function inspectDevInstanceStatus(
  options: DevStatusOperationOptions,
): Promise<DevStatusSnapshot> {
  const hostAdapters = options.hostAdapters ?? await createDefaultHostAdapters();
  const statusAdapters =
    options.statusAdapters ?? await createDefaultHostStatusAdapters();
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const selection = await canonicalizeDevRootSelection({
    fs: hostAdapters.fs,
    selection: resolveDevRootSelection({
      osHome: options.osHome,
      explodexHome: options.explodexHome,
      explicitRoot: options.explicitRoot,
    }),
  });
  const protectedPaths = await defaultProtectedPaths(
    hostAdapters,
    options.osHome,
    selection.explodexHome,
  );
  const stateLoad = await loadDevInstanceStateResult({
    adapters: hostAdapters,
    statePath: selection.layout.statePath,
  });
  const state = stateLoad.state;
  const [
    hostInspection,
    processInventory,
    observedListeners,
    phase0,
    paths,
  ] = await Promise.all([
    inspectHost({ adapters: hostAdapters, signal: options.signal }),
    verifiedProcesses({ adapters: statusAdapters, signal: options.signal }),
    listeners({ adapters: statusAdapters, signal: options.signal }),
    loadPhase0LaunchContract({
      adapters: hostAdapters,
      path: selection.layout.phase0ContractPath,
    }),
    pathEvidence({
      adapters: hostAdapters,
      selection,
      state,
      protectedPaths,
    }),
  ]);
  const host = hostInspection.ok ? hostInspection.host : null;
  const process = findRecordedProcess(state, processInventory.verified);
  const currentPidIdentity = state?.pid === null || state?.pid === undefined
    ? null
    : await statusAdapters.process.identify(state.pid, {
        signal: options.signal,
      });
  const listenerAuthority =
    state?.pid === null ||
      state?.pid === undefined ||
      state.processStartedAt === null
      ? null
      : classifyOwnedListenerAuthority({
          rootPid: state.pid,
          rootProcessStartedAt: state.processStartedAt,
          listeners: observedListeners,
          processes: processInventory.verified,
          privateRoots: [
            state.electronUserDataPath,
            state.codexHomePath,
            state.explodexStatePath,
          ],
        });
  const companionPids = listenerAuthority?.companionPids ?? [];
  const endpoint = await safeEndpointInspection({
    state,
    process,
    listeners: observedListeners,
    operationOwnedCompanionPids: companionPids,
    host,
    cdp,
    signal: options.signal,
  });
  const compatibility = await compatibilityEvidence({
    adapters: hostAdapters,
    explodexHome: selection.explodexHome,
    host,
    process,
    sdkRuntime: options.sdkRuntime,
  });
  const evidence: DevOwnershipEvidence = {
    requestedRoot: selection.rootPath,
    stateLoadStatus: stateLoad.status,
    state,
    currentHost: host,
    phase0: phase0 === null
      ? {
          status: "missing",
          frozenHost: null,
          markerValue: null,
        }
      : {
          status: phase0.status,
          frozenHost: phase0.frozenHost,
          markerValue: phase0.launchMarker?.value ?? null,
        },
    process,
    currentPidIdentity,
    paths,
    listeners: observedListeners,
    operationOwnedCompanionPids: companionPids,
    endpoint,
    compatibility,
    protectedMainOverlap:
      state?.electronUserDataPath !== undefined &&
      (protectedPaths.mainProfilePaths ?? []).includes(
        state.electronUserDataPath,
      ),
  };
  return {
    rootPath: selection.rootPath,
    stateLoadStatus: stateLoad.status,
    state,
    assessment: evaluateDevOwnership({
      operation: options.operation ?? "status",
      evidence,
    }),
    readOnly: true,
    activity: {
      launched: false,
      signaled: false,
      evaluated: false,
      wroteState: false,
      fellBack: false,
    },
  };
}

export async function recoverDevInstanceFromSystem(options: {
  osHome: string;
  explodexHome?: string;
  explicitRoot?: string | null;
  waitBoundMs?: number;
  signal?: AbortSignal;
  runtimeAdapters?: RuntimeAdapters;
  terminate: (snapshot: DevStatusSnapshot) => Promise<DevTerminationResult>;
}): Promise<DevRecoverSuccess | DevRecoverFailure> {
  const hostAdapters = await createDefaultHostAdapters();
  const selection = await canonicalizeDevRootSelection({
    fs: hostAdapters.fs,
    selection: resolveDevRootSelection({
      osHome: options.osHome,
      explodexHome: options.explodexHome,
      explicitRoot: options.explicitRoot,
    }),
  });
  const preflight = await inspectDevInstanceStatus({
    osHome: options.osHome,
    explodexHome: selection.explodexHome,
    explicitRoot: selection.explicit ? selection.rootPath : null,
    operation: "recover",
    signal: options.signal,
    hostAdapters,
  });
  if (
    preflight.stateLoadStatus !== "valid" ||
    preflight.state === null ||
    !(
      preflight.state.status === "stale" ||
      preflight.state.status === "failed" ||
      preflight.state.status === "starting" ||
      preflight.state.status === "stopping"
    )
  ) {
    return {
      ok: false,
      code: preflight.assessment.failures.some(
          (failure) => failure.code === "path_alias",
        )
        ? "dev.ownership-uncertain"
        : "dev.recovery-required",
      message:
        preflight.assessment.failures.find(
          (failure) => failure.code === "path_alias",
        )?.message ??
        "Recovery requires a valid stale, failed, starting, or stopping record.",
      snapshot: preflight,
    };
  }
  return recoverDevInstance({
    rootPath: selection.rootPath,
    waitBoundMs: options.waitBoundMs,
    signal: options.signal,
    runtimeAdapters: options.runtimeAdapters,
    readStatus: () => inspectDevInstanceStatus({
      osHome: options.osHome,
      explodexHome: selection.explodexHome,
      explicitRoot: selection.explicit ? selection.rootPath : null,
      operation: "recover",
      signal: options.signal,
      hostAdapters,
    }),
    saveState: (state) => saveDevInstanceState({
      adapters: hostAdapters,
      statePath: selection.layout.statePath,
      state,
    }),
    terminate: options.terminate,
  });
}
