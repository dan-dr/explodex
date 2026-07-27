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
  PHASE0_BENIGN_RENDERER_EXPRESSION,
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
  type ProtectedMainObservation,
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
  Phase0AcceptanceAuthority,
  Phase0CleanupMethod,
  Phase0ComparativeExperiment,
  Phase0ExperimentSideObservation,
  Phase0FrozenHost,
  Phase0OperationProcessEvidence,
  Phase0OperationResult,
  Phase0OwnershipEvidence,
  Phase0ProtectedMainObservation,
  Phase0ReadinessEvidence,
  SanitizedLaunchDescriptor,
} from "./types.ts";

export const DEFAULT_PHASE0_LAUNCH_MARKER = `--explodex-dev-instance=${DEFAULT_DEV_INSTANCE_ID}`;

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;

const BENIGN_RENDERER_EXPRESSION = PHASE0_BENIGN_RENDERER_EXPRESSION;

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
  /**
   * Optional pre-validated comparative experiment records. When supplied, the operation
   * skips re-running the isolation matrix and proceeds only to the acceptance launch.
   * Used for bounded keep-alive re-proof under host instability (M1-F05).
   * Records still pass semantic re-derivation before proven authority.
   */
  providedComparativeExperiments?: Phase0ComparativeExperiment[];
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
      acceptanceAuthority: null,
      acceptanceOperationId: null,
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
  const envValues: Record<string, string> = {};

  if (options.plan.useUserData) {
    argv.push(`--user-data-dir=${options.layout.electronUserDataPath}`);
    env.CODEX_ELECTRON_USER_DATA_PATH = options.layout.electronUserDataPath;
    envKeys.push("CODEX_ELECTRON_USER_DATA_PATH");
    envValues.CODEX_ELECTRON_USER_DATA_PATH = options.layout.electronUserDataPath;
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
    envValues.CODEX_HOME = options.layout.codexHomePath;
  }
  if (options.plan.useExplodexHome) {
    env.EXPLODEX_HOME = options.layout.explodexStatePath;
    envKeys.push("EXPLODEX_HOME");
    envValues.EXPLODEX_HOME = options.layout.explodexStatePath;
  }

  return {
    executablePath: options.frozenHost.executablePath,
    argv,
    env,
    descriptor: {
      argv: [options.frozenHost.executablePath, ...argv],
      envKeys,
      ...(Object.keys(envValues).length > 0 ? { envValues } : {}),
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
  clockIso?: string;
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
  let endpointPublishedPid: number | null = null;
  let targetId: string | null = null;
  let executionContextId: number | null = null;
  let executionContextUniqueId: string | null = null;
  let frameId: string | null = null;
  let rendererEvaluation: Phase0ReadinessEvidence["rendererEvaluation"] | null = null;
  let listenerCoOwned = false;

  if (expectCdp) {
    // Port ownership can precede the exact app:// page and default context.
    // Poll until complete readiness or the remaining bound expires.
    const readinessDeadline = Date.now() + (options.portTimeoutMs ?? 15_000);
    while (Date.now() < readinessDeadline) {
      if (options.signal?.aborted) {
        throw Object.assign(new Error("Phase 0 aborted"), { code: "ABORT_ERR" });
      }
      try {
        const ports = createNodePortInventoryAdapter(options.commands);
        const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
        const loopback = listeners.filter(
          (entry) =>
            entry.port === DEV_CDP_PORT &&
            (entry.host === DEV_CDP_HOST || entry.host === "localhost" || entry.host === "::1"),
        );
        const distinctOwners = new Set(loopback.map((entry) => entry.pid));
        // Unique-owner contract: any additional 9444 listener is hard co-ownership
        // ambiguity and rejects readiness authority rather than being tolerated.
        const expectedOwns = distinctOwners.has(options.pid);
        listenerCoOwned = distinctOwners.size !== 1 || !expectedOwns;
        if (listenerCoOwned && distinctOwners.size > 1) {
          browserIdentity = null;
          targetId = null;
          executionContextId = null;
          executionContextUniqueId = null;
          frameId = null;
          rendererEvaluation = null;
          break;
        }
        if (!expectedOwns || distinctOwners.size === 0) {
          listenerCoOwned = false;
          browserIdentity = null;
          await sleep(250, options.signal);
          continue;
        }

        const version = await options.cdp.readEndpoint({
          host: DEV_CDP_HOST,
          port: DEV_CDP_PORT,
          signal: options.signal,
        });
        if (typeof version.browser !== "string" || version.browser.length === 0) {
          browserIdentity = null;
          await sleep(250, options.signal);
          continue;
        }
        browserIdentity = version.browser;
        endpointPublishedPid =
          typeof version.pid === "number" && Number.isInteger(version.pid) && version.pid > 0
            ? version.pid
            : null;
        if (endpointPublishedPid !== null && endpointPublishedPid !== options.pid) {
          // Published endpoint PID disagreement is a hard incomplete result.
          rendererEvaluation = null;
          targetId = null;
          executionContextId = null;
          executionContextUniqueId = null;
          frameId = null;
          break;
        }

        const targets = await options.cdp.listTargets({
          host: DEV_CDP_HOST,
          port: DEV_CDP_PORT,
          signal: options.signal,
        });
        const pages = targets.filter(
          (target) => target.type === "page" && target.url === "app://-/index.html",
        );
        if (pages.length !== 1) {
          targetId = null;
          executionContextId = null;
          executionContextUniqueId = null;
          frameId = null;
          rendererEvaluation = null;
          await sleep(250, options.signal);
          continue;
        }
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
            if (selection.kind !== "selected") {
              executionContextId = null;
              executionContextUniqueId = null;
              frameId = null;
              rendererEvaluation = null;
            } else {
              executionContextId = selection.context.id;
              executionContextUniqueId = selection.context.uniqueId;
              frameId = selection.context.frameId;

              // Point-of-use revalidation before evaluation. Transient target/context
              // churn during page load must continue polling within the readiness bound;
              // only hard identity disagreements exit early.
              const alive = await options.runtimeProcess.isAlive(
                options.pid,
                options.processStartedAt,
                { abortSignal: options.signal },
              );
              if (!alive) {
                rendererEvaluation = null;
                targetId = null;
                executionContextId = null;
                executionContextUniqueId = null;
                frameId = null;
                break;
              }
              const recheckVersion = await options.cdp.readEndpoint({
                host: DEV_CDP_HOST,
                port: DEV_CDP_PORT,
                signal: options.signal,
              });
              const recheckPublished =
                typeof recheckVersion.pid === "number" &&
                Number.isInteger(recheckVersion.pid) &&
                recheckVersion.pid > 0
                  ? recheckVersion.pid
                  : null;
              if (recheckPublished !== null && recheckPublished !== options.pid) {
                // Hard endpoint PID disagreement: incomplete without reconnect.
                rendererEvaluation = null;
                targetId = null;
                executionContextId = null;
                executionContextUniqueId = null;
                frameId = null;
                break;
              }
              if (
                typeof recheckVersion.browser !== "string" ||
                recheckVersion.browser.length === 0
              ) {
                rendererEvaluation = null;
                await sleep(250, options.signal);
                continue;
              }
              browserIdentity = recheckVersion.browser;
              const recheckTargets = await options.cdp.listTargets({
                host: DEV_CDP_HOST,
                port: DEV_CDP_PORT,
                signal: options.signal,
              });
              const recheckPages = recheckTargets.filter(
                (entry) => entry.type === "page" && entry.url === "app://-/index.html",
              );
              if (recheckPages.length !== 1) {
                // Transient zero/multiple targets during load: keep polling.
                rendererEvaluation = null;
                targetId = null;
                executionContextId = null;
                executionContextUniqueId = null;
                frameId = null;
                await sleep(250, options.signal);
                continue;
              }
              if (recheckPages[0]!.id !== target.id) {
                // Target replacement: restart selection on the next poll.
                rendererEvaluation = null;
                targetId = null;
                executionContextId = null;
                executionContextUniqueId = null;
                frameId = null;
                await sleep(250, options.signal);
                continue;
              }
              const recheckContexts = await session.listExecutionContexts({
                signal: options.signal,
              });
              const recheckSelection = selectExactPageAndContext({
                targets: recheckTargets,
                contextsByTarget: { [target.id]: recheckContexts },
              });
              if (recheckSelection.kind !== "selected") {
                rendererEvaluation = null;
                executionContextId = null;
                executionContextUniqueId = null;
                frameId = null;
                await sleep(250, options.signal);
                continue;
              }
              // Accept the rechecked context identity; context ids can be reissued
              // during load as long as the selected default context remains unique.
              executionContextId = recheckSelection.context.id;
              executionContextUniqueId = recheckSelection.context.uniqueId;
              frameId = recheckSelection.context.frameId;

              const evaluation = await session.evaluate({
                executionContextId: recheckSelection.context.id,
                executionContextUniqueId: recheckSelection.context.uniqueId,
                expression: BENIGN_RENDERER_EXPRESSION,
                signal: options.signal,
              });
              if (
                evaluation === null ||
                evaluation === undefined ||
                evaluation.value === undefined
              ) {
                rendererEvaluation = null;
              } else {
                rendererEvaluation = {
                  expression: BENIGN_RENDERER_EXPRESSION,
                  result: evaluation.value,
                  evaluatedAt: options.clockIso ?? new Date().toISOString(),
                };
                break;
              }
            }
          } finally {
            await session.close({ timeoutMs: 2_000 });
          }
        } catch {
          // Context collection / evaluation failure: keep polling while bound remains.
          rendererEvaluation = null;
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
    !listenerCoOwned &&
    browserIdentity !== null &&
    targetId !== null &&
    executionContextId !== null &&
    executionContextUniqueId !== null &&
    frameId !== null &&
    rendererEvaluation !== null &&
    portOwner === options.pid &&
    (endpointPublishedPid === null || endpointPublishedPid === options.pid);

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
        endpointPublishedPid,
        targetId: targetId!,
        targetUrl: "app://-/index.html",
        executionContextId: executionContextId!,
        executionContextUniqueId: executionContextUniqueId!,
        frameId: frameId!,
        rendererEvaluation: rendererEvaluation!,
        readiness: "benign",
      }
    : null;

  return { process: processEvidence, readiness, ownership };
}

async function browserCloseIfPossible(
  cdp: CdpAdapter,
  timeoutMs: number,
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
      }, Math.max(1, Math.min(1_500, timeoutMs)));
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
      }, Math.max(1, Math.min(5_000, timeoutMs)));
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

async function revalidateProcessCleanupAuthority(options: {
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
  return { ok: true };
}

/**
 * Endpoint/port revalidation required before Browser.close.
 * Unique-owner contract: any additional 9444 listener refuses Browser.close.
 * Exact-PID SIGTERM of a still-verified process remains separately allowed for
 * legacy Phase 0 cleanup. Strict lifecycle callers can forbid that fallback
 * when endpoint ownership, target, or context identity has drifted.
 */
async function revalidateEndpointCleanupAuthority(options: {
  commands: ReadOnlyCommandRunner;
  cdp: CdpAdapter;
  pid: number;
  expectedTargetId?: string | null;
  expectedContextUniqueId?: string | null;
  signal?: AbortSignal;
}): Promise<
  { ok: true } |
  { ok: false; reason: string; exactSignalFallbackAllowed: boolean }
> {
  const ports = createNodePortInventoryAdapter(options.commands);
  const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
  const loopback = listeners.filter(
    (entry) =>
      entry.port === DEV_CDP_PORT &&
      (entry.host === DEV_CDP_HOST || entry.host === "localhost" || entry.host === "::1"),
  );
  const owners = new Set(loopback.map((entry) => entry.pid));
  if (owners.size === 0) {
    return {
      ok: false,
      reason: "Declared development port has no owner before Browser.close.",
      exactSignalFallbackAllowed: false,
    };
  }
  if (owners.size !== 1 || !owners.has(options.pid)) {
    return {
      ok: false,
      reason:
        "Listener co-ownership or foreign ownership before cleanup; refuse Browser.close under unique-owner contract.",
      exactSignalFallbackAllowed: false,
    };
  }

  try {
    const version = await options.cdp.readEndpoint({
      host: DEV_CDP_HOST,
      port: DEV_CDP_PORT,
      signal: options.signal,
    });
    if (typeof version.browser !== "string" || version.browser.length === 0) {
      return {
        ok: false,
        reason: "Endpoint browser identity missing/malformed before Browser.close.",
        exactSignalFallbackAllowed: false,
      };
    }
    if (
      typeof version.pid === "number" &&
      Number.isInteger(version.pid) &&
      version.pid > 0 &&
      version.pid !== options.pid
    ) {
      return {
        ok: false,
        reason: "Endpoint published PID disagrees before Browser.close; refuse Browser.close.",
        exactSignalFallbackAllowed: false,
      };
    }
    if (options.expectedTargetId) {
      const targets = await options.cdp.listTargets({
        host: DEV_CDP_HOST,
        port: DEV_CDP_PORT,
        signal: options.signal,
      });
      const pages = targets.filter(
        (target) => target.type === "page" && target.url === "app://-/index.html",
      );
      if (pages.length !== 1 || pages[0]!.id !== options.expectedTargetId) {
        return {
          ok: false,
          reason: "Target identity drifted before Browser.close; refuse Browser.close.",
          exactSignalFallbackAllowed: false,
        };
      }
      // Re-open and revalidate the exact default execution context unique ID.
      if (options.expectedContextUniqueId) {
        const session = await options.cdp.openTargetSession({
          host: DEV_CDP_HOST,
          port: DEV_CDP_PORT,
          target: pages[0]!,
          signal: options.signal,
        });
        try {
          const contexts = await session.listExecutionContexts({
            signal: options.signal,
          });
          const selection = selectExactPageAndContext({
            targets,
            contextsByTarget: { [pages[0]!.id]: contexts },
          });
          if (
            selection.kind !== "selected" ||
            selection.context.uniqueId !== options.expectedContextUniqueId
          ) {
            return {
              ok: false,
              reason:
                "Execution context unique ID drifted before Browser.close; refuse Browser.close.",
              exactSignalFallbackAllowed: false,
            };
          }
        } finally {
          await session.close({ timeoutMs: 2_000 });
        }
      }
    }
  } catch {
    return {
      ok: false,
      reason: "Endpoint unavailable before Browser.close; fall through to exact-PID signal.",
      exactSignalFallbackAllowed: true,
    };
  }
  return { ok: true };
}

/**
 * Create a fresh finite cleanup AbortSignal independent of the operation signal.
 * Aborted operations must not reuse their aborted signal for cleanup work.
 */
function createCleanupContext(timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const handle = globalThis.setTimeout(() => {
    controller.abort(Object.assign(new Error("Cleanup bound elapsed"), { code: "ABORT_ERR" }));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(handle);
    },
  };
}

/**
 * Stop exact helper processes that ChatGPT may spawn under our private roots
 * (for example CODEX_HOME computer-use services) and that can orphan onto 9444.
 * Only exact PIDs whose executable path is under one of the supplied private roots
 * are signaled; protected mains and unrelated processes are never targeted.
 */
async function stopPrivateRootHelpers(options: {
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  privateRoots: readonly string[];
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (options.privateRoots.length === 0) return;
  const inventory = createNodeProcessInventoryAdapter({
    commands: options.commands,
    exactProcess: options.runtimeProcess,
  });
  const processes = await inventory.list({ signal: options.signal });
  const helpers = processes.filter((entry) =>
    options.privateRoots.some(
      (root) =>
        entry.executablePath === root ||
        entry.executablePath.startsWith(`${root}/`) ||
        entry.arguments.some(
          (token) => token === root || token.startsWith(`${root}/`),
        ),
    ),
  );
  for (const helper of helpers) {
    // Never signal the canonical installed ChatGPT main executable here; that
    // identity is handled exclusively by the exact development PID path.
    if (helper.executablePath.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT")) {
      continue;
    }
    const identity = await options.runtimeProcess.identify(helper.pid, {
      abortSignal: options.signal,
    });
    if (identity === null) continue;
    try {
      await options.runtimeProcess.signalExact(
        { pid: identity.pid, processStartedAt: identity.processStartedAt },
        "SIGTERM",
        { abortSignal: options.signal },
      );
    } catch {
      // Best-effort helper cleanup; port-release check remains authoritative.
    }
  }
  const deadline = Date.now() + Math.min(options.timeoutMs, 5_000);
  while (Date.now() < deadline) {
    const ports = createNodePortInventoryAdapter(options.commands);
    const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: options.signal });
    if (listeners.length === 0) return;
    await sleep(options.pollMs, options.signal);
  }
}

export type StopExactProcessResult = {
  stopped: boolean;
  portReleased: boolean;
  uncertain: boolean;
  method: Phase0CleanupMethod;
  reason?: string;
};

export async function stopExactProcess(options: {
  runtimeProcess: RuntimeProcess;
  commands: ReadOnlyCommandRunner;
  cdp: CdpAdapter;
  pid: number;
  processStartedAt: string;
  executablePath: string;
  marker: string;
  timeoutMs: number;
  pollMs: number;
  expectedTargetId?: string | null;
  expectedContextUniqueId?: string | null;
  /**
   * Recovery/normal lifecycle callers fail closed when endpoint ownership,
   * target, or context drifted. Phase 0 historical cleanup keeps its existing
   * exact-PID fallback behavior.
   */
  requireCompleteEndpointOwnershipForSignal?: boolean;
  /** Injectable Browser.close attempt for exact ordering/failure tests. */
  browserClose?: (options: {
    cdp: CdpAdapter;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<boolean>;
  /** Private roots under which ChatGPT may spawn helper processes. */
  privateRoots?: readonly string[];
  /** Intentionally ignored for cleanup; cleanup always uses a fresh finite context. */
  signal?: AbortSignal;
}): Promise<StopExactProcessResult> {
  const deadline = Date.now() + options.timeoutMs;
  const cleanup = createCleanupContext(options.timeoutMs);
  try {
    const processAuthority = await revalidateProcessCleanupAuthority({
      commands: options.commands,
      runtimeProcess: options.runtimeProcess,
      pid: options.pid,
      processStartedAt: options.processStartedAt,
      executablePath: options.executablePath,
      marker: options.marker,
      signal: cleanup.signal,
    });
    if (!processAuthority.ok) {
      return {
        stopped: false,
        portReleased: false,
        uncertain: true,
        method: "none",
        reason: processAuthority.reason,
      };
    }

    // Browser.close requires exclusive endpoint/target/context revalidation.
    // Co-ownership or foreign/mismatched endpoint refuses Browser.close. Legacy
    // Phase 0 cleanup may still use exact-PID SIGTERM, while strict lifecycle
    // callers fail closed unless CDP itself is unavailable after exact listener
    // ownership was proven.
    let browserCloseAttempted = false;
    let browserCloseOk = false;
    let exactSignalUsed = false;
    const closeAuthority = await revalidateEndpointCleanupAuthority({
      commands: options.commands,
      cdp: options.cdp,
      pid: options.pid,
      expectedTargetId: options.expectedTargetId,
      expectedContextUniqueId: options.expectedContextUniqueId,
      signal: cleanup.signal,
    });
    if (
      !closeAuthority.ok &&
      options.requireCompleteEndpointOwnershipForSignal === true &&
      !closeAuthority.exactSignalFallbackAllowed
    ) {
      return {
        stopped: false,
        portReleased: false,
        uncertain: true,
        method: "none",
        reason: closeAuthority.reason,
      };
    }
    if (closeAuthority.ok) {
      browserCloseAttempted = true;
      try {
        const remaining = Math.max(0, deadline - Date.now());
        browserCloseOk = remaining > 0
          ? await (options.browserClose ?? (async ({ cdp, timeoutMs, signal }) =>
              browserCloseIfPossible(cdp, timeoutMs, signal)))({
                cdp: options.cdp,
                timeoutMs: remaining,
                signal: cleanup.signal,
              })
          : false;
      } catch {
        browserCloseOk = false;
      }
    }

    // Only wait on a successful Browser.close. When close is refused/failed, signal
    // immediately so the cleanup bound is not exhausted before SIGTERM.
    if (browserCloseOk) {
      const remainingForTermination = Math.max(0, deadline - Date.now());
      const closeWaitDeadline = Math.min(
        deadline,
        Date.now() + Math.min(5_000, Math.floor(remainingForTermination / 2)),
      );
      while (Date.now() < closeWaitDeadline) {
        const aliveAfterClose = await options.runtimeProcess.isAlive(
          options.pid,
          options.processStartedAt,
          { abortSignal: cleanup.signal },
        );
        if (!aliveAfterClose) break;
        await sleep(options.pollMs, cleanup.signal);
      }
    }

    let stillAlive = await options.runtimeProcess.isAlive(
      options.pid,
      options.processStartedAt,
      { abortSignal: cleanup.signal },
    );
    if (stillAlive) {
      if (Date.now() >= deadline) {
        return {
          stopped: false,
          portReleased: false,
          uncertain: true,
          method: browserCloseOk
            ? "browser-close-only"
            : browserCloseAttempted
              ? "browser-close-then-signal"
              : "exact-signal-only",
          reason: `Exact development PID ${options.pid} did not exit within the cleanup bound.`,
        };
      }
      const recheck = await revalidateProcessCleanupAuthority({
        commands: options.commands,
        runtimeProcess: options.runtimeProcess,
        pid: options.pid,
        processStartedAt: options.processStartedAt,
        executablePath: options.executablePath,
        marker: options.marker,
        signal: cleanup.signal,
      });
      if (!recheck.ok) {
        return {
          stopped: false,
          portReleased: false,
          uncertain: true,
          method: browserCloseAttempted ? "browser-close-then-signal" : "exact-signal-only",
          reason: recheck.reason,
        };
      }
      const signaled = await options.runtimeProcess.signalExact(
        { pid: options.pid, processStartedAt: options.processStartedAt },
        "SIGTERM",
        { abortSignal: cleanup.signal },
      );
      exactSignalUsed = true;
      if (!signaled) {
        return {
          stopped: false,
          portReleased: false,
          uncertain: true,
          method: browserCloseAttempted ? "browser-close-then-signal" : "exact-signal-only",
          reason: "Exact SIGTERM failed after Browser.close; residual authority preserved.",
        };
      }
      const signalDeadline = deadline;
      while (Date.now() < signalDeadline) {
        stillAlive = await options.runtimeProcess.isAlive(
          options.pid,
          options.processStartedAt,
          { abortSignal: cleanup.signal },
        );
        if (!stillAlive) break;
        await sleep(options.pollMs, cleanup.signal);
      }
    }

    stillAlive = await options.runtimeProcess.isAlive(
      options.pid,
      options.processStartedAt,
      { abortSignal: cleanup.signal },
    );
    const method: Phase0CleanupMethod =
      browserCloseOk && exactSignalUsed
        ? "browser-close-then-signal"
        : browserCloseOk && !exactSignalUsed
          ? "browser-close-only"
          : exactSignalUsed
            ? "exact-signal-only"
            : "none";
    if (stillAlive) {
      return {
        stopped: false,
        portReleased: false,
        uncertain: true,
        method,
        reason: `Exact development PID ${options.pid} did not exit within the cleanup bound.`,
      };
    }

    // After the exact ChatGPT PID exits, stop private-root helpers (computer-use
    // services, crashpad-adjacent helpers under our profile/CODEX_HOME) that may
    // otherwise orphan a 9444 listener.
    if (options.privateRoots !== undefined && options.privateRoots.length > 0) {
      await stopPrivateRootHelpers({
        commands: options.commands,
        runtimeProcess: options.runtimeProcess,
        privateRoots: options.privateRoots,
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
        signal: cleanup.signal,
      });
    }

    const ports = createNodePortInventoryAdapter(options.commands);
    const listeners = await ports.listenersFor(DEV_CDP_PORT, { signal: cleanup.signal });
    // Stopped proven authority requires zero remaining 9444 listeners.
    if (listeners.length > 0) {
      const stillOwned = listeners.some((entry) => entry.pid === options.pid);
      if (stillOwned) {
        return {
          stopped: true,
          portReleased: false,
          uncertain: true,
          method,
          reason: "Process exited but 9444 was not released; residual authority preserved.",
        };
      }
      const inventory = createNodeProcessInventoryAdapter({
        commands: options.commands,
        exactProcess: options.runtimeProcess,
      });
      const live = await inventory.list({ signal: cleanup.signal });
      const privateHolders = live.filter(
        (entry) =>
          listeners.some((listener) => listener.pid === entry.pid) &&
          (options.privateRoots ?? []).some(
            (root) =>
              entry.executablePath === root ||
              entry.executablePath.startsWith(`${root}/`) ||
              entry.arguments.some(
                (token) => token === root || token.startsWith(`${root}/`),
              ),
          ),
      );
      if (privateHolders.length > 0) {
        return {
          stopped: true,
          portReleased: false,
          uncertain: true,
          method,
          reason:
            "Private-root helper still holds 9444 after ChatGPT exit; residual authority preserved.",
        };
      }
      return {
        stopped: true,
        portReleased: false,
        uncertain: true,
        method,
        reason:
          "9444 still has a non-development listener after exact ChatGPT exit; residual authority preserved.",
      };
    }
    return {
      stopped: true,
      portReleased: true,
      uncertain: false,
      method,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Cleanup failed with an unknown error.";
    return {
      stopped: false,
      portReleased: false,
      uncertain: true,
      method: "none",
      reason: message,
    };
  } finally {
    cleanup.dispose();
  }
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
  let matchedPid: number | null = null;
  let collectedProcess: Phase0OperationProcessEvidence | null = null;
  let residualAuthority = false;
  let side: Phase0ExperimentSideObservation = sideFromFailure(
    built.descriptor,
    options.privateRoot,
  );

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
      return {
        side: sideFromFailure(built.descriptor, options.privateRoot),
        process: null,
        residualAuthority: false,
      };
    }
    processStartedAt = matched.processStartedAt;
    matchedPid = matched.process.pid;

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
    collectedProcess = collected.process;

    const exactMarkerPresent = matched.process.arguments.some(
      (token) => token === options.marker.value,
    );
    side = {
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
      ownershipAccepted:
        options.plan.useCdpPort && options.plan.useExactMarker
          ? collected.ownership.owned
          : false,
    };
  } catch {
    side = sideFromFailure(built.descriptor, options.privateRoot);
    collectedProcess = null;
  } finally {
    // Every experiment spawn is enclosed by exact cleanup using a fresh finite cleanup context.
    if (spawned !== null && processStartedAt !== null && matchedPid !== null) {
      let stop: StopExactProcessResult;
      if (options.plan.useCdpPort && options.plan.useExactMarker) {
        stop = await stopExactProcess({
          runtimeProcess: options.runtimeProcess,
          commands: options.commands,
          cdp: options.cdp,
          pid: matchedPid,
          processStartedAt,
          executablePath: options.frozenHost.executablePath,
          marker: options.marker.value,
          timeoutMs: options.stopTimeoutMs,
          pollMs: options.pollMs,
          expectedTargetId: collectedProcess?.targetId ?? null,
          expectedContextUniqueId: collectedProcess?.executionContextUniqueId ?? null,
          privateRoots: [
            options.privateRoot,
            layout.electronUserDataPath,
            layout.codexHomePath,
            layout.explodexStatePath,
          ],
        });
      } else {
        const cleanup = createCleanupContext(options.stopTimeoutMs + 2_000);
        try {
          await options.runtimeProcess.signalExact(
            { pid: matchedPid, processStartedAt },
            "SIGTERM",
            { abortSignal: cleanup.signal },
          );
          const deadline = Date.now() + options.stopTimeoutMs;
          let alive = true;
          while (Date.now() < deadline) {
            alive = await options.runtimeProcess.isAlive(matchedPid, processStartedAt, {
              abortSignal: cleanup.signal,
            });
            if (!alive) break;
            await sleep(options.pollMs, cleanup.signal);
          }
          stop = {
            stopped: !alive,
            portReleased: true,
            uncertain: alive,
            method: "exact-signal-only",
            reason: alive
              ? `Exact experiment PID ${matchedPid} did not exit within the cleanup bound.`
              : undefined,
          };
        } catch (error) {
          stop = {
            stopped: false,
            portReleased: false,
            uncertain: true,
            method: "exact-signal-only",
            reason: error instanceof Error ? error.message : "experiment cleanup failed",
          };
        } finally {
          cleanup.dispose();
        }
      }
      residualAuthority = stop.uncertain || !stop.stopped;
      if (side.launched) {
        side = {
          ...side,
          ownershipAccepted:
            options.plan.useCdpPort && options.plan.useExactMarker
              ? side.ownershipAccepted && stop.stopped && !stop.uncertain
              : false,
        };
      }
      if (stop.stopped && !stop.uncertain) {
        try {
          const { rm } = await import("node:fs/promises");
          // Reclaim the entire private experiment root, not only profile subtrees.
          await rm(options.privateRoot, { recursive: true, force: true });
        } catch {
          // Disk reclamation is best-effort and never changes ownership conclusions.
        }
      }
    } else if (spawned !== null) {
      // Spawned child without independently proven PID/start authority is never clean.
      // identify(null) alone is not exit confirmation; require wait() and zero 9444 listeners.
      const cleanup = createCleanupContext(options.stopTimeoutMs + 2_000);
      residualAuthority = true;
      try {
        try {
          spawned.kill("SIGTERM");
        } catch {
          // Kill failure preserves residual authority.
        }
        let childExitConfirmed = false;
        const waitPromise = spawned
          .wait()
          .then(() => {
            childExitConfirmed = true;
          })
          .catch(() => undefined);
        const deadline = Date.now() + options.stopTimeoutMs;
        while (Date.now() < deadline && !childExitConfirmed) {
          try {
            await options.runtimeProcess.identify(spawned.pid, {
              abortSignal: cleanup.signal,
            });
          } catch {
            break;
          }
          await Promise.race([
            waitPromise,
            sleep(options.pollMs, cleanup.signal).catch(() => undefined),
          ]);
        }
        const ports = createNodePortInventoryAdapter(options.commands);
        const listeners = await ports.listenersFor(DEV_CDP_PORT, {
          signal: cleanup.signal,
        });
        // Residual authority remains unless child exit is confirmed and 9444 is free.
        if (!(childExitConfirmed && listeners.length === 0)) {
          residualAuthority = true;
        }
      } catch {
        residualAuthority = true;
      } finally {
        cleanup.dispose();
      }
    }
  }

  return {
    side,
    process: collectedProcess,
    residualAuthority,
  };
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
  protectedMains?: readonly ProtectedMainObservation[];
}): Phase0OwnershipEvidence {
  const negatives = controlledOwnershipNegatives({
    expected: options.expected,
    developmentPid: options.developmentPid,
    developmentStartedAt: options.developmentStartedAt,
    protectedMains: options.protectedMains,
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
  const protectedMainCandidates = beforeProcesses.filter(
    (entry) =>
      entry.executablePath.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT") &&
      !entry.arguments.some((token) => token.startsWith("--explodex-dev-instance=")),
  );
  const protectedMainIdentities: Array<{
    pid: number;
    processStartedAt: string;
    executablePath: string;
    arguments: string[];
  }> = [];
  for (const candidate of protectedMainCandidates) {
    const identity = await runtimeProcess.identify(candidate.pid, {
      abortSignal: options.signal,
    });
    if (identity === null) {
      return disabledResult(
        `Unable to resolve protected-main kernel start identity for PID ${candidate.pid}; abort without authority transfer.`,
        "protected_main_identity_unresolved",
      );
    }
    protectedMainIdentities.push({
      pid: identity.pid,
      processStartedAt: identity.processStartedAt,
      executablePath: candidate.executablePath,
      arguments: [...candidate.arguments],
    });
  }

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
      try {
        return await runPhase0LockedBody({
          options,
          runtimeProcess,
          runtimeAdapters,
          commands,
          cdp,
          spawnAdapter,
          protectedPaths,
          osHome,
          layout,
          frozenHost,
          protectedMainIdentities,
          identity,
          readinessTimeoutMs,
          stopTimeoutMs,
          pollMs,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Phase 0 authority write or operation failed; residual authority remains non-authorizing.";
        const incomplete = createPreSpawnIncompleteContract({
          frozenHost,
          reason: message,
          acceptanceOperationId: identity.operationId,
        });
        return {
          ok: false as const,
          result: {
            ok: false as const,
            contract: incomplete,
            allowsLifecycleMutation: false as const,
            allowsCompatibilityProbe: false as const,
            layout,
            frozenHost,
            process: null,
            protectedMainSurvived: true,
            grantsOwnershipFromPathsOnly: false as const,
            error: {
              code: "phase0_write_failure",
              message,
            },
          },
        };
      }
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

async function runPhase0LockedBody(input: {
  options: Phase0OperationOptions;
  runtimeProcess: RuntimeProcess;
  runtimeAdapters: RuntimeAdapters;
  commands: ReadOnlyCommandRunner;
  cdp: CdpAdapter;
  spawnAdapter: LaunchSpawnAdapter;
  protectedPaths: ProtectedPathSet;
  osHome: string;
  layout: DevLayoutPaths;
  frozenHost: Phase0FrozenHost;
  protectedMainIdentities: Array<{
    pid: number;
    processStartedAt: string;
    executablePath: string;
    arguments: string[];
  }>;
  identity: OperationIdentity;
  readinessTimeoutMs: number;
  stopTimeoutMs: number;
  pollMs: number;
}): Promise<{ ok: true; result: Phase0OperationResult } | { ok: false; result: Phase0OperationResult }> {
  const {
    options,
    runtimeProcess,
    commands,
    cdp,
    spawnAdapter,
    protectedPaths,
    osHome,
    layout,
    frozenHost,
    protectedMainIdentities,
    identity,
    readinessTimeoutMs,
    stopTimeoutMs,
    pollMs,
  } = input;
  {
      // Invalidate any residual schema-1 / rejected proof before first spawn.
      const preSpawn = createPreSpawnIncompleteContract({
        frozenHost,
        acceptanceOperationId: identity.operationId,
      });
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
        frozenHost,
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
          acceptanceOperationId: identity.operationId,
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
      if (
        options.providedComparativeExperiments !== undefined &&
        options.providedComparativeExperiments.length > 0
      ) {
        for (const experiment of options.providedComparativeExperiments) {
          comparativeExperiments.push(experiment);
        }
      }
      let acceptanceProcess: Phase0OperationProcessEvidence | null = null;
      let acceptanceReadiness: Phase0ReadinessEvidence | null = null;
      let acceptanceOwnership: ReturnType<typeof classifyDevelopmentOwnership> | null = null;
      let residualAuthority = false;

      // Each treatment/control must use a distinct experiment identity and fresh private roots.
      // Boolean-plan caching that replays one launch across knob identities is forbidden.
      const runFreshSide = async (
        knob: Phase0CandidateKnob,
        sideName: "treatment" | "control",
        plan: Phase0LaunchPlan,
        sequence: number,
      ): Promise<{
        side: Phase0ExperimentSideObservation;
        process: Phase0OperationProcessEvidence | null;
        residualAuthority: boolean;
      }> => {
        const privateRoot = join(
          layout.rootPath,
          "experiments",
          knob,
          sideName,
          `run-${sequence}`,
        );
        return runOneExperimentLaunch({
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
      };

      let experimentSequence = 0;
      // Skip the isolation matrix only when caller supplies pre-validated comparative records.
      const skipMatrix = comparativeExperiments.length > 0;
      for (const plan of skipMatrix ? [] : plans) {
        experimentSequence += 1;
        const treatment = await runFreshSide(
          plan.knob,
          "treatment",
          plan.treatment,
          experimentSequence,
        );
        if (treatment.residualAuthority) residualAuthority = true;

        let controlSide: Phase0ExperimentSideObservation | null = null;
        if (plan.control !== null) {
          experimentSequence += 1;
          const control = await runFreshSide(
            plan.knob,
            "control",
            plan.control,
            experimentSequence,
          );
          if (control.residualAuthority) residualAuthority = true;
          controlSide = control.side;
        }

        const experimentRecord: Phase0ComparativeExperiment = {
          knob: plan.knob,
          experimentId: `phase0-${plan.knob}-${experimentSequence.toString(16)}-${Date.now().toString(16)}`,
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
        // Re-verify residual authority against live inventory/port before aborting.
        // A bounded race during experiment teardown must not block acceptance when no
        // experiment PID remains and 9444 is free.
        const inventory = createNodeProcessInventoryAdapter({
          commands,
          exactProcess: runtimeProcess,
        });
        const live = await inventory.list({ signal: options.signal });
        const residualLive = live.filter(
          (entry) =>
            entry.executablePath === frozenHost.executablePath &&
            entry.arguments.some((token) => token === marker.value),
        );
        const residualPorts = createNodePortInventoryAdapter(commands);
        const residualListeners = await residualPorts.listenersFor(DEV_CDP_PORT, {
          signal: options.signal,
        });
        const portStillHeld = residualListeners.some((entry) =>
          residualLive.some((process) => process.pid === entry.pid),
        );
        if (residualLive.length > 0 || portStillHeld) {
          const incomplete = evaluatePhase0LaunchContract({
            frozenHost,
            recheckedHost: frozenHost,
            comparativeExperiments,
            proposedMarker: marker,
            layout,
            clockIso: options.adapters.clock.nowIso(),
            acceptanceOperationId: identity.operationId,
            requireCompleteProof: true,
          });
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
            frozenHost,
            updatedAt: options.adapters.clock.nowIso(),
          });
          failedState.status = "failed";
          failedState.appVersion = frozenHost.appVersion;
          failedState.appBuild = frozenHost.appBuild;
          if (residualLive[0] !== undefined) {
            const identity = await runtimeProcess.identify(residualLive[0]!.pid, {
              abortSignal: options.signal,
            });
            failedState.pid = residualLive[0]!.pid;
            failedState.processStartedAt = identity?.processStartedAt ?? null;
            failedState.targetId = null;
            failedState.startedAt = null;
          }
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
        // No live residual process/port remains; clear the transient residual flag.
        residualAuthority = false;
      }

      // Dedicated acceptance launch on the primary layout with the retained set.
      const acceptancePlan: Phase0LaunchPlan = {
        useUserData: true,
        useCodexHome: true,
        useExplodexHome: false,
        useCdpPort: true,
        useExactMarker: true,
      };
      // Best-effort reclaim of comparative experiment roots before the correlated
      // acceptance launch so app:// readiness is not starved by disk pressure from
      // earlier private roots. Keep-alive acceptance preserves the primary
      // electron-user-data and codex-home so an interactive isolated-profile
      // sign-in (and later authenticated anchors) can survive across the probe.
      // Stopped Phase 0 acceptance still reclaims those primary roots for a clean
      // one-shot readiness matrix.
      try {
        const { rm } = await import("node:fs/promises");
        await rm(join(layout.rootPath, "experiments"), { recursive: true, force: true });
        if (!options.keepProcessAlive) {
          await rm(layout.electronUserDataPath, { recursive: true, force: true });
          await rm(layout.codexHomePath, { recursive: true, force: true });
        }
        await ensureDefaultDevLayout({
          fs: options.adapters.fs,
          rootPath: layout.rootPath,
          protectedPaths,
        });
      } catch {
        // Reclamation is best-effort; acceptance still uses the canonical layout paths.
      }
      const acceptanceBuilt = buildPlanForRoot({
        frozenHost,
        layout,
        marker,
        plan: acceptancePlan,
      });
      const logsStdout = join(layout.logsPath, "phase0.stdout.log");
      const logsStderr = join(layout.logsPath, "phase0.stderr.log");
      let acceptanceSpawned: SpawnedProcess | null = null;
      let acceptanceStartedAt: string | null = null;
      let evaluation: ReturnType<typeof evaluatePhase0LaunchContract> | null = null;
      let ownershipEvidence: Phase0OwnershipEvidence | null = null;
      let recheckedHost: Phase0FrozenHost | null = null;
      let protectedMainSurvived = true;
      let cleanupUncertain = false;
      let cleanupReason: string | undefined;
      let cleanupDisposition: Phase0AcceptanceAuthority["cleanupDisposition"] = {
        method: "none",
        stopped: false,
        portReleased: false,
        uncertain: true,
        reason: "Acceptance cleanup not yet performed.",
      };
      let finalHostRecheck: Phase0FrozenHost | null = null;
      const protectedMainAfter: Phase0AcceptanceAuthority["protectedMainAfter"] = [];

      try {
        acceptanceSpawned = await spawnAdapter.spawn({
          executablePath: acceptanceBuilt.executablePath,
          argv: acceptanceBuilt.argv,
          env: acceptanceBuilt.env,
          stdoutPath: logsStdout,
          stderrPath: logsStderr,
          inheritHostEnvironment: true,
        });

        const matched = await waitForExactDevProcess({
          commands,
          runtimeProcess,
          executablePath: frozenHost.executablePath,
          marker: marker.value,
          expectedPid: acceptanceSpawned.pid,
          timeoutMs: readinessTimeoutMs,
          pollMs,
          signal: options.signal,
        });
        if (matched === null) {
          // Leave acceptanceStartedAt null so finally uses unidentified-spawn residual cleanup.
          // Do not throw: a throw after finally would be misclassified as write_failure and
          // would skip residual incomplete evaluation/write.
          cleanupReason =
            `Timed out waiting for isolated development ChatGPT process with exact marker on PID ${acceptanceSpawned.pid}`;
        } else {
          acceptanceStartedAt = matched.processStartedAt;

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
            clockIso: options.adapters.clock.nowIso(),
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
          recheckedHost = freezeHostIdentity(recheck.host);
          if (!frozenHostEquals(frozenHost, recheckedHost)) {
            throw new Error(
              "Active-operation host identity drifted from the frozen Phase 0 identity; abort without reconnect or authority transfer.",
            );
          }

          ownershipEvidence = buildOwnershipEvidence({
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
            protectedMains: protectedMainIdentities,
          });
        }
      } finally {
        // Acceptance spawn cleanup always uses a fresh finite cleanup context, never the
        // possibly-aborted operation signal.
        if (
          !options.keepProcessAlive &&
          acceptanceProcess !== null &&
          acceptanceStartedAt !== null
        ) {
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
            expectedTargetId: acceptanceProcess.targetId,
            expectedContextUniqueId: acceptanceProcess.executionContextUniqueId,
            privateRoots: [
              layout.rootPath,
              layout.electronUserDataPath,
              layout.codexHomePath,
              layout.explodexStatePath,
            ],
          });
          cleanupDisposition = {
            method: stop.method,
            stopped: stop.stopped,
            portReleased: stop.portReleased,
            uncertain: stop.uncertain,
            ...(stop.reason !== undefined ? { reason: stop.reason } : {}),
          };
          if (!stop.stopped || !stop.portReleased || stop.uncertain) {
            cleanupUncertain = true;
            cleanupReason =
              stop.reason ??
              "Exact exit and 9444 release did not both complete; residual authority preserved.";
          }
        } else if (
          !options.keepProcessAlive &&
          acceptanceSpawned !== null &&
          acceptanceStartedAt === null
        ) {
          // Unidentified spawned child: never treat identify(null) alone as confirmed exit.
          // Require child-exit confirmation via wait(), and zero remaining 9444 listeners.
          const cleanup = createCleanupContext(stopTimeoutMs + 2_000);
          try {
            let killFailed = false;
            try {
              acceptanceSpawned.kill("SIGTERM");
            } catch {
              killFailed = true;
              cleanupUncertain = true;
            }
            let childExitConfirmed = false;
            let identityUnobservable = false;
            let pidReuseAmbiguity = false;
            let waitTimedOut = false;
            const waitPromise = acceptanceSpawned
              .wait()
              .then(() => {
                childExitConfirmed = true;
              })
              .catch(() => {
                // wait() rejection is not certain exit.
              });
            const deadline = Date.now() + stopTimeoutMs;
            while (Date.now() < deadline && !childExitConfirmed) {
              let identity: { pid: number; processStartedAt: string } | null = null;
              try {
                identity = await runtimeProcess.identify(acceptanceSpawned.pid, {
                  abortSignal: cleanup.signal,
                });
              } catch {
                identityUnobservable = true;
                break;
              }
              // identify(null) alone is not exit confirmation: PID may have been reused
              // and exited, or the identity may simply be unobservable without start proof.
              if (identity !== null) {
                // A live PID without known start identity is residual authority.
                // If start identity appears but we never had a baseline, treat as ambiguity.
                pidReuseAmbiguity = true;
              }
              await Promise.race([
                waitPromise,
                sleep(pollMs, cleanup.signal).catch(() => undefined),
              ]);
            }
            if (!childExitConfirmed) {
              waitTimedOut = true;
            }
            const ports = createNodePortInventoryAdapter(commands);
            const listeners = await ports.listenersFor(DEV_CDP_PORT, {
              signal: cleanup.signal,
            });
            // Any remaining 9444 listener (not only the spawned PID) is residual authority.
            const anyListenerRemains = listeners.length > 0;
            const uncertain =
              killFailed ||
              waitTimedOut ||
              !childExitConfirmed ||
              identityUnobservable ||
              pidReuseAmbiguity ||
              anyListenerRemains;
            cleanupDisposition = {
              method: "none",
              stopped: childExitConfirmed && !uncertain,
              portReleased: !anyListenerRemains,
              uncertain: true,
              reason:
                "Unidentified spawned child cleanup cannot prove exact exit/start identity and 9444 release; residual authority preserved.",
            };
            cleanupUncertain = true;
            cleanupReason = cleanupDisposition.reason!;
            void uncertain;
          } catch (error) {
            cleanupUncertain = true;
            cleanupReason =
              error instanceof Error
                ? error.message
                : "Unidentified spawned child cleanup failed; residual authority preserved.";
            cleanupDisposition = {
              method: "none",
              stopped: false,
              portReleased: false,
              uncertain: true,
              reason: cleanupReason,
            };
          } finally {
            cleanup.dispose();
          }
        } else if (options.keepProcessAlive && acceptanceProcess !== null) {
          // Intentional keep-alive for the exact-current-host compatibility probe.
          // Residual owned 9444 authority is recorded explicitly; never claim stopped.
          cleanupDisposition = {
            method: "none",
            stopped: false,
            portReleased: false,
            uncertain: false,
            reason:
              "intentional-keep-alive: acceptance process left alive for exact compatibility probe",
          };
          cleanupUncertain = false;
        }

        for (const protectedMain of protectedMainIdentities) {
          const alive = await runtimeProcess.isAlive(
            protectedMain.pid,
            protectedMain.processStartedAt,
            { abortSignal: undefined },
          );
          protectedMainAfter.push({
            pid: protectedMain.pid,
            processStartedAt: protectedMain.processStartedAt,
            survived: alive,
          });
          if (!alive) {
            protectedMainSurvived = false;
            cleanupReason =
              cleanupReason ??
              `Protected authoring main PID ${protectedMain.pid} did not survive Phase 0; fail closed.`;
          }
        }

        // Final host recheck before any proven write.
        const finalHost = await inspectCanonicalHost(options.adapters);
        if (!finalHost.ok || finalHost.host === null) {
          cleanupUncertain = true;
          cleanupReason =
            cleanupReason ?? "Final host recheck failed; proof remains non-authorizing.";
        } else {
          finalHostRecheck = freezeHostIdentity(finalHost.host);
          if (!frozenHostEquals(frozenHost, finalHostRecheck)) {
            cleanupUncertain = true;
            cleanupReason =
              cleanupReason ??
              "Final frozen-host recheck drifted; abort without proven authority transfer.";
          }
        }
      }

      // Proven evaluation happens only after cleanup/survivors/final host are known.
      if (
        !cleanupUncertain &&
        protectedMainSurvived &&
        acceptanceProcess !== null &&
        acceptanceReadiness !== null &&
        ownershipEvidence !== null &&
        recheckedHost !== null &&
        finalHostRecheck !== null
      ) {
        const protectedMainBefore: Phase0ProtectedMainObservation[] =
          protectedMainIdentities.map((entry) => {
            const verdict = classifyDevelopmentOwnership({
              role: "protected-main",
              pid: entry.pid,
              processStartedAt: entry.processStartedAt,
              executablePath: entry.executablePath,
              arguments: entry.arguments,
              portOwnerPid: null,
              port: 9333,
              endpointHost: DEV_CDP_HOST,
              browserIdentity: null,
              targetIds: [],
              defaultExecutionContextCount: 0,
              expected: {
                marker: marker.value,
                executablePath: frozenHost.executablePath,
                cdpHost: DEV_CDP_HOST,
                cdpPort: DEV_CDP_PORT,
              },
            });
            return {
              pid: entry.pid,
              processStartedAt: entry.processStartedAt,
              executablePath: entry.executablePath,
              arguments: [...entry.arguments],
              expectedVerdict: {
                owned: false as const,
                code: verdict.code,
              },
            };
          });
        const acceptanceAuthority: Phase0AcceptanceAuthority = {
          operationId: identity.operationId,
          readinessPid: acceptanceReadiness.pid,
          readinessProcessStartedAt: acceptanceReadiness.processStartedAt,
          protectedMainInventoryAttested: true,
          protectedMainBefore,
          protectedMainAfter,
          finalHostRecheck,
          cleanupDisposition,
          port9444Released: cleanupDisposition.portReleased && !cleanupDisposition.uncertain,
          mode: options.keepProcessAlive ? "keep-alive" : "stopped",
        };
        evaluation = evaluatePhase0LaunchContract({
          frozenHost,
          recheckedHost,
          comparativeExperiments,
          proposedMarker: marker,
          layout,
          clockIso: options.adapters.clock.nowIso(),
          readiness: acceptanceReadiness,
          ownership: ownershipEvidence,
          acceptanceLaunchDescriptor: acceptanceBuilt.descriptor,
          acceptanceAuthority,
          acceptanceOperationId: identity.operationId,
          requireCompleteProof: true,
        });
      } else {
        evaluation = evaluatePhase0LaunchContract({
          frozenHost,
          recheckedHost: recheckedHost ?? frozenHost,
          comparativeExperiments,
          proposedMarker: marker,
          layout,
          clockIso: options.adapters.clock.nowIso(),
          readiness: acceptanceReadiness,
          ownership: ownershipEvidence,
          acceptanceLaunchDescriptor: acceptanceBuilt.descriptor,
          acceptanceAuthority: null,
          acceptanceOperationId: identity.operationId,
          requireCompleteProof: true,
        });
      }

      if (
        evaluation === null ||
        cleanupUncertain ||
        !protectedMainSurvived ||
        evaluation.contract.status !== "proven"
      ) {
        const reason =
          cleanupReason ??
          (!protectedMainSurvived
            ? "Protected authoring main did not survive Phase 0; fail closed."
            : evaluation?.contract.reason ?? "Phase 0 launch-isolation proof incomplete");
        const incompleteContract = {
          ...(evaluation?.contract ??
            createPreSpawnIncompleteContract({
              frozenHost,
              reason,
              acceptanceOperationId: identity.operationId,
            })),
          status: "incomplete" as const,
          provenAt: null,
          acceptanceAuthority: null,
          acceptanceOperationId: identity.operationId,
          reason,
          comparativeExperiments,
          readiness: acceptanceReadiness,
        };
        const failedState = createInitialDevInstanceState({
          layout,
          appPath: frozenHost.bundlePath,
          executablePath: frozenHost.executablePath,
          launchMarker: marker.value,
          frozenHost,
          updatedAt: options.adapters.clock.nowIso(),
        });
        failedState.status = "failed";
        failedState.appVersion = frozenHost.appVersion;
        failedState.appBuild = frozenHost.appBuild;
        if (cleanupUncertain && acceptanceProcess !== null) {
          // Preserve residual identity; do not claim stopped.
          failedState.pid = acceptanceProcess.pid;
          failedState.processStartedAt = acceptanceProcess.processStartedAt;
          failedState.targetId = null;
          failedState.startedAt = null;
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

      // Success path: instance state first (stopped or keep-alive ready), proven contract last.
      const nextState = createInitialDevInstanceState({
        layout,
        appPath: frozenHost.bundlePath,
        executablePath: frozenHost.executablePath,
        launchMarker: marker.value,
        frozenHost,
        updatedAt: options.adapters.clock.nowIso(),
      });
      nextState.appVersion = frozenHost.appVersion;
      nextState.appBuild = frozenHost.appBuild;
      if (options.keepProcessAlive && acceptanceProcess !== null) {
        nextState.status = "ready";
        nextState.pid = acceptanceProcess.pid;
        nextState.processStartedAt = acceptanceProcess.processStartedAt;
        nextState.targetId = acceptanceProcess.targetId;
        nextState.browserIdentity = acceptanceProcess.browserIdentity;
        nextState.executionContextId = acceptanceProcess.executionContextId;
        nextState.executionContextUniqueId =
          acceptanceProcess.executionContextUniqueId;
        nextState.frameId = acceptanceProcess.frameId;
        nextState.startedAt = options.adapters.clock.nowIso();
      } else {
        nextState.status = "stopped";
        nextState.pid = null;
        nextState.processStartedAt = null;
        nextState.targetId = null;
        nextState.startedAt = null;
      }
      await saveDevInstanceState({
        adapters: options.adapters,
        statePath: layout.statePath,
        state: nextState,
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
  }
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
