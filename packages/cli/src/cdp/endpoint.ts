import type { HostIdentity } from "../host/types.ts";
import type {
  CdpAvailabilityInspector,
  DeclaredRoleEndpoint,
  HostRole,
  HostStatusAdapters,
  VerifiedProcess,
} from "../host/status.ts";
import type { CdpAdapter, CdpTargetSession } from "./adapters.ts";
import { selectExactPageAndContext } from "./target-selection.ts";
import type {
  CdpExecutionContext,
  CdpTarget,
  CdpTargetSummary,
  EndpointInspectionResult,
  TargetIdentity,
} from "./types.ts";

function summarize(targets: CdpTarget[]): CdpTargetSummary[] {
  return targets
    .map((target) => ({ id: target.id, type: target.type, url: target.url, title: target.title }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function endpointIdentityMatches(input: {
  browserIdentity: string;
  endpointPid?: number;
  expectedProcess: VerifiedProcess;
}): boolean {
  if (input.browserIdentity.trim().length === 0) return false;
  return input.endpointPid === undefined || input.endpointPid === input.expectedProcess.pid;
}

function targetIdentity(input: {
  role: HostRole;
  endpoint: DeclaredRoleEndpoint;
  process: VerifiedProcess;
  host: HostIdentity;
  browserIdentity: string;
  target: CdpTarget;
  context: CdpExecutionContext;
}): TargetIdentity {
  return {
    role: input.role,
    pid: input.process.pid,
    processStartedAt: input.process.processStartedAt,
    executablePath: input.process.executablePath,
    appVersion: input.host.appVersion,
    appBuild: input.host.appBuild,
    port: input.endpoint.port,
    browserIdentity: input.browserIdentity,
    targetId: input.target.id,
    targetType: "page",
    targetUrl: "app://-/index.html",
    executionContextId: input.context.id,
    executionContextUniqueId: input.context.uniqueId,
    frameId: input.context.frameId,
  };
}

export type DetailedEndpointInspection = EndpointInspectionResult & {
  session?: CdpTargetSession;
};

export async function inspectCompatibleEndpoint(input: {
  role: HostRole;
  endpoint: DeclaredRoleEndpoint;
  process: VerifiedProcess;
  host: HostIdentity;
  cdp: CdpAdapter;
  signal?: AbortSignal;
  retainSession?: boolean;
  onSessionOpened?(session: CdpTargetSession): void;
}): Promise<DetailedEndpointInspection> {
  const version = await input.cdp.readEndpoint({
    host: input.endpoint.host,
    port: input.endpoint.port,
    signal: input.signal,
  });
  const targets = await input.cdp.listTargets({
    host: input.endpoint.host,
    port: input.endpoint.port,
    signal: input.signal,
  });
  const targetSummaries = summarize(targets);
  if (!endpointIdentityMatches({
    browserIdentity: version.browser,
    endpointPid: version.pid,
    expectedProcess: input.process,
  })) {
    return {
      kind: "identity-mismatch",
      browserIdentity: version.browser,
      targets: targetSummaries,
      details: {
        expectedPid: input.process.pid,
        endpointPid: version.pid ?? null,
      },
    };
  }

  const compatibleTargets = targets.filter(
    (target) => target.type === "page" && target.url === "app://-/index.html",
  );
  if (compatibleTargets.length !== 1) {
    const code = compatibleTargets.length === 0 ? "target_not_found" : "target_ambiguous";
    return {
      kind: "rejected",
      code,
      browserIdentity: version.browser,
      targets: targetSummaries,
      details: {
        code,
        compatibleTargetIds: compatibleTargets.map((target) => target.id).sort(),
      },
    };
  }
  const selectedTarget = compatibleTargets[0];
  if (selectedTarget === undefined) throw new Error("Compatible target inventory was unexpectedly empty");
  const session = await input.cdp.openTargetSession({
    host: input.endpoint.host,
    port: input.endpoint.port,
    target: selectedTarget,
    signal: input.signal,
    onSessionOpened: input.onSessionOpened,
  });
  try {
    const contexts = await session.listExecutionContexts({ signal: input.signal });
    const selected = selectExactPageAndContext({
      targets,
      contextsByTarget: { [selectedTarget.id]: contexts },
    });
    if (selected.kind === "rejected") {
      if (input.retainSession === true) await session.close();
      return {
        kind: "rejected",
        code: selected.code,
        browserIdentity: version.browser,
        targets: targetSummaries,
        details: {
          code: selected.code,
          message: selected.message,
          candidates: selected.candidates,
        },
      };
    }
    const identity = targetIdentity({
      role: input.role,
      endpoint: input.endpoint,
      process: input.process,
      host: input.host,
      browserIdentity: version.browser,
      target: selected.target,
      context: selected.context,
    });
    if (input.retainSession) {
      return { kind: "available", target: identity, targets: targetSummaries, session };
    }
    return { kind: "available", target: identity, targets: targetSummaries };
  } catch (error: unknown) {
    if (input.retainSession === true) await session.close();
    throw error;
  } finally {
    if (input.retainSession !== true) await session.close();
  }
}

export function createCdpAvailabilityInspector(input: {
  host: HostIdentity;
  cdp: CdpAdapter;
}): CdpAvailabilityInspector {
  return {
    inspect(options: {
      role: HostRole;
      endpoint: DeclaredRoleEndpoint;
      process: VerifiedProcess;
      adapters: HostStatusAdapters;
      signal?: AbortSignal;
    }) {
      void options.adapters;
      return inspectCompatibleEndpoint({
        role: options.role,
        endpoint: options.endpoint,
        process: options.process,
        host: input.host,
        cdp: input.cdp,
        signal: options.signal,
      });
    },
  };
}
