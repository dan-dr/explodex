import { resolve } from "node:path";
import { createNodeCdpAdapter, type CdpAdapter } from "../cdp/adapters.ts";
import { createCdpAvailabilityInspector } from "../cdp/endpoint.ts";
import { runExactTargetOperation } from "../cdp/operation.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import { captureEphemeralPluginArtifact } from "../dev/ephemeral-artifact.ts";
import {
  loadStagedMainArtifactReceipt,
} from "../dev/main-staging.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  runEnabledPluginApplicationOperation,
} from "../plugin/application-operation.ts";
import { loadPluginsState } from "../plugin/install-state.ts";
import {
  pluginAuthorityFingerprint,
  revalidateEnabledPluginArtifacts,
} from "../plugin/reconciliation.ts";
import { readVerifiedSdkRuntimeSource } from "../plugin/review-target.ts";
import { targetIdentitiesEqual } from "../plugin/review-protocol.ts";
import { readGenerationRecord } from "../plugin/generation.ts";
import {
  createDefaultRuntimeAdapters,
  type RuntimeAdapters,
} from "../runtime/adapters.ts";
import {
  createDefaultHostAdapters,
  type HostAdapters,
} from "./adapters.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "./compatibility-state.ts";
import { compatibilityKeyHash } from "./compatibility-key.ts";
import { inspectHost } from "./identity.ts";
import {
  MAIN_HOT_PATH_RECOVERY_GUIDANCE,
} from "./main-hot-path.ts";
import { validateMainAuthorization } from "./main-authorization.ts";
import {
  mainApplyTargetsEqual,
  type MainApplyAdapterResult,
  type MainApplyAdapters,
  type MainApplyBaseline,
  type MainApplyCheckpoint,
  type MainApplyInspection,
  type PreparedMainApplyTarget,
} from "./main-apply.ts";
import {
  createDefaultHostStatusAdapters,
} from "./process-adapters.ts";
import { resolveSdkRuntimeIdentityForCli } from "./sdk-runtime-identity.ts";
import {
  collectHostStatus,
  type HostStatusAdapters,
  type ListenerObservation,
  type VerifiedProcess,
} from "./status.ts";
import type { HostIdentity } from "./types.ts";

type PreparedSystemMainTarget = {
  public: PreparedMainApplyTarget;
  process: VerifiedProcess;
  listener: ListenerObservation;
};

async function inspectPreparedMain(options: {
  explodexHome: string;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  cdp: CdpAdapter;
  signal?: AbortSignal;
}): Promise<MainApplyInspection | PreparedSystemMainTarget> {
  const host = await inspectHost({
    adapters: options.hostAdapters,
    signal: options.signal,
  });
  if (!host.ok) {
    return {
      mainState: "ambiguous-main",
      recoveryGuidance: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
      code: host.error.code,
      details: { host: host.error },
    };
  }
  const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
  const status = await collectHostStatus({
    role: "main",
    adapters: options.statusAdapters,
    inspectCdp: createCdpAvailabilityInspector({
      host: host.host,
      cdp: options.cdp,
    }),
    signal: options.signal,
  });
  if (
    status.mainState !== "cdp-main" ||
    status.selectedTarget === null ||
    status.processes.length !== 1 ||
    status.listeners.length !== 1
  ) {
    return {
      mainState: status.mainState === "cdp-main"
        ? "ambiguous-main"
        : status.mainState,
      recoveryGuidance: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
      code: status.diagnostic.code,
      details: {
        endpointObstruction: status.endpointObstruction,
        diagnostic: status.diagnostic,
      },
    };
  }
  const process = status.processes[0]!;
  const listener = status.listeners[0]!;
  const persisted = await loadCompatibilityRecord({
    adapters: options.hostAdapters,
    explodexHome: options.explodexHome,
  });
  const compatibility = evaluateCompatibility({
    host: host.host,
    sdkRuntime,
    persisted,
    runningProcess: {
      appVersion: status.selectedTarget.appVersion,
      appBuild: status.selectedTarget.appBuild,
      executablePath: process.executablePath,
    },
  });
  if (
    !compatibility.allowsCompatibilityDependentWork ||
    compatibility.currentKey === null
  ) {
    return {
      mainState: "ambiguous-main",
      recoveryGuidance: compatibility.nextAction ??
        MAIN_HOT_PATH_RECOVERY_GUIDANCE,
      code: "compatibility.unproven",
      details: {
        observedMainState: status.mainState,
        compatibility,
      },
    };
  }
  return {
    public: {
      mainState: "cdp-main",
      host: host.host,
      target: status.selectedTarget,
      compatibilityKeyHash: compatibilityKeyHash(
        compatibility.currentKey,
      ),
      sdkRuntimeIdentity: sdkRuntime,
    },
    process,
    listener,
  };
}

function isPreparedSystem(
  value: MainApplyInspection | PreparedSystemMainTarget,
): value is PreparedSystemMainTarget {
  return "public" in value;
}

function baselineExpression(options: {
  sdkRuntimeSha256: string;
  unrelatedPluginIds: readonly string[];
}): string {
  return `(() => {
  const runtime = globalThis.Explodex;
  const requestMark = runtime &&
    runtime["__explodexSdkRuntimeRequestMark"];
  if (
    !runtime ||
    typeof requestMark !== "string" ||
    !requestMark.startsWith(${JSON.stringify(`${options.sdkRuntimeSha256}:`)})
  ) {
    throw new Error("Protected main does not contain the exact unchanged SDK runtime");
  }
  const status = runtime["__explodexPluginApplicationStatus"];
  if (typeof status !== "function") {
    throw new Error("Protected main plugin status surface is unavailable");
  }
  return {
    schemaVersion: 1,
    url: String(globalThis.location && globalThis.location.href || ""),
    timeOrigin: Number(globalThis.performance && globalThis.performance.timeOrigin),
    historyLength: Number(globalThis.history && globalThis.history.length),
    route: globalThis.location
      ? String(globalThis.location.pathname + globalThis.location.search + globalThis.location.hash)
      : null,
    sdkRuntimeVersion: String(runtime.version || ""),
    sdkRuntimeSha256: requestMark.slice(0, 64),
    unrelatedPlugins: Object.fromEntries(
      ${JSON.stringify(options.unrelatedPluginIds)}.map((id) => {
        const observed = status(id);
        return [id, observed && observed.identity
          ? {
              version: observed.identity.version,
              payloadSha256: observed.identity.payloadSha256,
            }
          : null];
      }),
    ),
  };
})()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBaseline(options: {
  value: unknown;
  target: TargetIdentity;
}): MainApplyBaseline | null {
  const value = options.value;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.url !== "string" ||
    typeof value.timeOrigin !== "number" ||
    !Number.isFinite(value.timeOrigin) ||
    typeof value.historyLength !== "number" ||
    !Number.isInteger(value.historyLength) ||
    value.historyLength < 0 ||
    (value.route !== null && typeof value.route !== "string") ||
    typeof value.sdkRuntimeVersion !== "string" ||
    typeof value.sdkRuntimeSha256 !== "string" ||
    !isRecord(value.unrelatedPlugins)
  ) {
    return null;
  }
  const unrelatedPlugins: MainApplyBaseline["unrelatedPlugins"] = {};
  for (const id of Object.keys(value.unrelatedPlugins).sort()) {
    const identity = value.unrelatedPlugins[id];
    if (identity === null) {
      unrelatedPlugins[id] = null;
      continue;
    }
    if (
      !isRecord(identity) ||
      typeof identity.version !== "string" ||
      typeof identity.payloadSha256 !== "string"
    ) {
      return null;
    }
    unrelatedPlugins[id] = {
      version: identity.version,
      payloadSha256: identity.payloadSha256,
    };
  }
  return {
    pid: options.target.pid,
    processStartedAt: options.target.processStartedAt,
    targetId: options.target.targetId,
    executionContextUniqueId: options.target.executionContextUniqueId,
    url: value.url,
    timeOrigin: value.timeOrigin,
    historyLength: value.historyLength,
    route: value.route,
    sdkRuntimeVersion: value.sdkRuntimeVersion,
    sdkRuntimeSha256: value.sdkRuntimeSha256,
    unrelatedPlugins,
  };
}

function baselinesEqual(
  before: MainApplyBaseline,
  after: MainApplyBaseline,
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

export function createSystemMainApplyAdapters(options: {
  osHome: string;
  explodexHome?: string;
  timeoutMs: number;
  authorize(checkpoint: MainApplyCheckpoint): Promise<boolean>;
  hostAdapters?: HostAdapters;
  statusAdapters?: HostStatusAdapters;
  runtimeAdapters?: RuntimeAdapters;
  cdp?: CdpAdapter;
  nowMs?: () => number;
}): MainApplyAdapters {
  const explodexHome = resolve(resolveExplodexHome({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
  }));
  let hostAdaptersPromise: Promise<HostAdapters> | null = null;
  let statusAdaptersPromise: Promise<HostStatusAdapters> | null = null;
  let runtimeAdaptersPromise: Promise<RuntimeAdapters> | null = null;
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const hostAdapters = () => {
    hostAdaptersPromise ??= options.hostAdapters === undefined
      ? createDefaultHostAdapters()
      : Promise.resolve(options.hostAdapters);
    return hostAdaptersPromise;
  };
  const statusAdapters = () => {
    statusAdaptersPromise ??= options.statusAdapters === undefined
      ? createDefaultHostStatusAdapters()
      : Promise.resolve(options.statusAdapters);
    return statusAdaptersPromise;
  };
  const runtimeAdapters = () => {
    runtimeAdaptersPromise ??= options.runtimeAdapters === undefined
      ? createDefaultRuntimeAdapters()
      : Promise.resolve(options.runtimeAdapters);
    return runtimeAdaptersPromise;
  };
  const inspect = async (signal?: AbortSignal) =>
    inspectPreparedMain({
      explodexHome,
      hostAdapters: await hostAdapters(),
      statusAdapters: await statusAdapters(),
      cdp,
      signal,
    });

  return {
    async loadReceipt(input) {
      return loadStagedMainArtifactReceipt({
        explodexHome,
        id: input.provisional.validation.id,
        payloadSha256: input.provisional.validation.payloadSha256,
      });
    },
    captureArtifact(input) {
      return captureEphemeralPluginArtifact(input);
    },
    readGeneration(input) {
      return readGenerationRecord(resolve(input.artifactPath));
    },
    async inspectMain(input) {
      const observed = await inspect(input.signal);
      return isPreparedSystem(observed) ? observed.public : observed;
    },
    authorize: options.authorize,
    async apply(input): Promise<MainApplyAdapterResult> {
      const observed = await inspect(input.signal);
      if (
        !isPreparedSystem(observed) ||
        !mainApplyTargetsEqual(observed.public, input.prepared)
      ) {
        return {
          ok: false,
          code: "main.authorization-mismatch",
          message:
            "The exact protected main changed before the authorized apply.",
          sourceDelivered: false,
        };
      }
      if (
        input.authorization.operationId !== input.operationId ||
        input.authorization.pid !== input.prepared.target.pid ||
        input.authorization.targetId !== input.prepared.target.targetId ||
        input.authorization.executionContextUniqueId !==
          input.prepared.target.executionContextUniqueId
      ) {
        return {
          ok: false,
          code: "main.authorization-mismatch",
          message:
            "The consumed authorization did not match the exact apply target.",
          sourceDelivered: false,
        };
      }

      const loadedState = await loadPluginsState({ explodexHome });
      if (loadedState.status === "malformed") {
        return {
          ok: false,
          code: "plugin.reconciliation.state-invalid",
          message:
            "Authoritative plugin state is malformed, so unrelated main plugins cannot be preserved safely.",
          sourceDelivered: false,
        };
      }
      const enabled = loadedState.status === "valid"
        ? await revalidateEnabledPluginArtifacts({
            explodexHome,
            operationId: `${input.operationId}-enabled`,
            signal: input.signal,
            runtimeAdapters: await runtimeAdapters(),
          })
        : {
            ok: true as const,
            operationId: `${input.operationId}-enabled`,
            stateCommitted: false as const,
            results: [],
            snapshots: [],
            authorityFingerprint: null,
          };
      if (!enabled.ok) {
        return {
          ok: false,
          code: enabled.code,
          message: enabled.message,
          details: enabled.details,
          sourceDelivered: false,
        };
      }
      const unrelatedIds = loadedState.status === "valid"
        ? Object.keys(loadedState.state.plugins)
          .filter((id) =>
            id !== input.snapshot.identity.id &&
            loadedState.state.plugins[id]?.enabled !== null
          )
          .sort()
        : [];
      const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
      let sdkRuntimeSource: string;
      try {
        sdkRuntimeSource = await readVerifiedSdkRuntimeSource(sdkRuntime);
      } catch (error: unknown) {
        return {
          ok: false,
          code: "main.sdk-runtime-changed",
          message: error instanceof Error
            ? error.message
            : "The exact generated SDK runtime source is unavailable.",
          sourceDelivered: false,
        };
      }
      const revalidate = async () => {
        const current = await inspect(input.signal);
        if (
          !isPreparedSystem(current) ||
          !mainApplyTargetsEqual(current.public, input.prepared)
        ) {
          throw Object.assign(
            new Error("Protected main identity drifted during final apply."),
            { code: "host_identity_drift" as const },
          );
        }
        if (enabled.authorityFingerprint !== null) {
          const state = await loadPluginsState({ explodexHome });
          if (
            state.status !== "valid" ||
            pluginAuthorityFingerprint(state.state) !==
              enabled.authorityFingerprint
          ) {
            throw Object.assign(
              new Error(
                "Authoritative enabled plugin intent changed during final apply.",
              ),
              { code: "host_identity_drift" as const },
            );
          }
        }
        return {
          host: current.public.host,
          process: current.process,
          listener: current.listener,
        };
      };
      const observe = async (operation: string) => {
        const result = await runExactTargetOperation({
          runtime: await runtimeAdapters(),
          operationId: operation,
          operation: "main.apply.baseline",
          role: "main",
          homeIdentity: explodexHome,
          host: input.prepared.host,
          process: observed.process,
          endpoint: { host: "127.0.0.1", port: 9333 },
          cdp,
          signal: input.signal,
          revalidate,
          evaluate: {
            expression: baselineExpression({
              sdkRuntimeSha256: input.prepared.sdkRuntimeIdentity.sha256,
              unrelatedPluginIds: unrelatedIds,
            }),
            onBeforeEvaluation({ target }) {
              if (!targetIdentitiesEqual(target, input.prepared.target)) {
                throw Object.assign(
                  new Error("Protected main target changed before baseline observation."),
                  { code: "target_identity_drift" as const },
                );
              }
            },
          },
          stageBounds: {
            cdpDiscoveryMs: options.timeoutMs,
            cdpEvaluationMs: options.timeoutMs,
          },
        });
        if (!result.ok) {
          return {
            ok: false as const,
            code: result.error.code,
            message: result.error.message,
            details: {
              stage: result.error.stage,
              residualInventory: result.residualInventory,
            },
          };
        }
        const baseline = parseBaseline({
          value: result.result.evaluation.value,
          target: result.result.target,
        });
        return baseline === null
          ? {
              ok: false as const,
              code: "main.baseline-invalid",
              message: "Protected main baseline returned malformed evidence.",
            }
          : { ok: true as const, baseline };
      };

      const before = await observe(`${input.operationId}-baseline-before`);
      if (!before.ok) {
        return {
          ok: false,
          code: before.code,
          message: before.message,
          details: before.details,
          sourceDelivered: false,
        };
      }
      const snapshots = [
        ...enabled.snapshots.filter((snapshot) =>
          snapshot.identity.id !== input.snapshot.identity.id
        ),
        input.snapshot,
      ].sort((left, right) =>
        left.identity.id < right.identity.id
          ? -1
          : left.identity.id > right.identity.id
            ? 1
            : 0
      );
      const application = await runEnabledPluginApplicationOperation({
        runtime: await runtimeAdapters(),
        operationId: input.operationId,
        role: "main",
        homeIdentity: explodexHome,
        host: input.prepared.host,
        process: observed.process,
        endpoint: { host: "127.0.0.1", port: 9333 },
        cdp,
        expectedTarget: input.prepared.target,
        authorizeBeforeEvaluation(target) {
          const authorization = validateMainAuthorization({
            record: input.authorization,
            binding: {
              operationId: input.operationId,
              target,
              host: input.prepared.host,
              compatibilityKeyHash: input.prepared.compatibilityKeyHash,
              sdkRuntimeIdentity: input.prepared.sdkRuntimeIdentity,
              artifact: input.snapshot.identity,
            },
            nowMs: Date.now(),
          });
          if (!authorization.ok) {
            throw Object.assign(new Error(authorization.message), {
              code: authorization.code,
            });
          }
        },
        revalidate,
        sdkRuntimeSource,
        requireExistingSdkRuntimeSha256:
          input.prepared.sdkRuntimeIdentity.sha256,
        snapshots,
        timeoutMs: options.timeoutMs,
        signal: input.signal,
        lifecycleBoundary: "current",
      });
      const requested = application.applications.find((entry) =>
        entry.id === input.snapshot.identity.id &&
        entry.version === input.snapshot.identity.version &&
        entry.payloadSha256 === input.snapshot.identity.payloadSha256
      );
      if (!application.ok || requested === undefined) {
        return {
          ok: false,
          code: application.ok
            ? "main.apply-incomplete"
            : application.code,
          message: application.ok
            ? "The protected main did not report the exact staged application."
            : application.message,
          details: application.ok
            ? { applications: application.applications }
            : application.details,
          sourceDelivered: application.sourceDelivered,
          ...(requested === undefined ? {} : { application: requested }),
        };
      }
      const after = await observe(`${input.operationId}-baseline-after`);
      if (!after.ok || !baselinesEqual(before.baseline, after.ok
        ? after.baseline
        : before.baseline)) {
        return {
          ok: false,
          code: after.ok
            ? "main.baseline-changed"
            : after.code,
          message: after.ok
            ? "The protected main baseline or unrelated plugins changed during final apply."
            : after.message,
          details: after.ok
            ? { before: before.baseline, after: after.baseline }
            : after.details,
          sourceDelivered: true,
          application: requested,
        };
      }
      return {
        ok: true,
        target: application.target,
        application: requested,
        baselineBefore: before.baseline,
        baselineAfter: after.baseline,
      };
    },
    nowMs: options.nowMs ?? (() => Date.now()),
  };
}
