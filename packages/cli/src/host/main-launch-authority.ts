/**
 * Same-operation launch/attach authority for explicit no-main main launch.
 *
 * An initially observed cdp-main is availability only and never grants
 * attach/evaluation authority. Attach is permitted only when this operation
 * began from exact no-main/free-9333, holds launch coordination, and validates
 * an exact unconsumed producer coordination record bound to the winner.
 * Absence from baseline or later appearance alone is never attach authority.
 */

import type {
  CoordinationValidationFailure,
  LaunchCoordinationRecord,
} from "./main-launch-coordination.ts";
import { validateLaunchCoordinationRecord } from "./main-launch-coordination.ts";
import type { HostStatusResult, VerifiedProcess } from "./status.ts";
import type { CompatibilityKey, HostIdentity } from "./types.ts";

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
      lockGeneration: string;
      coordination: LaunchCoordinationRecord;
    }
  | {
      kind: "same-operation-race-winner";
      process: VerifiedProcess;
      operationId: string;
      lockGeneration: string;
      baseline: MainLaunchBaseline;
      coordination: LaunchCoordinationRecord;
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
 * Pure process novelty check. Never sufficient for attach authority without an
 * exact producer coordination record.
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

export type AttachAuthorizationFailure =
  | "no_baseline"
  | "no_coordination"
  | "not_same_operation_winner"
  | "missing_target"
  | "missing_record"
  | CoordinationValidationFailure;

/**
 * Authorize attach to a freshly observed cdp-main winner under launch
 * coordination. Requires an exact unconsumed producer coordination record
 * matching frozen host/key/process (and optionally target/browser). Refuses
 * initially-present mains, unrelated late debug mains, and
 * stale/malformed/mismatched/consumed/substituted records.
 */
export function authorizeSameOperationAttach(input: {
  baseline: MainLaunchBaseline | null;
  holdsLaunchCoordination: boolean;
  candidate: VerifiedProcess;
  selectedTargetPresent: boolean;
  coordination: LaunchCoordinationRecord | null;
  frozenHost: HostIdentity;
  compatibilityKey: CompatibilityKey;
  requireUnconsumedEffect?: boolean;
}):
  | { ok: true; authority: SameOperationAuthority }
  | { ok: false; reason: AttachAuthorizationFailure } {
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
  if (input.coordination === null) {
    return { ok: false, reason: "missing_record" };
  }

  const validated = validateLaunchCoordinationRecord({
    record: input.coordination,
    frozenHost: input.frozenHost,
    compatibilityKey: input.compatibilityKey,
    process: input.candidate,
    requireUnconsumedEffect: input.requireUnconsumedEffect ?? true,
  });
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }

  return {
    ok: true,
    authority: {
      kind: "same-operation-race-winner",
      process: input.candidate,
      operationId: input.baseline.operationId,
      lockGeneration: validated.record.lockGeneration,
      baseline: input.baseline,
      coordination: validated.record,
    },
  };
}

/**
 * True when the bound process still matches the operation's same-operation
 * authority (spawned by this op, or exact race-winner identity + record).
 */
export function authorityStillMatches(
  authority: SameOperationAuthority,
  process: Pick<VerifiedProcess, "pid" | "processStartedAt" | "executablePath">,
): boolean {
  if (
    authority.process.pid !== process.pid ||
    authority.process.processStartedAt !== process.processStartedAt ||
    authority.process.executablePath !== process.executablePath
  ) {
    return false;
  }
  return (
    authority.coordination.process.pid === process.pid &&
    authority.coordination.process.processStartedAt === process.processStartedAt &&
    authority.coordination.process.executablePath === process.executablePath
  );
}
