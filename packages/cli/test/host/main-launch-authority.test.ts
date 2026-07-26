import { describe, expect, test } from "bun:test";
import {
  authorizeSameOperationAttach,
  captureNoMainLaunchBaseline,
  isSameOperationRaceWinner,
  processKey,
} from "../../src/host/main-launch-authority.ts";
import {
  buildLaunchCoordinationRecord,
  parseLaunchCoordinationRecord,
  validateLaunchCoordinationRecord,
} from "../../src/host/main-launch-coordination.ts";
import type { HostStatusResult, VerifiedProcess } from "../../src/host/status.ts";
import type { CompatibilityKey, HostIdentity } from "../../src/host/types.ts";

const processA: VerifiedProcess = {
  pid: 100,
  parentPid: 1,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  arguments: [],
  processStartedAt: "start-a",
};

const processB: VerifiedProcess = {
  pid: 200,
  parentPid: 1,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  arguments: [],
  processStartedAt: "start-b",
};

const host: HostIdentity = {
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.codex",
  executableName: "ChatGPT",
  signingTeam: "2DC432GLL2",
  appVersion: "26.721.41059",
  appBuild: "5848",
  hostHashes: {
    "Contents/Info.plist": "b".repeat(64),
    "Contents/MacOS/ChatGPT": "c".repeat(64),
    "Contents/Resources/app.asar": "d".repeat(64),
  },
};

const key: CompatibilityKey = {
  schemaVersion: 1,
  appVersion: host.appVersion,
  appBuild: host.appBuild,
  hostHashes: { ...host.hostHashes },
  signingTeam: host.signingTeam,
  sdkRuntimeSha256: "a".repeat(64),
  probeSchemaVersion: 2,
  probeToolVersion: "1.0.0",
};

function noMain(): HostStatusResult {
  return {
    role: "main",
    endpoint: { host: "127.0.0.1", port: 9333 },
    mainState: "no-main",
    endpointObstruction: "port-free",
    processes: [],
    listeners: [],
    selectedTarget: null,
    targetInventory: [],
    diagnostic: { code: "no_main", message: "none" },
    readOnly: true,
    activity: { launched: false, evaluated: false, wroteState: false, focused: false },
  };
}

function recordFor(process: VerifiedProcess, overrides: Record<string, unknown> = {}) {
  return buildLaunchCoordinationRecord({
    producerOperationId: "producer-op",
    lockGeneration: "generation-1",
    writtenAt: "2026-07-26T12:00:00.000Z",
    frozenHost: host,
    compatibilityKey: key,
    process,
    browserIdentity: "Chrome/150.0",
    target: {
      targetId: "PAGE-WINNER",
      targetType: "page",
      targetUrl: "app://-/index.html",
      frameId: "FRAME-WINNER",
      executionContextId: 7,
      executionContextUniqueId: "unique-PAGE-WINNER-7",
    },
    ...overrides,
  });
}

describe("same-operation main launch authority", () => {
  test("captures baseline only from exact no-main/free-9333", () => {
    const baseline = captureNoMainLaunchBaseline({
      operationId: "op-1",
      status: noMain(),
    });
    expect(baseline).not.toBeNull();
    expect(baseline?.beganFromExactNoMainFreePort).toBe(true);
    expect(baseline?.initialProcessKeys).toEqual([]);

    expect(
      captureNoMainLaunchBaseline({
        operationId: "op-1",
        status: {
          ...noMain(),
          mainState: "cdp-main",
          endpointObstruction: "matching-endpoint",
          processes: [processA],
        },
      }),
    ).toBeNull();
  });

  test("process novelty alone is not attach authority without a producer record", () => {
    const baseline = captureNoMainLaunchBaseline({
      operationId: "op-1",
      status: {
        ...noMain(),
        processes: [processA],
      },
    });
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    expect(isSameOperationRaceWinner({ baseline, candidate: processA })).toBe(false);
    expect(isSameOperationRaceWinner({ baseline, candidate: processB })).toBe(true);
    expect(processKey(processA)).toBe("100@start-a");

    const refused = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
      coordination: null,
      frozenHost: host,
      compatibilityKey: key,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("missing_record");
  });

  test("attach requires baseline, coordination, target, novelty, and exact unconsumed record", () => {
    const baseline = captureNoMainLaunchBaseline({
      operationId: "op-1",
      status: noMain(),
    });
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    const coordination = recordFor(processB);

    expect(
      authorizeSameOperationAttach({
        baseline: null,
        holdsLaunchCoordination: true,
        candidate: processB,
        selectedTargetPresent: true,
        coordination,
        frozenHost: host,
        compatibilityKey: key,
      }).ok,
    ).toBe(false);

    expect(
      authorizeSameOperationAttach({
        baseline,
        holdsLaunchCoordination: false,
        candidate: processB,
        selectedTargetPresent: true,
        coordination,
        frozenHost: host,
        compatibilityKey: key,
      }).ok,
    ).toBe(false);

    expect(
      authorizeSameOperationAttach({
        baseline,
        holdsLaunchCoordination: true,
        candidate: processB,
        selectedTargetPresent: false,
        coordination,
        frozenHost: host,
        compatibilityKey: key,
      }).ok,
    ).toBe(false);

    const ok = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
      coordination,
      frozenHost: host,
      compatibilityKey: key,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.authority.kind).toBe("same-operation-race-winner");
    expect(ok.authority.process.pid).toBe(200);
    expect(ok.authority.coordination.effect.status).toBe("unconsumed");
  });

  test("refuses stale, mismatched, consumed, and substituted coordination records", () => {
    const baseline = captureNoMainLaunchBaseline({
      operationId: "op-1",
      status: noMain(),
    });
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    const coordination = recordFor(processB);

    const mismatchedProcess = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processA,
      selectedTargetPresent: true,
      coordination,
      frozenHost: host,
      compatibilityKey: key,
    });
    expect(mismatchedProcess.ok).toBe(false);

    const hostMismatch = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
      coordination,
      frozenHost: { ...host, appBuild: "9999" },
      compatibilityKey: key,
    });
    expect(hostMismatch.ok).toBe(false);
    if (!hostMismatch.ok) {
      expect(hostMismatch.reason).toBe("host_mismatch");
    }

    const keyMismatch = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
      coordination,
      frozenHost: host,
      compatibilityKey: { ...key, appBuild: "9999" },
    });
    expect(keyMismatch.ok).toBe(false);

    const consumed = {
      ...coordination,
      effect: {
        status: "consumed" as const,
        consumedAt: "2026-07-26T12:01:00.000Z",
        consumerOperationId: "other-op",
      },
    };
    const consumedAuth = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
      coordination: consumed,
      frozenHost: host,
      compatibilityKey: key,
    });
    expect(consumedAuth.ok).toBe(false);
    if (!consumedAuth.ok) {
      expect(consumedAuth.reason).toBe("effect_consumed");
    }

    const substituted = parseLaunchCoordinationRecord({
      ...coordination,
      process: { ...coordination.process, pid: 999 },
    });
    expect(substituted).not.toBeNull();
    const substitutedAuth = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
      coordination: substituted,
      frozenHost: host,
      compatibilityKey: key,
    });
    expect(substitutedAuth.ok).toBe(false);

    const malformed = validateLaunchCoordinationRecord({
      record: { schemaVersion: 1 } as never,
      frozenHost: host,
      compatibilityKey: key,
      process: processB,
      requireUnconsumedEffect: true,
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.reason).toBe("malformed");
    }
  });
});
