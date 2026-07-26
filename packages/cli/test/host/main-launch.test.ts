import { describe, expect, test } from "bun:test";
import type { CdpAdapter, CdpTargetSession } from "../../src/cdp/adapters.ts";
import type { CdpTarget } from "../../src/cdp/types.ts";
import type { LaunchSpawnAdapter, SpawnedProcess } from "../../src/dev/launch-adapters.ts";
import {
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  DEFAULT_PROBE_TOOL_VERSION,
  MISSION_BASELINE_APP_BUILD,
  MISSION_BASELINE_APP_VERSION,
  PROBE_SCHEMA_VERSION,
} from "../../src/host/constants.ts";
import {
  assessMainHotPath,
  formatMainHotPathHuman,
  formatMainHotPathJson,
  MAIN_HOT_PATH_RECOVERY_GUIDANCE,
  MAIN_HOT_PATH_UNAVAILABLE_CODE,
} from "../../src/host/main-hot-path.ts";
import {
  buildMainLaunchArgv,
  formatMainLaunchHuman,
  formatMainLaunchJson,
  runExplicitMainLaunch,
  type MainLaunchOptions,
} from "../../src/host/main-launch.ts";
import type {
  HostStatusAdapters,
  HostStatusResult,
  ListenerObservation,
  ProcessObservation,
  VerifiedProcess,
} from "../../src/host/status.ts";
import type {
  CompatibilityReport,
  HostIdentity,
} from "../../src/host/types.ts";
import type { ProcessIdentity } from "../../src/runtime/adapters.ts";
import { createFakeRuntimeHarness, runWithClockPump } from "../runtime/fixture-runtime.ts";

const EXECUTABLE = `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`;
const START = "2026-07-26T12:00:00.000000000Z";
const LAUNCHED_START = "2026-07-26T12:00:01.000000000Z";
const SDK = { version: "1.2.0", sha256: "a".repeat(64) };
const PROBE = { schemaVersion: PROBE_SCHEMA_VERSION, toolVersion: DEFAULT_PROBE_TOOL_VERSION };

function frozenHost(overrides: Partial<HostIdentity> = {}): HostIdentity {
  return {
    bundlePath: CANONICAL_BUNDLE_PATH,
    executablePath: EXECUTABLE,
    bundleId: "com.openai.codex",
    executableName: CANONICAL_EXECUTABLE_NAME,
    signingTeam: "2DC432GLL2",
    appVersion: MISSION_BASELINE_APP_VERSION,
    appBuild: MISSION_BASELINE_APP_BUILD,
    hostHashes: {
      "Contents/Info.plist": "b".repeat(64),
      "Contents/MacOS/ChatGPT": "c".repeat(64),
      "Contents/Resources/app.asar": "d".repeat(64),
    },
    ...overrides,
  };
}

function provenCompatibility(host: HostIdentity = frozenHost()): CompatibilityReport {
  return {
    status: "proven",
    key: {
      schemaVersion: 1,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      hostHashes: { ...host.hostHashes },
      signingTeam: host.signingTeam,
      sdkRuntimeSha256: SDK.sha256,
      probeSchemaVersion: PROBE_SCHEMA_VERSION,
      probeToolVersion: DEFAULT_PROBE_TOOL_VERSION,
    },
    currentKey: {
      schemaVersion: 1,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      hostHashes: { ...host.hostHashes },
      signingTeam: host.signingTeam,
      sdkRuntimeSha256: SDK.sha256,
      probeSchemaVersion: PROBE_SCHEMA_VERSION,
      probeToolVersion: DEFAULT_PROBE_TOOL_VERSION,
    },
    matched: true,
    reason: null,
    nextAction: null,
    allowsCompatibilityDependentWork: true,
  };
}

function unprovenCompatibility(): CompatibilityReport {
  return {
    status: "unproven",
    key: null,
    currentKey: null,
    matched: false,
    reason: "no_compatibility_record",
    nextAction: "probe first",
    allowsCompatibilityDependentWork: false,
  };
}

function noMainStatus(overrides: Partial<HostStatusResult> = {}): HostStatusResult {
  return {
    role: "main",
    endpoint: { host: "127.0.0.1", port: 9333 },
    mainState: "no-main",
    endpointObstruction: "port-free",
    processes: [],
    listeners: [],
    selectedTarget: null,
    targetInventory: [],
    diagnostic: { code: "no_main", message: "No main" },
    readOnly: true,
    activity: { launched: false, evaluated: false, wroteState: false, focused: false },
    ...overrides,
  };
}

function plainMainStatus(pid = 4100): HostStatusResult {
  const process: VerifiedProcess = {
    pid,
    parentPid: 1,
    executablePath: EXECUTABLE,
    arguments: [EXECUTABLE],
    processStartedAt: START,
  };
  return noMainStatus({
    mainState: "plain-main",
    processes: [process],
    diagnostic: { code: "plain_main", message: "Plain main" },
  });
}

function cdpMainStatus(pid = 5200, start = START): HostStatusResult {
  const process: VerifiedProcess = {
    pid,
    parentPid: 1,
    executablePath: EXECUTABLE,
    arguments: [EXECUTABLE, "--remote-debugging-port=9333"],
    processStartedAt: start,
  };
  const listener: ListenerObservation = {
    pid,
    processStartedAt: start,
    host: "127.0.0.1",
    port: 9333,
    family: "ipv4",
  };
  return noMainStatus({
    mainState: "cdp-main",
    endpointObstruction: "matching-endpoint",
    processes: [process],
    listeners: [listener],
    selectedTarget: {
      role: "main",
      pid,
      processStartedAt: start,
      executablePath: EXECUTABLE,
      appVersion: MISSION_BASELINE_APP_VERSION,
      appBuild: MISSION_BASELINE_APP_BUILD,
      port: 9333,
      browserIdentity: "Chrome/150.0",
      targetId: "PAGE-WINNER",
      targetType: "page",
      targetUrl: "app://-/index.html",
      executionContextId: 7,
      executionContextUniqueId: "unique-PAGE-WINNER-7",
      frameId: "FRAME-WINNER",
    },
    targetInventory: [{ id: "PAGE-WINNER", type: "page", url: "app://-/index.html" }],
    diagnostic: { code: "cdp_main", message: "cdp main" },
  });
}

function readyAfterSpawnStatus(pid: number, start: string): HostStatusResult {
  return cdpMainStatus(pid, start);
}

type StatusSequence = {
  calls: number;
  next: () => HostStatusResult;
};

function sequenceStatus(steps: HostStatusResult[]): StatusSequence & {
  collect: () => Promise<HostStatusResult>;
} {
  let index = 0;
  const state: StatusSequence = { calls: 0, next: () => steps[Math.min(index, steps.length - 1)]! };
  return {
    ...state,
    async collect() {
      state.calls += 1;
      const value = steps[Math.min(index, steps.length - 1)]!;
      if (index < steps.length - 1) index += 1;
      return structuredClone(value);
    },
  };
}

function createStatusAdapters(options: {
  processes?: ProcessObservation[];
  listeners?: ListenerObservation[];
  identities?: Record<number, ProcessIdentity | null>;
} = {}): HostStatusAdapters {
  const processes = options.processes ?? [];
  const listeners = options.listeners ?? [];
  const identities = options.identities ?? {};
  return {
    process: {
      async list() {
        return processes.map((p) => ({ ...p, arguments: [...p.arguments] }));
      },
      async identify(pid) {
        const found = identities[pid];
        return found === undefined ? null : found === null ? null : { ...found };
      },
    },
    port: {
      async listenersFor(port) {
        return listeners.filter((l) => l.port === port).map((l) => ({ ...l }));
      },
    },
  };
}

function createSpawnAdapter(options: {
  pid?: number;
  onSpawn?: (argv: readonly string[]) => void;
  fail?: boolean;
} = {}): LaunchSpawnAdapter & {
  spawns: number;
  lastArgv: string[] | null;
  killed: string[];
} {
  const state = {
    spawns: 0,
    lastArgv: null as string[] | null,
    killed: [] as string[],
  };
  return {
    get spawns() {
      return state.spawns;
    },
    get lastArgv() {
      return state.lastArgv;
    },
    get killed() {
      return state.killed;
    },
    async spawn(input) {
      state.spawns += 1;
      state.lastArgv = [...input.argv];
      options.onSpawn?.(input.argv);
      if (options.fail) {
        throw new Error("spawn refused by fixture");
      }
      const pid = options.pid ?? 7701;
      const child: SpawnedProcess = {
        pid,
        async wait() {
          return { exitCode: null, signal: null };
        },
        kill(signal = "SIGTERM") {
          state.killed.push(signal);
        },
      };
      return child;
    },
  };
}

function createCdpAdapter(options: {
  pid?: number;
  start?: string;
  evaluate?: (expression: string) => unknown;
  failList?: boolean;
  multiTarget?: boolean;
} = {}): CdpAdapter & { evaluations: string[]; sessionsClosed: number } {
  const pid = options.pid ?? 7701;
  const start = options.start ?? LAUNCHED_START;
  const state = { evaluations: [] as string[], sessionsClosed: 0 };
  const page: CdpTarget = {
    id: "PAGE-1",
    type: "page",
    title: "ChatGPT",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/PAGE-1",
  };
  const extra: CdpTarget = {
    id: "PAGE-2",
    type: "page",
    title: "Other",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/PAGE-2",
  };
  return {
    get evaluations() {
      return state.evaluations;
    },
    get sessionsClosed() {
      return state.sessionsClosed;
    },
    async readEndpoint() {
      return {
        browser: "Chrome/150.0.7871.124",
        protocolVersion: "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/BROWSER-1",
        pid,
      };
    },
    async listTargets() {
      if (options.failList) throw new Error("list failed");
      return options.multiTarget ? [page, extra] : [page];
    },
    async openTargetSession(input) {
      const targetId = input.target.id;
      const session: CdpTargetSession = {
        targetId,
        isOpen: () => true,
        async listExecutionContexts() {
          return [
            {
              id: 91,
              uniqueId: `unique-${targetId}-91`,
              targetId,
              frameId: `FRAME-${targetId}`,
              isDefault: true,
              origin: "app://-",
              name: "",
            },
          ];
        },
        async evaluate({ expression }) {
          state.evaluations.push(expression);
          return {
            value: options.evaluate?.(expression) ?? {
              explodexMainLaunchReadiness: true,
              readyState: "complete",
              href: "app://-/index.html",
            },
          };
        },
        async close() {
          state.sessionsClosed += 1;
        },
      };
      input.onSessionOpened?.(session);
      void start;
      return session;
    },
  };
}

function baseOptions(overrides: Partial<MainLaunchOptions> & {
  statusSteps?: HostStatusResult[];
  spawnPid?: number;
  spawnFail?: boolean;
  multiTarget?: boolean;
  evaluateFail?: boolean;
  work?: MainLaunchOptions["work"];
} = {}): MainLaunchOptions & {
  harness: ReturnType<typeof createFakeRuntimeHarness>;
  spawnAdapter: ReturnType<typeof createSpawnAdapter>;
  cdpAdapter: ReturnType<typeof createCdpAdapter>;
  statusSeq: ReturnType<typeof sequenceStatus>;
} {
  const host = frozenHost();
  const harness = createFakeRuntimeHarness({
    self: { pid: 9001, processStartedAt: "2026-07-26T11:00:00.000Z" },
  });
  const spawnPid = overrides.spawnPid ?? 7701;
  const knownStarts = new Map<number, string>([
    [spawnPid, LAUNCHED_START],
    [5200, START],
    [4100, START],
    [7701, LAUNCHED_START],
  ]);
  for (const [pid, start] of knownStarts) {
    harness.setProcessAlive(pid, start, true);
  }
  harness.adapters.process.identify = async (pid) => {
    const start = knownStarts.get(pid);
    if (start === undefined) return null;
    return { pid, processStartedAt: start };
  };
  harness.adapters.process.isAlive = async (pid, processStartedAt) => {
    return knownStarts.get(pid) === processStartedAt;
  };

  const statusSteps = overrides.statusSteps ?? [
    noMainStatus(),
    noMainStatus(),
    readyAfterSpawnStatus(spawnPid, LAUNCHED_START),
  ];
  const statusSeq = sequenceStatus(statusSteps);
  const spawnAdapter = createSpawnAdapter({
    pid: spawnPid,
    fail: overrides.spawnFail,
  });
  const cdpAdapter = createCdpAdapter({
    pid: spawnPid,
    start: LAUNCHED_START,
    multiTarget: overrides.multiTarget,
  });

  const options: MainLaunchOptions = {
    runtime: harness.adapters,
    hostAdapters: {
      fs: {
        async exists() { return false; },
        async stat() { return { kind: "missing" }; },
        async canExecute() { return false; },
        async realpath(path) { return path; },
        async readFile() { throw new Error("unused"); },
      },
      process: {
        async execFile() { return { stdout: "", stderr: "", exitCode: 1 }; },
      },
      clock: { nowIso: () => "2026-07-26T12:00:00.000Z" },
      hash: { sha256Hex: () => "e".repeat(64) },
    },
    statusAdapters: createStatusAdapters(),
    spawn: spawnAdapter,
    cdp: cdpAdapter,
    explodexHome: "/tmp/explodex-main-launch-test-home",
    sdkRuntime: SDK,
    probe: PROBE,
    freezeHost: async () => host,
    loadCompatibility: async () => provenCompatibility(host),
    collectStatus: () => statusSeq.collect(),
    readinessPollMs: 1,
    stageBounds: {
      "launch-readiness": 5_000,
      "cdp-discovery": 5_000,
      "cdp-evaluation": 5_000,
      "lock-acquisition": 2_000,
    },
    work: overrides.work,
    ...overrides,
  };

  // Keep injected fixtures after spread overrides.
  options.freezeHost = overrides.freezeHost ?? (async () => host);
  options.loadCompatibility = overrides.loadCompatibility ?? (async () => provenCompatibility(host));
  options.collectStatus = overrides.collectStatus ?? (() => statusSeq.collect());
  options.spawn = overrides.spawn ?? spawnAdapter;
  options.cdp = overrides.cdp ?? cdpAdapter;
  options.runtime = overrides.runtime ?? harness.adapters;
  options.work = overrides.work;

  return { ...options, harness, spawnAdapter, cdpAdapter, statusSeq };
}

async function runLaunch(
  options: MainLaunchOptions & { harness: ReturnType<typeof createFakeRuntimeHarness> },
) {
  return runWithClockPump(options.harness, runExplicitMainLaunch(options));
}

describe("VAL-HOST-015 protected authoring main hot path", () => {
  test("plain-main refuses inject/refresh/review/load/unload/dynamic-apply with stable recovery text", () => {
    for (const operation of [
      "inject",
      "refresh",
      "review",
      "load",
      "unload",
      "dynamic-apply",
      "final-main-apply",
    ] as const) {
      const assessment = assessMainHotPath({
        operation,
        mainState: "plain-main",
      });
      expect(assessment.allowed).toBe(false);
      if (assessment.allowed) return;
      expect(assessment.code).toBe(MAIN_HOT_PATH_UNAVAILABLE_CODE);
      expect(assessment.recoveryGuidance).toBe(MAIN_HOT_PATH_RECOVERY_GUIDANCE);
      expect(assessment.blockedBeforeLaunchOrEvaluation).toBe(true);
      expect(assessment.autoResume).toBe(false);
      expect(assessment.recoveryGuidance).toContain("Manually provide or relaunch");
      expect(assessment.recoveryGuidance).toContain("127.0.0.1:9333");
      expect(assessment.recoveryGuidance).toContain("will not automatically resume");
      expect(assessment.autoResume).toBe(false);
      const human = formatMainHotPathHuman(assessment);
      expect(human).toContain("main_hot_path_unavailable");
      expect(human).toContain("autoResume: false");
      const json = formatMainHotPathJson(assessment) as { ok: boolean; error: { code: string } };
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe(MAIN_HOT_PATH_UNAVAILABLE_CODE);
    }
  });

  test("non-hot operations remain usable with plain-main", () => {
    for (const operation of ["help", "host-inspect", "status", "compatibility-report"] as const) {
      const assessment = assessMainHotPath({
        operation,
        mainState: "plain-main",
      });
      expect(assessment.allowed).toBe(true);
      if (!assessment.allowed) return;
      expect(assessment.reason).toBe("non-hot-operation");
    }
  });

  test("explicit launch refuses plain-main without spawn or signal", async () => {
    const setup = baseOptions({
      statusSteps: [plainMainStatus(4100), plainMainStatus(4100)],
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MAIN_HOT_PATH_UNAVAILABLE_CODE);
    expect(setup.spawnAdapter.spawns).toBe(0);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
    const human = formatMainLaunchHuman(result);
    expect(human).toContain("main_hot_path_unavailable");
    expect(human).toContain("autoResume: false");
    expect(human).toContain("Manually provide or relaunch");
  });
});

describe("VAL-HOST-012 explicit no-main launch", () => {
  test("buildMainLaunchArgv uses only loopback 9333 remote debugging", () => {
    expect([...buildMainLaunchArgv()]).toEqual(["--remote-debugging-port=9333"]);
  });

  test("blocks before spawn when compatibility is unproven", async () => {
    const setup = baseOptions({
      loadCompatibility: async () => unprovenCompatibility(),
      statusSteps: [noMainStatus()],
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("compatibility_unproven");
    expect(setup.spawnAdapter.spawns).toBe(0);
    expect(result.partial.survivingChatGpt).toBeUndefined();
  });

  test("blocks when 9333 is foreign-obstructed under no-main", async () => {
    const setup = baseOptions({
      statusSteps: [
        noMainStatus({
          endpointObstruction: "foreign-or-mismatched-endpoint",
          listeners: [{
            pid: 9999,
            processStartedAt: "foreign-start",
            host: "127.0.0.1",
            port: 9333,
            family: "ipv4",
          }],
        }),
      ],
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("port_obstructed");
    expect(setup.spawnAdapter.spawns).toBe(0);
  });

  test("from no-main and free 9333 launches once, runs work once, leaves ChatGPT surviving", async () => {
    let workCount = 0;
    const setup = baseOptions({
      work: async (ctx) => {
        workCount += 1;
        const evaluation = await ctx.evaluate(
          "(() => ({ explodexMainLaunchReadiness: true, readyState: document.readyState, href: location.href }))()",
        );
        return { result: evaluation.value, injectionPerformed: false };
      },
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.path).toBe("spawn");
    expect(result.result.spawnedByThisOperation).toBe(true);
    expect(result.result.chatgptSurvives).toBe(true);
    expect(result.result.injectionClaimed).toBe(false);
    expect(result.result.process.pid).toBe(7701);
    expect(result.result.process.port).toBe(9333);
    expect(result.result.process.host).toBe("127.0.0.1");
    expect(result.result.target.targetUrl).toBe("app://-/index.html");
    expect(setup.spawnAdapter.spawns).toBe(1);
    expect(setup.spawnAdapter.lastArgv).toEqual(["--remote-debugging-port=9333"]);
    expect(workCount).toBe(1);
    expect(setup.cdpAdapter.evaluations.length).toBe(1);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
    expect(result.residualInventory.advisoryLeasesHeld).toBe(0);
    expect(result.residualInventory.openLockDescriptors).toBe(0);
    expect(result.residualInventory.commandOwnedChildren).toBe(0);
    // Protected process is not a control-plane residual; sessions/locks closed.
    expect(result.residualInventory.sessions).toBe(0);
    const human = formatMainLaunchHuman(result);
    expect(human).toContain("chatgptSurvives: true");
    expect(human).toContain("pid: 7701");
    const json = formatMainLaunchJson(result) as { ok: boolean; result: { path: string } };
    expect(json.ok).toBe(true);
    expect(json.result.path).toBe("spawn");
  });

  test("host drift after spawn preserves process and aborts without reconnect", async () => {
    let hostReads = 0;
    const base = frozenHost();
    const setup = baseOptions({
      freezeHost: async () => {
        hostReads += 1;
        if (hostReads <= 2) return base;
        // Drift after spawn/readiness host recheck
        return frozenHost({ appBuild: "9999" });
      },
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("host_identity_drift");
    expect(setup.spawnAdapter.spawns).toBe(1);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
    const details = result.error.details as { survivingChatGpt?: { pid: number }; injectionClaimed?: boolean };
    expect(details.survivingChatGpt?.pid).toBe(7701);
    expect(details.injectionClaimed).toBe(false);
    expect(result.partial.survivingChatGpt?.pid).toBe(7701);
  });
});

describe("VAL-HOST-013 launch races never duplicate main", () => {
  test("initially present cdp-main is refused without attach or evaluation", async () => {
    const preexisting = cdpMainStatus(5200, START);
    const setup = baseOptions({
      statusSteps: [preexisting, preexisting],
      cdp: createCdpAdapter({ pid: 5200, start: START }),
      work: async () => {
        throw new Error("work must not run for preexisting cdp-main");
      },
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("preexisting_cdp_main");
    expect(setup.spawnAdapter.spawns).toBe(0);
    expect(setup.cdpAdapter.evaluations).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
  });

  test("pre-spawn plain-main appearance fails state_changed without spawn", async () => {
    const setup = baseOptions({
      statusSteps: [noMainStatus(), plainMainStatus(4100)],
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("state_changed");
    expect(setup.spawnAdapter.spawns).toBe(0);
    expect(setup.harness.signalsSent).toEqual([]);
  });

  test("pre-spawn foreign listener fails state_changed without spawn", async () => {
    const setup = baseOptions({
      statusSteps: [
        noMainStatus(),
        noMainStatus({
          endpointObstruction: "foreign-or-mismatched-endpoint",
          listeners: [{
            pid: 8888,
            processStartedAt: "foreign",
            host: "127.0.0.1",
            port: 9333,
            family: "ipv4",
          }],
        }),
      ],
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("state_changed");
    expect(setup.spawnAdapter.spawns).toBe(0);
  });

  test("pre-spawn same-operation cdp-main winner uses attach path without second spawn", async () => {
    let workCount = 0;
    const winner = cdpMainStatus(5200, START);
    const setup = baseOptions({
      // Began from exact no-main/free-9333; winner appears only after baseline.
      statusSteps: [noMainStatus(), winner, winner, winner],
      cdp: createCdpAdapter({ pid: 5200, start: START }),
      work: async (ctx) => {
        workCount += 1;
        expect(ctx.path).toBe("attach");
        expect(ctx.process.pid).toBe(5200);
        return { result: { attached: true }, injectionPerformed: false };
      },
    });
    // For attach path readiness still needs the winner to own the port.
    const result = await runLaunch(setup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.path).toBe("attach");
    expect(result.result.spawnedByThisOperation).toBe(false);
    expect(result.result.process.pid).toBe(5200);
    expect(setup.spawnAdapter.spawns).toBe(0);
    expect(workCount).toBe(1);
    expect(setup.harness.signalsSent).toEqual([]);
  });

  test("barrier-controlled simultaneous launches share coordination and spawn at most once", async () => {
    const host = frozenHost();
    const harnessA = createFakeRuntimeHarness({
      self: { pid: 9001, processStartedAt: "2026-07-26T11:00:00.000Z" },
    });
    const harnessB = createFakeRuntimeHarness({
      self: { pid: 9002, processStartedAt: "2026-07-26T11:00:01.000Z" },
    });
    // Shared coordination authority: same lock filesystem + shared process inventory.
    harnessB.adapters.fs = harnessA.adapters.fs;

    const spawnA = createSpawnAdapter({ pid: 7701 });
    const spawnB = createSpawnAdapter({ pid: 7702 });
    for (const harness of [harnessA, harnessB]) {
      harness.setProcessAlive(7701, LAUNCHED_START, true);
      harness.setProcessAlive(7702, LAUNCHED_START, true);
      harness.adapters.process.identify = async (pid) => {
        if (pid === 7701 || pid === 7702) {
          return { pid, processStartedAt: LAUNCHED_START };
        }
        return null;
      };
      harness.adapters.process.isAlive = async (pid, start) =>
        (pid === 7701 || pid === 7702) && start === LAUNCHED_START;
    }

    // Shared mutable inventory starts as exact no-main/free-9333.
    let sharedStatus: HostStatusResult = noMainStatus();
    const winnerAfterSpawn = readyAfterSpawnStatus(7701, LAUNCHED_START);
    let evaluations = 0;

    // Explicit barrier: both ops must arrive before either may complete pre-spawn recheck.
    let barrierArrivals = 0;
    const barrierWaiters: Array<() => void> = [];
    const barrier = (): Promise<void> =>
      new Promise((resolve) => {
        barrierArrivals += 1;
        barrierWaiters.push(resolve);
        if (barrierArrivals >= 2) {
          for (const wake of barrierWaiters.splice(0)) wake();
        }
      });

    const hostAdapters = baseOptions().hostAdapters;
    const common = {
      hostAdapters,
      explodexHome: "/tmp/explodex-main-launch-barrier-race-home",
      sdkRuntime: SDK,
      probe: PROBE,
      freezeHost: async () => host,
      loadCompatibility: async () => provenCompatibility(host),
      readinessPollMs: 1,
      stageBounds: {
        "launch-readiness": 5_000,
        "cdp-discovery": 5_000,
        "cdp-evaluation": 5_000,
        // Contender must observe bounded lock_busy while winner holds the lease.
        "lock-acquisition": 80,
      } as const,
    };

    const collectShared = async (): Promise<HostStatusResult> => structuredClone(sharedStatus);

    const makeWork = (label: "A" | "B") =>
      async () => {
        evaluations += 1;
        return { result: { label }, injectionPerformed: false };
      };

    // Explicit barrier on the first inventory so both simultaneous operations
    // prove concurrent start before racing shared launch coordination.
    // The loser typically fails lock_busy and never reaches pre-spawn recheck.
    const collectWithBarrier = () => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1) {
          await barrier();
        }
        // After a spawn has won, subsequent inventories show the exact winner.
        if (spawnA.spawns + spawnB.spawns >= 1) {
          sharedStatus = winnerAfterSpawn;
        }
        return collectShared();
      };
    };

    const collectA = collectWithBarrier();
    const collectB = collectWithBarrier();
    const cdpA = createCdpAdapter({ pid: 7701, start: LAUNCHED_START });
    const cdpB = createCdpAdapter({ pid: 7701, start: LAUNCHED_START });

    const promiseA = runExplicitMainLaunch({
      ...common,
      operationId: "race-op-a",
      runtime: harnessA.adapters,
      statusAdapters: createStatusAdapters(),
      spawn: spawnA,
      cdp: cdpA,
      collectStatus: collectA,
      work: makeWork("A"),
    });
    const promiseB = runExplicitMainLaunch({
      ...common,
      operationId: "race-op-b",
      runtime: harnessB.adapters,
      statusAdapters: createStatusAdapters(),
      spawn: spawnB,
      cdp: cdpB,
      collectStatus: collectB,
      work: makeWork("B"),
    });

    // Simultaneous clock pump for both promises with shared FS coordination.
    let settledA = false;
    let settledB = false;
    let resultA!: Awaited<typeof promiseA>;
    let resultB!: Awaited<typeof promiseB>;
    let errA: unknown;
    let errB: unknown;
    void promiseA.then(
      (value) => {
        settledA = true;
        resultA = value;
      },
      (error: unknown) => {
        settledA = true;
        errA = error;
      },
    );
    void promiseB.then(
      (value) => {
        settledB = true;
        resultB = value;
      },
      (error: unknown) => {
        settledB = true;
        errB = error;
      },
    );

    let steps = 0;
    while ((!settledA || !settledB) && steps < 20_000) {
      harnessA.advanceMs(5);
      harnessB.advanceMs(5);
      steps += 1;
      await Promise.resolve();
      await Promise.resolve();
    }
    if (!settledA || !settledB) {
      throw new Error(`barrier race did not settle after ${steps} steps`);
    }
    if (errA !== undefined) throw errA;
    if (errB !== undefined) throw errB;

    const outcomes = [resultA, resultB];
    const spawns = spawnA.spawns + spawnB.spawns;
    expect(spawns).toBeLessThanOrEqual(1);
    expect(evaluations).toBeLessThanOrEqual(1);

    const successes = outcomes.filter((outcome) => outcome.ok);
    const failures = outcomes.filter((outcome) => !outcome.ok);
    // At least one operation must finish under shared coordination; the loser is
    // bounded busy/state-changed or attaches only to the exact operation winner.
    expect(successes.length + failures.length).toBe(2);

    if (successes.length === 1) {
      const winner = successes[0]!;
      if (!winner.ok) return;
      expect(winner.result.process.pid).toBe(7701);
      expect(winner.result.spawnedByThisOperation || winner.result.path === "attach").toBe(true);
      const loser = failures[0];
      if (loser !== undefined && !loser.ok) {
        expect(
          ["lock_busy", "state_changed", "operation_timeout", "preexisting_cdp_main"].includes(
            loser.error.code,
          ),
        ).toBe(true);
      }
    } else if (successes.length === 2) {
      // Both may succeed only when one spawned and the other attached to that exact winner.
      const paths = successes.map((s) => (s.ok ? s.result.path : null));
      expect(paths.includes("spawn") || paths.every((p) => p === "attach")).toBe(true);
      expect(spawns).toBeLessThanOrEqual(1);
      for (const success of successes) {
        if (!success.ok) continue;
        expect(success.result.process.pid).toBe(7701);
      }
      // Still at most one requested evaluation across both.
      expect(evaluations).toBeLessThanOrEqual(1);
    } else {
      // Both failed: still must not have double-spawned or double-evaluated.
      expect(spawns).toBeLessThanOrEqual(1);
      expect(evaluations).toBeLessThanOrEqual(1);
    }

    expect(spawnA.killed).toEqual([]);
    expect(spawnB.killed).toEqual([]);
    expect(harnessA.signalsSent).toEqual([]);
    expect(harnessB.signalsSent).toEqual([]);
    expect(barrierArrivals).toBeGreaterThanOrEqual(2);
  });
});

describe("VAL-HOST-012/020 full pre-effect revalidation", () => {
  test("target/context drift before evaluation stops without reconnect and preserves process", async () => {
    let listCount = 0;
    const cdp = createCdpAdapter({ pid: 7701, start: LAUNCHED_START });
    const originalList = cdp.listTargets.bind(cdp);
    cdp.listTargets = async (input) => {
      listCount += 1;
      const targets = await originalList(input);
      // After discovery (first listTargets inside inspect), subsequent lists show replacement.
      if (listCount >= 2) {
        return targets.map((target) =>
          target.id === "PAGE-1"
            ? { ...target, id: "PAGE-REPLACED" }
            : target
        );
      }
      return targets;
    };

    const setup = baseOptions({
      cdp,
      work: async (ctx) => {
        await ctx.evaluate("(() => 1)()");
        return { result: { ok: true }, injectionPerformed: false };
      },
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      ["target_identity_drift", "context_identity_drift", "endpoint_identity_mismatch"].includes(
        result.error.code,
      ),
    ).toBe(true);
    expect(setup.spawnAdapter.spawns).toBe(1);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
    expect(result.partial.survivingChatGpt?.pid).toBe(7701);
    // No evaluation effect after drift (use the injected adapter under test).
    expect(cdp.evaluations.length).toBe(0);
  });

  test("port owner drift before evaluation stops without reconnect", async () => {
    let statusCalls = 0;
    const ready = readyAfterSpawnStatus(7701, LAUNCHED_START);
    const drifted = noMainStatus({
      processes: ready.processes,
      listeners: [{
        pid: 9999,
        processStartedAt: "foreign",
        host: "127.0.0.1",
        port: 9333,
        family: "ipv4",
      }],
      endpointObstruction: "foreign-or-mismatched-endpoint",
    });
    const setup = baseOptions({
      collectStatus: async () => {
        statusCalls += 1;
        // 1: initial baseline, 2: pre-spawn recheck, 3+: readiness until ready,
        // then revalidation must observe drift.
        if (statusCalls <= 2) return noMainStatus();
        if (statusCalls <= 4) return ready;
        return drifted;
      },
      work: async (ctx) => {
        await ctx.evaluate("(() => 1)()");
        return { result: { ok: true }, injectionPerformed: false };
      },
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("port_owner_drift");
    expect(setup.spawnAdapter.spawns).toBe(1);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(result.partial.survivingChatGpt?.pid).toBe(7701);
  });
});

describe("VAL-HOST-014 partial launch preserves process", () => {
  test.each([
    {
      name: "readiness failure",
      statusSteps: [
        noMainStatus(),
        noMainStatus(),
        // never becomes ready (no listener match)
        noMainStatus({
          processes: [{
            pid: 7701,
            parentPid: 1,
            executablePath: EXECUTABLE,
            arguments: [EXECUTABLE, "--remote-debugging-port=9333"],
            processStartedAt: LAUNCHED_START,
          }],
          listeners: [],
        }),
      ],
      stageBounds: { "launch-readiness": 30, "cdp-discovery": 5_000, "cdp-evaluation": 5_000, "lock-acquisition": 2_000 },
      expectedCodes: ["readiness_failed", "operation_timeout"],
    },
    {
      name: "multi-target after spawn",
      statusSteps: [
        noMainStatus(),
        noMainStatus(),
        readyAfterSpawnStatus(7701, LAUNCHED_START),
      ],
      multiTarget: true,
      stageBounds: { "launch-readiness": 5_000, "cdp-discovery": 5_000, "cdp-evaluation": 5_000, "lock-acquisition": 2_000 },
      expectedCodes: ["target_ambiguous"],
    },
    {
      name: "requested work failure",
      statusSteps: [
        noMainStatus(),
        noMainStatus(),
        readyAfterSpawnStatus(7701, LAUNCHED_START),
      ],
      work: async () => {
        throw new Error("work boom");
      },
      stageBounds: { "launch-readiness": 5_000, "cdp-discovery": 5_000, "cdp-evaluation": 5_000, "lock-acquisition": 2_000 },
      expectedCodes: ["requested_work_failed"],
    },
  ] as const)("preserves launched process on $name", async (row) => {
    const setup = baseOptions({
      statusSteps: [...row.statusSteps],
      multiTarget: "multiTarget" in row ? row.multiTarget : false,
      work: "work" in row ? row.work : undefined,
      stageBounds: { ...row.stageBounds },
    });
    const result = await runLaunch(setup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((row.expectedCodes as readonly string[]).includes(result.error.code)).toBe(true);
    expect(setup.spawnAdapter.spawns).toBe(1);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
    const details = result.error.details as {
      survivingChatGpt?: { pid: number; processStartedAt: string };
      injectionClaimed: boolean;
      lastCompletedStage: string | null;
    };
    expect(details.survivingChatGpt?.pid).toBe(7701);
    expect(details.injectionClaimed).toBe(false);
    expect(result.partial.survivingChatGpt?.pid).toBe(7701);
    const human = formatMainLaunchHuman(result);
    expect(human).toContain("survivingChatGpt: 7701");
    expect(human).toContain("injectionClaimed: false");
    // No residual helper/control channel
    expect(result.residualInventory.sessions).toBe(0);
    expect(result.residualInventory.advisoryLeasesHeld).toBe(0);
    expect(result.residualInventory.openLockDescriptors).toBe(0);
    expect(result.residualInventory.reconnectLoops).toBe(0);
  });

  test("SIGINT after spawn preserves process and reports interrupted/partial", async () => {
    const setup = baseOptions({
      stageBounds: {
        "launch-readiness": 5_000,
        "cdp-discovery": 5_000,
        "cdp-evaluation": 5_000,
        "lock-acquisition": 2_000,
      },
      work: async (ctx) => {
        // Emit interrupt mid-work
        setup.harness.emitSignal("SIGINT");
        ctx.throwIfInterrupted();
        return { result: null };
      },
    });
    const result = await runLaunch(setup);
    // Work path may report interrupted or requested_work_failed depending on timing;
    // process must survive either way once spawned.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(setup.spawnAdapter.spawns).toBe(1);
    expect(setup.spawnAdapter.killed).toEqual([]);
    expect(setup.harness.signalsSent).toEqual([]);
    expect(
      result.partial.survivingChatGpt?.pid === 7701 ||
        (result.error.details as { survivingChatGpt?: { pid: number } } | undefined)?.survivingChatGpt?.pid === 7701,
    ).toBe(true);
  });
});
