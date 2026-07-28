import type { DevInstanceState, DevRecoveryDiagnostic, Phase0FrozenHost } from "./types.ts";

export type DevVerifiedLaunch = {
  pid: number;
  processStartedAt: string;
  targetId: string;
  browserIdentity: string;
  executionContextId: number;
  executionContextUniqueId: string;
  frameId: string;
  appVersion: string;
  appBuild: string;
  frozenHost: Phase0FrozenHost;
};

export type DevLifecycleLaunchAdapter = (options: {
  onSpawn(identity: {
    pid: number;
    processStartedAt: string | null;
  }): Promise<void>;
}) => Promise<DevVerifiedLaunch>;

export type DevLifecycleSuccess = {
  ok: true;
  operationId: string;
  state: DevInstanceState;
  reusedReady: boolean;
  terminationMethod: DevRecoveryDiagnostic["terminationMethod"];
};

export type DevLifecycleFailure = {
  ok: false;
  code:
    | "dev.start-refused"
    | "dev.ensure-refused"
    | "dev.restart-refused"
    | "dev.stop-refused"
    | "dev.launch-failed"
    | "dev.launch-partial"
    | "dev.state-write-failed"
    | "dev.termination-failed"
    | "dev.instance-busy"
    | "dev.lock-failed"
    | "operation.interrupted"
    | "operation.timeout";
  message: string;
  state: DevInstanceState | null;
  recoveryRequired: boolean;
  partialDisposition:
    | "none"
    | "gracefully-closed"
    | "left-running-unverified"
    | "left-running-close-failed";
  details?: unknown;
};

export type DevLifecycleResult = DevLifecycleSuccess | DevLifecycleFailure;
