import { describe, expect, test } from "bun:test";
import {
  COMPATIBILITY_DEPENDENT_OPERATIONS,
  COMPATIBILITY_INDEPENDENT_OPERATIONS,
  DEFAULT_PROBE_TOOL_VERSION,
  MISSION_BASELINE_APP_BUILD,
  MISSION_BASELINE_APP_VERSION,
  PROBE_SCHEMA_VERSION,
  PUBLIC_COMPATIBILITY_PROBE_HINT,
} from "../../src/host/constants.ts";
import {
  compatibilityKeysEqual,
  deriveCompatibilityKey,
} from "../../src/host/compatibility-key.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
  saveCompatibilityRecord,
} from "../../src/host/compatibility-state.ts";
import {
  createLaunchOrEvaluationGuard,
  gateCompatibilityDependentOperation,
  runIfCompatibilityAllows,
} from "../../src/host/compatibility-gate.ts";
import { reportHost, formatHostReportHuman, formatHostReportJson } from "../../src/host/report.ts";
import { inspectHost } from "../../src/host/identity.ts";
import { resolveExplodexHome, compatibilityStatePath } from "../../src/home/paths.ts";
import type { CompatibilityKey, CompatibilityRecord, HostIdentity } from "../../src/host/types.ts";
import {
  createFixtureAdapters,
  defaultCanonicalBundleOptions,
  sha256Of,
} from "./fixture-fs.ts";

const SDK_A = { version: "0.0.0-migration", sha256: sha256Of("sdk-runtime-a") };
const SDK_B = { version: "0.0.0-migration", sha256: sha256Of("sdk-runtime-b") };
const PROBE = { schemaVersion: PROBE_SCHEMA_VERSION, toolVersion: DEFAULT_PROBE_TOOL_VERSION };

function hostFromInspection(host: HostIdentity): HostIdentity {
  return host;
}

async function validHost(): Promise<{
  host: HostIdentity;
  adapters: ReturnType<typeof createFixtureAdapters>["adapters"];
  fs: ReturnType<typeof createFixtureAdapters>["fs"];
}> {
  const { adapters, fs } = createFixtureAdapters({});
  const inspection = await inspectHost({
    adapters,
    bundlePath: "/Applications/ChatGPT.app",
    requireCanonicalPath: true,
  });
  if (!inspection.ok || !inspection.host) throw new Error("fixture host must be valid");
  return { host: hostFromInspection(inspection.host), adapters, fs };
}

function provenRecord(key: CompatibilityKey): CompatibilityRecord {
  return {
    key,
    status: "proven",
    probedAt: "2026-07-23T12:00:00.000Z",
    target: {
      role: "development",
      pid: 4242,
      processStartedAt: "2026-07-23T11:59:00.000Z",
      port: 9444,
      targetId: "TARGET-1",
    },
    capabilitySummary: { bridge: true },
  };
}

describe("clean home compatibility (VAL-HOST-005)", () => {
  test("clean home reports unproven compatibility", async () => {
    const { host, adapters } = await validHost();
    const home = resolveExplodexHome({ osHome: "/tmp/clean-user" });
    expect(home).toBe("/tmp/clean-user/.explodex");

    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_A,
      probe: PROBE,
      persisted: null,
    });

    expect(report.status).toBe("unproven");
    expect(report.allowsCompatibilityDependentWork).toBe(false);
    expect(report.nextAction).toContain("9444");
    expect(report.nextAction).toBe(PUBLIC_COMPATIBILITY_PROBE_HINT);

    // Independent operations remain conceptually allowed.
    for (const operation of COMPATIBILITY_INDEPENDENT_OPERATIONS) {
      const gate = gateCompatibilityDependentOperation({ operation, compatibility: report });
      expect(gate.allowed).toBe(true);
    }
  });

  test("dependent operations block before launch or CDP when unproven", async () => {
    const { host } = await validHost();
    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_A,
      probe: PROBE,
      persisted: null,
    });

    for (const operation of COMPATIBILITY_DEPENDENT_OPERATIONS) {
      const guard = createLaunchOrEvaluationGuard();
      const { gate, result } = runIfCompatibilityAllows({
        operation,
        compatibility: report,
        run: () => {
          guard.tryLaunch();
          guard.tryEvaluate();
          return "should-not-run";
        },
      });
      expect(gate.allowed).toBe(false);
      if (gate.allowed) throw new Error("expected block");
      expect(gate.blockedBeforeLaunchOrEvaluation).toBe(true);
      expect(gate.error.nextAction).toContain("9444");
      expect(result).toBeUndefined();
      expect(guard.attempts).toEqual([]);
    }
  });

  test("host report with empty home state stays unproven and usable", async () => {
    const { adapters } = createFixtureAdapters({});
    const home = "/tmp/explodex-homes/clean-1/.explodex";
    const report = await reportHost({
      adapters,
      explodexHome: home,
      sdkRuntime: SDK_A,
      probe: PROBE,
    });
    expect(report.ok).toBe(true);
    expect(report.compatibility.status).toBe("unproven");
    const human = formatHostReportHuman(report);
    expect(human).toContain("hostValid: true");
    expect(human).toContain("compatibility.status: unproven");
    const json = formatHostReportJson(report) as {
      ok: boolean;
      result: { compatibility: { status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.result.compatibility.status).toBe("unproven");
  });
});

describe("compatibility key exactness (VAL-HOST-006)", () => {
  test("deriveCompatibilityKey includes host, SDK, and probe identities", async () => {
    const { host } = await validHost();
    const key = deriveCompatibilityKey({ host, sdkRuntime: SDK_A, probe: PROBE });
    expect(key.schemaVersion).toBe(1);
    expect(key.appVersion).toBe(MISSION_BASELINE_APP_VERSION);
    expect(key.appBuild).toBe(MISSION_BASELINE_APP_BUILD);
    expect(key.signingTeam).toBe("2DC432GLL2");
    expect(key.sdkRuntimeSha256).toBe(SDK_A.sha256);
    expect(key.probeSchemaVersion).toBe(PROBE_SCHEMA_VERSION);
    expect(key.probeToolVersion).toBe(DEFAULT_PROBE_TOOL_VERSION);
    expect(key.hostHashes["Contents/Info.plist"]).toMatch(/^[a-f0-9]{64}$/);
    expect(key.hostHashes["Contents/MacOS/ChatGPT"]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("proven record is accepted only when every field matches", async () => {
    const { host, adapters, fs } = await validHost();
    const home = "/tmp/explodex-homes/proven-ok/.explodex";
    const key = deriveCompatibilityKey({ host, sdkRuntime: SDK_A, probe: PROBE });
    await saveCompatibilityRecord({
      adapters,
      explodexHome: home,
      record: provenRecord(key),
    });

    const loaded = await loadCompatibilityRecord({ adapters, explodexHome: home });
    expect(loaded?.status).toBe("proven");

    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_A,
      probe: PROBE,
      persisted: loaded,
    });
    expect(report.status).toBe("proven");
    expect(report.matched).toBe(true);
    expect(report.allowsCompatibilityDependentWork).toBe(true);

    // State was written under the home (temp then rename), never under the host bundle.
    expect(await fs.exists(compatibilityStatePath(home))).toBe(true);
    expect(fs.writeLog.length).toBeGreaterThan(0);
    expect(fs.writeLog.every((w) => w.path.startsWith(home))).toBe(true);
    expect(fs.writeLog.every((w) => !w.path.startsWith("/Applications/ChatGPT.app"))).toBe(true);
  });

  const mismatchCases: Array<{
    name: string;
    mutate: (key: CompatibilityKey) => CompatibilityKey;
  }> = [
    {
      name: "appVersion",
      mutate: (key) => ({ ...key, appVersion: "0.0.1" }),
    },
    {
      name: "appBuild",
      mutate: (key) => ({ ...key, appBuild: "1" }),
    },
    {
      name: "signingTeam",
      mutate: (key) => ({ ...key, signingTeam: "ZZZZZZZZZZ" }),
    },
    {
      name: "sdkRuntimeSha256",
      mutate: (key) => ({ ...key, sdkRuntimeSha256: SDK_B.sha256 }),
    },
    {
      name: "probeSchemaVersion",
      mutate: (key) => ({ ...key, probeSchemaVersion: key.probeSchemaVersion + 1 }),
    },
    {
      name: "probeToolVersion",
      mutate: (key) => ({ ...key, probeToolVersion: "other-probe/9.9.9" }),
    },
    {
      name: "hostHashes.Info.plist",
      mutate: (key) => ({
        ...key,
        hostHashes: {
          ...key.hostHashes,
          "Contents/Info.plist": sha256Of("drifted-plist"),
        },
      }),
    },
    {
      name: "hostHashes.executable same-build drift",
      mutate: (key) => ({
        ...key,
        hostHashes: {
          ...key.hostHashes,
          "Contents/MacOS/ChatGPT": sha256Of("same-build-byte-drift"),
        },
      }),
    },
  ];

  test.each(mismatchCases)("mismatch on $name returns unproven and blocks", async ({ mutate }) => {
    const { host } = await validHost();
    const currentKey = deriveCompatibilityKey({ host, sdkRuntime: SDK_A, probe: PROBE });
    const staleKey = mutate(currentKey);
    expect(compatibilityKeysEqual(currentKey, staleKey)).toBe(false);

    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_A,
      probe: PROBE,
      persisted: provenRecord(staleKey),
    });
    expect(report.status).toBe("unproven");
    expect(report.matched).toBe(false);
    expect(report.allowsCompatibilityDependentWork).toBe(false);
    expect(report.reason?.startsWith("compatibility_key_mismatch")).toBe(true);

    const gate = gateCompatibilityDependentOperation({
      operation: "inject",
      compatibility: report,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("expected block");
    expect(gate.error.code).toBe("compatibility_stale");
    expect(gate.blockedBeforeLaunchOrEvaluation).toBe(true);
  });

  test("changed SDK runtime against stored proof becomes unproven", async () => {
    const { host } = await validHost();
    const keyA = deriveCompatibilityKey({ host, sdkRuntime: SDK_A, probe: PROBE });
    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_B,
      probe: PROBE,
      persisted: provenRecord(keyA),
    });
    expect(report.status).toBe("unproven");
    expect(report.reason).toContain("sdkRuntimeSha256");
  });

  test("running process that disagrees with current app build invalidates proof", async () => {
    const { host } = await validHost();
    const key = deriveCompatibilityKey({ host, sdkRuntime: SDK_A, probe: PROBE });
    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_A,
      probe: PROBE,
      persisted: provenRecord(key),
      runningProcess: {
        appVersion: host.appVersion,
        appBuild: "1111",
      },
    });
    expect(report.status).toBe("unproven");
    expect(report.reason).toContain("running_app_build");
    expect(report.allowsCompatibilityDependentWork).toBe(false);
  });

  test("compatibility verdict never implies process ownership", async () => {
    const { host } = await validHost();
    const key = deriveCompatibilityKey({ host, sdkRuntime: SDK_A, probe: PROBE });
    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK_A,
      probe: PROBE,
      persisted: provenRecord(key),
    });
    expect(report.allowsCompatibilityDependentWork).toBe(true);
    // The report intentionally has no PID/port/target ownership fields.
    expect("pid" in report).toBe(false);
    expect("port" in report).toBe(false);
    expect("targetId" in report).toBe(false);
  });
});

describe("host report integration", () => {
  test("live-shaped fixture with unknown build is valid host and unproven compatibility", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "30.0.0",
          appBuild: "9999",
        }),
      ],
    });
    const report = await reportHost({
      adapters,
      explodexHome: "/tmp/explodex-homes/unknown-build/.explodex",
      sdkRuntime: SDK_A,
    });
    expect(report.ok).toBe(true);
    if (!report.ok || !report.host) throw new Error("expected ok");
    expect(report.hostValid).toBe(true);
    expect(report.host.appBuild).toBe("9999");
    expect(report.compatibility.status).toBe("unproven");
    expect(report.compatibility.allowsCompatibilityDependentWork).toBe(false);
  });
});
