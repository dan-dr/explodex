import type { TargetIdentity } from "../cdp/types.ts";
import type {
  EphemeralPluginArtifactResult,
} from "../dev/ephemeral-artifact.ts";
import {
  type StagedMainArtifactReceipt,
  validateStagedMainArtifact,
} from "../dev/main-staging.ts";
import type { GenerationRecord } from "../plugin/generation.ts";
import type {
  PluginPayloadSnapshot,
} from "../plugin/approval-transaction.ts";
import type { RuntimeApplicationResult } from "../plugin/application-operation.ts";
import { targetIdentitiesEqual } from "../plugin/review-protocol.ts";
import {
  createMainAuthorization,
  type MainAuthorization,
  type MainAuthorizationBinding,
} from "./main-authorization.ts";
import type { MainClassification } from "./status.ts";
import type { HostIdentity } from "./types.ts";

export type PreparedMainApplyTarget = {
  mainState: "cdp-main";
  host: HostIdentity;
  target: TargetIdentity;
  compatibilityKeyHash: string;
  sdkRuntimeIdentity: {
    version: string;
    sha256: string;
  };
};

export type BlockedMainApplyTarget = {
  mainState: Exclude<MainClassification, "cdp-main">;
  recoveryGuidance: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type MainApplyInspection =
  | PreparedMainApplyTarget
  | BlockedMainApplyTarget;

export type MainApplyBaseline = {
  pid: number;
  processStartedAt: string;
  targetId: string;
  executionContextUniqueId: string;
  url: string;
  timeOrigin: number;
  historyLength: number;
  route: string | null;
  sdkRuntimeVersion: string;
  sdkRuntimeSha256: string;
  unrelatedPlugins: Record<
    string,
    { version: string; payloadSha256: string } | null
  >;
};

export type MainApplyAdapterResult =
  | {
      ok: true;
      target: TargetIdentity;
      application: RuntimeApplicationResult;
      baselineBefore: MainApplyBaseline;
      baselineAfter: MainApplyBaseline;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      sourceDelivered: boolean;
      application?: RuntimeApplicationResult;
    };

export type MainApplyCheckpoint = {
  operationId: string;
  expiresAt: string;
  target: TargetIdentity;
  host: HostIdentity;
  compatibilityKeyHash: string;
  sdkRuntimeIdentity: {
    version: string;
    sha256: string;
  };
  artifact: {
    id: string;
    version: string;
    payloadSha256: string;
  };
};

export type MainApplyAdapters = {
  loadReceipt(input: {
    artifactPath: string;
    provisional: Extract<EphemeralPluginArtifactResult, { ok: true }>;
  }): Promise<StagedMainArtifactReceipt | null>;
  captureArtifact(input: {
    artifactPath: string;
    signal?: AbortSignal;
  }): Promise<EphemeralPluginArtifactResult>;
  readGeneration(input: {
    artifactPath: string;
  }): Promise<GenerationRecord | null>;
  inspectMain(input: {
    signal?: AbortSignal;
  }): Promise<MainApplyInspection>;
  authorize(checkpoint: MainApplyCheckpoint): Promise<boolean>;
  apply(input: {
    operationId: string;
    prepared: PreparedMainApplyTarget;
    snapshot: PluginPayloadSnapshot;
    authorization: MainAuthorization;
    signal?: AbortSignal;
  }): Promise<MainApplyAdapterResult>;
  nowMs(): number;
};

type MainApplyArtifactIdentity = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type MainApplyResult =
  | {
      ok: true;
      operationId: string;
      stagedIdentity: MainApplyArtifactIdentity;
      appliedIdentity: MainApplyArtifactIdentity;
      target: TargetIdentity;
      baseline: {
        before: MainApplyBaseline;
        after: MainApplyBaseline;
      };
      baselinePreserved: true;
      sourceDelivered: true;
      authorizationConsumed: true;
      application: RuntimeApplicationResult;
    }
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      stagedIdentity: MainApplyArtifactIdentity | null;
      sourceDelivered: boolean;
      checkpoint?: MainApplyCheckpoint;
      details?: Record<string, unknown>;
    };

function failed(options: {
  operationId: string;
  code: string;
  message: string;
  stagedIdentity?: MainApplyArtifactIdentity | null;
  sourceDelivered?: boolean;
  checkpoint?: MainApplyCheckpoint;
  details?: Record<string, unknown>;
}): MainApplyResult {
  return {
    ok: false,
    operationId: options.operationId,
    code: options.code,
    message: options.message,
    stagedIdentity: options.stagedIdentity ?? null,
    sourceDelivered: options.sourceDelivered ?? false,
    ...(options.checkpoint === undefined
      ? {}
      : { checkpoint: options.checkpoint }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

function artifactIdentity(
  captured: Extract<EphemeralPluginArtifactResult, { ok: true }>,
) {
  return {
    id: captured.validation.id,
    version: captured.validation.version,
    payloadSha256: captured.validation.payloadSha256,
  };
}

function stagingArtifact(
  captured: Extract<EphemeralPluginArtifactResult, { ok: true }>,
) {
  return {
    ...artifactIdentity(captured),
    lifecycle: captured.validation.lifecycle,
    sdkRange: captured.validation.sdkRange,
  };
}

export function mainApplyTargetsEqual(
  left: PreparedMainApplyTarget,
  right: PreparedMainApplyTarget,
): boolean {
  const leftHashKeys = Object.keys(left.host.hostHashes).sort();
  const rightHashKeys = Object.keys(right.host.hostHashes).sort();
  return left.compatibilityKeyHash === right.compatibilityKeyHash &&
    left.sdkRuntimeIdentity.version === right.sdkRuntimeIdentity.version &&
    left.sdkRuntimeIdentity.sha256 === right.sdkRuntimeIdentity.sha256 &&
    left.host.bundlePath === right.host.bundlePath &&
    left.host.executablePath === right.host.executablePath &&
    left.host.bundleId === right.host.bundleId &&
    left.host.executableName === right.host.executableName &&
    left.host.signingTeam === right.host.signingTeam &&
    left.host.appVersion === right.host.appVersion &&
    left.host.appBuild === right.host.appBuild &&
    leftHashKeys.length === rightHashKeys.length &&
    leftHashKeys.every((key, index) =>
      key === rightHashKeys[index] &&
      left.host.hostHashes[key] === right.host.hostHashes[key]
    ) &&
    targetIdentitiesEqual(left.target, right.target);
}

function authorizationBinding(options: {
  operationId: string;
  prepared: PreparedMainApplyTarget;
  artifact: {
    id: string;
    version: string;
    payloadSha256: string;
  };
}): MainAuthorizationBinding {
  return {
    operationId: options.operationId,
    target: options.prepared.target,
    host: options.prepared.host,
    compatibilityKeyHash: options.prepared.compatibilityKeyHash,
    sdkRuntimeIdentity: options.prepared.sdkRuntimeIdentity,
    artifact: options.artifact,
  };
}

function checkpoint(options: {
  binding: MainAuthorizationBinding;
  expiresAt: string;
}): MainApplyCheckpoint {
  return {
    operationId: options.binding.operationId,
    expiresAt: options.expiresAt,
    target: options.binding.target,
    host: options.binding.host,
    compatibilityKeyHash: options.binding.compatibilityKeyHash,
    sdkRuntimeIdentity: options.binding.sdkRuntimeIdentity,
    artifact: options.binding.artifact,
  };
}

export async function runMainApplyOperation(options: {
  artifactPath: string;
  operationId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  authorizationTtlMs?: number;
  adapters: MainApplyAdapters;
}): Promise<MainApplyResult> {
  const provisional = await options.adapters.captureArtifact({
    artifactPath: options.artifactPath,
    signal: options.signal,
  });
  if (!provisional.ok) {
    return failed({
      operationId: options.operationId,
      code: provisional.code,
      message: provisional.message,
      details: provisional.details,
    });
  }
  const stagedIdentity = artifactIdentity(provisional);
  const receipt = await options.adapters.loadReceipt({
    artifactPath: options.artifactPath,
    provisional,
  });
  if (receipt === null) {
    return failed({
      operationId: options.operationId,
      code: "develop.dev-revalidation-required",
      message:
        "No exact staged main-artifact receipt exists for these bytes. Rebuild with publishable SDK inputs and validate on owned development.",
      stagedIdentity,
    });
  }
  if (
    receipt.lifecycle !== "dynamic" ||
    provisional.validation.lifecycle !== "dynamic"
  ) {
    return failed({
      operationId: options.operationId,
      code: "main.lifecycle-protected",
      message:
        "Renderer-start and app-start artifacts cannot be applied to the protected authoring main.",
      stagedIdentity,
    });
  }

  const initial = await options.adapters.inspectMain({
    signal: options.signal,
  });
  if (initial.mainState !== "cdp-main") {
    const code = initial.code === "compatibility.unproven"
      ? "compatibility.unproven"
      : "main.hot-path-unavailable";
    return failed({
      operationId: options.operationId,
      code,
      message: code === "compatibility.unproven"
        ? "The exact current compatibility proof is unavailable for this main operation."
        : "Main hot path unavailable. The exact staged artifact remains available for a later new operation.",
      stagedIdentity,
      details: {
        mainState: initial.mainState,
        recoveryGuidance: initial.recoveryGuidance,
        ...(initial.details === undefined ? {} : { cause: initial.details }),
      },
    });
  }

  const initialGeneration = await options.adapters.readGeneration({
    artifactPath: options.artifactPath,
  });
  const initialPreflight = validateStagedMainArtifact({
    receipt,
    artifact: stagingArtifact(provisional),
    generation: initialGeneration,
    mainSdkRuntime: initial.sdkRuntimeIdentity,
    compatibilityKeyHash: initial.compatibilityKeyHash,
  });
  if (!initialPreflight.ok) {
    return failed({
      operationId: options.operationId,
      code: initialPreflight.code,
      message: initialPreflight.message,
      stagedIdentity,
      details: initialPreflight.details,
    });
  }

  const issuedAtMs = options.adapters.nowMs();
  const ttlMs = Math.min(
    options.authorizationTtlMs ?? 300_000,
    options.timeoutMs,
  );
  const binding = authorizationBinding({
    operationId: options.operationId,
    prepared: initial,
    artifact: stagedIdentity,
  });
  const lease = createMainAuthorization({
    binding,
    issuedAtMs,
    ttlMs,
  });
  const requestedCheckpoint = checkpoint({
    binding,
    expiresAt: lease.record.expiresAt,
  });
  if (!(await options.adapters.authorize(requestedCheckpoint))) {
    return failed({
      operationId: options.operationId,
      code: "main.authorization-required",
      message:
        "A fresh explicit checkpoint is required for this exact authoring-main operation and staged artifact.",
      stagedIdentity,
      checkpoint: requestedCheckpoint,
    });
  }

  const current = await options.adapters.inspectMain({
    signal: options.signal,
  });
  if (
    current.mainState !== "cdp-main" ||
    !mainApplyTargetsEqual(initial, current)
  ) {
    return failed({
      operationId: options.operationId,
      code: "main.authorization-mismatch",
      message:
        "The exact authoring-main or compatibility identity changed after the checkpoint.",
      stagedIdentity,
      details: {
        expected: initial,
        observed: current,
      },
    });
  }
  const captured = await options.adapters.captureArtifact({
    artifactPath: options.artifactPath,
    signal: options.signal,
  });
  if (!captured.ok) {
    return failed({
      operationId: options.operationId,
      code: captured.code,
      message: captured.message,
      stagedIdentity,
      details: captured.details,
    });
  }
  const generation = await options.adapters.readGeneration({
    artifactPath: options.artifactPath,
  });
  const finalPreflight = validateStagedMainArtifact({
    receipt,
    artifact: stagingArtifact(captured),
    generation,
    mainSdkRuntime: current.sdkRuntimeIdentity,
    compatibilityKeyHash: current.compatibilityKeyHash,
  });
  if (!finalPreflight.ok) {
    return failed({
      operationId: options.operationId,
      code: finalPreflight.code,
      message: finalPreflight.message,
      stagedIdentity,
      details: finalPreflight.details,
    });
  }

  const currentBinding = authorizationBinding({
    operationId: options.operationId,
    prepared: current,
    artifact: artifactIdentity(captured),
  });
  const authorized = lease.validateAndConsume({
    binding: currentBinding,
    nowMs: options.adapters.nowMs(),
  });
  if (!authorized.ok) {
    return failed({
      operationId: options.operationId,
      code: authorized.code,
      message: authorized.message,
      stagedIdentity,
      details: authorized.mismatch === undefined
        ? undefined
        : { mismatch: authorized.mismatch },
    });
  }

  const applied = await options.adapters.apply({
    operationId: options.operationId,
    prepared: current,
    snapshot: captured.snapshot,
    authorization: lease.record,
    signal: options.signal,
  });
  if (!applied.ok) {
    return failed({
      operationId: options.operationId,
      code: applied.code,
      message: applied.message,
      stagedIdentity,
      sourceDelivered: applied.sourceDelivered,
      details: {
        ...(applied.details ?? {}),
        ...(applied.application === undefined
          ? {}
          : { application: applied.application }),
        authorizationConsumed: true,
      },
    });
  }
  const expectedIdentity = artifactIdentity(captured);
  if (
    applied.target.pid !== current.target.pid ||
    applied.target.processStartedAt !== current.target.processStartedAt ||
    applied.target.targetId !== current.target.targetId ||
    applied.target.executionContextUniqueId !==
      current.target.executionContextUniqueId ||
    applied.application.id !== expectedIdentity.id ||
    applied.application.version !== expectedIdentity.version ||
    applied.application.payloadSha256 !== expectedIdentity.payloadSha256 ||
    (applied.application.status !== "applied" &&
      applied.application.status !== "unchanged") ||
    applied.application.appliedIdentity?.id !== expectedIdentity.id ||
    applied.application.appliedIdentity.version !== expectedIdentity.version ||
    applied.application.appliedIdentity.payloadSha256 !==
      expectedIdentity.payloadSha256 ||
    applied.baselineBefore.pid !== current.target.pid ||
    applied.baselineBefore.processStartedAt !== current.target.processStartedAt ||
    applied.baselineBefore.targetId !== current.target.targetId ||
    applied.baselineBefore.executionContextUniqueId !==
      current.target.executionContextUniqueId ||
    applied.baselineBefore.sdkRuntimeVersion !==
      current.sdkRuntimeIdentity.version ||
    applied.baselineBefore.sdkRuntimeSha256 !== current.sdkRuntimeIdentity.sha256 ||
    applied.baselineAfter.pid !== current.target.pid ||
    applied.baselineAfter.processStartedAt !== current.target.processStartedAt ||
    applied.baselineAfter.targetId !== current.target.targetId ||
    applied.baselineAfter.executionContextUniqueId !==
      current.target.executionContextUniqueId ||
    applied.baselineAfter.sdkRuntimeVersion !==
      current.sdkRuntimeIdentity.version ||
    applied.baselineAfter.sdkRuntimeSha256 !== current.sdkRuntimeIdentity.sha256 ||
    JSON.stringify(applied.baselineBefore) !==
      JSON.stringify(applied.baselineAfter)
  ) {
    return failed({
      operationId: options.operationId,
      code: "main.apply-incomplete",
      message:
        "The final apply did not preserve or confirm the exact authorized main baseline and staged identity.",
      stagedIdentity,
      sourceDelivered: true,
      details: {
        target: applied.target,
        application: applied.application,
        baseline: {
          before: applied.baselineBefore,
          after: applied.baselineAfter,
        },
        authorizationConsumed: true,
      },
    });
  }
  return {
    ok: true,
    operationId: options.operationId,
    stagedIdentity,
    appliedIdentity: expectedIdentity,
    target: applied.target,
    baseline: {
      before: applied.baselineBefore,
      after: applied.baselineAfter,
    },
    baselinePreserved: true,
    sourceDelivered: true,
    authorizationConsumed: true,
    application: applied.application,
  };
}
