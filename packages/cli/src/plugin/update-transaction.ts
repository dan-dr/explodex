import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { ResidualLockAuthority } from "../runtime/locks.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import {
  captureExactPayloadSnapshot,
  type PluginPayloadIdentity,
  type PluginPayloadSnapshot,
} from "./approval-transaction.ts";
import {
  loadPluginsState,
  savePluginsStateAtomic,
  type PluginsState,
} from "./install-state.ts";
import type { PluginMutationResult } from "./reconciliation.ts";
import type { RuntimeApplicationResult } from "./application-operation.ts";
import type { ReviewSelectionTuple } from "./review-protocol.ts";
import {
  withPluginStateLock,
  type PluginStateLockFailure,
} from "./state-lock.ts";
import {
  prepareRecommendationArtifact,
  type PluginUpdateAdapters,
  type PreparedUpdateArtifact,
} from "./update-artifact.ts";
import {
  fullUpdateIdentityKey,
  listPluginUpdateRecommendations,
  normalizeUpdateRecommendations,
  recommendationMetadata,
  updateIdentityKey,
  validateUpdateSelection,
  type PluginUpdateListingResult,
  type PluginUpdateMetadata,
  type PluginUpdateRecommendation,
} from "./update-recommendation.ts";

export { listPluginUpdateRecommendations };
export type {
  PluginUpdateAdapters,
  PluginUpdateListingResult,
  PluginUpdateMetadata,
  PluginUpdateRecommendation,
};

export type PluginUpdateSuccess = {
  ok: true;
  operationId: string;
  selected: PluginPayloadIdentity[];
  downloaded: PluginPayloadIdentity[];
  installed: PluginPayloadIdentity[];
  artifactCommitted: boolean;
  stateCommitted: boolean;
  authorityChanged: boolean;
  snapshots: PluginPayloadSnapshot[];
  mutations: PluginMutationResult[];
  residualLockAuthority?: ResidualLockAuthority;
};

export type PluginUpdateFailure = {
  ok: false;
  operationId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  selected: PluginPayloadIdentity[];
  downloaded: PluginPayloadIdentity[];
  installed: PluginPayloadIdentity[];
  artifactCommitted: boolean;
  stateCommitted: boolean;
  authorityChanged: boolean;
  snapshots: PluginPayloadSnapshot[];
  mutations: PluginMutationResult[];
  residualLockAuthority?: ResidualLockAuthority;
};

export type PluginUpdateResult = PluginUpdateSuccess | PluginUpdateFailure;

function applicationIntent(
  identity: RuntimeApplicationResult["appliedIdentity"],
): { version: string; payloadSha256: string } | null {
  return identity === null
    ? null
    : {
        version: identity.version,
        payloadSha256: identity.payloadSha256,
      };
}

export function mergePluginUpdateApplicationResults(options: {
  mutations: readonly PluginMutationResult[];
  applications: readonly RuntimeApplicationResult[];
  target: TargetIdentity | null;
}): PluginMutationResult[] {
  const applications = new Map(
    options.applications.map((application) => [application.id, application]),
  );
  return options.mutations.map((mutation) => {
    if (
      mutation.reviewStatus !== "approved" ||
      mutation.application.status !== "apply-pending"
    ) {
      return mutation;
    }
    const application = applications.get(mutation.id);
    if (application === undefined) {
      const message =
        "Update intent committed, but live replacement was not attempted.";
      return {
        ...mutation,
        application: {
          ...mutation.application,
          status: "not-attempted",
          target: options.target,
          message,
          error: {
            code: "plugin.update.application-not-attempted",
            message,
            stage: "evaluation",
            possiblePartialEffects: false,
          },
        },
      };
    }
    const status =
      application.status === "applied" || application.status === "unchanged"
        ? "applied"
        : application.status;
    return {
      ...mutation,
      application: {
        status,
        lifecycle: "dynamic",
        target: options.target,
        boundary: application.boundary,
        appliedIdentity: applicationIntent(application.appliedIdentity),
        ...(application.status === "unchanged"
          ? { message: "The exact selected update was already applied." }
          : application.error === undefined
            ? {}
            : {
                message: application.error.message,
                error: {
                  code: application.error.code,
                  message: application.error.message,
                  stage:
                    application.stage === "setup" ||
                      application.stage === "cleanup" ||
                      application.stage === "evaluation"
                      ? application.stage
                      : "evaluation" as const,
                  possiblePartialEffects:
                    application.possiblePartialEffects,
                },
              }),
      },
    };
  });
}

function cloneState(state: PluginsState, updatedAt: string): PluginsState {
  const plugins: PluginsState["plugins"] = {};
  for (const id of Object.keys(state.plugins).sort()) {
    const record = state.plugins[id]!;
    plugins[id] = {
      installed: record.installed.map((artifact) => ({
        ...artifact,
        source: { ...artifact.source },
      })),
      enabled: record.enabled === null ? null : { ...record.enabled },
      pendingReview: record.pendingReview.map((identity) => ({ ...identity })),
    };
  }
  return { schemaVersion: 1, plugins, updatedAt };
}

function failure(options: {
  operationId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  selected?: PluginPayloadIdentity[];
  downloaded?: PluginPayloadIdentity[];
  installed?: PluginPayloadIdentity[];
  artifactCommitted?: boolean;
  stateCommitted?: boolean;
  snapshots?: PluginPayloadSnapshot[];
  mutations?: PluginMutationResult[];
  residualLockAuthority?: ResidualLockAuthority;
}): PluginUpdateFailure {
  return {
    ok: false,
    operationId: options.operationId,
    code: options.code,
    message: options.message,
    ...(options.details === undefined ? {} : { details: options.details }),
    selected: options.selected ?? [],
    downloaded: options.downloaded ?? [],
    installed: options.installed ?? [],
    artifactCommitted: options.artifactCommitted ?? false,
    stateCommitted: options.stateCommitted ?? false,
    authorityChanged: options.stateCommitted ?? false,
    snapshots: options.snapshots ?? [],
    mutations: options.mutations ?? [],
    ...(options.residualLockAuthority === undefined
      ? {}
      : { residualLockAuthority: options.residualLockAuthority }),
  };
}

function applyTransitions(
  state: PluginsState,
  prepared: readonly PreparedUpdateArtifact[],
): Array<{
  prepared: PreparedUpdateArtifact;
  previousIntent: { version: string; payloadSha256: string } | null;
}> {
  return prepared.map((entry) => {
    const record = state.plugins[entry.identity.id];
    if (record === undefined || record.installed.length === 0) {
      throw new Error(
        "Selected update no longer has an existing plugin state record.",
      );
    }
    const previousIntent = record.enabled === null
      ? null
      : { ...record.enabled };
    if (
      !record.installed.some((candidate) =>
        updateIdentityKey(candidate) === updateIdentityKey(entry.identity)
      )
    ) {
      record.installed.push({
        ...entry.installed,
        source: { ...entry.installed.source },
      });
      record.installed.sort((left, right) =>
        updateIdentityKey(left) < updateIdentityKey(right) ? -1 :
        updateIdentityKey(left) > updateIdentityKey(right) ? 1 : 0
      );
    }
    if (previousIntent !== null) {
      record.enabled = {
        version: entry.identity.version,
        payloadSha256: entry.identity.payloadSha256,
      };
      record.pendingReview = record.pendingReview.filter((candidate) =>
        updateIdentityKey(candidate) !== updateIdentityKey(entry.identity)
      );
    } else {
      record.enabled = null;
      if (
        !record.pendingReview.some((candidate) =>
          updateIdentityKey(candidate) === updateIdentityKey(entry.identity)
        )
      ) {
        record.pendingReview.push({
          version: entry.identity.version,
          payloadSha256: entry.identity.payloadSha256,
        });
        record.pendingReview.sort((left, right) =>
          updateIdentityKey(left) < updateIdentityKey(right) ? -1 :
          updateIdentityKey(left) > updateIdentityKey(right) ? 1 : 0
        );
      }
    }
    return { prepared: entry, previousIntent };
  });
}

function pendingMutation(
  transition: ReturnType<typeof applyTransitions>[number],
): PluginMutationResult {
  const currentIntent = transition.previousIntent === null
    ? null
    : {
        version: transition.prepared.identity.version,
        payloadSha256: transition.prepared.identity.payloadSha256,
      };
  if (transition.previousIntent === null) {
    return {
      id: transition.prepared.identity.id,
      previousIntent: null,
      currentIntent: null,
      stateCommitted: true,
      reviewStatus: "pending",
      application: {
        status: "not-applicable",
        lifecycle: transition.prepared.lifecycle,
        target: null,
        boundary: "none",
        appliedIdentity: null,
      },
    };
  }
  if (transition.prepared.lifecycle !== "dynamic") {
    return {
      id: transition.prepared.identity.id,
      previousIntent: transition.previousIntent,
      currentIntent,
      stateCommitted: true,
      reviewStatus: "approved",
      application: {
        status: "boundary-required",
        lifecycle: transition.prepared.lifecycle,
        target: null,
        boundary: transition.prepared.lifecycle === "renderer-start"
          ? "renderer"
          : "app",
        appliedIdentity: null,
      },
    };
  }
  return {
    id: transition.prepared.identity.id,
    previousIntent: transition.previousIntent,
    currentIntent,
    stateCommitted: true,
    reviewStatus: "approved",
    application: {
      status: "apply-pending",
      lifecycle: "dynamic",
      target: null,
      boundary: "none",
      appliedIdentity: null,
    },
  };
}

function hasCommittedTransitions(
  state: PluginsState,
  transitions: ReturnType<typeof applyTransitions>,
): boolean {
  return transitions.every(({ prepared, previousIntent }) => {
    const record = state.plugins[prepared.identity.id];
    if (
      record === undefined ||
      !record.installed.some((candidate) =>
        updateIdentityKey(candidate) === updateIdentityKey(prepared.identity)
      )
    ) {
      return false;
    }
    if (previousIntent === null) {
      return record.enabled === null &&
        record.pendingReview.some((candidate) =>
          updateIdentityKey(candidate) === updateIdentityKey(prepared.identity)
        );
    }
    return record.enabled !== null &&
      updateIdentityKey(record.enabled) ===
        updateIdentityKey(prepared.identity) &&
      !record.pendingReview.some((candidate) =>
        updateIdentityKey(candidate) === updateIdentityKey(prepared.identity)
      );
  });
}

function mapLockFailure(
  locked: PluginStateLockFailure<PluginUpdateResult>,
  operationId: string,
  selected: PluginPayloadIdentity[],
): PluginUpdateFailure {
  const completed = locked.completedValue;
  return failure({
    operationId: completed?.operationId ?? operationId,
    code: locked.code,
    message: locked.message,
    details: locked.details,
    selected: completed?.selected ?? selected,
    downloaded: completed?.downloaded ?? [],
    installed: completed?.installed ?? [],
    artifactCommitted: completed?.artifactCommitted ?? false,
    stateCommitted: completed?.stateCommitted ?? false,
    snapshots: completed?.snapshots ?? [],
    mutations: completed?.mutations ?? [],
    residualLockAuthority: locked.residual,
  });
}

export async function applySelectedPluginUpdates(options: {
  explodexHome: string;
  recommendations: readonly unknown[];
  selected: readonly ReviewSelectionTuple[];
  fetchArchive(
    recommendation: PluginUpdateRecommendation,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  now?: () => string;
  signal?: AbortSignal;
  operationId?: string;
  lockWaitMs?: number;
  runtimeAdapters?: RuntimeAdapters;
  adapters?: PluginUpdateAdapters;
}): Promise<PluginUpdateResult> {
  const operationId = options.operationId ?? "plugin-update";
  const normalized = normalizeUpdateRecommendations(options.recommendations);
  if (!normalized.ok) {
    return failure({ operationId, ...normalized });
  }
  const selection = validateUpdateSelection(
    normalized.values,
    options.selected,
  );
  if (!selection.ok) {
    return failure({ operationId, ...selection });
  }
  if (selection.values.length === 0) {
    return {
      ok: true,
      operationId,
      selected: [],
      downloaded: [],
      installed: [],
      artifactCommitted: false,
      stateCommitted: false,
      authorityChanged: false,
      snapshots: [],
      mutations: [],
    };
  }
  if (options.signal?.aborted) {
    return failure({
      operationId,
      code: "operation.interrupted",
      message: "Plugin update was interrupted before mutation.",
      selected: selection.values,
    });
  }

  const home = resolve(options.explodexHome);
  const recommendationByIdentity = new Map(
    normalized.values.map((recommendation) => [
      fullUpdateIdentityKey(recommendation.artifact),
      recommendation,
    ]),
  );
  const locked = await withPluginStateLock<PluginUpdateResult>({
    explodexHome: home,
    operation: "plugin.update.apply",
    operationId,
    signal: options.signal,
    waitBoundMs: options.lockWaitMs,
    runtimeAdapters: options.runtimeAdapters,
    work: async () => {
      const loaded = await loadPluginsState({ explodexHome: home });
      if (loaded.status !== "valid") {
        return failure({
          operationId,
          code: "plugin.update.state-invalid",
          message:
            "Update Selected requires a valid authoritative plugins.json state.",
          selected: selection.values,
        });
      }
      for (const identity of selection.values) {
        const recommendation = recommendationByIdentity.get(
          fullUpdateIdentityKey(identity),
        );
        const metadata = recommendation === undefined
          ? null
          : recommendationMetadata(loaded.state, recommendation);
        if (metadata === null) {
          return failure({
            operationId,
            code: "plugin.update.stale-selection",
            message:
              "Selected update metadata is stale for the current authoritative state.",
            details: { identity },
            selected: selection.values,
          });
        }
      }

      const now = options.now?.() ?? new Date().toISOString();
      const prepared: PreparedUpdateArtifact[] = [];
      const downloaded: PluginPayloadIdentity[] = [];
      const installed: PluginPayloadIdentity[] = [];
      let artifactCommitted = false;
      for (const identity of selection.values) {
        const recommendation = recommendationByIdentity.get(
          fullUpdateIdentityKey(identity),
        )!;
        const result = await prepareRecommendationArtifact({
          home,
          state: loaded.state,
          recommendation,
          signal: options.signal,
          now,
          fetchArchive: options.fetchArchive,
          adapters: options.adapters,
        });
        if (!result.ok) {
          return failure({
            operationId,
            code: result.code,
            message: result.message,
            details: result.details,
            selected: selection.values,
            downloaded: result.downloaded
              ? [...downloaded, identity]
              : downloaded,
            installed,
            artifactCommitted: artifactCommitted || result.committedNow,
          });
        }
        prepared.push(result.value);
        if (result.value.downloaded) downloaded.push(identity);
        installed.push(identity);
        artifactCommitted ||= result.value.committedNow;
      }
      if (options.signal?.aborted) {
        return failure({
          operationId,
          code: "operation.interrupted",
          message:
            "Plugin update was interrupted after artifact installation and before state commit.",
          selected: selection.values,
          downloaded,
          installed,
          artifactCommitted,
        });
      }

      const next = cloneState(loaded.state, now);
      let transitions: ReturnType<typeof applyTransitions>;
      try {
        transitions = applyTransitions(next, prepared);
      } catch (error: unknown) {
        return failure({
          operationId,
          code: "plugin.update.stale-selection",
          message: error instanceof Error
            ? error.message
            : "Plugin update state changed before transition.",
          selected: selection.values,
          downloaded,
          installed,
          artifactCommitted,
        });
      }
      const mutations = transitions.map(pendingMutation);
      try {
        await options.adapters?.beforeStateCommit?.();
        if (options.signal?.aborted) {
          return failure({
            operationId,
            code: "operation.interrupted",
            message:
              "Plugin update was interrupted before the authoritative state commit.",
            selected: selection.values,
            downloaded,
            installed,
            artifactCommitted,
          });
        }
        await (options.adapters?.writeState ?? savePluginsStateAtomic)({
          explodexHome: home,
          state: next,
        });
      } catch (error: unknown) {
        const observed = await loadPluginsState({ explodexHome: home });
        const committed = observed.status === "valid" &&
          hasCommittedTransitions(observed.state, transitions);
        return failure({
          operationId,
          code: "plugin.update.state-write-failed",
          message: error instanceof Error
            ? error.message
            : "Plugin update state commit failed.",
          selected: selection.values,
          downloaded,
          installed,
          artifactCommitted,
          stateCommitted: committed,
          mutations: committed ? mutations : [],
        });
      }

      await options.adapters?.afterStateCommitBeforeSnapshot?.();
      if (options.signal?.aborted) {
        return failure({
          operationId,
          code: "operation.interrupted",
          message:
            "Plugin update was interrupted after state commit and before live application.",
          selected: selection.values,
          downloaded,
          installed,
          artifactCommitted,
          stateCommitted: true,
          mutations,
        });
      }
      const snapshots: PluginPayloadSnapshot[] = [];
      const readSnapshotFile = options.adapters?.readSnapshotFile ??
        (async (path: string) => readFile(path));
      for (const transition of transitions) {
        if (
          transition.previousIntent === null ||
          transition.prepared.lifecycle !== "dynamic"
        ) {
          continue;
        }
        const snapshot = await captureExactPayloadSnapshot({
          artifactPath: transition.prepared.artifactPath,
          identity: transition.prepared.identity,
          signal: options.signal,
          readSnapshotFile,
        });
        if (!snapshot.ok) {
          return failure({
            operationId,
            code: options.signal?.aborted
              ? "operation.interrupted"
              : "plugin.update.snapshot-invalid",
            message: snapshot.message,
            details: snapshot.details,
            selected: selection.values,
            downloaded,
            installed,
            artifactCommitted,
            stateCommitted: true,
            mutations,
          });
        }
        snapshots.push(snapshot.snapshot);
      }
      await options.adapters?.afterSnapshot?.();
      if (options.signal?.aborted) {
        return failure({
          operationId,
          code: "operation.interrupted",
          message:
            "Plugin update was interrupted after state commit and before live application.",
          selected: selection.values,
          downloaded,
          installed,
          artifactCommitted,
          stateCommitted: true,
          mutations,
        });
      }
      return {
        ok: true,
        operationId,
        selected: selection.values,
        downloaded,
        installed,
        artifactCommitted,
        stateCommitted: true,
        authorityChanged: true,
        snapshots,
        mutations,
      };
    },
  });
  return locked.ok
    ? locked.value
    : mapLockFailure(locked, operationId, selection.values);
}
