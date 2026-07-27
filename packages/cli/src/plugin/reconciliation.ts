import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { TargetIdentity } from "../cdp/types.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import {
  captureExactPayloadSnapshot,
  type PluginPayloadSnapshot,
} from "./approval-transaction.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import {
  loadPluginsState,
  type PluginsState,
} from "./install-state.ts";
import type { PluginManifestV1 } from "./manifest.ts";
import {
  withPluginStateLock,
  type PluginStateLockFailure,
} from "./state-lock.ts";
import type { ResidualLockAuthority } from "../runtime/locks.ts";

export type PersistedPluginIntent = {
  version: string;
  payloadSha256: string;
};

export type PluginApplicationObservation = {
  status:
    | "not-applicable"
    | "applied"
    | "apply-pending"
    | "boundary-required"
    | "blocked"
    | "failed"
    | "not-attempted";
  lifecycle: PluginManifestV1["lifecycle"] | null;
  target: TargetIdentity | null;
  boundary: "none" | "renderer" | "app";
  appliedIdentity: PersistedPluginIntent | null;
  message?: string;
  error?: {
    code: string;
    message: string;
    stage: "revalidation" | "snapshot" | "evaluation" | "setup" | "cleanup";
    possiblePartialEffects: boolean;
  };
};

export type PluginMutationResult = {
  id: string;
  previousIntent: PersistedPluginIntent | null;
  currentIntent: PersistedPluginIntent | null;
  stateCommitted: boolean;
  reviewStatus: "not-required" | "pending" | "approved";
  application: PluginApplicationObservation;
};

export type EnabledPluginReconciliationAdapters = {
  beforeArtifactRevalidation?(id: string): void | Promise<void>;
  afterArtifactRevalidation?(id: string): void | Promise<void>;
  readSnapshotFile?(path: string): Promise<Uint8Array>;
};

export type EnabledPluginRevalidationResult =
  | {
      ok: true;
      operationId: string;
      stateCommitted: false;
      results: PluginMutationResult[];
      snapshots: PluginPayloadSnapshot[];
      authorityFingerprint: string;
      residualLockAuthority?: ResidualLockAuthority;
    }
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      stateCommitted: false;
      results: PluginMutationResult[];
      snapshots: PluginPayloadSnapshot[];
      authorityFingerprint: string | null;
      residualLockAuthority?: ResidualLockAuthority;
    };

function copyIntent(
  value: PersistedPluginIntent | null,
): PersistedPluginIntent | null {
  return value === null ? null : { ...value };
}

function failure(options: {
  operationId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  residualLockAuthority?: ResidualLockAuthority;
}): EnabledPluginRevalidationResult {
  return {
    ok: false,
    operationId: options.operationId,
    code: options.code,
    message: options.message,
    ...(options.details === undefined ? {} : { details: options.details }),
    stateCommitted: false,
    results: [],
    snapshots: [],
    authorityFingerprint: null,
    ...(options.residualLockAuthority === undefined
      ? {}
      : { residualLockAuthority: options.residualLockAuthority }),
  };
}

function blockedResult(options: {
  id: string;
  intent: PersistedPluginIntent;
  lifecycle?: PluginManifestV1["lifecycle"];
  code: string;
  message: string;
  stage: "revalidation" | "snapshot";
}): PluginMutationResult {
  return {
    id: options.id,
    previousIntent: copyIntent(options.intent),
    currentIntent: copyIntent(options.intent),
    stateCommitted: false,
    reviewStatus: "not-required",
    application: {
      status: "blocked",
      lifecycle: options.lifecycle ?? null,
      target: null,
      boundary: "none",
      appliedIdentity: null,
      message: options.message,
      error: {
        code: options.code,
        message: options.message,
        stage: options.stage,
        possiblePartialEffects: false,
      },
    },
  };
}

function enabledEntries(state: PluginsState): Array<{
  id: string;
  intent: PersistedPluginIntent;
  artifactPath: string | null;
}> {
  return Object.keys(state.plugins).sort().flatMap((id) => {
    const record = state.plugins[id]!;
    if (record.enabled === null) return [];
    const installed = record.installed.find((candidate) =>
      candidate.version === record.enabled?.version &&
      candidate.payloadSha256 === record.enabled.payloadSha256
    );
    return [{
      id,
      intent: { ...record.enabled },
      artifactPath: installed === undefined ? null : installed.relativePath,
    }];
  });
}

function mapLockFailure(
  locked: PluginStateLockFailure<EnabledPluginRevalidationResult>,
  operationId: string,
): EnabledPluginRevalidationResult {
  if (locked.completedValue !== undefined) {
    return {
      ...locked.completedValue,
      ok: false,
      code: locked.code,
      message: locked.message,
      details: locked.details,
      residualLockAuthority: locked.residual,
    };
  }
  return failure({
    operationId,
    code: locked.code,
    message: locked.message,
    details: locked.details,
    residualLockAuthority: locked.residual,
  });
}

/**
 * Revalidate authoritative enabled intent without mutating it.
 * Each exact identity is handled independently and no alternate artifact is
 * considered when the authoritative identity is missing or invalid.
 */
export async function revalidateEnabledPluginArtifacts(options: {
  explodexHome: string;
  boundary?: "current" | "renderer" | "app";
  operationId?: string;
  signal?: AbortSignal;
  lockWaitMs?: number;
  runtimeAdapters?: RuntimeAdapters;
  adapters?: EnabledPluginReconciliationAdapters;
  afterRevalidation?(input: {
    results: readonly PluginMutationResult[];
    snapshots: readonly PluginPayloadSnapshot[];
    authorityFingerprint: string;
  }): Promise<void>;
}): Promise<EnabledPluginRevalidationResult> {
  const home = resolve(options.explodexHome);
  const operationId = options.operationId ?? "plugin-reconciliation";
  if (options.signal?.aborted) {
    return failure({
      operationId,
      code: "operation.interrupted",
      message: "Plugin reconciliation was interrupted before revalidation.",
    });
  }

  const locked = await withPluginStateLock<EnabledPluginRevalidationResult>({
    explodexHome: home,
    operation: "plugin.reconcile",
    operationId,
    signal: options.signal,
    waitBoundMs: options.lockWaitMs,
    runtimeAdapters: options.runtimeAdapters,
    work: async () => {
      const loaded = await loadPluginsState({ explodexHome: home });
      if (loaded.status !== "valid") {
        return failure({
          operationId,
          code: "plugin.reconciliation.state-invalid",
          message:
            "Authoritative plugin state is missing or malformed; enabled intent cannot be reconciled.",
        });
      }

      const results: PluginMutationResult[] = [];
      const snapshots: PluginPayloadSnapshot[] = [];
      const readSnapshotFile = options.adapters?.readSnapshotFile ??
        (async (path: string) => readFile(path));
      for (const enabled of enabledEntries(loaded.state)) {
        if (options.signal?.aborted) {
          return {
            ok: false,
            operationId,
            code: "operation.interrupted",
            message:
              "Plugin reconciliation was interrupted during exact artifact revalidation.",
            stateCommitted: false,
            results,
            snapshots,
            authorityFingerprint: pluginAuthorityFingerprint(loaded.state),
          };
        }
        if (enabled.artifactPath === null) {
          results.push(blockedResult({
            id: enabled.id,
            intent: enabled.intent,
            code: "plugin.reconciliation.enabled-artifact-missing",
            message:
              "The exact enabled artifact is not present in authoritative installed state.",
            stage: "revalidation",
          }));
          continue;
        }
        const artifactPath = resolve(home, enabled.artifactPath);
        await options.adapters?.beforeArtifactRevalidation?.(enabled.id);
        const validated = await validateInstallablePayloadDir(artifactPath, {
          source: "directory",
          expectedIdentity: {
            id: enabled.id,
            version: enabled.intent.version,
            payloadSha256: enabled.intent.payloadSha256,
          },
        });
        if (!validated.ok) {
          results.push(blockedResult({
            id: enabled.id,
            intent: enabled.intent,
            code: validated.code,
            message: validated.message,
            stage: "revalidation",
          }));
          continue;
        }
        await options.adapters?.afterArtifactRevalidation?.(enabled.id);
        const boundary = options.boundary ?? "current";
        const applicable =
          validated.lifecycle === "dynamic" ||
          (
            validated.lifecycle === "renderer-start" &&
            (boundary === "renderer" || boundary === "app")
          ) ||
          (validated.lifecycle === "app-start" && boundary === "app");
        if (!applicable) {
          results.push({
            id: enabled.id,
            previousIntent: copyIntent(enabled.intent),
            currentIntent: copyIntent(enabled.intent),
            stateCommitted: false,
            reviewStatus: "not-required",
            application: {
              status: "boundary-required",
              lifecycle: validated.lifecycle,
              target: null,
              boundary: validated.lifecycle === "renderer-start"
                ? "renderer"
                : "app",
              appliedIdentity: null,
            },
          });
          continue;
        }
        const captured = await captureExactPayloadSnapshot({
          artifactPath,
          identity: { id: enabled.id, ...enabled.intent },
          signal: options.signal,
          readSnapshotFile,
        });
        if (!captured.ok) {
          results.push(blockedResult({
            id: enabled.id,
            intent: enabled.intent,
            lifecycle: validated.lifecycle,
            code: "plugin.reconciliation.snapshot-invalid",
            message: captured.message,
            stage: "snapshot",
          }));
          continue;
        }
        snapshots.push(captured.snapshot);
        results.push({
          id: enabled.id,
          previousIntent: copyIntent(enabled.intent),
          currentIntent: copyIntent(enabled.intent),
          stateCommitted: false,
          reviewStatus: "not-required",
          application: {
            status: "apply-pending",
            lifecycle: validated.lifecycle,
            target: null,
            boundary: "none",
            appliedIdentity: null,
          },
        });
      }
      const authorityFingerprint = pluginAuthorityFingerprint(loaded.state);
      await options.afterRevalidation?.({
        results,
        snapshots,
        authorityFingerprint,
      });
      return {
        ok: true,
        operationId,
        stateCommitted: false,
        results,
        snapshots,
        authorityFingerprint,
      };
    },
  });
  return locked.ok ? locked.value : mapLockFailure(locked, operationId);
}

export function pluginAuthorityFingerprint(state: PluginsState): string {
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
}
