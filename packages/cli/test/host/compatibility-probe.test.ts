import { describe, expect, test } from "bun:test";
import {
  COMPATIBILITY_SCHEMA_VERSION,
  DEFAULT_PROBE_TOOL_VERSION,
  PROBE_SCHEMA_VERSION,
} from "../../src/host/constants.ts";
import { deriveCompatibilityKey } from "../../src/host/compatibility-key.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
  saveCompatibilityRecord,
} from "../../src/host/compatibility-state.ts";
import {
  assembleCompatibilityProbeResult,
  buildCompatibilityRecordFromProbe,
  correlateProbeSections,
  decideProbeCommit,
} from "../../src/host/probe-result.ts";
import {
  REQUIRED_BRIDGE_METHODS,
  REQUIRED_PROBE_ANCHORS,
  type ProbeAnchorsSection,
  type ProbeBridgeSection,
  type ProbeCorrelationIdentity,
  type ProbeEndpointSection,
  type ProbeIsolationSection,
  type ProbeSafetySection,
  type ProbeSdkBootstrapSection,
} from "../../src/host/probe-types.ts";
import { resolveGeneratedSdkRuntimeIdentity } from "../../src/host/sdk-runtime-identity.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import { createFixtureAdapters, sha256Of } from "./fixture-fs.ts";
import { inspectHost } from "../../src/host/identity.ts";
import { validatePhase0AcceptanceAuthority } from "../../src/dev/phase0.ts";
import type { Phase0AcceptanceAuthority, Phase0FrozenHost } from "../../src/dev/types.ts";

const SDK = { version: "1.2.0", sha256: sha256Of("sdk-runtime-probe") };
const PROBE = { schemaVersion: PROBE_SCHEMA_VERSION, toolVersion: DEFAULT_PROBE_TOOL_VERSION };

async function validHost(): Promise<HostIdentity> {
  const { adapters } = createFixtureAdapters({});
  const inspection = await inspectHost({ adapters });
  if (!inspection.ok || !inspection.host) throw new Error("fixture host must be valid");
  return inspection.host;
}

function identityFor(host: HostIdentity): ProbeCorrelationIdentity {
  const key = deriveCompatibilityKey({ host, sdkRuntime: SDK, probe: PROBE });
  return {
    operationId: "probe_test_1",
    compatibilityKey: key,
    frozenHost: host,
    pid: 50134,
    processStartedAt: "105599718.151298435",
    port: 9444,
    targetId: "TARGET-ACCEPT",
    executionContextId: 1,
    executionContextUniqueId: "ctx-unique-1",
    sdkRuntime: SDK,
    probe: PROBE,
  };
}

function completeIsolation(host: HostIdentity): ProbeIsolationSection {
  return {
    complete: true,
    phase0Status: "proven",
    retainedKnobs: ["electron-user-data", "codex-home", "cdp-port", "launch-marker"],
    launchMarker: "--explodex-dev-instance=plugin-dev",
    isolation: {
      electronUserDataPath: "/tmp/dev/electron-user-data",
      codexHomePath: "/tmp/dev/codex-home",
      explodexHomePath: null,
      cdpHost: "127.0.0.1",
      cdpPort: 9444,
    },
    phase0FrozenHost: {
      bundlePath: host.bundlePath,
      executablePath: host.executablePath,
      bundleId: host.bundleId,
      executableName: host.executableName,
      signingTeam: host.signingTeam,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      hostHashes: { ...host.hostHashes },
    },
    reason: null,
  };
}

function completeEndpoint(identity: ProbeCorrelationIdentity): ProbeEndpointSection {
  return {
    complete: true,
    portOwnerPid: identity.pid,
    browserIdentity: "Chrome/150.0.7871.128",
    endpointPublishedPid: identity.pid,
    targets: [
      {
        id: identity.targetId,
        type: "page",
        url: "app://-/index.html",
        title: "ChatGPT",
      },
    ],
    selectedTargetId: identity.targetId,
    selectedTargetUrl: "app://-/index.html",
    executionContextId: identity.executionContextId,
    executionContextUniqueId: identity.executionContextUniqueId,
    reason: null,
  };
}

function completeBridge(): ProbeBridgeSection {
  return {
    complete: true,
    transportAvailable: true,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods: [...REQUIRED_BRIDGE_METHODS],
    benignRequest: "theme-or-availability",
    benignResponse: { kind: "theme", value: "dark" },
    conversationMutated: false,
    turnStarted: false,
    settingsChanged: false,
    reason: null,
  };
}

function completeSdk(): ProbeSdkBootstrapSection {
  return {
    complete: true,
    sdkRuntime: SDK,
    firstBootstrapVersion: SDK.version,
    secondBootstrapVersion: SDK.version,
    singleInstance: true,
    repeatCount: 2,
    reason: null,
  };
}

function completeAnchors(mode: "all-pass" | "pending" | "fail-sidebar" = "all-pass"): ProbeAnchorsSection {
  const matrix = REQUIRED_PROBE_ANCHORS.map((name) => {
    if (mode === "fail-sidebar" && name === "sidebar") {
      return {
        name,
        verdict: "fail" as const,
        selector: null,
        count: 0,
        visible: null,
        rect: null,
        requiresSignedIn: false,
        reason: "missing",
      };
    }
    if (mode === "pending" && (name === "profileSettingsFooter" || name === "homeAmbient")) {
      return {
        name,
        verdict: "pending-unreachable" as const,
        selector: null,
        count: 0,
        visible: null,
        rect: null,
        requiresSignedIn: name === "profileSettingsFooter",
        reason: "requires_signed_in_or_route",
      };
    }
    return {
      name,
      verdict: "pass" as const,
      selector: `[data-test="${name}"]`,
      count: 1,
      visible: true,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      requiresSignedIn: name === "profileSettingsFooter",
      reason: null,
    };
  });
  const pendingUnreachable = matrix
    .filter((entry) => entry.verdict === "pending-unreachable")
    .map((entry) => entry.name);
  const failed = matrix.filter((entry) => entry.verdict === "fail").map((entry) => entry.name);
  return {
    complete: mode === "all-pass",
    matrix,
    pendingUnreachable,
    failed,
    reason:
      mode === "all-pass"
        ? null
        : mode === "pending"
          ? "signed_in_or_route_anchor_pending"
          : "anchor_failed:sidebar",
  };
}

function completeSafety(host: HostIdentity): ProbeSafetySection {
  return {
    complete: true,
    role: "development",
    port: 9444,
    hostReadOnly: true,
    conversationNondestructive: true,
    isolated: true,
    devFirst: true,
    hostSnapshots: {
      operationStart: host,
      preEndpoint: host,
      preBridge: host,
      preSdk: host,
      preAnchor: host,
      prePersist: host,
    },
    authoringMain: {
      pid: 60014,
      processStartedAt: "2026-07-26T00:00:00.000000000Z",
      survived: true,
    },
    credentialsInspected: false,
    reason: null,
  };
}

describe("compatibility probe pure result (VAL-HOST-008/037-040)", () => {
  test("complete correlated sections authorize atomic proven commit", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const result = assembleCompatibilityProbeResult({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("all-pass"),
      safety: completeSafety(host),
      clockIso: "2026-07-26T18:00:00.000Z",
    });

    expect(result.correlation.ok).toBe(true);
    expect(result.status).toBe("proven");
    expect(result.allowsCompatibilityCommit).toBe(true);
    expect(result.probedAt).toBe("2026-07-26T18:00:00.000Z");

    const record = buildCompatibilityRecordFromProbe(result);
    expect(record.status).toBe("proven");
    expect(record.target.pid).toBe(identity.pid);
    expect(record.target.port).toBe(9444);
    expect(record.key.schemaVersion).toBe(COMPATIBILITY_SCHEMA_VERSION);
    expect(record.key.sdkRuntimeSha256).toBe(SDK.sha256);
  });

  test("endpoint-only partial result cannot commit proven", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const result = assembleCompatibilityProbeResult({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: {
        complete: false,
        transportAvailable: false,
        requiredMethods: REQUIRED_BRIDGE_METHODS,
        observedMethods: [],
        benignRequest: null,
        benignResponse: null,
        conversationMutated: false,
        turnStarted: false,
        settingsChanged: false,
        reason: "bridge_not_run",
      },
      sdkBootstrap: {
        complete: false,
        sdkRuntime: null,
        firstBootstrapVersion: null,
        secondBootstrapVersion: null,
        singleInstance: false,
        repeatCount: 0,
        reason: "sdk_not_run",
      },
      anchors: completeAnchors("all-pass"),
      safety: completeSafety(host),
      clockIso: "2026-07-26T18:00:00.000Z",
    });
    expect(result.status).toBe("unproven");
    expect(result.allowsCompatibilityCommit).toBe(false);
    expect(() => buildCompatibilityRecordFromProbe(result)).toThrow();
  });

  test("cross-section identity mismatch aborts without commit", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const endpoint = completeEndpoint(identity);
    endpoint.portOwnerPid = identity.pid + 1;
    const correlation = correlateProbeSections({
      identity,
      isolation: completeIsolation(host),
      endpoint,
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("all-pass"),
      safety: completeSafety(host),
    });
    expect(correlation.ok).toBe(false);
    expect(correlation.mismatches).toContain("endpoint.portOwnerPid");

    const decision = decideProbeCommit({
      schemaVersion: 1,
      operationId: identity.operationId,
      identity,
      isolation: completeIsolation(host),
      endpoint,
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("all-pass"),
      safety: completeSafety(host),
      correlation,
    });
    expect(decision.commit).toBe(false);
    expect(decision.status).toBe("failed");
  });

  test("active host snapshot drift fails correlation", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const safety = completeSafety(host);
    safety.hostSnapshots.prePersist = {
      ...host,
      appBuild: "9999",
    };
    const correlation = correlateProbeSections({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("all-pass"),
      safety,
    });
    expect(correlation.ok).toBe(false);
    expect(correlation.mismatches.some((entry) => entry.startsWith("safety.hostSnapshots"))).toBe(
      true,
    );
  });

  test("unreachable signed-in anchors remain pending and never prove", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const result = assembleCompatibilityProbeResult({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("pending"),
      safety: completeSafety(host),
      clockIso: "2026-07-26T18:00:00.000Z",
    });
    expect(result.status).toBe("pending");
    expect(result.allowsCompatibilityCommit).toBe(false);
    expect(result.reason).toContain("pending");
  });

  test("required reachable anchor failure leaves unproven", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const result = assembleCompatibilityProbeResult({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("fail-sidebar"),
      safety: completeSafety(host),
      clockIso: "2026-07-26T18:00:00.000Z",
    });
    expect(result.status).toBe("unproven");
    expect(result.allowsCompatibilityCommit).toBe(false);
  });

  test("safety-only result cannot record proven", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const result = assembleCompatibilityProbeResult({
      identity,
      isolation: {
        complete: false,
        phase0Status: null,
        retainedKnobs: [],
        launchMarker: null,
        isolation: null,
        phase0FrozenHost: null,
        reason: "missing",
      },
      endpoint: {
        complete: false,
        portOwnerPid: null,
        browserIdentity: null,
        endpointPublishedPid: null,
        targets: [],
        selectedTargetId: null,
        selectedTargetUrl: null,
        executionContextId: null,
        executionContextUniqueId: null,
        reason: "missing",
      },
      bridge: {
        complete: false,
        transportAvailable: false,
        requiredMethods: REQUIRED_BRIDGE_METHODS,
        observedMethods: [],
        benignRequest: null,
        benignResponse: null,
        conversationMutated: false,
        turnStarted: false,
        settingsChanged: false,
        reason: "missing",
      },
      sdkBootstrap: {
        complete: false,
        sdkRuntime: null,
        firstBootstrapVersion: null,
        secondBootstrapVersion: null,
        singleInstance: false,
        repeatCount: 0,
        reason: "missing",
      },
      anchors: completeAnchors("all-pass"),
      safety: completeSafety(host),
      clockIso: "2026-07-26T18:00:00.000Z",
    });
    expect(result.status).toBe("unproven");
    expect(result.allowsCompatibilityCommit).toBe(false);
  });

  test("changed compatibility key invalidates prior proven record", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const proven = assembleCompatibilityProbeResult({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: completeBridge(),
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("all-pass"),
      safety: completeSafety(host),
      clockIso: "2026-07-26T18:00:00.000Z",
    });
    const record = buildCompatibilityRecordFromProbe(proven);
    const { adapters } = createFixtureAdapters({});
    const home = "/tmp/explodex-homes/probe-key-drift/.explodex";
    await saveCompatibilityRecord({ adapters, explodexHome: home, record });
    const loaded = await loadCompatibilityRecord({ adapters, explodexHome: home });
    expect(loaded?.status).toBe("proven");

    const report = evaluateCompatibility({
      host,
      sdkRuntime: { version: SDK.version, sha256: sha256Of("different-sdk") },
      probe: PROBE,
      persisted: loaded,
    });
    expect(report.status).toBe("unproven");
    expect(report.allowsCompatibilityDependentWork).toBe(false);
    expect(report.reason).toContain("compatibility_key_mismatch");
  });

  test("generated SDK runtime identity resolves version and sha256", async () => {
    const runtime = await resolveGeneratedSdkRuntimeIdentity();
    expect(runtime.version.length).toBeGreaterThan(0);
    expect(runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.source.includes("Explodex")).toBe(true);
  });
});

describe("Phase 0 keep-alive acceptance authority (M1-F05)", () => {
  test("keep-alive acceptance validates residual owned authority without stop claim", async () => {
    const host = await validHost();
    const frozen: Phase0FrozenHost = {
      bundlePath: host.bundlePath,
      executablePath: host.executablePath,
      bundleId: host.bundleId,
      executableName: host.executableName,
      signingTeam: host.signingTeam,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      hostHashes: { ...host.hostHashes },
    };
    const authority: Phase0AcceptanceAuthority = {
      operationId: "phase0_keep_alive_1",
      readinessPid: 50134,
      readinessProcessStartedAt: "105599718.151298435",
      protectedMainInventoryAttested: true,
      protectedMainBefore: [],
      protectedMainAfter: [],
      finalHostRecheck: frozen,
      cleanupDisposition: {
        method: "none",
        stopped: false,
        portReleased: false,
        uncertain: false,
        reason: "intentional-keep-alive",
      },
      port9444Released: false,
      mode: "keep-alive",
    };
    const readiness = {
      pid: 50134,
      processStartedAt: "105599718.151298435",
      executablePath: frozen.executablePath,
      portOwnerPid: 50134,
      cdpHost: "127.0.0.1" as const,
      cdpPort: 9444 as const,
      browserIdentity: "Chrome/150.0.7871.128",
      endpointPublishedPid: 50134,
      targetId: "T1",
      targetUrl: "app://-/index.html" as const,
      executionContextId: 1,
      executionContextUniqueId: "u1",
      frameId: "T1",
      rendererEvaluation: {
        expression:
          "(() => ({ explodexPhase0Readiness: true, readyState: document.readyState, href: location.href }))()",
        result: {
          explodexPhase0Readiness: true,
          readyState: "interactive",
          href: "app://-/index.html",
        },
        evaluatedAt: "2026-07-26T18:00:00.000Z",
      },
      readiness: "benign" as const,
    };
    const check = validatePhase0AcceptanceAuthority(authority, {
      frozenHost: frozen,
      readiness,
      launchMarker: "--explodex-dev-instance=plugin-dev",
      isolation: {
        electronUserDataPath: "/tmp/dev/electron-user-data",
        codexHomePath: "/tmp/dev/codex-home",
        explodexHomePath: null,
        cdpHost: "127.0.0.1",
        cdpPort: 9444,
      },
      descriptor: {
        argv: [frozen.executablePath, "--user-data-dir=/tmp/dev/electron-user-data", "--remote-debugging-port=9444", "--explodex-dev-instance=plugin-dev"],
        envKeys: ["CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH"],
        envValues: {
          CODEX_HOME: "/tmp/dev/codex-home",
          CODEX_ELECTRON_USER_DATA_PATH: "/tmp/dev/electron-user-data",
        },
      },
    });
    expect(check.ok).toBe(true);
  });

  test("stopped acceptance still rejects cleanup method none", async () => {
    const host = await validHost();
    const frozen: Phase0FrozenHost = {
      bundlePath: host.bundlePath,
      executablePath: host.executablePath,
      bundleId: host.bundleId,
      executableName: host.executableName,
      signingTeam: host.signingTeam,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      hostHashes: { ...host.hostHashes },
    };
    const authority: Phase0AcceptanceAuthority = {
      operationId: "phase0_stopped_1",
      readinessPid: 50134,
      readinessProcessStartedAt: "105599718.151298435",
      protectedMainInventoryAttested: true,
      protectedMainBefore: [],
      protectedMainAfter: [],
      finalHostRecheck: frozen,
      cleanupDisposition: {
        method: "none",
        stopped: false,
        portReleased: false,
        uncertain: false,
      },
      port9444Released: false,
      mode: "stopped",
    };
    const readiness = {
      pid: 50134,
      processStartedAt: "105599718.151298435",
      executablePath: frozen.executablePath,
      portOwnerPid: 50134,
      cdpHost: "127.0.0.1" as const,
      cdpPort: 9444 as const,
      browserIdentity: "Chrome/150.0.7871.128",
      endpointPublishedPid: null,
      targetId: "T1",
      targetUrl: "app://-/index.html" as const,
      executionContextId: 1,
      executionContextUniqueId: "u1",
      frameId: "T1",
      rendererEvaluation: {
        expression:
          "(() => ({ explodexPhase0Readiness: true, readyState: document.readyState, href: location.href }))()",
        result: {
          explodexPhase0Readiness: true,
          readyState: "interactive",
          href: "app://-/index.html",
        },
        evaluatedAt: "2026-07-26T18:00:00.000Z",
      },
      readiness: "benign" as const,
    };
    const check = validatePhase0AcceptanceAuthority(authority, {
      frozenHost: frozen,
      readiness,
      launchMarker: "--explodex-dev-instance=plugin-dev",
      isolation: {
        electronUserDataPath: "/tmp/dev/electron-user-data",
        codexHomePath: "/tmp/dev/codex-home",
        explodexHomePath: null,
        cdpHost: "127.0.0.1",
        cdpPort: 9444,
      },
      descriptor: {
        argv: [frozen.executablePath, "--explodex-dev-instance=plugin-dev"],
        envKeys: [],
      },
    });
    expect(check.ok).toBe(false);
  });
});
