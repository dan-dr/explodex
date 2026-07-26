/**
 * Same-operation launch/attach authority for explicit no-main main launch.
 *
 * An initially observed cdp-main is availability only and never grants
 * attach/evaluation authority. Attach is permitted only when this operation
 * began from exact no-main/free-9333, holds launch coordination, and
 * independently proves the exact winner appeared after the operation began.
 */

import type { HostStatusResult, VerifiedProcess } from "./status.ts";

export type MainLaunchBaseline = {
  /** Operation ID that established this baseline. */
  operationId: string;
  /** True only when the first inventory was exact no-main + free 9333. */
  beganFromExactNoMainFreePort: true;
  initialMainState: "no-main";
  initialEndpointObstruction: "port-free";
  /** pid@processStartedAt keys present at operation start (normally empty). */
  initialProcessKeys: readonly string[];
};

export type SameOperationAuthority =
  | {
      kind: "spawned-by-this-operation";
      process: VerifiedProcess;
      operationId: string;
    }
  | {
      kind: "same-operation-race-winner";
      process: VerifiedProcess;
      operationId: string;
      baseline: MainLaunchBaseline;
    };

export function processKey(process: Pick<VerifiedProcess, "pid" | "processStartedAt">): string {
  return `${process.pid}@${process.processStartedAt}`;
}

/**
 * Capture the operation-start baseline. Returns null when the initial inventory
 * is not exact no-main with a free 9333 (attach authority cannot be established).
 */
export function captureNoMainLaunchBaseline(input: {
  operationId: string;
  status: HostStatusResult;
}): MainLaunchBaseline | null {
  if (
    input.status.mainState !== "no-main" ||
    input.status.endpointObstruction !== "port-free"
  ) {
    return null;
  }
  return {
    operationId: input.operationId,
    beganFromExactNoMainFreePort: true,
    initialMainState: "no-main",
    initialEndpointObstruction: "port-free",
    initialProcessKeys: input.status.processes.map(processKey),
  };
}

/**
 * Pure predicate: may this exact process be treated as the same-operation race
 * winner for attach? Requires a no-main baseline and a process that was not
 * present in the initial inventory.
 */
export function isSameOperationRaceWinner(input: {
  baseline: MainLaunchBaseline;
  candidate: VerifiedProcess;
}): boolean {
  if (!input.baseline.beganFromExactNoMainFreePort) return false;
  if (input.baseline.initialMainState !== "no-main") return false;
  if (input.baseline.initialEndpointObstruction !== "port-free") return false;
  const key = processKey(input.candidate);
  return !input.baseline.initialProcessKeys.includes(key);
}

/**
 * Authorize attach to a freshly observed cdp-main winner under launch
 * coordination. Refuses initially-present mains and any candidate that was
 * already inventoried at operation start.
 */
export function authorizeSameOperationAttach(input: {
  baseline: MainLaunchBaseline | null;
  holdsLaunchCoordination: boolean;
  candidate: VerifiedProcess;
  selectedTargetPresent: boolean;
}):
  | { ok: true; authority: SameOperationAuthority }
  | { ok: false; reason: "no_baseline" | "no_coordination" | "not_same_operation_winner" | "missing_target" } {
  if (input.baseline === null) {
    return { ok: false, reason: "no_baseline" };
  }
  if (!input.holdsLaunchCoordination) {
    return { ok: false, reason: "no_coordination" };
  }
  if (!input.selectedTargetPresent) {
    return { ok: false, reason: "missing_target" };
  }
  if (!isSameOperationRaceWinner({
    baseline: input.baseline,
    candidate: input.candidate,
  })) {
    return { ok: false, reason: "not_same_operation_winner" };
  }
  return {
    ok: true,
    authority: {
      kind: "same-operation-race-winner",
      process: input.candidate,
      operationId: input.baseline.operationId,
      baseline: input.baseline,
    },
  };
}

/**
 * True when the bound process still matches the operation's same-operation
 * authority (spawned by this op, or exact race-winner identity).
 */
export function authorityStillMatches(
  authority: SameOperationAuthority,
  process: Pick<VerifiedProcess, "pid" | "processStartedAt" | "executablePath">,
): boolean {
  return (
    authority.process.pid === process.pid &&
    authority.process.processStartedAt === process.processStartedAt &&
    authority.process.executablePath === process.executablePath
  );
}
