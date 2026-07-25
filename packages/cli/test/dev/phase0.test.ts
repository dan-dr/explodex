import { describe, expect, test } from "bun:test";
import {
  createDisabledPhase0Contract,
  describeDevLayout,
  ensureDefaultDevLayout,
  evaluatePhase0LaunchContract,
  gateDevelopmentLifecycleMutation,
  loadPhase0LaunchContract,
  markerMatchesExactly,
  ownershipFromLayoutOnly,
  runIfPhase0Allows,
  savePhase0LaunchContract,
} from "../../src/dev/index.ts";
import type { Phase0KnobObservation } from "../../src/dev/types.ts";
import { MISSION_BASELINE_APP_BUILD } from "../../src/host/constants.ts";
import type { HostAdapters } from "../../src/host/adapters.ts";
import { createFixedClock, createMemoryHash, MemoryFileSystem } from "../host/fixture-fs.ts";

const CLOCK = "2026-07-25T15:00:00.000Z";
const MARKER = "--explodex-dev-instance=plugin-dev";

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
        argv: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", MARKER, "--remote-debugging-port=9444"],
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

  test("independent knob matrix retains only the smallest effective set", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-b/.explodex/dev/plugin-dev");
    const result = evaluatePhase0LaunchContract({
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });

    expect(result.contract.status).toBe("proven");
    expect(result.allowsLifecycleMutation).toBe(true);
    expect(result.allowsCompatibilityProbe).toBe(true);
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
    const base = completeObservations(layout.rootPath);

    const missingMarker = evaluatePhase0LaunchContract({
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
      observations: base.filter((entry) => entry.knob !== "launch-marker"),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(missingMarker.contract.status).toBe("incomplete");
    expect(missingMarker.allowsLifecycleMutation).toBe(false);

    const substringMarker = evaluatePhase0LaunchContract({
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
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
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
      observations: base,
      proposedMarker: { kind: "exact-argv-token", value: "--token=super-secret" },
      layout,
      clockIso: CLOCK,
    });
    expect(secretMarker.contract.status).toBe("incomplete");
    expect(secretMarker.allowsLifecycleMutation).toBe(false);
  });

  test("unauthorized or mismatched build cannot freeze a proven contract", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-d/.explodex/dev/plugin-dev");
    const result = evaluatePhase0LaunchContract({
      appBuild: "5848",
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(result.contract.status).toBe("incomplete");
    expect(result.allowsLifecycleMutation).toBe(false);
    expect(result.contract.reason).toMatch(/not the authorized build/);
  });

  test("exact marker matching rejects substrings and protected-main argv", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-e/.explodex/dev/plugin-dev");
    const proven = evaluatePhase0LaunchContract({
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
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
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
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

    let launched = false;
    const result = runIfPhase0Allows({
      operation: "compatibility-probe",
      contract: loaded,
      expectedBuild: MISSION_BASELINE_APP_BUILD,
      run: () => {
        launched = true;
        return "launched";
      },
    });
    expect(result.gate.allowed).toBe(false);
    expect(launched).toBe(false);
    expect(result.result).toBeUndefined();
  });

  test("proven contract allows lifecycle mutation only for the expected build", () => {
    const layout = describeDevLayout("/tmp/homes/phase0-g/.explodex/dev/plugin-dev");
    const proven = evaluatePhase0LaunchContract({
      appBuild: MISSION_BASELINE_APP_BUILD,
      authorizedBuild: MISSION_BASELINE_APP_BUILD,
      observations: completeObservations(layout.rootPath),
      proposedMarker: { kind: "exact-argv-token", value: MARKER },
      layout,
      clockIso: CLOCK,
    });
    expect(proven.contract.status).toBe("proven");

    const allowed = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: proven.contract,
      expectedBuild: MISSION_BASELINE_APP_BUILD,
    });
    expect(allowed.allowed).toBe(true);

    const mismatched = gateDevelopmentLifecycleMutation({
      operation: "dev-start",
      contract: proven.contract,
      expectedBuild: "5848",
    });
    expect(mismatched.allowed).toBe(false);
    if (mismatched.allowed) return;
    expect(mismatched.error.code).toBe("phase0_build_mismatch");
  });
});
