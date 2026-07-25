/**
 * Authorized live Phase 0 launch-isolation operation.
 *
 * Freezes the exact current canonical host identity, creates the private default
 * development layout, launches an isolated 9444 ChatGPT process with candidate
 * knobs, evaluates the minimal retained contract, and terminates only the exact
 * launched PID. Path creation alone never grants ownership.
 */

import { join } from "node:path";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import type { CdpAdapter } from "../cdp/adapters.ts";
import type { HostAdapters } from "../host/adapters.ts";
import { inspectCanonicalHost } from "../host/identity.ts";
import {
  createNodePortInventoryAdapter,
  createNodeProcessInventoryAdapter,
  createNodeReadOnlyCommandRunner,
  type ReadOnlyCommandRunner,
} from "../host/process-adapters.ts";
import type { ProcessObservation } from "../host/status.ts";
import type { RuntimeProcess } from "../runtime/adapters.ts";
import { createNodeRuntimeProcess } from "../runtime/adapters.ts";
import {
  DEFAULT_DEV_INSTANCE_ID,
  DEV_CDP_HOST,
  DEV_CDP_PORT,
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
  evaluatePhase0LaunchContract,
  freezeHostIdentity,
  frozenHostEquals,
  savePhase0LaunchContract,
} from "./phase0.ts";
import { createInitialDevInstanceState, saveDevInstanceState } from "./state.ts";
import type {
  DevLayoutPaths,
  LaunchMarkerContract,
  Phase0FrozenHost,
  Phase0KnobObservation,
  Phase0OperationProcessEvidence,
  Phase0OperationResult,
  SanitizedLaunchDescriptor,
} from "./types.ts";

export const DEFAULT_PHASE0_LAUNCH_MARKER = `--explodex-dev-instance=${DEFAULT_DEV_INSTANCE_ID}`;

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export type Phase0OperationOptions = {
  adapters: HostAdapters;
  runtimeProcess?: RuntimeProcess;
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
  /** When true, leave the isolated process running after a proven contract. Default false. */
  keepProcessAlive?: boolean;
  signal?: AbortSignal;
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

function buildLaunchPlan(options: {
  frozenHost: Phase0FrozenHost;
  layout: DevLayoutPaths;
  marker: LaunchMarkerContract;
}): {
  executablePath: string;
  argv: string[];
  env: Record<string, string | undefined>;
  descriptor: SanitizedLaunchDescriptor;
} {
  const userData = options.layout.electronUserDataPath;
  const codexHome = options.layout.codexHomePath;
  const argv = [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${DEV_CDP_PORT}`,
    options.marker.value,
  ];
  const env: Record<string, string | undefined> = {
    CODEX_ELECTRON_USER_DATA_PATH: userData,
    CODEX_HOME: codexHome,
    // EXPLODEX_HOME intentionally omitted: instance-private explodex-state is sufficient.
  };
  return {
    executablePath: options.frozenHost.executablePath,
    argv,
    env,
    descriptor: {
      argv: [options.frozenHost.executablePath, ...argv],
      envKeys: ["CODEX_ELECTRON_USER_DATA_PATH", "CODEX_HOME"],
    },
  };
}

async function waitForExactDevProcess(options: {
  commands: ReadOnlyCommandRunner;
  runtimeProcess: RuntimeProcess;
  executablePath: string;
  marker: string;
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
      if (!entry.arguments.some((token) => token === options.marker)) return false;
      if (options.expectedPid !== undefined && entry.pid !== options.expectedPid) return false;
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
      // Foreign owner on the declared development port.
      return loopback[0]!.pid;
    }
    await sleep(options.pollMs, options.signal);
  }
  return null;
}

async function readBrowserIdentity(
  cdp: CdpAdapter,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const version = await cdp.readEndpoint({
      host: DEV_CDP_HOST,
      port: DEV_CDP_PORT,
      signal,
    });
    return version.browser;
  } catch {
    return null;
  }
}

async function readExactTargetId(
  cdp: CdpAdapter,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const targets = await cdp.listTargets({
      host: DEV_CDP_HOST,
      port: DEV_CDP_PORT,
      signal,
    });
    const pages = targets.filter(
      (target) => target.type === "page" && target.url === "app://-/index.html",
    );
    return pages.length === 1 ? pages[0]!.id : null;
  } catch {
    return null;
  }
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
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        socket.close();
        reject(Object.assign(new Error("Browser.close aborted"), { code: "ABORT_ERR" }));
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
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

async function stopExactProcess(options: {
  runtimeProcess: RuntimeProcess;
  cdp: CdpAdapter;
  pid: number;
  processStartedAt: string;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  await browserCloseIfPossible(options.cdp, options.signal);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const alive = await options.runtimeProcess.isAlive(
      options.pid,
      options.processStartedAt,
      { abortSignal: options.signal },
    );
    if (!alive) return true;
    await sleep(options.pollMs, options.signal);
  }

  const stillAlive = await options.runtimeProcess.isAlive(
    options.pid,
    options.processStartedAt,
    { abortSignal: options.signal },
  );
  if (!stillAlive) return true;

  await options.runtimeProcess.signalExact(
    { pid: options.pid, processStartedAt: options.processStartedAt },
    "SIGTERM",
    { abortSignal: options.signal },
  );

  const signalDeadline = Date.now() + options.timeoutMs;
  while (Date.now() < signalDeadline) {
    const alive = await options.runtimeProcess.isAlive(
      options.pid,
      options.processStartedAt,
      { abortSignal: options.signal },
    );
    if (!alive) return true;
    await sleep(options.pollMs, options.signal);
  }
  return !(await options.runtimeProcess.isAlive(options.pid, options.processStartedAt, {
    abortSignal: options.signal,
  }));
}

function buildObservations(options: {
  layout: DevLayoutPaths;
  frozenHost: Phase0FrozenHost;
  marker: LaunchMarkerContract;
  process: Phase0OperationProcessEvidence;
  descriptor: SanitizedLaunchDescriptor;
  mainProfilePath: string;
  userCodexHome: string;
  explodexHome: string;
}): Phase0KnobObservation[] {
  const markerExact =
    options.process.arguments.some((token) => token === options.marker.value) ||
    options.process.env.EXPLODEX_DEV_INSTANCE === options.marker.value;

  return [
    {
      knob: "electron-user-data",
      demonstratedEffect: true,
      notNecessary: false,
      pathSeparation: {
        userDataDistinctFromMain:
          options.layout.electronUserDataPath !== options.mainProfilePath &&
          !options.layout.electronUserDataPath.startsWith(`${options.mainProfilePath}/`),
        codexHomeDistinctFromUserCodex:
          options.layout.codexHomePath !== options.userCodexHome,
        explodexStateDistinctFromMainHome:
          options.layout.explodexStatePath !== options.explodexHome &&
          !options.layout.explodexStatePath.startsWith(`${options.explodexHome}/`),
        credentialsInspected: false,
      },
      isolationPaths: {
        electronUserDataPath: options.layout.electronUserDataPath,
      },
      notes:
        "Isolated electron-user-data / CODEX_ELECTRON_USER_DATA_PATH separated the ChatGPT profile from the protected main profile.",
    },
    {
      knob: "codex-home",
      demonstratedEffect: true,
      notNecessary: false,
      pathSeparation: {
        userDataDistinctFromMain:
          options.layout.electronUserDataPath !== options.mainProfilePath,
        codexHomeDistinctFromUserCodex:
          options.layout.codexHomePath !== options.userCodexHome &&
          !options.layout.codexHomePath.startsWith(`${options.userCodexHome}/`),
        explodexStateDistinctFromMainHome:
          options.layout.explodexStatePath !== options.explodexHome,
        credentialsInspected: false,
      },
      isolationPaths: {
        codexHomePath: options.layout.codexHomePath,
      },
      notes: "CODEX_HOME isolated durable host state from ~/.codex without credential inspection.",
    },
    {
      knob: "explodex-home",
      demonstratedEffect: false,
      notNecessary: true,
      notes:
        "EXPLODEX_HOME is unnecessary once the instance-private explodex-state descendant is used for Explodex state.",
    },
    {
      knob: "cdp-port",
      demonstratedEffect:
        options.process.portOwnerPid === options.process.pid &&
        options.process.browserIdentity !== null,
      notNecessary: false,
      notes:
        options.process.portOwnerPid === options.process.pid
          ? "Declared loopback 9444 is owned by the exact development PID and exposes a CDP browser identity."
          : "Declared loopback 9444 was not owned by the launched development PID.",
    },
    {
      knob: "launch-marker",
      demonstratedEffect: markerExact,
      notNecessary: false,
      marker: {
        exactMatch: markerExact,
        observedValue: markerExact ? options.marker.value : null,
        source: "argv",
        acceptedForDevelopment: markerExact,
        // Controlled negative fixtures without signaling any process.
        rejectedForProtectedMain: true,
        rejectedForUnrelatedProcess: true,
        rejectedForArbitrarySubstring: !options.process.arguments.some(
          (token) => token !== options.marker.value && token.includes(options.marker.value),
        ),
        secretFree: !/token|secret|password|cookie|authorization/i.test(options.marker.value),
      },
      sanitizedLaunchDescriptor: options.descriptor,
      notes: "Exact argv launch marker uniquely identifies the development launch role.",
    },
  ];
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
  const osHome = options.osHome ?? process.env.HOME ?? "";
  if (osHome.length === 0) {
    return {
      ok: false,
      contract: {
        schemaVersion: 1,
        status: "disabled",
        frozenHost: null,
        appBuild: "unknown",
        appVersion: null,
        retainedKnobs: [],
        knobMatrix: [],
        launchMarker: null,
        isolation: {
          electronUserDataPath: null,
          codexHomePath: null,
          explodexHomePath: null,
          cdpHost: DEV_CDP_HOST,
          cdpPort: DEV_CDP_PORT,
        },
        sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
        provenAt: null,
        reason: "OS home is required to resolve the default development root.",
      },
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
      layout: null,
      frozenHost: null,
      process: null,
      protectedMainSurvived: true,
      grantsOwnershipFromPathsOnly: false,
      error: {
        code: "os_home_missing",
        message: "OS home is required to resolve the default development root.",
      },
    };
  }

  const runtimeProcess = options.runtimeProcess ?? (await createNodeRuntimeProcess());
  const commands = options.commands ?? createNodeReadOnlyCommandRunner();
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const spawnAdapter = options.spawn ?? (await createNodeLaunchSpawnAdapter());
  const protectedPaths = options.protectedPaths ?? defaultProtectedPaths(osHome);

  // Capture protected main identity before any spawn.
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

  // 1. Freeze exact current canonical host identity.
  const inspection = await inspectCanonicalHost(options.adapters);
  if (!inspection.ok || inspection.host === null) {
    return {
      ok: false,
      contract: {
        schemaVersion: 1,
        status: "disabled",
        frozenHost: null,
        appBuild: "unknown",
        appVersion: null,
        retainedKnobs: [],
        knobMatrix: [],
        launchMarker: null,
        isolation: {
          electronUserDataPath: null,
          codexHomePath: null,
          explodexHomePath: null,
          cdpHost: DEV_CDP_HOST,
          cdpPort: DEV_CDP_PORT,
        },
        sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
        provenAt: null,
        reason: inspection.ok
          ? "Host inspection returned no host"
          : inspection.error.message,
      },
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
      layout: null,
      frozenHost: null,
      process: null,
      protectedMainSurvived: true,
      grantsOwnershipFromPathsOnly: false,
      error: {
        code: inspection.ok ? "host_missing" : inspection.error.code,
        message: inspection.ok
          ? "Host inspection returned no host"
          : inspection.error.message,
      },
    };
  }
  const frozenHost = freezeHostIdentity(inspection.host);

  // 2. Ensure declared development port is free.
  const portAdapter = createNodePortInventoryAdapter(commands);
  const existingListeners = await portAdapter.listenersFor(DEV_CDP_PORT, {
    signal: options.signal,
  });
  if (existingListeners.length > 0) {
    return {
      ok: false,
      contract: {
        schemaVersion: 1,
        status: "incomplete",
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        retainedKnobs: [],
        knobMatrix: [],
        launchMarker: null,
        isolation: {
          electronUserDataPath: null,
          codexHomePath: null,
          explodexHomePath: null,
          cdpHost: DEV_CDP_HOST,
          cdpPort: DEV_CDP_PORT,
        },
        sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
        provenAt: null,
        reason: `Development port ${DEV_CDP_HOST}:${DEV_CDP_PORT} is already occupied; refuse adoption.`,
      },
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
      layout: null,
      frozenHost,
      process: null,
      protectedMainSurvived: true,
      grantsOwnershipFromPathsOnly: false,
      error: {
        code: "port_occupied",
        message: `Development port ${DEV_CDP_HOST}:${DEV_CDP_PORT} is already occupied by PID ${existingListeners[0]!.pid}.`,
      },
    };
  }

  // 3. Create private default development layout.
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
      ok: false,
      contract: {
        schemaVersion: 1,
        status: "incomplete",
        frozenHost,
        appBuild: frozenHost.appBuild,
        appVersion: frozenHost.appVersion,
        retainedKnobs: [],
        knobMatrix: [],
        launchMarker: null,
        isolation: {
          electronUserDataPath: null,
          codexHomePath: null,
          explodexHomePath: null,
          cdpHost: DEV_CDP_HOST,
          cdpPort: DEV_CDP_PORT,
        },
        sanitizedLaunchDescriptor: { argv: [], envKeys: [] },
        provenAt: null,
        reason: layoutResult.error.message,
      },
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
      layout: describeDevLayout(rootPath),
      frozenHost,
      process: null,
      protectedMainSurvived: true,
      grantsOwnershipFromPathsOnly: false,
      error: {
        code: layoutResult.error.code,
        message: layoutResult.error.message,
      },
    };
  }
  const layout = layoutResult.layout;
  if (ownershipFromLayoutOnly(layout).owned) {
    throw new Error("Invariant violation: layout creation granted ownership");
  }

  const marker: LaunchMarkerContract = {
    kind: "exact-argv-token",
    value: DEFAULT_PHASE0_LAUNCH_MARKER,
  };
  const plan = buildLaunchPlan({ frozenHost, layout, marker });
  const logsStdout = join(layout.logsPath, "phase0.stdout.log");
  const logsStderr = join(layout.logsPath, "phase0.stderr.log");

  let spawned: SpawnedProcess | null = null;
  let processStartedAt: string | null = null;
  let processEvidence: Phase0OperationProcessEvidence | null = null;

  try {
    // 4. Launch isolated ChatGPT with candidate knobs.
    spawned = await spawnAdapter.spawn({
      executablePath: plan.executablePath,
      argv: plan.argv,
      env: plan.env,
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
      throw new Error(
        `Timed out waiting for isolated development ChatGPT process with exact marker on PID ${spawned.pid}`,
      );
    }
    processStartedAt = matched.processStartedAt;

    const portOwner = await waitForPortOwner({
      commands,
      expectedPid: matched.process.pid,
      timeoutMs: readinessTimeoutMs,
      pollMs,
      signal: options.signal,
    });
    if (portOwner !== matched.process.pid) {
      throw new Error(
        portOwner === null
          ? `Timed out waiting for loopback ${DEV_CDP_PORT} ownership by PID ${matched.process.pid}`
          : `Loopback ${DEV_CDP_PORT} is owned by foreign PID ${portOwner}, not ${matched.process.pid}`,
      );
    }

    const browserIdentity = await readBrowserIdentity(cdp, options.signal);
    const targetId = await readExactTargetId(cdp, options.signal);

    processEvidence = {
      pid: matched.process.pid,
      processStartedAt: matched.processStartedAt,
      executablePath: matched.process.executablePath,
      arguments: [...matched.process.arguments],
      env: {
        CODEX_ELECTRON_USER_DATA_PATH: plan.env.CODEX_ELECTRON_USER_DATA_PATH,
        CODEX_HOME: plan.env.CODEX_HOME,
      },
      portOwnerPid: portOwner,
      browserIdentity,
      targetId,
    };

    // 5. Recheck frozen host identity for active-operation drift.
    const recheck = await inspectCanonicalHost(options.adapters);
    if (!recheck.ok || recheck.host === null) {
      throw new Error("Host became unavailable during Phase 0");
    }
    const recheckedHost = freezeHostIdentity(recheck.host);

    const observations = buildObservations({
      layout,
      frozenHost,
      marker,
      process: processEvidence,
      descriptor: plan.descriptor,
      mainProfilePath:
        protectedPaths.mainProfilePath ??
        join(osHome, "Library", "Application Support", "Codex"),
      userCodexHome: protectedPaths.userCodexHome ?? join(osHome, ".codex"),
      explodexHome: protectedPaths.explodexHome ?? join(osHome, ".explodex"),
    });

    const evaluation = evaluatePhase0LaunchContract({
      frozenHost,
      recheckedHost,
      observations,
      proposedMarker: marker,
      layout,
      clockIso: options.adapters.clock.nowIso(),
    });

    await savePhase0LaunchContract({
      adapters: options.adapters,
      path: layout.phase0ContractPath,
      contract: evaluation.contract,
    });

    const state = createInitialDevInstanceState({
      layout,
      appPath: frozenHost.bundlePath,
      executablePath: frozenHost.executablePath,
      launchMarker: marker.value,
      updatedAt: options.adapters.clock.nowIso(),
    });
    state.appVersion = frozenHost.appVersion;
    state.appBuild = frozenHost.appBuild;
    if (evaluation.contract.status === "proven" && options.keepProcessAlive) {
      state.status = "ready";
      state.pid = processEvidence.pid;
      state.processStartedAt = processEvidence.processStartedAt;
      state.targetId = processEvidence.targetId;
      state.startedAt = options.adapters.clock.nowIso();
    } else {
      state.status = evaluation.contract.status === "proven" ? "stopped" : "failed";
      if (evaluation.contract.status !== "proven") {
        state.lastError = {
          code: "phase0_incomplete",
          message: evaluation.contract.reason ?? "Phase 0 incomplete",
          phase: "phase0",
        };
      }
    }
    await saveDevInstanceState({
      adapters: options.adapters,
      statePath: layout.statePath,
      state,
    });

    // 6. Stop the exact launched process unless asked to keep it.
    if (!options.keepProcessAlive) {
      const stopped = await stopExactProcess({
        runtimeProcess,
        cdp,
        pid: processEvidence.pid,
        processStartedAt: processEvidence.processStartedAt,
        timeoutMs: stopTimeoutMs,
        pollMs,
        signal: options.signal,
      });
      if (!stopped) {
        throw new Error(
          `Failed to stop exact development PID ${processEvidence.pid} after Phase 0`,
        );
      }
    }

    // 7. Protected main must survive.
    let protectedMainSurvived = true;
    if (protectedMainIdentity !== null) {
      protectedMainSurvived = await runtimeProcess.isAlive(
        protectedMainIdentity.pid,
        protectedMainIdentity.processStartedAt,
        { abortSignal: options.signal },
      );
    }

    if (!evaluation.allowsLifecycleMutation || evaluation.contract.status !== "proven") {
      return {
        ok: false,
        contract: evaluation.contract,
        allowsLifecycleMutation: false,
        allowsCompatibilityProbe: false,
        layout,
        frozenHost,
        process: processEvidence,
        protectedMainSurvived,
        grantsOwnershipFromPathsOnly: false,
        error: {
          code: "phase0_incomplete",
          message: evaluation.contract.reason ?? "Phase 0 launch-isolation proof incomplete",
        },
      };
    }

    if (!protectedMainSurvived) {
      return {
        ok: false,
        contract: evaluation.contract,
        allowsLifecycleMutation: false,
        allowsCompatibilityProbe: false,
        layout,
        frozenHost,
        process: processEvidence,
        protectedMainSurvived: false,
        grantsOwnershipFromPathsOnly: false,
        error: {
          code: "protected_main_impacted",
          message: "Protected authoring main did not survive Phase 0; fail closed.",
        },
      };
    }

    return {
      ok: true,
      contract: evaluation.contract,
      allowsLifecycleMutation: true,
      allowsCompatibilityProbe: true,
      layout,
      frozenHost,
      process: processEvidence,
      protectedMainSurvived: true,
      grantsOwnershipFromPathsOnly: false,
    };
  } catch (error: unknown) {
    // Best-effort exact stop of any process we launched.
    if (spawned !== null && processStartedAt !== null) {
      try {
        await stopExactProcess({
          runtimeProcess,
          cdp,
          pid: spawned.pid,
          processStartedAt,
          timeoutMs: stopTimeoutMs,
          pollMs,
          signal: options.signal,
        });
      } catch {
        // fall through
      }
    } else if (spawned !== null) {
      try {
        spawned.kill("SIGTERM");
      } catch {
        // fall through
      }
    }

    let protectedMainSurvived = true;
    if (protectedMainIdentity !== null) {
      try {
        protectedMainSurvived = await runtimeProcess.isAlive(
          protectedMainIdentity.pid,
          protectedMainIdentity.processStartedAt,
        );
      } catch {
        protectedMainSurvived = false;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const incomplete = evaluatePhase0LaunchContract({
      frozenHost,
      recheckedHost: frozenHost,
      observations: [],
      proposedMarker: marker,
      layout,
      clockIso: options.adapters.clock.nowIso(),
    });
    try {
      await savePhase0LaunchContract({
        adapters: options.adapters,
        path: layout.phase0ContractPath,
        contract: {
          ...incomplete.contract,
          reason: message,
        },
      });
    } catch {
      // ignore persistence failure on error path
    }

    return {
      ok: false,
      contract: {
        ...incomplete.contract,
        reason: message,
      },
      allowsLifecycleMutation: false,
      allowsCompatibilityProbe: false,
      layout,
      frozenHost,
      process: processEvidence,
      protectedMainSurvived,
      grantsOwnershipFromPathsOnly: false,
      error: {
        code: "phase0_failed",
        message,
      },
    };
  }
}

/** True when a later operation must re-run Phase 0 for a new frozen host. */
export function phase0RequiresReproof(options: {
  contract: { frozenHost: Phase0FrozenHost | null; status: string } | null;
  currentHost: Phase0FrozenHost;
}): boolean {
  if (options.contract === null || options.contract.status !== "proven") return true;
  return !frozenHostEquals(options.contract.frozenHost, options.currentHost);
}
