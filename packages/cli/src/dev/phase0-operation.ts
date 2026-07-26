/**
 * Authorized live Phase 0 launch-isolation operation (M1-F04R).
 *
 * Serializes proof mutation under the accepted bounded advisory-lock runtime,
 * writes an incomplete/non-authorizing contract before the first spawn, runs
 * factual comparative experiments for each candidate knob with fresh private
 * roots, requires complete readiness and pure ownership classifier evidence,
 * and commits proven authority only after exact cleanup and protected-main
 * survival succeed. Obsolete schema-1 proofs cannot authorize mutation.
 */

import { join } from "node:path";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import type { CdpAdapter } from "../cdp/adapters.ts";
import { selectExactPageAndContext } from "../cdp/target-selection.ts";
import type { HostAdapters } from "../host/adapters.ts";
import { inspectCanonicalHost } from "../host/identity.ts";
import {
  createNodePortInventoryAdapter,
  createNodeProcessInventoryAdapter,
  createNodeReadOnlyCommandRunner,
  type ReadOnlyCommandRunner,
} from "../host/process-adapters.ts";
import type { ProcessObservation } from "../host/status.ts";
import {
  createDefaultRuntimeAdapters,
  createNodeRuntimeProcess,
  type RuntimeAdapters,
  type RuntimeProcess,
} from "../runtime/adapters.ts";
import { withOperationLock } from "../runtime/locks.ts";
import type { OperationIdentity } from "../runtime/types.ts";
import {
  DEFAULT_DEV_INSTANCE_ID,
  DEV_CDP_HOST,
  DEV_CDP_PORT,
  PHASE0_CANDIDATE_KNOBS,
  type Phase0CandidateKnob,
} from "./constants.ts";
import {
  describeDevLayout,
  ensureDefaultDevLayout,
  ownershipFromLayoutOnly,
  resolveDefaultDevRoot,
  type ProtectedPathSet,
} from "./layout.ts";
import {
  createNodeLaunchSpawnAdapter,
  type LaunchSpawnAdapter,
  type SpawnedProcess,
} from "./launch-adapters.ts";
import {
  classifyDevelopmentOwnership,
  controlledOwnershipNegatives,
  type OwnershipExpected,
} from "./ownership.ts";
import {
  createPreSpawnIncompleteContract,
  deriveKnobVerdictFromExperiment,
  evaluatePhase0LaunchContract,
  freezeHostIdentity,
  frozenHostEquals,
  savePhase0LaunchContract,
} from "./phase0.ts";
import { createInitialDevInstanceState, saveDevInstanceState } from "./state.ts";
import type {
  DevLayoutPaths,
  LaunchMarkerContract,
  Phase0ComparativeExperiment,
  Phase0ExperimentSideObservation,
  Phase0FrozenHost,
  Phase0OperationProcessEvidence,
  Phase0OperationResult,
  Phase0OwnershipEvidence,
  Phase0ReadinessEvidence,
  SanitizedLaunchDescriptor,
} from "./types.ts";

export const DEFAULT_PHASE0_LAUNCH_MARKER = `--explodex-dev-instance=${DEFAULT_DEV_INSTANCE_ID}`;

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;

export type Phase0LaunchPlan = {
  useUserData: boolean;
  useCodexHome: boolean;
  useExplodexHome: boolean;
  useCdpPort: boolean;
  useExactMarker: boolean;
  /** When true, inject a substring-only marker instead of the exact token. */
  useSubstringMarker?: boolean;
};

export type Phase0OperationOptions = {
  adapters: HostAdapters;
  runtimeProcess?: RuntimeProcess;
  runtimeAdapters?: RuntimeAdapters;
  commands?: ReadOnlyCommandRunner;
  cdp?: CdpAdapter;
  spawn?: LaunchSpawnAdapter;
  /** OS home used to resolve the default ~/.explodex/dev/plugin-dev root. */
  osHome?: string;
  /** Explicit absolute development root; defaults to the canonical plugin-dev path. */
  rootPath?: string;
  protectedPaths?: ProtectedPathSet;
  readinessTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
  lockWaitMs?: number;
  /** When true, leave the isolated process running after a proven contract. Default false. */
  keepProcessAlive?: boolean;
  signal?: AbortSignal;
  /**
   * Optional override for comparative experiment plans (tests).
   * When omitted, the production matrix varies each candidate knob independently.
   */
  experimentPlans?: Array<{
    knob: Phase0CandidateKnob;
    treatment: Phase0LaunchPlan;
    control: Phase0LaunchPlan | null;
  }>;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Phase 0 aborted"), { code: "ABORT_ERR" }));
      return;
    }
    const handle = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      globalThis.clearTimeout(handle);
      reject(Object.assign(new Error("Phase 0 aborted"), { code: "ABORT_ERR" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultProtectedPaths(osHome: string): ProtectedPathSet {
  return {
    mainProfilePath: join(osHome, "Library", "Application Support", "Codex"),
    userCodexHome: join(osHome, ".codex"),
    explodexHome: join(osHome, ".explodex"),
  };
}

function disabledResult(
  message: string,
  code: string,
  frozenHost: Phase0FrozenHost | null = null,
): Phase0OperationResult {
  return {
    ok: false,
    contract: {
      schemaVersion: 2,
      status: frozenHost === null ? "disabled" : "incomplete",
      frozenHost,
      appBuild: frozenHost?.appBuild ?? "unknown",
      appVersion: frozenHost?.appVersion ?? null,
      retainedKnobs: [],
      knobMatrix: [],
      comparativeExperiments: [],
      launchMarker: null,
      isolation: {
        electronUserDataPath: null,
        codexHomePath: null,
        explodexHomePath: null,
        cdpHost: DEV_CDP_HOST,
        cdpPort: DEV_CDP_PORT,
      },
      readiness: null,
      ownership: null,
      sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
      provenAt: null,
      reason: message,
    },
    allowsLifecycleMutation: false,
    allowsCompatibilityProbe: false,
    layout: null,
    frozenHost,
    process: null,
    protectedMainSurvived: true,
    grantsOwnershipFromPathsOnly: false,
    error: { code, message },
  };
}

function buildPlanForRoot(options: {
  frozenHost: Phase0FrozenHost;
  layout: DevLayoutPaths;
  marker: LaunchMarkerContract;
  plan: Phase0LaunchPlan;
}): {
  executablePath: string;
  argv: string[];
  env: Record<string, string | undefined>;
  descriptor: SanitizedLaunchDescriptor;
} {
  const argv: string[] = [];
  const envKeys: string[] = [];
  const env: Record<string, string | undefined> = {};

  if (options.plan.useUserData) {
    argv.push(`--user-data-dir=${options.layout.electronUserDataPath}`);
    env.CODEX_ELECTRON_USER_DATA_PATH = options.layout.electronUserDataPath;
    envKeys.push("CODEX_ELECTRON_USER_DATA_PATH");
  }
  if (options.plan.useCdpPort) {
    argv.push(`--remote-debugging-port=${DEV_CDP_PORT}`);
  }
  if (options.plan.useExactMarker) {
    argv.push(options.marker.value);
  } else if (options.plan.useSubstringMarker) {
    argv.push(`prefix-${options.marker.value}-suffix`);
  }
  if (options.plan.useCodexHome) {
    env.CODEX_HOME = options.layout.codexHomePath;
    envKeys.push("CODEX_HOME");
  }
  if (options.plan.useExplodexHome) {
    env.EXPLODEX_HOME = options.layout.explodexStatePath;
    envKeys.push("EXPLODEX_HOME");
  }

  return {
    executablePath: options.frozenHost.executablePath,
    argv,
    env,
    descriptor: {
      argv: [options.frozenHost.executablePath, ...argv],
      envKeys,
    },
  };
}

async function waitForExactDevProcess(options: {
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  executablePath: string;
  marker: string | null;
  expectedPid?: number;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<{ process: ProcessObservation; processStartedAt: string } | null> {
  const inventory = createNodeProcessInventoryAdapter({
    commands: options.commands,
    exactProcess: options.runtimeProcess,
  });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw Object.assign(new Error("Phase 0 aborted"), { code: "ABORT_ERR" });
    }
    const processes = await inventory.list({ signal: options.signal });
    const matches = processes.filter((entry) => {
      if (entry.executablePath !== options.executablePath) return false;
      if (options.expectedPid !== undefined && entry.pid !== options.expectedPid) return false;
      if (options.marker !== null) {
        return entry.arguments.some((token) => token === options.marker);
      }
      return true;
    });
    if (matches.length === 1) {
      const process = matches[0]!;
      const identity = await options.runtimeProcess.identify(process.pid, {
        abortSignal: options.signal,
      });
      if (identity !== null) {
        return { process, processStartedAt: identity.processStartedAt };
      }
    }
    await sleep(options.pollMs, options.signal);
  }
  return null;
}

async function waitForPortOwner(options: {
  commands: ReadOnlyCommandRunner;
  expectedPid: number;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<number | null> {
  const ports = createNodePortInventoryAdapter(options.commands);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw Object.assign(new Error("Phase 0 aborted"), { code: "ABORT_ERR" });
    }
    const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
    const loopback = listeners.filter(
      (entry) =>
        entry.port === DEV_CDP_PORT &&
        (entry.host === DEV_CDP_HOST || entry.host === "localhost" || entry.host === "::1"),
    );
    if (loopback.some((entry) => entry.pid === options.expectedPid)) {
      return options.expectedPid;
    }
    if (loopback.length > 0) {
      return loopback[0]!.pid;
    }
    await sleep(options.pollMs, options.signal);
  }
  return null;
}

async function collectReadiness(options: {
  cdp: CdpAdapter;
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  frozenHost: Phase0FrozenHost;
  pid: number;
  processStartedAt: string;
  argumentsList: readonly string[];
  marker: string;
  /** When false, skip CDP/port waits (control launches that omit the port). */
  expectCdp?: boolean;
  portTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  process: Phase0OperationProcessEvidence;
  readiness: Phase0ReadinessEvidence | null;
  ownership: ReturnType<typeof classifyDevelopmentOwnership>;
}> {
  const expectCdp = options.expectCdp !== false;
  const portOwner = expectCdp
    ? await waitForPortOwner({
        commands: options.commands,
        expectedPid: options.pid,
        timeoutMs: options.portTimeoutMs ?? 15_000,
        pollMs: 50,
        signal: options.signal,
      })
    : null;

  let browserIdentity: string | null = null;
  let targetId: string | null = null;
  let executionContextId: number | null = null;
  let executionContextUniqueId: string | null = null;
  let frameId: string | null = null;

  if (expectCdp) {
    // Port ownership can precede the exact app:// page and default context.
    // Poll until complete readiness or the remaining bound expires.
    const readinessDeadline = Date.now() + (options.portTimeoutMs ?? 15_000);
    while (Date.now() < readinessDeadline) {
      if (options.signal?.aborted) {
        throw Object.assign(new Error("Phase 0 aborted"), { code: "ABORT_ERR" });
      }
      try {
        const version = await options.cdp.readEndpoint({
          host: DEV_CDP_HOST,
          port: DEV_CDP_PORT,
          signal: options.signal,
        });
        browserIdentity = version.browser;
        const targets = await options.cdp.listTargets({
          host: DEV_CDP_HOST,
          port: DEV_CDP_PORT,
          signal: options.signal,
        });
        const pages = targets.filter(
          (target) => target.type === "page" && target.url === "app://-/index.html",
        );
        if (pages.length === 1) {
          const target = pages[0]!;
          targetId = target.id;
          try {
            const session = await options.cdp.openTargetSession({
              host: DEV_CDP_HOST,
              port: DEV_CDP_PORT,
              target,
              signal: options.signal,
            });
            try {
              const contexts = await session.listExecutionContexts({
                signal: options.signal,
              });
              const selection = selectExactPageAndContext({
                targets,
                contextsByTarget: { [target.id]: contexts },
              });
              if (selection.kind === "selected") {
                executionContextId = selection.context.id;
                executionContextUniqueId = selection.context.uniqueId;
                frameId = selection.context.frameId;
                break;
              }
            } finally {
              await session.close({ timeoutMs: 2_000 });
            }
          } catch {
            // Context collection failure: keep polling while bound remains.
          }
        } else {
          targetId = null;
        }
      } catch {
        // Endpoint not ready yet.
      }
      await sleep(250, options.signal);
    }
  }

  const expected: OwnershipExpected = {
    marker: options.marker,
    executablePath: options.frozenHost.executablePath,
    cdpHost: DEV_CDP_HOST,
    cdpPort: DEV_CDP_PORT,
    expectedPid: options.pid,
    expectedProcessStartedAt: options.processStartedAt,
  };

  const ownership = classifyDevelopmentOwnership({
    role: "development",
    pid: options.pid,
    processStartedAt: options.processStartedAt,
    executablePath: options.frozenHost.executablePath,
    arguments: options.argumentsList,
    portOwnerPid: portOwner,
    port: DEV_CDP_PORT,
    endpointHost: DEV_CDP_HOST,
    browserIdentity,
    targetIds: targetId === null ? [] : [targetId],
    defaultExecutionContextCount:
      executionContextId === null ? 0 : 1,
    expected,
  });

  const complete =
    ownership.owned &&
    browserIdentity !== null &&
    targetId !== null &&
    executionContextId !== null &&
    executionContextUniqueId !== null &&
    frameId !== null &&
    portOwner === options.pid;

  const processEvidence: Phase0OperationProcessEvidence = {
    pid: options.pid,
    processStartedAt: options.processStartedAt,
    executablePath: options.frozenHost.executablePath,
    arguments: [...options.argumentsList],
    env: {},
    portOwnerPid: portOwner,
    browserIdentity,
    targetId,
    executionContextId,
    executionContextUniqueId,
    frameId,
    readiness: complete ? "benign" : "incomplete",
  };

  const readiness: Phase0ReadinessEvidence | null = complete
    ? {
        pid: options.pid,
        processStartedAt: options.processStartedAt,
        executablePath: options.frozenHost.executablePath,
        portOwnerPid: options.pid,
        cdpHost: DEV_CDP_HOST,
        cdpPort: DEV_CDP_PORT,
        browserIdentity: browserIdentity!,
        targetId: targetId!,
        targetUrl: "app://-/index.html",
        executionContextId: executionContextId!,
        executionContextUniqueId: executionContextUniqueId!,
        frameId: frameId!,
        readiness: "benign",
      }
    : null;

  return { process: processEvidence, readiness, ownership };
}

async function browserCloseIfPossible(
  cdp: CdpAdapter,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const version = await cdp.readEndpoint({
      host: DEV_CDP_HOST,
      port: DEV_CDP_PORT,
      signal,
    });
    const url = version.webSocketDebuggerUrl;
    if (typeof url !== "string" || url.length === 0) return false;
    // Fixture/test endpoints that are not real sockets fail closed quickly.
    if (url.includes("/devtools/browser/test")) {
      return false;
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        socket.close();
        reject(Object.assign(new Error("Browser.close aborted"), { code: "ABORT_ERR" }));
      };
      const connectTimeout = globalThis.setTimeout(() => {
        cleanup();
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error("Browser.close connect timed out"));
      }, 1_500);
      const onOpen = (): void => {
        globalThis.clearTimeout(connectTimeout);
        cleanup();
        resolve();
      };
      const onError = (): void => {
        globalThis.clearTimeout(connectTimeout);
        cleanup();
        reject(new Error("Browser.close websocket failed"));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    await new Promise<void>((resolve, reject) => {
      const requestId = 1;
      const timeout = globalThis.setTimeout(() => {
        socket.close();
        reject(new Error("Browser.close timed out"));
      }, 5_000);
      const onMessage = (event: MessageEvent): void => {
        if (typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data) as { id?: number };
          if (parsed.id === requestId) {
            globalThis.clearTimeout(timeout);
            socket.removeEventListener("message", onMessage);
            socket.close();
            resolve();
          }
        } catch {
          // ignore
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id: requestId, method: "Browser.close" }));
    });
    return true;
  } catch {
    return false;
  }
}

async function revalidateCleanupAuthority(options: {
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  pid: number;
  processStartedAt: string;
  executablePath: string;
  marker: string;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const alive = await options.runtimeProcess.isAlive(
    options.pid,
    options.processStartedAt,
    { abortSignal: options.signal },
  );
  if (!alive) {
    return { ok: false, reason: "Process identity drifted before cleanup; preserve residual authority." };
  }
  const inventory = createNodeProcessInventoryAdapter({
    commands: options.commands,
    exactProcess: options.runtimeProcess,
  });
  const processes = await inventory.list({ signal: options.signal });
  const match = processes.find((entry) => entry.pid === options.pid);
  if (match === undefined) {
    return { ok: false, reason: "Launched process is no longer inventoriable before cleanup." };
  }
  if (match.executablePath !== options.executablePath) {
    return { ok: false, reason: "Executable identity drifted before cleanup." };
  }
  if (!match.arguments.some((token) => token === options.marker)) {
    return { ok: false, reason: "Exact marker no longer present before cleanup." };
  }
  const ports = createNodePortInventoryAdapter(options.commands);
  const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
  const owner = listeners.find(
    (entry) =>
      entry.port === DEV_CDP_PORT &&
      (entry.host === DEV_CDP_HOST || entry.host === "localhost" || entry.host === "::1"),
  );
  if (owner !== undefined && owner.pid !== options.pid) {
    return { ok: false, reason: "Port owner drifted before cleanup; refuse foreign Browser.close." };
  }
  return { ok: true };
}

async function stopExactProcess(options: {
  runtimeProcess: RuntimeProcess;
  commands: ReadOnlyCommandRunner;
  cdp: CdpAdapter;
  pid: number;
  processStartedAt: string;
  executablePath: string;
  marker: string;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<{ stopped: boolean; portReleased: boolean; uncertain: boolean; reason?: string }> {
  const authority = await revalidateCleanupAuthority({
    commands: options.commands,
    runtimeProcess: options.runtimeProcess,
    pid: options.pid,
    processStartedAt: options.processStartedAt,
    executablePath: options.executablePath,
    marker: options.marker,
    signal: options.signal,
  });
  if (!authority.ok) {
    return { stopped: false, portReleased: false, uncertain: true, reason: authority.reason };
  }

  await browserCloseIfPossible(options.cdp, options.signal);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const alive = await options.runtimeProcess.isAlive(
      options.pid,
      options.processStartedAt,
      { abortSignal: options.signal },
    );
    if (!alive) break;
    await sleep(options.pollMs, options.signal);
  }

  let stillAlive = await options.runtimeProcess.isAlive(
    options.pid,
    options.processStartedAt,
    { abortSignal: options.signal },
  );
  if (stillAlive) {
    const recheck = await revalidateCleanupAuthority({
      commands: options.commands,
      runtimeProcess: options.runtimeProcess,
      pid: options.pid,
      processStartedAt: options.processStartedAt,
      executablePath: options.executablePath,
      marker: options.marker,
      signal: options.signal,
    });
    if (!recheck.ok) {
      return { stopped: false, portReleased: false, uncertain: true, reason: recheck.reason };
    }
    await options.runtimeProcess.signalExact(
      { pid: options.pid, processStartedAt: options.processStartedAt },
      "SIGTERM",
      { abortSignal: options.signal },
    );
    const signalDeadline = Date.now() + options.timeoutMs;
    while (Date.now() < signalDeadline) {
      stillAlive = await options.runtimeProcess.isAlive(
        options.pid,
        options.processStartedAt,
        { abortSignal: options.signal },
      );
      if (!stillAlive) break;
      await sleep(options.pollMs, options.signal);
    }
  }

  stillAlive = await options.runtimeProcess.isAlive(
    options.pid,
    options.processStartedAt,
    { abortSignal: options.signal },
  );
  if (stillAlive) {
    return {
      stopped: false,
      portReleased: false,
      uncertain: true,
      reason: `Exact development PID ${options.pid} did not exit within the cleanup bound.`,
    };
  }

  const ports = createNodePortInventoryAdapter(options.commands);
  const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
  const stillOwned = listeners.some((entry) => entry.pid === options.pid);
  return {
    stopped: true,
    portReleased: !stillOwned,
    uncertain: false,
  };
}

function pathSeparationFor(
  layout: DevLayoutPaths,
  protectedPaths: ProtectedPathSet,
  osHome: string,
  plan: Phase0LaunchPlan,
): Phase0ExperimentSideObservation["pathSeparation"] {
  const mainProfile =
    protectedPaths.mainProfilePath ?? join(osHome, "Library", "Application Support", "Codex");
  const userCodex = protectedPaths.userCodexHome ?? join(osHome, ".codex");
  const explodexHome = protectedPaths.explodexHome ?? join(osHome, ".explodex");
  // Only knobs actually applied in this plan can demonstrate path separation.
  // Private instance state is intentionally under ~/.explodex/dev/plugin-dev; it
  // must not equal the Explodex home root or escape the instance root.
  return {
    userDataDistinctFromMain:
      plan.useUserData &&
      layout.electronUserDataPath !== mainProfile &&
      !layout.electronUserDataPath.startsWith(`${mainProfile}/`),
    codexHomeDistinctFromUserCodex:
      plan.useCodexHome &&
      layout.codexHomePath !== userCodex &&
      !layout.codexHomePath.startsWith(`${userCodex}/`),
    explodexStateDistinctFromMainHome:
      layout.explodexStatePath !== explodexHome &&
      layout.explodexStatePath.startsWith(`${layout.rootPath}/`),
    credentialsInspected: false,
  };
}

function sideFromFailure(descriptor: SanitizedLaunchDescriptor, privateRoot: string | null): Phase0ExperimentSideObservation {
  return {
    launched: false,
    privateRoot,
    descriptor,
    pid: null,
    processStartedAt: null,
    portOwnerPid: null,
    browserIdentity: null,
    targetId: null,
    executionContextId: null,
    exactMarkerPresent: false,
    ownershipAccepted: false,
  };
}

async function runOneExperimentLaunch(options: {
  adapters: HostAdapters;
  spawn: LaunchSpawnAdapter;
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  cdp: CdpAdapter;
  frozenHost: Phase0FrozenHost;
  privateRoot: string;
  protectedPaths: ProtectedPathSet;
  osHome: string;
  marker: LaunchMarkerContract;
  plan: Phase0LaunchPlan;
  readinessTimeoutMs: number;
  stopTimeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<{
  side: Phase0ExperimentSideObservation;
  process: Phase0OperationProcessEvidence | null;
  residualAuthority: boolean;
}> {
  const layoutResult = await ensureDefaultDevLayout({
    fs: options.adapters.fs,
    rootPath: options.privateRoot,
    protectedPaths: options.protectedPaths,
  });
  if (!layoutResult.ok) {
    const plan = buildPlanForRoot({
      frozenHost: options.frozenHost,
      layout: describeDevLayout(options.privateRoot),
      marker: options.marker,
      plan: options.plan,
    });
    return {
      side: sideFromFailure(plan.descriptor, options.privateRoot),
      process: null,
      residualAuthority: false,
    };
  }
  const layout = layoutResult.layout;
  const built = buildPlanForRoot({
    frozenHost: options.frozenHost,
    layout,
    marker: options.marker,
    plan: options.plan,
  });
  const logsStdout = join(layout.logsPath, "phase0-experiment.stdout.log");
  const logsStderr = join(layout.logsPath, "phase0-experiment.stderr.log");

  let spawned: SpawnedProcess | null = null;
  let processStartedAt: string | null = null;
  try {
    // Ensure port free for this experiment when using 9444.
    if (options.plan.useCdpPort) {
      const ports = createNodePortInventoryAdapter(options.commands);
      const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
      if (listeners.length > 0) {
        return {
          side: {
            ...sideFromFailure(built.descriptor, options.privateRoot),
            launched: false,
          },
          process: null,
          residualAuthority: false,
        };
      }
    }

    spawned = await options.spawn.spawn({
      executablePath: built.executablePath,
      argv: built.argv,
      env: built.env,
      stdoutPath: logsStdout,
      stderrPath: logsStderr,
    });

    const matched = await waitForExactDevProcess({
      commands: options.commands,
      runtimeProcess: options.runtimeProcess,
      executablePath: options.frozenHost.executablePath,
      marker: options.plan.useExactMarker ? options.marker.value : null,
      expectedPid: spawned.pid,
      timeoutMs: options.readinessTimeoutMs,
      pollMs: options.pollMs,
      signal: options.signal,
    });
    if (matched === null) {
      try {
        spawned.kill("SIGTERM");
      } catch {
        // ignore
      }
      return {
        side: sideFromFailure(built.descriptor, options.privateRoot),
        process: null,
        residualAuthority: false,
      };
    }
    processStartedAt = matched.processStartedAt;

    const collected = await collectReadiness({
      cdp: options.cdp,
      commands: options.commands,
      runtimeProcess: options.runtimeProcess,
      frozenHost: options.frozenHost,
      pid: matched.process.pid,
      processStartedAt: matched.processStartedAt,
      argumentsList: matched.process.arguments,
      marker: options.marker.value,
      expectCdp: options.plan.useCdpPort && options.plan.useExactMarker,
      portTimeoutMs: options.readinessTimeoutMs,
      signal: options.signal,
    });

    // Prefer exact SIGTERM for experiment cleanup; skip Browser.close when CDP was not claimed.
    let stop: { stopped: boolean; portReleased: boolean; uncertain: boolean; reason?: string };
    if (options.plan.useCdpPort && options.plan.useExactMarker && collected.ownership.owned) {
      stop = await stopExactProcess({
        runtimeProcess: options.runtimeProcess,
        commands: options.commands,
        cdp: options.cdp,
        pid: matched.process.pid,
        processStartedAt: matched.processStartedAt,
        executablePath: options.frozenHost.executablePath,
        marker: options.marker.value,
        timeoutMs: options.stopTimeoutMs,
        pollMs: options.pollMs,
        signal: options.signal,
      });
    } else {
      await options.runtimeProcess.signalExact(
        { pid: matched.process.pid, processStartedAt: matched.processStartedAt },
        "SIGTERM",
        { abortSignal: options.signal },
      );
      const alive = await options.runtimeProcess.isAlive(
        matched.process.pid,
        matched.processStartedAt,
        { abortSignal: options.signal },
      );
      stop = { stopped: !alive, portReleased: true, uncertain: alive };
    }

    const exactMarkerPresent = matched.process.arguments.some(
      (token) => token === options.marker.value,
    );
    const side: Phase0ExperimentSideObservation = {
      launched: true,
      privateRoot: options.privateRoot,
      descriptor: built.descriptor,
      pid: matched.process.pid,
      processStartedAt: matched.processStartedAt,
      portOwnerPid: collected.process.portOwnerPid,
      browserIdentity: collected.process.browserIdentity,
      targetId: collected.process.targetId,
      executionContextId: collected.process.executionContextId,
      pathSeparation: pathSeparationFor(
        layout,
        options.protectedPaths,
        options.osHome,
        options.plan,
      ),
      exactMarkerPresent,
      // For comparative sides, ownershipAccepted reflects classifier + successful stop when claimed.
      ownershipAccepted:
        options.plan.useCdpPort && options.plan.useExactMarker
          ? collected.ownership.owned && stop.stopped
          : false,
    };

    // Best-effort reclaim of private experiment profile bytes after exact stop.
    // Acceptance uses the primary layout and must not be cleared here.
    if (stop.stopped && !stop.uncertain) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(layout.electronUserDataPath, { recursive: true, force: true });
        await rm(layout.codexHomePath, { recursive: true, force: true });
      } catch {
        // Disk reclamation is best-effort and never changes ownership conclusions.
      }
    }

    return {
      side,
      process: collected.process,
      residualAuthority: stop.uncertain || !stop.stopped,
    };
  } catch {
    if (spawned !== null) {
      try {
        if (processStartedAt !== null) {
          await stopExactProcess({
            runtimeProcess: options.runtimeProcess,
            commands: options.commands,
            cdp: options.cdp,
            pid: spawned.pid,
            processStartedAt,
            executablePath: options.frozenHost.executablePath,
            marker: options.marker.value,
            timeoutMs: options.stopTimeoutMs,
            pollMs: options.pollMs,
            signal: options.signal,
          });
        } else {
          spawned.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
    }
    return {
      side: sideFromFailure(built.descriptor, options.privateRoot),
      process: null,
      residualAuthority: false,
    };
  }
}

function defaultExperimentPlans(): Array<{
  knob: Phase0CandidateKnob;
  treatment: Phase0LaunchPlan;
  control: Phase0LaunchPlan | null;
}> {
  const full: Phase0LaunchPlan = {
    useUserData: true,
    useCodexHome: true,
    useExplodexHome: false,
    useCdpPort: true,
    useExactMarker: true,
  };
  return [
    {
      knob: "electron-user-data",
      treatment: { ...full },
      control: { ...full, useUserData: false },
    },
    {
      knob: "codex-home",
      treatment: { ...full },
      control: { ...full, useCodexHome: false },
    },
    {
      knob: "explodex-home",
      // Treatment without EXPLODEX_HOME; control with it for non-necessity comparison.
      treatment: { ...full, useExplodexHome: false },
      control: { ...full, useExplodexHome: true },
    },
    {
      knob: "cdp-port",
      treatment: { ...full },
      control: { ...full, useCdpPort: false },
    },
    {
      knob: "launch-marker",
      treatment: { ...full },
      control: { ...full, useExactMarker: false, useSubstringMarker: true },
    },
  ];
}

function buildOwnershipEvidence(options: {
  positive: ReturnType<typeof classifyDevelopmentOwnership>;
  expected: OwnershipExpected;
  developmentPid: number;
  developmentStartedAt: string;
}): Phase0OwnershipEvidence {
  const negatives = controlledOwnershipNegatives({
    expected: options.expected,
    developmentPid: options.developmentPid,
    developmentStartedAt: options.developmentStartedAt,
  }).map((candidate) => {
    const verdict = classifyDevelopmentOwnership(candidate);
    return {
      role: candidate.role,
      owned: false as const,
      code: verdict.code,
      reasons: verdict.reasons,
    };
  });
  return {
    positive: {
      owned: options.positive.owned,
      code: options.positive.code,
      reasons: options.positive.reasons,
    },
    negatives,
  };
}

/**
 * Execute authorized live Phase 0 against the exact current canonical host identity
 * frozen at operation start. Historical build differences are not blockers.
 */
export async function runPhase0LaunchIsolation(
  options: Phase0OperationOptions,
): Promise<Phase0OperationResult> {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const osHome = options.osHome ?? process.env.HOME ?? "";
  if (osHome.length === 0) {
    return disabledResult("OS home is required to resolve the default development root.", "os_home_missing");
  }

  const runtimeProcess = options.runtimeProcess ?? (await createNodeRuntimeProcess());
  const runtimeAdapters =
    options.runtimeAdapters ?? (await createDefaultRuntimeAdapters());
  const commands = options.commands ?? createNodeReadOnlyCommandRunner();
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const spawnAdapter = options.spawn ?? (await createNodeLaunchSpawnAdapter());
  const protectedPaths = options.protectedPaths ?? defaultProtectedPaths(osHome);

  const mainInventory = createNodeProcessInventoryAdapter({
    commands,
    exactProcess: runtimeProcess,
  });
  const beforeProcesses = await mainInventory.list({ signal: options.signal });
  const protectedMain = beforeProcesses.find(
    (entry) =>
      entry.executablePath.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT") &&
      !entry.arguments.some((token) => token.startsWith("--explodex-dev-instance=")),
  );
  const protectedMainIdentity =
    protectedMain === undefined
      ? null
      : await runtimeProcess.identify(protectedMain.pid, { abortSignal: options.signal });

  const inspection = await inspectCanonicalHost(options.adapters);
  if (!inspection.ok || inspection.host === null) {
    return disabledResult(
      inspection.ok ? "Host inspection returned no host" : inspection.error.message,
      inspection.ok ? "host_missing" : inspection.error.code,
    );
  }
  const frozenHost = freezeHostIdentity(inspection.host);

  const rootPath =
    options.rootPath ??
    resolveDefaultDevRoot({
      osHome,
    });
  const layoutResult = await ensureDefaultDevLayout({
    fs: options.adapters.fs,
    rootPath,
    protectedPaths,
  });
  if (!layoutResult.ok) {
    return {
      ...disabledResult(layoutResult.error.message, layoutResult.error.code, frozenHost),
      layout: describeDevLayout(rootPath),
      frozenHost,
    };
  }
  const layout = layoutResult.layout;
  if (ownershipFromLayoutOnly(layout).owned) {
    throw new Error("Invariant violation: layout creation granted ownership");
  }

  // Explodex home for advisory lock is the parent of dev/plugin-dev when using default layout.
  const explodexHomeForLock =
    protectedPaths.explodexHome ??
    join(osHome, ".explodex");

  const self = runtimeProcess.self();
  const identity: OperationIdentity = {
    operationId: `phase0_${Date.now().toString(16)}_${self.pid}`,
    operation: "phase0-launch-isolation",
    startedAt: options.adapters.clock.nowIso(),
    ownerPid: self.pid,
    ownerProcessStartedAt: self.processStartedAt,
  };

  const lockResult = await withOperationLock(
    {
      adapters: runtimeAdapters,
      explodexHome: explodexHomeForLock,
      resource: "dev-instance",
      identity,
      waitBoundMs: lockWaitMs,
      pollIntervalMs: 50,
      abortSignal: options.signal,
    },
    async () => {
      // Invalidate any residual schema-1 / rejected proof before first spawn.
      const preSpawn = createPreSpawnIncompleteContract({ frozenHost });
      await savePhase0LaunchContract({
        adapters: options.adapters,
        path: layout.phase0ContractPath,
        contract: preSpawn,
      });
      const startingState = createInitialDevInstanceState({
        layout,
        appPath: frozenHost.bundlePath,
        executablePath: frozenHost.executablePath,
        launchMarker: DEFAULT_PHASE0_LAUNCH_MARKER,
        updatedAt: options.adapters.clock.nowIso(),
      });
      startingState.status = "starting";
      startingState.appVersion = frozenHost.appVersion;
      startingState.appBuild = frozenHost.appBuild;
      startingState.lastError = {
        code: "phase0_incomplete",
        message: "Phase 0 incomplete/non-authorizing authority written before first spawn.",
        phase: "phase0",
      };
      // starting without live pid is allowed for pre-spawn incomplete.
      startingState.pid = null;
      startingState.processStartedAt = null;
      startingState.targetId = null;
      await saveDevInstanceState({
        adapters: options.adapters,
        statePath: layout.statePath,
        state: startingState,
      });

      // Port must be free before experiments that claim 9444.
      const portAdapter = createNodePortInventoryAdapter(commands);
      const existingListeners = await portAdapter.listenersFor(DEV_CDP_PORT, {
        signal: options.signal,
      });
      if (existingListeners.length > 0) {
        const incomplete = createPreSpawnIncompleteContract({
          frozenHost,
          reason: `Development port ${DEV_CDP_HOST}:${DEV_CDP_PORT} is already occupied; refuse adoption.`,
        });
        await savePhase0LaunchContract({
          adapters: options.adapters,
          path: layout.phase0ContractPath,
          contract: incomplete,
        });
        return {
          ok: false as const,
          result: {
            ...disabledResult(
              `Development port ${DEV_CDP_HOST}:${DEV_CDP_PORT} is already occupied by PID ${existingListeners[0]!.pid}.`,
              "port_occupied",
              frozenHost,
            ),
            layout,
            frozenHost,
            contract: incomplete,
          },
        };
      }

      const marker: LaunchMarkerContract = {
        kind: "exact-argv-token",
        value: DEFAULT_PHASE0_LAUNCH_MARKER,
      };
      const plans = options.experimentPlans ?? defaultExperimentPlans();
      const comparativeExperiments: Phase0ComparativeExperiment[] = [];
      let acceptanceProcess: Phase0OperationProcessEvidence | null = null;
      let acceptanceReadiness: Phase0ReadinessEvidence | null = null;
      let acceptanceOwnership: ReturnType<typeof classifyDevelopmentOwnership> | null = null;
      let residualAuthority = false;

      // Cache identical launch plans so the comparative matrix does not re-spawn
      // the same ChatGPT configuration for every knob that shares a treatment.
      const launchCache = new Map<
        string,
        {
          side: Phase0ExperimentSideObservation;
          process: Phase0OperationProcessEvidence | null;
          residualAuthority: boolean;
        }
      >();
      const planKey = (plan: Phase0LaunchPlan): string =>
        JSON.stringify({
          useUserData: plan.useUserData,
          useCodexHome: plan.useCodexHome,
          useExplodexHome: plan.useExplodexHome,
          useCdpPort: plan.useCdpPort,
          useExactMarker: plan.useExactMarker,
          useSubstringMarker: plan.useSubstringMarker === true,
        });

      const runCached = async (
        knob: Phase0CandidateKnob,
        sideName: "treatment" | "control",
        plan: Phase0LaunchPlan,
      ): Promise<{
        side: Phase0ExperimentSideObservation;
        process: Phase0OperationProcessEvidence | null;
        residualAuthority: boolean;
      }> => {
        const key = planKey(plan);
        const cached = launchCache.get(key);
        if (cached !== undefined) {
          return {
            side: {
              ...cached.side,
              // Preserve factual descriptor/private-root identity of the cached launch.
            },
            process: cached.process,
            residualAuthority: cached.residualAuthority,
          };
        }
        const privateRoot = join(layout.rootPath, "experiments", knob, sideName);
        const launched = await runOneExperimentLaunch({
          adapters: options.adapters,
          spawn: spawnAdapter,
          commands,
          runtimeProcess,
          cdp,
          frozenHost,
          privateRoot,
          protectedPaths,
          osHome,
          marker,
          plan,
          readinessTimeoutMs,
          stopTimeoutMs,
          pollMs,
          signal: options.signal,
        });
        launchCache.set(key, launched);
        return launched;
      };

      for (const plan of plans) {
        const treatment = await runCached(plan.knob, "treatment", plan.treatment);
        if (treatment.residualAuthority) residualAuthority = true;

        let controlSide: Phase0ExperimentSideObservation | null = null;
        if (plan.control !== null) {
          const control = await runCached(plan.knob, "control", plan.control);
          if (control.residualAuthority) residualAuthority = true;
          controlSide = control.side;
        }

        const experimentRecord: Phase0ComparativeExperiment = {
          knob: plan.knob,
          experimentId: `phase0-${plan.knob}-${Date.now().toString(16)}`,
          treatmentLabel: `treatment:${plan.knob}`,
          controlLabel: plan.control === null ? "control:none" : `control:${plan.knob}`,
          treatment: treatment.side,
          control: controlSide,
          conclusion: "missing",
          evidence: "",
        };
        // Derive conclusion via the same pure evaluator used at contract time.
        const verdict = deriveKnobVerdictFromExperiment(experimentRecord);
        experimentRecord.conclusion = verdict.effect;
        experimentRecord.evidence = verdict.evidence;
        comparativeExperiments.push(experimentRecord);
      }

      if (residualAuthority) {
        const incomplete = evaluatePhase0LaunchContract({
          frozenHost,
          recheckedHost: frozenHost,
          comparativeExperiments,
          proposedMarker: marker,
          layout,
          clockIso: options.adapters.clock.nowIso(),
          requireCompleteProof: true,
        });
        // Do not claim stopped/proven when cleanup is uncertain.
        await savePhase0LaunchContract({
          adapters: options.adapters,
          path: layout.phase0ContractPath,
          contract: {
            ...incomplete.contract,
            status: "incomplete",
            provenAt: null,
            reason:
              incomplete.contract.reason ??
              "Cleanup uncertain; residual authority preserved and proof remains non-authorizing.",
          },
        });
        const failedState = createInitialDevInstanceState({
          layout,
          appPath: frozenHost.bundlePath,
          executablePath: frozenHost.executablePath,
          launchMarker: marker.value,
          updatedAt: options.adapters.clock.nowIso(),
        });
        failedState.status = "failed";
        failedState.appVersion = frozenHost.appVersion;
        failedState.appBuild = frozenHost.appBuild;
        failedState.lastError = {
          code: "phase0_cleanup_uncertain",
          message: "Cleanup uncertain; residual authority preserved.",
          phase: "phase0",
        };
        await saveDevInstanceState({
          adapters: options.adapters,
          statePath: layout.statePath,
          state: failedState,
        });
        return {
          ok: false as const,
          result: {
            ok: false as const,
            contract: {
              ...incomplete.contract,
              status: "incomplete" as const,
              provenAt: null,
              reason:
                "Cleanup uncertain; residual authority preserved and proof remains non-authorizing.",
            },
            allowsLifecycleMutation: false as const,
            allowsCompatibilityProbe: false as const,
            layout,
            frozenHost,
            process: acceptanceProcess,
            protectedMainSurvived: true,
            grantsOwnershipFromPathsOnly: false as const,
            error: {
              code: "phase0_cleanup_uncertain",
              message: "Cleanup uncertain; residual authority preserved.",
            },
          },
        };
      }

      // Dedicated acceptance launch on the primary layout with the retained set.
      const acceptancePlan: Phase0LaunchPlan = {
        useUserData: true,
        useCodexHome: true,
        useExplodexHome: false,
        useCdpPort: true,
        useExactMarker: true,
      };
      const acceptanceBuilt = buildPlanForRoot({
        frozenHost,
        layout,
        marker,
        plan: acceptancePlan,
      });
      const logsStdout = join(layout.logsPath, "phase0.stdout.log");
      const logsStderr = join(layout.logsPath, "phase0.stderr.log");
      const spawned = await spawnAdapter.spawn({
        executablePath: acceptanceBuilt.executablePath,
        argv: acceptanceBuilt.argv,
        env: acceptanceBuilt.env,
        stdoutPath: logsStdout,
        stderrPath: logsStderr,
      });

      const matched = await waitForExactDevProcess({
        commands,
        runtimeProcess,
        executablePath: frozenHost.executablePath,
        marker: marker.value,
        expectedPid: spawned.pid,
        timeoutMs: readinessTimeoutMs,
        pollMs,
        signal: options.signal,
      });
      if (matched === null) {
        try {
          spawned.kill("SIGTERM");
        } catch {
          // ignore
        }
        throw new Error(
          `Timed out waiting for isolated development ChatGPT process with exact marker on PID ${spawned.pid}`,
        );
      }

      const collected = await collectReadiness({
        cdp,
        commands,
        runtimeProcess,
        frozenHost,
        pid: matched.process.pid,
        processStartedAt: matched.processStartedAt,
        argumentsList: matched.process.arguments,
        marker: marker.value,
        expectCdp: true,
        portTimeoutMs: readinessTimeoutMs,
        signal: options.signal,
      });
      acceptanceProcess = {
        ...collected.process,
        env: {
          CODEX_ELECTRON_USER_DATA_PATH: acceptanceBuilt.env.CODEX_ELECTRON_USER_DATA_PATH,
          CODEX_HOME: acceptanceBuilt.env.CODEX_HOME,
        },
      };
      acceptanceReadiness = collected.readiness;
      acceptanceOwnership = collected.ownership;

      // Active-operation host recheck before any proven authority.
      const recheck = await inspectCanonicalHost(options.adapters);
      if (!recheck.ok || recheck.host === null) {
        throw new Error("Host became unavailable during Phase 0");
      }
      const recheckedHost = freezeHostIdentity(recheck.host);
      if (!frozenHostEquals(frozenHost, recheckedHost)) {
        throw new Error(
          "Active-operation host identity drifted from the frozen Phase 0 identity; abort without reconnect or authority transfer.",
        );
      }

      const ownershipEvidence = buildOwnershipEvidence({
        positive: acceptanceOwnership,
        expected: {
          marker: marker.value,
          executablePath: frozenHost.executablePath,
          cdpHost: DEV_CDP_HOST,
          cdpPort: DEV_CDP_PORT,
          expectedPid: acceptanceProcess.pid,
          expectedProcessStartedAt: acceptanceProcess.processStartedAt,
        },
        developmentPid: acceptanceProcess.pid,
        developmentStartedAt: acceptanceProcess.processStartedAt,
      });

      const evaluation = evaluatePhase0LaunchContract({
        frozenHost,
        recheckedHost,
        comparativeExperiments,
        proposedMarker: marker,
        layout,
        clockIso: options.adapters.clock.nowIso(),
        readiness: acceptanceReadiness,
        ownership: ownershipEvidence,
        requireCompleteProof: true,
      });

      // Cleanup before any stopped/proven write.
      let protectedMainSurvived = true;
      let cleanupUncertain = false;
      let cleanupReason: string | undefined;
      if (!options.keepProcessAlive) {
        const stop = await stopExactProcess({
          runtimeProcess,
          commands,
          cdp,
          pid: acceptanceProcess.pid,
          processStartedAt: acceptanceProcess.processStartedAt,
          executablePath: frozenHost.executablePath,
          marker: marker.value,
          timeoutMs: stopTimeoutMs,
          pollMs,
          signal: options.signal,
        });
        if (!stop.stopped || !stop.portReleased || stop.uncertain) {
          cleanupUncertain = true;
          cleanupReason =
            stop.reason ??
            "Exact exit and 9444 release did not both complete; residual authority preserved.";
        }
      }

      if (protectedMainIdentity !== null) {
        protectedMainSurvived = await runtimeProcess.isAlive(
          protectedMainIdentity.pid,
          protectedMainIdentity.processStartedAt,
          { abortSignal: options.signal },
        );
      }

      // Final host recheck before any proven write.
      const finalHost = await inspectCanonicalHost(options.adapters);
      if (!finalHost.ok || finalHost.host === null) {
        cleanupUncertain = true;
        cleanupReason = "Final host recheck failed; proof remains non-authorizing.";
      } else if (!frozenHostEquals(frozenHost, freezeHostIdentity(finalHost.host))) {
        cleanupUncertain = true;
        cleanupReason =
          "Final frozen-host recheck drifted; abort without proven authority transfer.";
      }

      if (
        cleanupUncertain ||
        !protectedMainSurvived ||
        evaluation.contract.status !== "proven"
      ) {
        const reason =
          cleanupReason ??
          (!protectedMainSurvived
            ? "Protected authoring main did not survive Phase 0; fail closed."
            : evaluation.contract.reason ?? "Phase 0 launch-isolation proof incomplete");
        const incompleteContract = {
          ...evaluation.contract,
          status: "incomplete" as const,
          provenAt: null,
          reason,
        };
        // State write first (failed/non-stopped if uncertain), never proven last on failure.
        const failedState = createInitialDevInstanceState({
          layout,
          appPath: frozenHost.bundlePath,
          executablePath: frozenHost.executablePath,
          launchMarker: marker.value,
          updatedAt: options.adapters.clock.nowIso(),
        });
        failedState.status = cleanupUncertain ? "failed" : "failed";
        failedState.appVersion = frozenHost.appVersion;
        failedState.appBuild = frozenHost.appBuild;
        if (cleanupUncertain && acceptanceProcess !== null) {
          // Preserve residual identity; do not claim stopped.
          failedState.pid = acceptanceProcess.pid;
          failedState.processStartedAt = acceptanceProcess.processStartedAt;
          failedState.targetId = null;
        }
        failedState.lastError = {
          code: cleanupUncertain
            ? "phase0_cleanup_uncertain"
            : !protectedMainSurvived
              ? "protected_main_impacted"
              : "phase0_incomplete",
          message: reason,
          phase: "phase0",
        };
        await saveDevInstanceState({
          adapters: options.adapters,
          statePath: layout.statePath,
          state: failedState,
        });
        await savePhase0LaunchContract({
          adapters: options.adapters,
          path: layout.phase0ContractPath,
          contract: incompleteContract,
        });
        return {
          ok: false as const,
          result: {
            ok: false as const,
            contract: incompleteContract,
            allowsLifecycleMutation: false as const,
            allowsCompatibilityProbe: false as const,
            layout,
            frozenHost,
            process: acceptanceProcess,
            protectedMainSurvived,
            grantsOwnershipFromPathsOnly: false as const,
            error: {
              code: cleanupUncertain
                ? "phase0_cleanup_uncertain"
                : !protectedMainSurvived
                  ? "protected_main_impacted"
                  : "phase0_incomplete",
              message: reason,
            },
          },
        };
      }

      // Success path: stopped state first, proven contract last.
      const stoppedState = createInitialDevInstanceState({
        layout,
        appPath: frozenHost.bundlePath,
        executablePath: frozenHost.executablePath,
        launchMarker: marker.value,
        updatedAt: options.adapters.clock.nowIso(),
      });
      if (options.keepProcessAlive && acceptanceProcess !== null) {
        stoppedState.status = "ready";
        stoppedState.pid = acceptanceProcess.pid;
        stoppedState.processStartedAt = acceptanceProcess.processStartedAt;
        stoppedState.targetId = acceptanceProcess.targetId;
        stoppedState.startedAt = options.adapters.clock.nowIso();
      } else {
        stoppedState.status = "stopped";
        stoppedState.pid = null;
        stoppedState.processStartedAt = null;
        stoppedState.targetId = null;
      }
      stoppedState.appVersion = frozenHost.appVersion;
      stoppedState.appBuild = frozenHost.appBuild;
      await saveDevInstanceState({
        adapters: options.adapters,
        statePath: layout.statePath,
        state: stoppedState,
      });

      // Proven contract is the last authority write.
      await savePhase0LaunchContract({
        adapters: options.adapters,
        path: layout.phase0ContractPath,
        contract: evaluation.contract,
      });

      return {
        ok: true as const,
        result: {
          ok: true as const,
          contract: evaluation.contract,
          allowsLifecycleMutation: true as const,
          allowsCompatibilityProbe: true as const,
          layout,
          frozenHost,
          process: acceptanceProcess!,
          protectedMainSurvived: true,
          grantsOwnershipFromPathsOnly: false as const,
        },
      };
    },
  );

  if (!lockResult.ok) {
    return disabledResult(
      lockResult.message,
      lockResult.code,
      frozenHost,
    );
  }

  return lockResult.value.result;
}

/** True when a later operation must re-run Phase 0 for a new frozen host. */
export function phase0RequiresReproof(options: {
  contract: { frozenHost: Phase0FrozenHost | null; status: string; schemaVersion?: number } | null;
  currentHost: Phase0FrozenHost;
}): boolean {
  if (options.contract === null || options.contract.status !== "proven") return true;
  if (
    options.contract.schemaVersion !== undefined &&
    options.contract.schemaVersion !== 2
  ) {
    return true;
  }
  return !frozenHostEquals(options.contract.frozenHost, options.currentHost);
}
