import type { TargetIdentity } from "../cdp/types.ts";
import type { CompatibilityProbeResult } from "../host/probe-types.ts";
import { describeDevLayout } from "./layout.ts";

export const DEV_AUTH_MODE = "interactive" as const;

export type DevInteractiveAuthBlockerDetails = {
  blocker: "authentication";
  authMode: typeof DEV_AUTH_MODE;
  projectedAuthAdvertised: false;
  role: "development";
  rootPath: string;
  electronUserDataPath: string;
  codexHomePath: string;
  target: Pick<
    TargetIdentity,
    | "role"
    | "pid"
    | "processStartedAt"
    | "port"
    | "targetId"
    | "executionContextId"
    | "executionContextUniqueId"
    | "appVersion"
    | "appBuild"
  >;
  requiredAction: string;
  credentialHandling: {
    cliEntryAllowed: false;
    mainStateCopyAllowed: false;
    automaticProjection: false;
  };
  devRemainsRunning: true;
  resume: {
    firstOperation: "dev.status";
    recoveryOperation: "dev.recover";
    continuationOperation: "plugin.develop";
    requiresNewPublicOperation: true;
    reusesBlockedOutput: false;
  };
};

export function compatibilityProbeRequiresInteractiveAuth(
  probe: CompatibilityProbeResult,
): boolean {
  if (probe.status !== "pending") return false;
  if (probe.anchors.pendingUnreachable.length === 0) return false;
  return probe.anchors.matrix.some((entry) =>
    entry.requiresSignedIn &&
    entry.verdict === "pending-unreachable" &&
    probe.anchors.pendingUnreachable.includes(entry.name)
  );
}

export function createDevInteractiveAuthBlockerDetails(options: {
  rootPath: string;
  target: Pick<
    TargetIdentity,
    | "role"
    | "pid"
    | "processStartedAt"
    | "port"
    | "targetId"
    | "executionContextId"
    | "executionContextUniqueId"
    | "appVersion"
    | "appBuild"
  >;
}): DevInteractiveAuthBlockerDetails {
  if (options.target.role !== "development" || options.target.port !== 9444) {
    throw new TypeError(
      "Interactive authentication may be requested only for the exact development target on port 9444.",
    );
  }
  const layout = describeDevLayout(options.rootPath);
  return {
    blocker: "authentication",
    authMode: DEV_AUTH_MODE,
    projectedAuthAdvertised: false,
    role: "development",
    rootPath: layout.rootPath,
    electronUserDataPath: layout.electronUserDataPath,
    codexHomePath: layout.codexHomePath,
    target: {
      role: options.target.role,
      pid: options.target.pid,
      processStartedAt: options.target.processStartedAt,
      port: options.target.port,
      targetId: options.target.targetId,
      executionContextId: options.target.executionContextId,
      executionContextUniqueId: options.target.executionContextUniqueId,
      appVersion: options.target.appVersion,
      appBuild: options.target.appBuild,
    },
    requiredAction:
      "Sign in manually in the already-running isolated development ChatGPT window. Do not enter credentials in Explodex and do not copy authoring-main profile or CODEX_HOME state.",
    credentialHandling: {
      cliEntryAllowed: false,
      mainStateCopyAllowed: false,
      automaticProjection: false,
    },
    devRemainsRunning: true,
    resume: {
      firstOperation: "dev.status",
      recoveryOperation: "dev.recover",
      continuationOperation: "plugin.develop",
      requiresNewPublicOperation: true,
      reusesBlockedOutput: false,
    },
  };
}
