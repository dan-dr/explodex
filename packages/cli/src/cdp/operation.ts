import type { HostIdentity } from "../host/types.ts";
import type {
  DeclaredRoleEndpoint,
  HostRole,
  ListenerObservation,
  VerifiedProcess,
} from "../host/status.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import { runBoundedOperation } from "../runtime/operation.ts";
import type { BoundedOperationResult } from "../runtime/types.ts";
import type { CdpAdapter, CdpEvaluationResult } from "./adapters.ts";
import { inspectCompatibleEndpoint } from "./endpoint.ts";
import type { TargetIdentity, TargetingErrorCode } from "./types.ts";

export class TargetingError extends Error {
  readonly code: TargetingErrorCode;
  readonly stage: "cdp-discovery" | "cdp-evaluation";
  readonly details: unknown;

  constructor(
    code: TargetingErrorCode,
    message: string,
    details?: unknown,
    stage: "cdp-discovery" | "cdp-evaluation" = "cdp-evaluation",
  ) {
    super(message);
    this.name = "TargetingError";
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

export type PointOfUseIdentity = {
  host: HostIdentity;
  process: VerifiedProcess;
  listener: ListenerObservation;
};

export type ExactTargetOperationResult = {
  target: TargetIdentity;
  evaluation: CdpEvaluationResult;
  operationBinding: {
    operationId: string;
    homeIdentity: string;
    role: HostRole;
    port: 9333 | 9444;
    callbackIdentity: string | null;
  };
};

function hostMatches(expected: HostIdentity, current: HostIdentity): boolean {
  if (
    expected.bundlePath !== current.bundlePath ||
    expected.executablePath !== current.executablePath ||
    expected.bundleId !== current.bundleId ||
    expected.signingTeam !== current.signingTeam ||
    expected.appVersion !== current.appVersion ||
    expected.appBuild !== current.appBuild
  ) return false;
  const expectedEntries = Object.entries(expected.hostHashes).sort(([left], [right]) => left.localeCompare(right));
  const currentEntries = Object.entries(current.hostHashes).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(expectedEntries) === JSON.stringify(currentEntries);
}

function processMatches(expected: VerifiedProcess, current: VerifiedProcess): boolean {
  return expected.pid === current.pid &&
    expected.processStartedAt === current.processStartedAt &&
    expected.executablePath === current.executablePath;
}

function listenerMatches(expected: DeclaredRoleEndpoint, process: VerifiedProcess, current: ListenerObservation): boolean {
  return current.pid === process.pid &&
    current.processStartedAt === process.processStartedAt &&
    current.host === expected.host &&
    current.port === expected.port;
}

function stageFailure(
  stage: "cdp-discovery" | "cdp-evaluation",
  error: unknown,
  details?: unknown,
): Error & { stage: "cdp-discovery" | "cdp-evaluation"; details: unknown } {
  const cause = error instanceof Error
    ? { name: error.name, message: error.message }
    : error;
  const inherited = typeof error === "object" && error !== null && "details" in error
    ? (error as { details?: unknown }).details
    : undefined;
  const mergedDetails = {
    ...(inherited === undefined ? {} : asDetails(inherited)),
    ...(details === undefined ? {} : asDetails(details)),
    cause,
  };
  return Object.assign(
    error instanceof Error ? error : new Error(`CDP ${stage} failed with a non-Error throw`),
    { stage, details: mergedDetails },
  );
}

function asDetails(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { details: value };
}

function targetingFailureFromInspection(
  inspection: Exclude<Awaited<ReturnType<typeof inspectCompatibleEndpoint>>, { kind: "available" }>,
  stage: "cdp-discovery" | "cdp-evaluation",
): TargetingError {
  if (inspection.kind === "rejected") {
    return new TargetingError(
      inspection.code,
      `Exact renderer selection failed: ${inspection.code}`,
      { inspection },
      stage,
    );
  }
  return new TargetingError(
    "endpoint_identity_mismatch",
    "The endpoint identity no longer matched the selected process",
    { inspection },
    stage,
  );
}

function pointOfUseDetails(input: {
  expectedHost: HostIdentity;
  expectedProcess: VerifiedProcess;
  expectedEndpoint: DeclaredRoleEndpoint;
  expectedTarget: TargetIdentity;
  current: PointOfUseIdentity;
  currentTarget?: TargetIdentity;
}): unknown {
  return {
    expected: {
      appBuild: input.expectedHost.appBuild,
      pid: input.expectedProcess.pid,
      processStartedAt: input.expectedProcess.processStartedAt,
      endpoint: input.expectedEndpoint,
      target: input.expectedTarget,
    },
    observed: {
      appBuild: input.current.host.appBuild,
      pid: input.current.process.pid,
      processStartedAt: input.current.process.processStartedAt,
      listener: input.current.listener,
      target: input.currentTarget ?? null,
    },
  };
}

function assertPointOfUseIdentity(input: {
  expectedHost: HostIdentity;
  expectedProcess: VerifiedProcess;
  expectedEndpoint: DeclaredRoleEndpoint;
  expectedTarget: TargetIdentity;
  current: PointOfUseIdentity;
  currentTarget: TargetIdentity;
}): void {
  const details = { pointOfUse: pointOfUseDetails(input) };
  if (!hostMatches(input.expectedHost, input.current.host)) {
    throw new TargetingError("host_identity_drift", "Canonical host/build identity changed before evaluation", details);
  }
  if (!processMatches(input.expectedProcess, input.current.process)) {
    throw new TargetingError("process_identity_drift", "Process PID/start/executable identity changed before evaluation", details);
  }
  if (!listenerMatches(input.expectedEndpoint, input.expectedProcess, input.current.listener)) {
    throw new TargetingError("port_owner_drift", "Declared port ownership changed before evaluation", details);
  }
  if (input.currentTarget.browserIdentity !== input.expectedTarget.browserIdentity) {
    throw new TargetingError("browser_identity_drift", "Browser endpoint identity changed before evaluation", details);
  }
  if (
    input.currentTarget.targetId !== input.expectedTarget.targetId ||
    input.currentTarget.targetType !== input.expectedTarget.targetType ||
    input.currentTarget.targetUrl !== input.expectedTarget.targetUrl
  ) {
    throw new TargetingError("target_identity_drift", "Renderer target changed before evaluation", details);
  }
  if (
    input.currentTarget.executionContextId !== input.expectedTarget.executionContextId ||
    input.currentTarget.executionContextUniqueId !== input.expectedTarget.executionContextUniqueId ||
    input.currentTarget.frameId !== input.expectedTarget.frameId
  ) {
    throw new TargetingError(
      "context_identity_drift",
      "Renderer execution context changed before evaluation",
      details,
    );
  }
}

export async function runExactTargetOperation(options: {
  runtime: RuntimeAdapters;
  operationId?: string;
  operation: string;
  role: HostRole;
  homeIdentity: string;
  host: HostIdentity;
  process: VerifiedProcess;
  endpoint: DeclaredRoleEndpoint;
  cdp: CdpAdapter;
  revalidate(): Promise<PointOfUseIdentity>;
  evaluate: { expression: string; callbackIdentity?: string };
}): Promise<BoundedOperationResult<ExactTargetOperationResult>> {
  return runBoundedOperation({
    adapters: options.runtime,
    operation: options.operation,
    operationId: options.operationId,
    run: async (ctx) => {
      const discovery = await ctx.runExternalWait("cdp-discovery", async (control) => {
        try {
          const inspected = await inspectCompatibleEndpoint({
            role: options.role,
            endpoint: options.endpoint,
            process: options.process,
            host: options.host,
            cdp: options.cdp,
            signal: control.signal,
            retainSession: true,
            onSessionOpened(session) {
              ctx.scope.register({
                kind: "session",
                label: `cdp:${ctx.identity.operationId}:${session.targetId}`,
                disposition: "command-owned",
                dispose: () => session.close(),
              });
            },
          });
          if (inspected.kind !== "available") {
            throw targetingFailureFromInspection(inspected, "cdp-discovery");
          }
          if (inspected.session === undefined) {
            throw new TargetingError(
              "target_not_found",
              "The selected target session was unavailable",
              { inspected },
              "cdp-discovery",
            );
          }
          return { target: inspected.target, session: inspected.session };
        } catch (error: unknown) {
          throw stageFailure("cdp-discovery", error);
        }
      });
      ctx.markStageComplete("cdp-discovery");
      if (options.evaluate.callbackIdentity !== undefined) {
        ctx.scope.register({
          kind: "callback",
          label: `callback:${ctx.identity.operationId}:${options.evaluate.callbackIdentity}`,
          disposition: "command-owned",
          dispose: () => undefined,
        });
      }

      const evaluation = await ctx.runExternalWait("cdp-evaluation", async (control) => {
        try {
          const current = await options.revalidate();
          const preInspectionDetails = {
            pointOfUse: pointOfUseDetails({
              expectedHost: options.host,
              expectedProcess: options.process,
              expectedEndpoint: options.endpoint,
              expectedTarget: discovery.target,
              current,
            }),
          };
          if (!hostMatches(options.host, current.host)) {
            throw new TargetingError(
              "host_identity_drift",
              "Canonical host/build identity changed before evaluation",
              preInspectionDetails,
            );
          }
          if (!processMatches(options.process, current.process)) {
            throw new TargetingError(
              "process_identity_drift",
              "Process PID/start/executable identity changed before evaluation",
              preInspectionDetails,
            );
          }
          if (!listenerMatches(options.endpoint, options.process, current.listener)) {
            throw new TargetingError(
              "port_owner_drift",
              "Declared port ownership changed before evaluation",
              preInspectionDetails,
            );
          }
          const reinspection = await inspectCompatibleEndpoint({
            role: options.role,
            endpoint: options.endpoint,
            process: current.process,
            host: current.host,
            cdp: options.cdp,
            signal: control.signal,
          });
          if (reinspection.kind !== "available") {
            throw targetingFailureFromInspection(reinspection, "cdp-evaluation");
          }
          assertPointOfUseIdentity({
            expectedHost: options.host,
            expectedProcess: options.process,
            expectedEndpoint: options.endpoint,
            expectedTarget: discovery.target,
            current,
            currentTarget: reinspection.target,
          });
          if (!control.tryCommitEffect()) {
            throw Object.assign(new Error("Evaluation authority expired before effect commit"), {
              code: "operation_interrupted" as const,
              stage: "cdp-evaluation" as const,
            });
          }
          return await discovery.session.evaluate({
            executionContextId: discovery.target.executionContextId,
            executionContextUniqueId: discovery.target.executionContextUniqueId,
            expression: options.evaluate.expression,
            signal: control.signal,
          });
        } catch (error: unknown) {
          throw stageFailure("cdp-evaluation", error, { target: discovery.target });
        }
      });
      ctx.markStageComplete("cdp-evaluation");

      return {
        target: discovery.target,
        evaluation,
        operationBinding: {
          operationId: ctx.identity.operationId,
          homeIdentity: options.homeIdentity,
          role: options.role,
          port: options.endpoint.port,
          callbackIdentity: options.evaluate.callbackIdentity ?? null,
        },
      };
    },
  });
}
