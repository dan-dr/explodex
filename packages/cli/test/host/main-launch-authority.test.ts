import { describe, expect, test } from "bun:test";
import {
  authorizeSameOperationAttach,
  captureNoMainLaunchBaseline,
  isSameOperationRaceWinner,
  processKey,
} from "../../src/host/main-launch-authority.ts";
import type { HostStatusResult, VerifiedProcess } from "../../src/host/status.ts";

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

  test("same-operation winner must not have been present at baseline", () => {
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
  });

  test("attach requires baseline, coordination, target, and same-operation winner", () => {
    const baseline = captureNoMainLaunchBaseline({
      operationId: "op-1",
      status: noMain(),
    });
    expect(baseline).not.toBeNull();
    if (baseline === null) return;

    expect(
      authorizeSameOperationAttach({
        baseline: null,
        holdsLaunchCoordination: true,
        candidate: processB,
        selectedTargetPresent: true,
      }).ok,
    ).toBe(false);

    expect(
      authorizeSameOperationAttach({
        baseline,
        holdsLaunchCoordination: false,
        candidate: processB,
        selectedTargetPresent: true,
      }).ok,
    ).toBe(false);

    expect(
      authorizeSameOperationAttach({
        baseline,
        holdsLaunchCoordination: true,
        candidate: processB,
        selectedTargetPresent: false,
      }).ok,
    ).toBe(false);

    const ok = authorizeSameOperationAttach({
      baseline,
      holdsLaunchCoordination: true,
      candidate: processB,
      selectedTargetPresent: true,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.authority.kind).toBe("same-operation-race-winner");
    expect(ok.authority.process.pid).toBe(200);
  });
});
