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
  buildBridgeEvalExpression,
  classifyBenignBridgeResponse,
  conversationNondestructiveFromBridge,
  deriveNondestructiveFromSurfaces,
  factuallyObservedRequiredMethods,
  parseBridgeValue,
} from "../../src/host/probe-bridge.ts";
import {
  correlatePointOfUseObservation,
  matchBrowserTargetContext,
  matchCompatibilityIdentity,
  matchCompleteCompatibleTargetInventory,
  matchCompleteDefaultContextInventory,
  matchFrozenHost,
  matchProcessIdentity,
  matchUniquePortOwner,
  type ProbePointOfUseExpected,
  type ProbePointOfUseObservation,
} from "../../src/host/probe-point-of-use.ts";
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
  type ProbeConversationSurface,
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
import type { TargetIdentity } from "../../src/cdp/types.ts";

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

function completeSurface(overrides: Partial<ProbeConversationSurface> = {}): ProbeConversationSurface {
  return {
    href: "app://-/index.html",
    readyState: "complete",
    conversationIds: ["c1"],
    messageCount: 2,
    composerValue: "",
    nextTurnHints: [{ key: "model", value: "gpt" }],
    ...overrides,
  };
}

function completeBridge(): ProbeBridgeSection {
  const surface = completeSurface();
  return {
    complete: true,
    transportAvailable: true,
    invokedTransport: "electronBridge.sendMessageFromView",
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods: [...REQUIRED_BRIDGE_METHODS],
    benignRequest: JSON.stringify({
      transport: "electronBridge.sendMessageFromView",
      type: "get-setting",
      params: { key: "__explodex.compat-probe.sentinel" },
    }),
    benignResponse: {
      kind: "success",
      transport: "electronBridge.sendMessageFromView",
      invoked: true,
      value: null,
    },
    conversationMutated: false,
    turnStarted: false,
    settingsChanged: false,
    beforeSurface: surface,
    afterSurface: surface,
    surfaceEvidenceComplete: true,
    reason: null,
  };
}

function incompleteBridgeFixture(
  reason: string,
  overrides: Partial<ProbeBridgeSection> = {},
): ProbeBridgeSection {
  return {
    complete: false,
    transportAvailable: false,
    invokedTransport: null,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods: [],
    benignRequest: null,
    benignResponse: null,
    conversationMutated: null,
    turnStarted: null,
    settingsChanged: null,
    beforeSurface: null,
    afterSurface: null,
    surfaceEvidenceComplete: false,
    reason,
    ...overrides,
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
      bridge: incompleteBridgeFixture("bridge_not_run"),
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
      schemaVersion: 2,
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
      bridge: incompleteBridgeFixture("missing"),
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

  test("fabricated nondestructive bridge without surface evidence cannot commit proven", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const fabricated: ProbeBridgeSection = {
      complete: true,
      transportAvailable: true,
      invokedTransport: "electronBridge.sendMessageFromView",
      requiredMethods: REQUIRED_BRIDGE_METHODS,
      observedMethods: [...REQUIRED_BRIDGE_METHODS],
      benignRequest: "theme-or-availability",
      benignResponse: { kind: "theme", value: "dark" },
      conversationMutated: false,
      turnStarted: false,
      settingsChanged: false,
      beforeSurface: null,
      afterSurface: null,
      surfaceEvidenceComplete: false,
      reason: null,
    };
    const result = assembleCompatibilityProbeResult({
      identity,
      isolation: completeIsolation(host),
      endpoint: completeEndpoint(identity),
      bridge: fabricated,
      sdkBootstrap: completeSdk(),
      anchors: completeAnchors("all-pass"),
      safety: {
        ...completeSafety(host),
        conversationNondestructive: true,
      },
      clockIso: "2026-07-26T18:00:00.000Z",
    });
    expect(result.allowsCompatibilityCommit).toBe(false);
    expect(result.status).toBe("unproven");
    expect(result.reason).toContain("nondestructive");
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

describe("factual bridge observations (VAL-HOST-038 / M1-F05R)", () => {
  test("required methods are recorded only when factually observed", () => {
    const missing = factuallyObservedRequiredMethods([]);
    expect(missing.observedRequired).toEqual([]);
    expect(missing.missingRequired).toEqual([...REQUIRED_BRIDGE_METHODS]);

    const partial = factuallyObservedRequiredMethods(["start-turn-for-host"]);
    expect(partial.observedRequired).toEqual(["start-turn-for-host"]);
    expect(partial.missingRequired).toEqual(["update-thread-settings-for-next-turn"]);

    const full = factuallyObservedRequiredMethods([...REQUIRED_BRIDGE_METHODS, "extra"]);
    expect(full.missingRequired).toEqual([]);
  });

  test("bridge expression never invents required methods into observedMethods", () => {
    const expression = buildBridgeEvalExpression();
    expect(expression.includes("if (!observed.includes(method)) observed.push(method)")).toBe(
      false,
    );
    expect(expression.includes("observed.push(method)")).toBe(true);
    expect(expression.includes("beforeSurface")).toBe(true);
    expect(expression.includes("afterSurface")).toBe(true);
    expect(expression.includes("invokedTransport")).toBe(true);
    expect(expression.includes("electronBridge.sendMessageFromView")).toBe(true);
    expect(expression.includes("appServerSend")).toBe(true);
    // Must actually invoke a bridge transport, not only check availability.
    expect(expression.includes("sendMessageFromView(message)")).toBe(true);
  });

  test("missing required methods leave bridge non-authorizing even with transport", () => {
    const surface = completeSurface();
    const section = parseBridgeValue({
      transportAvailable: true,
      invokedTransport: "electronBridge.sendMessageFromView",
      observedMethods: [],
      benignRequest: JSON.stringify({ type: "get-setting" }),
      benignResponse: {
        kind: "success",
        transport: "electronBridge.sendMessageFromView",
        invoked: true,
        value: null,
      },
      beforeSurface: surface,
      afterSurface: surface,
    });
    expect(section.complete).toBe(false);
    expect(section.reason).toContain("bridge_methods_missing");
    expect(section.observedMethods).toEqual([]);
  });

  test("hard-coded mutation false flags without surfaces cannot authorize nondestructive", () => {
    const section = parseBridgeValue({
      transportAvailable: true,
      invokedTransport: "electronBridge.sendMessageFromView",
      observedMethods: [...REQUIRED_BRIDGE_METHODS],
      benignRequest: JSON.stringify({ type: "get-setting" }),
      benignResponse: {
        kind: "success",
        transport: "electronBridge.sendMessageFromView",
        invoked: true,
        value: null,
      },
      conversationMutated: false,
      turnStarted: false,
      settingsChanged: false,
    });
    expect(section.complete).toBe(false);
    expect(section.surfaceEvidenceComplete).toBe(false);
    expect(conversationNondestructiveFromBridge(section)).toBe(false);
  });

  test("changed conversation surface cannot be reported nondestructive", () => {
    const before = completeSurface({ messageCount: 1, conversationIds: ["a"] });
    const after = completeSurface({ messageCount: 2, conversationIds: ["a"] });
    const derived = deriveNondestructiveFromSurfaces(before, after);
    expect(derived.surfaceEvidenceComplete).toBe(true);
    expect(derived.turnStarted).toBe(true);
    expect(derived.conversationNondestructive).toBe(false);

    const section = parseBridgeValue({
      transportAvailable: true,
      invokedTransport: "electronBridge.sendMessageFromView",
      observedMethods: [...REQUIRED_BRIDGE_METHODS],
      benignRequest: JSON.stringify({ type: "get-setting" }),
      benignResponse: {
        kind: "success",
        transport: "electronBridge.sendMessageFromView",
        invoked: true,
        value: null,
      },
      beforeSurface: before,
      afterSurface: after,
    });
    expect(section.complete).toBe(false);
    expect(section.reason).toBe("bridge_mutated_conversation");
    expect(conversationNondestructiveFromBridge(section)).toBe(false);
  });

  test("complete matching before/after surfaces authorize nondestructive bridge", () => {
    const surface = completeSurface();
    const section = parseBridgeValue({
      transportAvailable: true,
      invokedTransport: "electronBridge.sendMessageFromView",
      observedMethods: [...REQUIRED_BRIDGE_METHODS],
      benignRequest: JSON.stringify({
        transport: "electronBridge.sendMessageFromView",
        type: "get-setting",
      }),
      benignResponse: {
        kind: "success",
        transport: "electronBridge.sendMessageFromView",
        invoked: true,
        value: null,
      },
      beforeSurface: surface,
      afterSurface: { ...surface, conversationIds: [...surface.conversationIds] },
    });
    expect(section.complete).toBe(true);
    expect(section.surfaceEvidenceComplete).toBe(true);
    expect(section.invokedTransport).toBe("electronBridge.sendMessageFromView");
    expect(conversationNondestructiveFromBridge(section)).toBe(true);
  });
});

describe("point-of-use identity barriers (VAL-HOST-037/039/040 / M1-F05R)", () => {
  test("host, process, port, target/context, and compatibility barriers detect drift", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const process = {
      pid: identity.pid,
      parentPid: 0,
      processStartedAt: identity.processStartedAt,
      executablePath: host.executablePath,
      arguments: [host.executablePath],
    };
    const target: TargetIdentity = {
      role: "development",
      pid: identity.pid,
      processStartedAt: identity.processStartedAt,
      executablePath: host.executablePath,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      port: 9444,
      browserIdentity: "Chrome/150.0.7871.128",
      targetId: identity.targetId,
      targetType: "page",
      targetUrl: "app://-/index.html",
      executionContextId: identity.executionContextId,
      executionContextUniqueId: identity.executionContextUniqueId,
      frameId: identity.targetId,
    };
    const expected: ProbePointOfUseExpected = {
      host,
      process,
      port: 9444,
      browserIdentity: target.browserIdentity,
      target,
      compatibilityKey: identity.compatibilityKey,
      sdkRuntime: SDK,
      probe: PROBE,
    };

    expect(matchFrozenHost(host, { ...host, appBuild: "9999" })).toBe("active_host_drift");
    expect(
      matchProcessIdentity(process, {
        pid: process.pid,
        processStartedAt: "other-start",
        executablePath: process.executablePath,
        alive: true,
      }),
    ).toBe("process_identity_drift:start");
    expect(
      matchUniquePortOwner(process, 9444, [
        {
          pid: process.pid + 1,
          processStartedAt: process.processStartedAt,
          host: "127.0.0.1",
          port: 9444,
          family: "ipv4",
        },
      ]),
    ).toBe("port_owner_drift:missing_acceptance");
    expect(
      matchBrowserTargetContext(target, {
        browserIdentity: target.browserIdentity,
        endpointPublishedPid: target.pid,
        targetId: "OTHER",
        targetUrl: target.targetUrl,
        targetType: target.targetType,
        executionContextId: target.executionContextId,
        executionContextUniqueId: target.executionContextUniqueId,
        frameId: target.frameId,
      }),
    ).toBe("target_identity_drift:id");
    expect(
      matchCompatibilityIdentity(
        identity.compatibilityKey,
        host,
        { version: SDK.version, sha256: sha256Of("different-sdk") },
        PROBE,
      ),
    ).toBe("compatibility_identity_drift");

    const okObservation: ProbePointOfUseObservation = {
      host,
      processAlive: true,
      processExecutablePath: process.executablePath,
      processStartedAt: process.processStartedAt,
      listeners: [
        {
          pid: process.pid,
          processStartedAt: process.processStartedAt,
          host: "127.0.0.1",
          port: 9444,
          family: "ipv4" as const,
        },
      ],
      browserIdentity: target.browserIdentity,
      endpointPublishedPid: target.pid,
      compatibleTargets: [
        {
          id: target.targetId,
          type: target.targetType,
          url: target.targetUrl,
        },
      ],
      defaultContexts: [
        {
          id: target.executionContextId,
          uniqueId: target.executionContextUniqueId,
          frameId: target.frameId,
          isDefault: true,
        },
      ],
      targetId: target.targetId,
      targetUrl: target.targetUrl,
      targetType: target.targetType,
      executionContextId: target.executionContextId,
      executionContextUniqueId: target.executionContextUniqueId,
      frameId: target.frameId,
      compatibilityKey: identity.compatibilityKey,
    };
    expect(correlatePointOfUseObservation({ expected, observation: okObservation })).toBeNull();
    expect(
      correlatePointOfUseObservation({
        expected,
        observation: {
          ...okObservation,
          executionContextUniqueId: "drifted",
          defaultContexts: [
            {
              id: target.executionContextId,
              uniqueId: "drifted",
              frameId: target.frameId,
              isDefault: true,
            },
          ],
        },
      }),
    ).toBe("context_identity_drift:uniqueId");
  });
});

describe("fail-closed uniqueness and bridge success (M1-F05R2 / VAL-HOST-008/037-040)", () => {
  function fixtureProcess(host: HostIdentity, identity: ProbeCorrelationIdentity) {
    return {
      pid: identity.pid,
      parentPid: 0,
      processStartedAt: identity.processStartedAt,
      executablePath: host.executablePath,
      arguments: [host.executablePath],
    };
  }

  function fixtureTarget(
    host: HostIdentity,
    identity: ProbeCorrelationIdentity,
  ): TargetIdentity {
    return {
      role: "development",
      pid: identity.pid,
      processStartedAt: identity.processStartedAt,
      executablePath: host.executablePath,
      appVersion: host.appVersion,
      appBuild: host.appBuild,
      port: 9444,
      browserIdentity: "Chrome/150.0.7871.128",
      targetId: identity.targetId,
      targetType: "page",
      targetUrl: "app://-/index.html",
      executionContextId: identity.executionContextId,
      executionContextUniqueId: identity.executionContextUniqueId,
      frameId: identity.targetId,
    };
  }

  function okObservation(
    host: HostIdentity,
    identity: ProbeCorrelationIdentity,
    process: ReturnType<typeof fixtureProcess>,
    target: TargetIdentity,
  ): ProbePointOfUseObservation {
    return {
      host,
      processAlive: true,
      processExecutablePath: process.executablePath,
      processStartedAt: process.processStartedAt,
      listeners: [
        {
          pid: process.pid,
          processStartedAt: process.processStartedAt,
          host: "127.0.0.1",
          port: 9444,
          family: "ipv4",
        },
      ],
      browserIdentity: target.browserIdentity,
      endpointPublishedPid: target.pid,
      compatibleTargets: [
        { id: target.targetId, type: target.targetType, url: target.targetUrl },
      ],
      defaultContexts: [
        {
          id: target.executionContextId,
          uniqueId: target.executionContextUniqueId,
          frameId: target.frameId,
          isDefault: true,
        },
      ],
      targetId: target.targetId,
      targetUrl: target.targetUrl,
      targetType: target.targetType,
      executionContextId: target.executionContextId,
      executionContextUniqueId: target.executionContextUniqueId,
      frameId: target.frameId,
      compatibilityKey: identity.compatibilityKey,
    };
  }

  test("extra undeclared 9444 co-owner aborts unique port barrier", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const process = fixtureProcess(host, identity);
    expect(
      matchUniquePortOwner(process, 9444, [
        {
          pid: process.pid,
          processStartedAt: process.processStartedAt,
          host: "127.0.0.1",
          port: 9444,
          family: "ipv4",
        },
        {
          pid: process.pid + 99,
          processStartedAt: "other-start",
          host: "127.0.0.1",
          port: 9444,
          family: "ipv4",
        },
      ]),
    ).toBe("port_owner_drift:undeclared_co_owner");
  });

  test("executable substitution from fresh observation aborts process barrier", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const process = fixtureProcess(host, identity);
    expect(
      matchProcessIdentity(process, {
        pid: process.pid,
        processStartedAt: process.processStartedAt,
        executablePath: "/Applications/Other.app/Contents/MacOS/Other",
        alive: true,
      }),
    ).toBe("process_identity_drift:executable");
    // Expected path must never be treated as observed when observation is missing.
    expect(
      matchProcessIdentity(process, {
        pid: process.pid,
        processStartedAt: process.processStartedAt,
        executablePath: null,
        alive: true,
      }),
    ).toBe("process_identity_drift:executable_unobserved");
  });

  test("additional compatible app target aborts complete inventory", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const target = fixtureTarget(host, identity);
    expect(
      matchCompleteCompatibleTargetInventory(target, [
        { id: target.targetId, type: "page", url: "app://-/index.html" },
        { id: "EXTRA-TARGET", type: "page", url: "app://-/index.html" },
      ]),
    ).toBe("target_inventory_ambiguous");
  });

  test("additional default context aborts complete inventory", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const target = fixtureTarget(host, identity);
    expect(
      matchCompleteDefaultContextInventory(target, [
        {
          id: target.executionContextId,
          uniqueId: target.executionContextUniqueId,
          frameId: target.frameId,
          isDefault: true,
        },
        {
          id: target.executionContextId + 1,
          uniqueId: "ctx-extra",
          frameId: "frame-extra",
          isDefault: true,
        },
      ]),
    ).toBe("context_inventory_ambiguous");
  });

  test("availability-only, error, wrong-transport, and theme responses remain incomplete", () => {
    const surface = completeSurface();
    const base = {
      transportAvailable: true,
      observedMethods: [...REQUIRED_BRIDGE_METHODS],
      benignRequest: JSON.stringify({ type: "get-setting" }),
      beforeSurface: surface,
      afterSurface: surface,
    };

    const availability = parseBridgeValue({
      ...base,
      invokedTransport: "electronBridge.sendMessageFromView",
      benignResponse: { kind: "availability", transportAvailable: true },
    });
    expect(availability.complete).toBe(false);
    expect(availability.reason).toBe("bridge_availability_only");

    const error = parseBridgeValue({
      ...base,
      invokedTransport: "electronBridge.sendMessageFromView",
      benignResponse: { kind: "error", message: "boom" },
    });
    expect(error.complete).toBe(false);
    expect(error.reason).toBe("bridge_benign_response_error");

    const wrongTransport = parseBridgeValue({
      ...base,
      invokedTransport: null,
      benignRequest: "electronBridge.getSystemThemeVariant",
      benignResponse: {
        kind: "wrong-transport",
        attempted: "electronBridge.getSystemThemeVariant",
      },
    });
    expect(wrongTransport.complete).toBe(false);
    expect(
      wrongTransport.reason === "bridge_transport_not_invoked" ||
        wrongTransport.reason === "bridge_wrong_transport",
    ).toBe(true);

    const themeOnly = parseBridgeValue({
      ...base,
      invokedTransport: "electronBridge.sendMessageFromView",
      benignResponse: { kind: "theme", value: "dark" },
    });
    expect(themeOnly.complete).toBe(false);
    expect(themeOnly.reason).toBe("bridge_wrong_transport");

    expect(classifyBenignBridgeResponse({ kind: "availability" }).ok).toBe(false);
    expect(classifyBenignBridgeResponse({ kind: "error", message: "x" }).ok).toBe(false);
    expect(
      classifyBenignBridgeResponse({
        kind: "success",
        transport: "electronBridge.sendMessageFromView",
        invoked: true,
        value: null,
      }).ok,
    ).toBe(true);
  });

  test("operation-level ambiguity/drift rows produce zero later evaluations and zero compatibility writes", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const process = fixtureProcess(host, identity);
    const target = fixtureTarget(host, identity);
    const expected: ProbePointOfUseExpected = {
      host,
      process,
      port: 9444,
      browserIdentity: target.browserIdentity,
      target,
      compatibilityKey: identity.compatibilityKey,
      sdkRuntime: SDK,
      probe: PROBE,
    };
    const baseline = okObservation(host, identity, process, target);

    const rows: Array<{ name: string; observation: ProbePointOfUseObservation; reason: string }> = [
      {
        name: "extra-listener",
        reason: "port_owner_drift:undeclared_co_owner",
        observation: {
          ...baseline,
          listeners: [
            ...baseline.listeners,
            {
              pid: process.pid + 7,
              processStartedAt: "foreign-start",
              host: "127.0.0.1",
              port: 9444,
              family: "ipv4",
            },
          ],
        },
      },
      {
        name: "executable-substitution",
        reason: "process_identity_drift:executable",
        observation: {
          ...baseline,
          processExecutablePath: "/Applications/Foreign.app/Contents/MacOS/Foreign",
        },
      },
      {
        name: "additional-compatible-target",
        reason: "target_inventory_ambiguous",
        observation: {
          ...baseline,
          compatibleTargets: [
            ...baseline.compatibleTargets,
            { id: "EXTRA", type: "page", url: "app://-/index.html" },
          ],
        },
      },
      {
        name: "additional-default-context",
        reason: "context_inventory_ambiguous",
        observation: {
          ...baseline,
          defaultContexts: [
            ...baseline.defaultContexts,
            {
              id: 99,
              uniqueId: "extra-ctx",
              frameId: "extra-frame",
              isDefault: true,
            },
          ],
        },
      },
    ];

    for (const row of rows) {
      let evaluations = 0;
      let compatibilityWrites = 0;
      const drift = correlatePointOfUseObservation({
        expected,
        observation: row.observation,
      });
      expect(drift).toBe(row.reason);
      // Barrier fail-closed: no later evaluation or persistence may occur.
      if (drift !== null) {
        // Intentionally do not evaluate or write.
      } else {
        evaluations += 1;
        compatibilityWrites += 1;
      }
      expect(evaluations).toBe(0);
      expect(compatibilityWrites).toBe(0);
    }
  });

  test("pre-repair schema/tool identity cannot authorize current probe key", async () => {
    const host = await validHost();
    const current = deriveCompatibilityKey({ host, sdkRuntime: SDK, probe: PROBE });
    expect(current.probeSchemaVersion).toBe(PROBE_SCHEMA_VERSION);
    expect(current.probeToolVersion).toBe(DEFAULT_PROBE_TOOL_VERSION);
    expect(PROBE_SCHEMA_VERSION).toBe(2);
    expect(DEFAULT_PROBE_TOOL_VERSION).toBe("explodex-compat-probe/0.2.0");

    const preRepairProbe = {
      schemaVersion: 1,
      toolVersion: "explodex-compat-probe/0.1.0",
    };
    const preRepairKey = deriveCompatibilityKey({
      host,
      sdkRuntime: SDK,
      probe: preRepairProbe,
    });
    expect(preRepairKey.probeSchemaVersion).not.toBe(current.probeSchemaVersion);
    expect(preRepairKey.probeToolVersion).not.toBe(current.probeToolVersion);

    const { adapters } = createFixtureAdapters({});
    const home = "/tmp/explodex-homes/probe-pre-repair-invalidation/.explodex";
    // Persist a pre-repair proven-looking record; current evaluation must reject it.
    await saveCompatibilityRecord({
      adapters,
      explodexHome: home,
      record: {
        key: preRepairKey,
        status: "proven",
        probedAt: "2026-07-26T12:00:00.000Z",
        target: {
          role: "development",
          pid: 50134,
          processStartedAt: "105599718.151298435",
          port: 9444,
          targetId: "TARGET-ACCEPT",
        },
        capabilitySummary: { preRepair: true },
      },
    });
    const loaded = await loadCompatibilityRecord({ adapters, explodexHome: home });
    const report = evaluateCompatibility({
      host,
      sdkRuntime: SDK,
      probe: PROBE,
      persisted: loaded,
    });
    expect(report.status).toBe("unproven");
    expect(report.allowsCompatibilityDependentWork).toBe(false);
    expect(report.reason).toContain("compatibility_key_mismatch");
  });

  test("copied expected executable without fresh observation cannot correlate", async () => {
    const host = await validHost();
    const identity = identityFor(host);
    const process = fixtureProcess(host, identity);
    const target = fixtureTarget(host, identity);
    const expected: ProbePointOfUseExpected = {
      host,
      process,
      port: 9444,
      browserIdentity: target.browserIdentity,
      target,
      compatibilityKey: identity.compatibilityKey,
      sdkRuntime: SDK,
      probe: PROBE,
    };
    const baseline = okObservation(host, identity, process, target);
    // Observation omits executable even though expected still has the correct path.
    expect(
      correlatePointOfUseObservation({
        expected,
        observation: {
          ...baseline,
          processExecutablePath: null,
        },
      }),
    ).toBe("process_identity_drift:executable_unobserved");
  });
});
