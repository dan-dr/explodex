import { describe, expect, test } from "bun:test";
import {
  createDisabledPhase0Contract,
  describeDevLayout,
  ensureDefaultDevLayout,
  evaluatePhase0LaunchContract,
  freezeHostIdentity,
  frozenHostEquals,
  gateDevelopmentLifecycleMutation,
  loadPhase0LaunchContract,
  markerMatchesExactly,
  ownershipFromLayoutOnly,
  phase0RequiresReproof,
  runIfPhase0Allows,
  savePhase0LaunchContract,
} from "../../src/dev/index.ts";
import type {
  Phase0ComparativeExperiment,
  Phase0FrozenHost,
  Phase0KnobObservation,
  Phase0OwnershipEvidence,
  Phase0ReadinessEvidence,
} from "../../src/dev/types.ts";
import {
  HISTORICAL_OBSERVED_APP_BUILD_2026_07_25,
  MISSION_BASELINE_APP_BUILD,
  MISSION_BASELINE_APP_VERSION,
} from "../../src/host/constants.ts";
import type { HostAdapters } from "../../src/host/adapters.ts";
import { createFixedClock, createMemoryHash, MemoryFileSystem } from "../host/fixture-fs.ts";

const CLOCK = "2026-07-25T15:00:00.000Z";
const MARKER = "--explodex-dev-instance=plugin-dev";

function sampleFrozenHost(overrides: Partial<Phase0FrozenHost> = {}): Phase0FrozenHost {
  return freezeHostIdentity({
    bundlePath: "/Applications/ChatGPT.app",
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    bundleId: "com.openai.codex",
    executableName: "ChatGPT",
    signingTeam: "2DC432GLL2",
    appVersion: "26.721.41059",
    appBuild: HISTORICAL_OBSERVED_APP_BUILD_2026_07_25,
    hostHashes: {
      "Contents/Info.plist": "a".repeat(64),
      "Contents/MacOS/ChatGPT": "b".repeat(64),
      "Contents/Resources/app.asar": "c".repeat(64),
    },
    ...overrides,
  });
}

function adaptersFor(fs: MemoryFileSystem): HostAdapters {
  return {
    fs,
    process: {
      async execFile() {
        return { stdout: "", stderr: "unused", exitCode: 1 };
      },
    },
    clock: createFixedClock(CLOCK),
    hash: createMemoryHash(),
  };
}

function sampleReadiness(frozenHost: Phase0FrozenHost): Phase0ReadinessEvidence {
  return {
    pid: 4242,
    processStartedAt: "dev-start-identity",
    executablePath: frozenHost.executablePath,
    portOwnerPid: 4242,
    cdpHost: "127.0.0.1",
    cdpPort: 9444,
    browserIdentity: "Chrome/ChatGPT",
    targetId: "target-1",
    targetUrl: "app://-/index.html",
    executionContextId: 1,
    executionContextUniqueId: "ctx-unique-1",
    frameId: "frame-1",
    readiness: "benign",
  };
}

function sampleOwnership(): Phase0OwnershipEvidence {
  return {
    positive: {
      owned: true,
      code: "owned",
      reasons: ["exact development ownership"],
    },
    negatives: [
      { role: "protected-main", owned: false, code: "protected_main", reasons: ["main"] },
      { role: "unrelated", owned: false, code: "unrelated_marker", reasons: ["unrelated"] },
      {
        role: "arbitrary-substring",
        owned: false,
        code: "arbitrary_substring",
        reasons: ["substring"],
      },
      { role: "pid-reuse", owned: false, code: "pid_reuse", reasons: ["reuse"] },
      { role: "wrong-endpoint", owned: false, code: "wrong_endpoint", reasons: ["endpoint"] },
      {
        role: "conflicting-source",
        owned: false,
        code: "conflicting_source",
        reasons: ["conflict"],
      },
    ],
  };
}

function sampleComparativeExperiments(layoutRoot: string): Phase0ComparativeExperiment[] {
  const layout = describeDevLayout(layoutRoot);
  const treatmentBase = {
    launched: true as const,
    privateRoot: layout.rootPath,
    descriptor: {
      argv: [
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        `--user-data-dir=${layout.electronUserDataPath}`,
        "--remote-debugging-port=9444",
        MARKER,
      ],
      envKeys: ["CODEX_HOME"],
    },
    pid: 4242,
    processStartedAt: "dev-start-identity",
    portOwnerPid: 4242,
    browserIdentity: "Chrome/ChatGPT",
    targetId: "target-1",
    executionContextId: 1,
    pathSeparation: {
      userDataDistinctFromMain: true,
      codexHomeDistinctFromUserCodex: true,
      explodexStateDistinctFromMainHome: true,
      credentialsInspected: false as const,
    },
    exactMarkerPresent: true,
    ownershipAccepted: true,
  };
  const controlRejected = {
    ...treatmentBase,
    launched: true as const,
    ownershipAccepted: false,
    exactMarkerPresent: false,
    portOwnerPid: null,
    browserIdentity: null,
    targetId: null,
    executionContextId: null,
  };
  return [
    {
      knob: "electron-user-data",
      experimentId: "exp-user-data",
      treatmentLabel: "treatment:electron-user-data",
      controlLabel: "control:electron-user-data",
      treatment: treatmentBase,
      control: {
        ...controlRejected,
        pathSeparation: {
          userDataDistinctFromMain: false,
          codexHomeDistinctFromUserCodex: true,
          explodexStateDistinctFromMainHome: true,
          credentialsInspected: false,
        },
      },
      conclusion: "demonstrated",
      evidence: "user-data isolation demonstrated",
    },
    {
      knob: "codex-home",
      experimentId: "exp-codex-home",
      treatmentLabel: "treatment:codex-home",
      controlLabel: "control:codex-home",
      treatment: treatmentBase,
      control: {
        ...controlRejected,
        pathSeparation: {
          userDataDistinctFromMain: true,
          codexHomeDistinctFromUserCodex: false,
          explodexStateDistinctFromMainHome: true,
          credentialsInspected: false,
        },
      },
      conclusion: "demonstrated",
      evidence: "CODEX_HOME isolation demonstrated",
    },
    {
      knob: "explodex-home",
      experimentId: "exp-explodex-home",
      treatmentLabel: "treatment:explodex-home",
      controlLabel: "control:explodex-home",
      treatment: treatmentBase,
      control: { ...treatmentBase, ownershipAccepted: true },
      conclusion: "not-necessary",
      evidence: "EXPLODEX_HOME not necessary with private explodex-state",
    },
    {
      knob: "cdp-port",
      experimentId: "exp-cdp-port",
      treatmentLabel: "treatment:cdp-port",
      controlLabel: "control:cdp-port",
      treatment: treatmentBase,
      control: controlRejected,
      conclusion: "demonstrated",
      evidence: "9444 ownership demonstrated",
    },
    {
      knob: "launch-marker",
      experimentId: "exp-marker",
      treatmentLabel: "treatment:launch-marker",
      controlLabel: "control:launch-marker",
      treatment: treatmentBase,
      control: controlRejected,
      conclusion: "demonstrated",
      evidence: "exact marker ownership demonstrated",
    },
  ];
}

function completeObservations(layoutRoot: string): Phase0KnobObservation[] {
  const layout = describeDevLayout(layoutRoot);
  return [
    {
      knob: "electron-user-data",
      demonstratedEffect: true,
      notNecessary: false,
      pathSeparation: {
        userDataDistinctFromMain: true,
        codexHomeDistinctFromUserCodex: true,
        explodexStateDistinctFromMainHome: true,
        credentialsInspected: false,
      },
      isolationPaths: { electronUserDataPath: layout.electronUserDataPath },
      notes: "User-data override isolated the ChatGPT profile from the main profile.",
    },
    {
      knob: "codex-home",
      demonstratedEffect: true,
      notNecessary: false,
      pathSeparation: {
        userDataDistinctFromMain: true,
        codexHomeDistinctFromUserCodex: true,
        explodexStateDistinctFromMainHome: true,
        credentialsInspected: false,
      },
      isolationPaths: { codexHomePath: layout.codexHomePath },
      notes: "CODEX_HOME isolated durable host state from ~/.codex.",
    },
    {
      knob: "explodex-home",
      demonstratedEffect: false,
      notNecessary: true,
      notes: "EXPLODEX_HOME is unnecessary once instance-private explodex-state is used.",
    },
    {
      knob: "cdp-port",
      demonstratedEffect: true,
      notNecessary: false,
      notes: "Declared loopback 9444 is required as the development-role endpoint.",
    },
    {
      knob: "launch-marker",
      demonstratedEffect: true,
      notNecessary: false,
      marker: {
        exactMatch: true,
        observedValue: MARKER,
        source: "argv",
        acceptedForDevelopment: true,
        rejectedForProtectedMain: true,
        rejectedForUnrelatedProcess: true,
        rejectedForArbitrarySubstring: true,
        secretFree: true,
      },
      sanitizedLaunchDescriptor: {
        argv: [
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          MARKER,
          "--remote-debugging-port=9444",
        ],
        envKeys: ["CODEX_HOME"],
      },
      notes: "Exact argv marker uniquely identifies the development launch.",
    },
  ];
}

describe("Phase 0 launch-isolation contract (VAL-HOST-007)", () => {
  test("disabled contract blocks lifecycle mutation and compatibility probing", () => {
    const contract = createDisabledPhase0Contract({
      appBuild: MISSION_BASELINE_APP_BUILD,
    });
    for (const operation of [
      "dev-start",
      "dev-ensure",
      "dev-restart",
      "dev-stop",
      "dev-inject",
      "dev-recover",
      "compatibility-probe",
    ] as const) {
      const gate = gateDevelopmentLifecycleMutation({ operation, contract });
      expect(gate.allowed).toBe(false);
      if (gate.allowed) continue;
      expect(gate.blockedBeforeLaunchOrEvaluation).toBe(true);
      expect(gate.error.code).toMatch(/phase0_/);
    }
  });

  test("path creation alone neither proves Phase 0 nor owns a process", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/phase0-a/.explodex/dev/plugin-dev";
    const layout = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(ownershipFromLayoutOnly(layout.layout).owned).toBe(false);

    const loaded = await loadPhase0LaunchContract({
      adapters: adaptersFor(fs),
      path: layout.layout.phase0ContractPath,
    });
    expect(loaded).toBeNull();

    const gate = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: loaded,
    });
    expect(gate.allowed).toBe(false);
  });

  test("independent knob matrix retains only the smallest effective set for the frozen current host", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-b/.explodex/dev/plugin-dev");
    const frozenHost = sampleFrozenHost();
    // Frozen host differs from the dated readiness baseline and must still prove.
    expect(frozenHost.appBuild).not.toBe(MISSION_BASELINE_APP_BUILD);
    expect(frozenHost.appVersion).not.toBe(MISSION_BASELINE_APP_VERSION);

    const result = evaluatePhase0LaunchContract({
      frozenHost,
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });

    expect(result.contract.status).toBe("proven");
    expect(result.allowsLifecycleMutation).toBe(true);
    expect(result.allowsCompatibilityProbe).toBe(true);
    expect(result.contract.frozenHost).toEqual(frozenHost);
    expect(result.contract.appBuild).toBe(frozenHost.appBuild);
    expect(result.contract.appVersion).toBe(frozenHost.appVersion);
    expect(result.contract.retainedKnobs).toEqual([
      "electron-user-data",
      "codex-home",
      "cdp-port",
      "launch-marker",
    ]);
    expect(result.contract.retainedKnobs).not.toContain("explodex-home");
    const explodex = result.contract.knobMatrix.find((entry) => entry.name === "explodex-home");
    expect(explodex?.status).toBe("omitted");
    expect(explodex?.effect).toBe("not-necessary");
    expect(result.contract.launchMarker?.value).toBe(MARKER);
    expect(result.contract.isolation.cdpPort).toBe(9444);
  });

  test("missing, ambiguous, or non-minimal marker evidence keeps mutation disabled", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-c/.explodex/dev/plugin-dev");
    const frozenHost = sampleFrozenHost();
    const base = completeObservations(layout.rootPath);

    const missingMarker = evaluatePhase0LaunchContract({
      frozenHost,
      observations: base.filter((entry) => entry.knob !== "launch-marker"),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(missingMarker.contract.status).toBe("incomplete");
    expect(missingMarker.allowsLifecycleMutation).toBe(false);

    const substringMarker = evaluatePhase0LaunchContract({
      frozenHost,
      observations: base.map((entry) =>
        entry.knob === "launch-marker"
          ? {
              ...entry,
              marker: {
                ...entry.marker!,
                rejectedForArbitrarySubstring: false,
              },
            }
          : entry,
      ),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(substringMarker.contract.status).toBe("incomplete");
    expect(substringMarker.allowsLifecycleMutation).toBe(false);

    const secretMarker = evaluatePhase0LaunchContract({
      frozenHost,
      observations: base,
      proposedMarker: { kind: "exact-argv-token", value: "--token=super-secret" },
      layout,
      clockIso: CLOCK,
    });
    expect(secretMarker.contract.status).toBe("incomplete");
    expect(secretMarker.allowsLifecycleMutation).toBe(false);
  });

  test("historical difference from dated observations is not a blocker when freeze matches recheck", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-hist/.explodex/dev/plugin-dev");
    const historical = sampleFrozenHost({
      appVersion: MISSION_BASELINE_APP_VERSION,
      appBuild: MISSION_BASELINE_APP_BUILD,
    });
    const current = sampleFrozenHost({
      appVersion: "26.721.41059",
      appBuild: HISTORICAL_OBSERVED_APP_BUILD_2026_07_25,
      hostHashes: {
        "Contents/Info.plist": "d".repeat(64),
        "Contents/MacOS/ChatGPT": "e".repeat(64),
        "Contents/Resources/app.asar": "f".repeat(64),
      },
    });
    expect(frozenHostEquals(historical, current)).toBe(false);

    const result = evaluatePhase0LaunchContract({
      frozenHost: current,
      recheckedHost: current,
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(result.contract.status).toBe("proven");
    expect(result.contract.appBuild).toBe(current.appBuild);
    expect(result.allowsLifecycleMutation).toBe(true);
  });

  test("active-operation host drift aborts without proving or reconnecting", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-d/.explodex/dev/plugin-dev");
    const frozen = sampleFrozenHost({ appBuild: "5848" });
    const drifted = sampleFrozenHost({
      appBuild: "9999",
      appVersion: "99.0.0",
      hostHashes: {
        "Contents/Info.plist": "1".repeat(64),
        "Contents/MacOS/ChatGPT": "2".repeat(64),
        "Contents/Resources/app.asar": "3".repeat(64),
      },
    });
    const result = evaluatePhase0LaunchContract({
      frozenHost: frozen,
      recheckedHost: drifted,
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(result.contract.status).toBe("incomplete");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.reason).toMatch(/drifted from the frozen/i);
  });

  test("between-operation host change requires automatic re-proof rather than build choice", () => {
    const previous = sampleFrozenHost({ appBuild: MISSION_BASELINE_APP_BUILD });
    const current = sampleFrozenHost({ appBuild: HISTORICAL_OBSERVED_APP_BUILD_2026_07_25 });
    const proven = evaluatePhase0LaunchContract({
      frozenHost: previous,
      observations: completeObservations("/tmp/homes/phase0-reproof/.explodex/dev/plugin-dev"),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout: describeDevLayout("/tmp/homes/phase0-reproof/.explodex/dev/plugin-dev"),
      clockIso: CLOCK,
    });
    expect(proven.contract.status).toBe("proven");
    expect(
      phase0RequiresReproof({
        contract: proven.contract,
        currentHost: current,
      }),
    ).toBe(true);
    expect(
      phase0RequiresReproof({
        contract: proven.contract,
        currentHost: previous,
      }),
    ).toBe(false);
  });

  test("exact marker matching rejects substrings and protected-main argv", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-e/.explodex/dev/plugin-dev");
    const proven = evaluatePhase0LaunchContract({
      frozenHost: sampleFrozenHost(),
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(proven.contract.status).toBe("proven");

    expect(
      markerMatchesExactly({
        contract: proven.contract,
        observedArgv: [MARKER],
      }),
    ).toBe(true);
    expect(
      markerMatchesExactly({
        contract: proven.contract,
        observedArgv: [`prefix-${MARKER}-suffix`],
      }),
    ).toBe(false);
    expect(
      markerMatchesExactly({
        contract: proven.contract,
        observedArgv: ["--remote-debugging-port=9333"],
      }),
    ).toBe(false);
  });

  test("incomplete contracts persist and keep runIfPhase0Allows from launching", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/phase0-f/.explodex/dev/plugin-dev";
    const layoutResult = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(layoutResult.ok).toBe(true);
    if (!layoutResult.ok) return;

    const incomplete = evaluatePhase0LaunchContract({
      frozenHost: sampleFrozenHost(),
      observations: [],
      proposedMarker: null,
      layout: layoutResult.layout,
      clockIso: CLOCK,
    });
    expect(incomplete.contract.status).toBe("incomplete");

    await savePhase0LaunchContract({
      adapters: adaptersFor(fs),
      path: layoutResult.layout.phase0ContractPath,
      contract: incomplete.contract,
    });
    const loaded = await loadPhase0LaunchContract({
      adapters: adaptersFor(fs),
      path: layoutResult.layout.phase0ContractPath,
    });
    expect(loaded?.status).toBe("incomplete");
    expect(loaded?.frozenHost?.appBuild).toBe(HISTORICAL_OBSERVED_APP_BUILD_2026_07_25);

    let launched = false;
    const result = runIfPhase0Allows({
      operation: "compatibility-probe",
      contract: loaded,
      expectedHost: sampleFrozenHost(),
      run: () => {
        launched = true;
        return "launched";
      },
    });
    expect(result.gate.allowed).toBe(false);
    expect(launched).toBe(false);
    expect(result.result).toBeUndefined();
  });

  test("proven contract allows lifecycle mutation only for the matching frozen host", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-g/.explodex/dev/plugin-dev");
    const frozenHost = sampleFrozenHost();
    const proven = evaluatePhase0LaunchContract({
      frozenHost,
      comparativeExperiments: sampleComparativeExperiments(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
      readiness: sampleReadiness(frozenHost),
      ownership: sampleOwnership(),
      requireCompleteProof: true,
    });
    expect(proven.contract.status).toBe("proven");
    expect(proven.contract.schemaVersion).toBe(2);
    expect(proven.contract.readiness?.targetId).toBe("target-1");
    expect(proven.contract.comparativeExperiments).toHaveLength(5);

    const allowed = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: proven.contract,
      expectedHost: frozenHost,
    });
    expect(allowed.allowed).toBe(true);

    const withoutHost = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: proven.contract,
    });
    expect(withoutHost.allowed).toBe(false);
    if (withoutHost.allowed) return;
    expect(withoutHost.error.code).toBe("phase0_host_mismatch");

    const mismatched = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: proven.contract,
      expectedHost: sampleFrozenHost({ appBuild: "0001", appVersion: "0.0.1" }),
    });
    expect(mismatched.allowed).toBe(false);
    if (mismatched.allowed) return;
    expect(mismatched.error.code).toBe("phase0_host_mismatch");
  });

  test("obsolete schema-1 proof cannot authorize lifecycle mutation", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/phase0-schema1/.explodex/dev/plugin-dev";
    const layoutResult = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(layoutResult.ok).toBe(true);
    if (!layoutResult.ok) return;

    const schema1 = {
      schemaVersion: 1,
      status: "proven",
      frozenHost: sampleFrozenHost(),
      appBuild: HISTORICAL_OBSERVED_APP_BUILD_2026_07_25,
      appVersion: "26.721.41059",
      retainedKnobs: ["electron-user-data", "codex-home", "cdp-port", "launch-marker"],
      knobMatrix: [],
      launchMarker: { kind: "exact-argv-token", value: MARKER },
      isolation: {
        electronUserDataPath: layoutResult.layout.electronUserDataPath,
        codexHomePath: layoutResult.layout.codexHomePath,
        explodexHomePath: null,
        cdpHost: "127.0.0.1",
        cdpPort: 9444,
      },
      sanitizedLaunchDescriptor: { argv: [MARKER], envKeys: [] },
      provenAt: CLOCK,
      reason: null,
    };
    await fs.writeFile(
      layoutResult.layout.phase0ContractPath,
      new TextEncoder().encode(`${JSON.stringify(schema1)}\n`),
    );
    const loaded = await loadPhase0LaunchContract({
      adapters: adaptersFor(fs),
      path: layoutResult.layout.phase0ContractPath,
    });
    expect(loaded).toBeNull();

    const gate = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: loaded,
      expectedHost: sampleFrozenHost(),
    });
    expect(gate.allowed).toBe(false);
  });

  test("complete proof rejects null target readiness", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-readiness/.explodex/dev/plugin-dev");
    const frozenHost = sampleFrozenHost();
    const result = evaluatePhase0LaunchContract({
      frozenHost,
      comparativeExperiments: sampleComparativeExperiments(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
      readiness: null,
      ownership: sampleOwnership(),
      requireCompleteProof: true,
    });
    expect(result.contract.status).toBe("incomplete");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.reason).toMatch(/readiness/i);
  });
});
