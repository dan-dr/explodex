import { lstat, rm } from "node:fs/promises";
import {
  join,
  resolve,
  sep,
} from "node:path";
import type { ResidualLockAuthority } from "../runtime/locks.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import {
  loadPluginsState,
  savePluginsStateAtomic,
  type InstalledArtifact,
  type PluginsState,
} from "./install-state.ts";
import type { PluginManifestV1 } from "./manifest.ts";
import type {
  PersistedPluginIntent,
  PluginApplicationObservation,
  PluginMutationResult,
} from "./reconciliation.ts";
import type {
  PluginDisableOptions,
  PluginDisableResult,
  PluginMutationIdentity,
  PluginRemoveOptions,
  PluginRemoveResult,
  PluginTeardownResult,
} from "./mutation-types.ts";
import {
  withPluginStateLock,
  type PluginStateLockFailure,
} from "./state-lock.ts";

function identityEquals(
  left: PluginMutationIdentity,
  right: PluginMutationIdentity,
): boolean {
  return left.version === right.version &&
    left.payloadSha256 === right.payloadSha256;
}

function copyIntent(
  value: PersistedPluginIntent | null,
): PersistedPluginIntent | null {
  return value === null ? null : { ...value };
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
      enabled: copyIntent(record.enabled),
      pendingReview: record.pendingReview.map((identity) => ({
        ...identity,
      })),
    };
  }
  return {
    schemaVersion: 1,
    plugins,
    updatedAt,
  };
}

function stateAuthority(state: PluginsState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    plugins: state.plugins,
  });
}

async function committedStateMatches(
  home: string,
  expected: PluginsState,
): Promise<boolean> {
  const loaded = await loadPluginsState({ explodexHome: home });
  return loaded.status === "valid" &&
    stateAuthority(loaded.state) === stateAuthority(expected);
}

async function artifactLifecycle(options: {
  home: string;
  id: string;
  artifact: InstalledArtifact;
  signal?: AbortSignal;
}): Promise<PluginManifestV1["lifecycle"] | null> {
  const validated = await validateInstallablePayloadDir(
    resolve(options.home, options.artifact.relativePath),
    {
      source: "directory",
      expectedIdentity: {
        id: options.id,
        version: options.artifact.version,
        payloadSha256: options.artifact.payloadSha256,
      },
      signal: options.signal,
    },
  );
  return validated.ok ? validated.lifecycle : null;
}

function mutationApplication(options: {
  previousIntent: PersistedPluginIntent | null;
  lifecycle: PluginManifestV1["lifecycle"] | null;
  targetRequested: boolean;
}): PluginApplicationObservation {
  if (options.previousIntent === null) {
    return {
      status: "not-applicable",
      lifecycle: options.lifecycle,
      target: null,
      boundary: "none",
      appliedIdentity: null,
      message: "The selected identity was not authoritative enabled intent.",
    };
  }
  if (options.lifecycle === "renderer-start") {
    return {
      status: "boundary-required",
      lifecycle: "renderer-start",
      target: null,
      boundary: "renderer",
      appliedIdentity: null,
      message:
        "Persisted intent is cleared. Any previously running effect remains until an allowed renderer boundary and is omitted from future payloads.",
    };
  }
  if (options.lifecycle === "app-start") {
    return {
      status: "boundary-required",
      lifecycle: "app-start",
      target: null,
      boundary: "app",
      appliedIdentity: null,
      message:
        "Persisted intent is cleared. Any previously running effect remains until an allowed app boundary and is omitted from future payloads.",
    };
  }
  if (options.lifecycle === null) {
    const message =
      "Persisted intent is cleared, but the installed lifecycle metadata could not be read for optional live teardown.";
    return {
      status: "blocked",
      lifecycle: null,
      target: null,
      boundary: "none",
      appliedIdentity: null,
      message,
      error: {
        code: "plugin.mutation.lifecycle-unavailable",
        message,
        stage: "revalidation",
        possiblePartialEffects: false,
      },
    };
  }
  if (!options.targetRequested) {
    const message =
      "Persisted intent is cleared. No exact renderer target was inspected, so live teardown was not attempted.";
    return {
      status: "not-attempted",
      lifecycle: "dynamic",
      target: null,
      boundary: "none",
      appliedIdentity: null,
      message,
      error: {
        code: "plugin.mutation.teardown-not-requested",
        message,
        stage: "cleanup",
        possiblePartialEffects: false,
      },
    };
  }
  return {
    status: "apply-pending",
    lifecycle: "dynamic",
    target: null,
    boundary: "none",
    appliedIdentity: null,
    message:
      "Persisted intent is cleared and exact dynamic teardown is pending.",
  };
}

function applyTeardownResult(
  mutation: PluginMutationResult,
  result: PluginTeardownResult,
): PluginMutationResult {
  return {
    ...mutation,
    application: {
      status: result.status,
      lifecycle: "dynamic",
      target: result.target,
      boundary: "none",
      appliedIdentity: result.appliedIdentity,
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.error === undefined ? {} : { error: result.error }),
    },
  };
}

function disableFailure(options: {
  operationId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stateCommitted?: boolean;
  mutation?: PluginMutationResult | null;
  residualLockAuthority?: ResidualLockAuthority;
}): PluginDisableResult {
  return {
    ok: false,
    operationId: options.operationId,
    code: options.code,
    message: options.message,
    ...(options.details === undefined ? {} : { details: options.details }),
    stateCommitted: options.stateCommitted ?? false,
    authorityChanged: options.stateCommitted ?? false,
    mutation: options.mutation ?? null,
    ...(options.residualLockAuthority === undefined
      ? {}
      : { residualLockAuthority: options.residualLockAuthority }),
  };
}

function removeFailure(options: {
  operationId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  removed?: ({ id: string } & PluginMutationIdentity) | null;
  stateCommitted?: boolean;
  artifactDeleted?: boolean;
  orphanedDirectory?: string | null;
  mutation?: PluginMutationResult | null;
  residualLockAuthority?: ResidualLockAuthority;
}): PluginRemoveResult {
  return {
    ok: false,
    operationId: options.operationId,
    code: options.code,
    message: options.message,
    ...(options.details === undefined ? {} : { details: options.details }),
    removed: options.removed ?? null,
    stateCommitted: options.stateCommitted ?? false,
    authorityChanged: options.stateCommitted ?? false,
    artifactDeleted: options.artifactDeleted ?? false,
    orphanedDirectory: options.orphanedDirectory ?? null,
    mutation: options.mutation ?? null,
    ...(options.residualLockAuthority === undefined
      ? {}
      : { residualLockAuthority: options.residualLockAuthority }),
  };
}

function mapDisableLockFailure(
  locked: PluginStateLockFailure<PluginDisableResult>,
  operationId: string,
): PluginDisableResult {
  const completed = locked.completedValue;
  return disableFailure({
    operationId: completed?.operationId ?? operationId,
    code: locked.code,
    message: locked.message,
    details: locked.details,
    stateCommitted: completed?.stateCommitted ?? false,
    mutation: completed?.mutation ?? null,
    residualLockAuthority: locked.residual,
  });
}

function mapRemoveLockFailure(
  locked: PluginStateLockFailure<PluginRemoveResult>,
  operationId: string,
): PluginRemoveResult {
  const completed = locked.completedValue;
  return removeFailure({
    operationId: completed?.operationId ?? operationId,
    code: locked.code,
    message: locked.message,
    details: locked.details,
    removed: completed?.removed ?? null,
    stateCommitted: completed?.stateCommitted ?? false,
    artifactDeleted: completed?.artifactDeleted ?? false,
    orphanedDirectory: completed?.orphanedDirectory ?? null,
    mutation: completed?.mutation ?? null,
    residualLockAuthority: locked.residual,
  });
}

export async function disableInstalledPlugin(
  options: PluginDisableOptions,
): Promise<PluginDisableResult> {
  const home = resolve(options.explodexHome);
  const operationId = options.operationId ?? "plugin-disable";
  if (options.signal?.aborted) {
    return disableFailure({
      operationId,
      code: "operation.interrupted",
      message: "Plugin disable was interrupted before mutation.",
    });
  }
  const writeState = options.adapters?.writeState ?? savePluginsStateAtomic;
  const locked = await withPluginStateLock<PluginDisableResult>({
    explodexHome: home,
    operation: "plugin.disable",
    operationId,
    signal: options.signal,
    waitBoundMs: options.lockWaitMs,
    runtimeAdapters: options.runtimeAdapters,
    work: async () => {
      const loaded = await loadPluginsState({ explodexHome: home });
      if (loaded.status !== "valid") {
        return disableFailure({
          operationId,
          code: "plugin.disable.state-invalid",
          message:
            "Disable requires a valid authoritative plugins.json state.",
        });
      }
      const record = loaded.state.plugins[options.id];
      if (record === undefined || record.installed.length === 0) {
        return disableFailure({
          operationId,
          code: "plugin.disable.not-installed",
          message: `Plugin '${options.id}' is not installed.`,
        });
      }
      const previousIntent = copyIntent(record.enabled);
      const enabledArtifact = previousIntent === null
        ? null
        : record.installed.find((candidate) =>
            identityEquals(candidate, previousIntent)
          ) ?? null;
      const lifecycle = enabledArtifact === null
        ? null
        : await artifactLifecycle({
            home,
            id: options.id,
            artifact: enabledArtifact,
            signal: options.signal,
          });
      if (previousIntent === null) {
        return {
          ok: true,
          operationId,
          stateCommitted: false,
          authorityChanged: false,
          mutation: {
            id: options.id,
            previousIntent: null,
            currentIntent: null,
            stateCommitted: false,
            reviewStatus: record.pendingReview.length === 0
              ? "not-required"
              : "pending",
            application: mutationApplication({
              previousIntent,
              lifecycle,
              targetRequested: options.teardown !== undefined,
            }),
          },
        };
      }
      const next = cloneState(
        loaded.state,
        options.now?.() ?? new Date().toISOString(),
      );
      next.plugins[options.id]!.enabled = null;
      let stateCommitted = false;
      let stateWriteFailure: string | null = null;
      try {
        if (options.signal?.aborted) {
          return disableFailure({
            operationId,
            code: "operation.interrupted",
            message: "Plugin disable was interrupted before state commit.",
          });
        }
        await writeState({ explodexHome: home, state: next });
        stateCommitted = true;
      } catch (error: unknown) {
        stateCommitted = await committedStateMatches(home, next);
        if (!stateCommitted) {
          return disableFailure({
            operationId,
            code: "plugin.disable.state-write-failed",
            message: error instanceof Error
              ? error.message
              : "Plugin disable state commit failed.",
          });
        }
        stateWriteFailure = error instanceof Error
          ? error.message
          : "Plugin disable state commit reported a failure after rename.";
      }
      let mutation: PluginMutationResult = {
        id: options.id,
        previousIntent,
        currentIntent: null,
        stateCommitted: true,
        reviewStatus: next.plugins[options.id]!.pendingReview.length === 0
          ? "not-required"
          : "pending",
        application: mutationApplication({
          previousIntent,
          lifecycle,
          targetRequested: options.teardown !== undefined,
        }),
      };
      if (
        lifecycle === "dynamic" &&
        enabledArtifact !== null &&
        options.teardown !== undefined
      ) {
        try {
          mutation = applyTeardownResult(
            mutation,
            await options.teardown({
              id: options.id,
              identity: {
                version: enabledArtifact.version,
                payloadSha256: enabledArtifact.payloadSha256,
              },
              lifecycle: "dynamic",
            }),
          );
        } catch (error: unknown) {
          const message = error instanceof Error
            ? error.message
            : "Exact dynamic teardown failed.";
          mutation = {
            ...mutation,
            application: {
              status: "failed",
              lifecycle: "dynamic",
              target: null,
              boundary: "none",
              appliedIdentity: previousIntent,
              message,
              error: {
                code: "plugin.disable.teardown-failed",
                message,
                stage: "cleanup",
                possiblePartialEffects: true,
              },
            },
          };
        }
      }
      if (stateWriteFailure !== null) {
        return disableFailure({
          operationId,
          code: "plugin.disable.state-write-failed",
          message: stateWriteFailure,
          stateCommitted: true,
          mutation,
        });
      }
      return {
        ok: true,
        operationId,
        stateCommitted: true,
        authorityChanged: true,
        mutation,
      };
    },
  });
  return locked.ok ? locked.value : mapDisableLockFailure(locked, operationId);
}

async function assertSafeArtifactDirectory(options: {
  home: string;
  id: string;
  artifactPath: string;
}): Promise<void> {
  const pluginsRoot = resolve(options.home, "plugins");
  const idRoot = join(pluginsRoot, options.id);
  const artifactPath = resolve(options.artifactPath);
  if (
    artifactPath === idRoot ||
    !artifactPath.startsWith(`${idRoot}${sep}`)
  ) {
    throw new Error("Artifact deletion path escaped the exact plugin identity root.");
  }
  for (const path of [pluginsRoot, idRoot, artifactPath]) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Artifact deletion requires exact non-symlink directories.");
    }
  }
}

export async function removeInstalledPlugin(
  options: PluginRemoveOptions,
): Promise<PluginRemoveResult> {
  const home = resolve(options.explodexHome);
  const operationId = options.operationId ?? "plugin-remove";
  if (options.signal?.aborted) {
    return removeFailure({
      operationId,
      code: "operation.interrupted",
      message: "Plugin removal was interrupted before mutation.",
    });
  }
  const writeState = options.adapters?.writeState ?? savePluginsStateAtomic;
  const deleteArtifact = options.adapters?.deleteArtifact ??
    ((path: string) => rm(path, { recursive: true }));
  const locked = await withPluginStateLock<PluginRemoveResult>({
    explodexHome: home,
    operation: "plugin.remove",
    operationId,
    signal: options.signal,
    waitBoundMs: options.lockWaitMs,
    runtimeAdapters: options.runtimeAdapters,
    work: async () => {
      const loaded = await loadPluginsState({ explodexHome: home });
      if (loaded.status !== "valid") {
        return removeFailure({
          operationId,
          code: "plugin.remove.state-invalid",
          message:
            "Removal requires a valid authoritative plugins.json state.",
        });
      }
      const record = loaded.state.plugins[options.id];
      if (record === undefined || record.installed.length === 0) {
        return removeFailure({
          operationId,
          code: "plugin.remove.not-installed",
          message: `Plugin '${options.id}' is not installed.`,
        });
      }
      if (options.identity === undefined && record.installed.length !== 1) {
        return removeFailure({
          operationId,
          code: "plugin.remove.exact-selection-required",
          message:
            `Plugin '${options.id}' has multiple installed identities; specify exact artifact version and payload SHA-256.`,
          details: {
            installed: record.installed.map((artifact) => ({
              version: artifact.version,
              payloadSha256: artifact.payloadSha256,
            })),
          },
        });
      }
      const selected = options.identity === undefined
        ? record.installed[0]!
        : record.installed.find((candidate) =>
            identityEquals(candidate, options.identity!)
          );
      if (selected === undefined) {
        return removeFailure({
          operationId,
          code: "plugin.remove.identity-not-installed",
          message:
            `The exact requested identity for plugin '${options.id}' is not installed.`,
        });
      }
      const removed = {
        id: options.id,
        version: selected.version,
        payloadSha256: selected.payloadSha256,
      };
      const previousIntent = copyIntent(record.enabled);
      const removedWasEnabled = previousIntent !== null &&
        identityEquals(previousIntent, selected);
      const lifecycle = await artifactLifecycle({
        home,
        id: options.id,
        artifact: selected,
        signal: options.signal,
      });
      const next = cloneState(
        loaded.state,
        options.now?.() ?? new Date().toISOString(),
      );
      const nextRecord = next.plugins[options.id]!;
      nextRecord.installed = nextRecord.installed.filter((candidate) =>
        !identityEquals(candidate, selected)
      );
      nextRecord.pendingReview = nextRecord.pendingReview.filter((candidate) =>
        !identityEquals(candidate, selected)
      );
      if (removedWasEnabled) nextRecord.enabled = null;
      if (
        nextRecord.installed.length === 0 &&
        nextRecord.enabled === null &&
        nextRecord.pendingReview.length === 0
      ) {
        delete next.plugins[options.id];
      }
      let stateCommitted = false;
      let stateWriteFailure: string | null = null;
      try {
        if (options.signal?.aborted) {
          return removeFailure({
            operationId,
            code: "operation.interrupted",
            message: "Plugin removal was interrupted before state commit.",
          });
        }
        await writeState({ explodexHome: home, state: next });
        stateCommitted = true;
      } catch (error: unknown) {
        stateCommitted = await committedStateMatches(home, next);
        if (!stateCommitted) {
          return removeFailure({
            operationId,
            code: "plugin.remove.state-write-failed",
            message: error instanceof Error
              ? error.message
              : "Plugin removal state commit failed.",
            removed,
          });
        }
        stateWriteFailure = error instanceof Error
          ? error.message
          : "Plugin removal state commit reported a failure after rename.";
      }
      let mutation: PluginMutationResult = {
        id: options.id,
        previousIntent,
        currentIntent: removedWasEnabled ? null : previousIntent,
        stateCommitted: true,
        reviewStatus: next.plugins[options.id]?.pendingReview.length
          ? "pending"
          : "not-required",
        application: mutationApplication({
          previousIntent: removedWasEnabled ? previousIntent : null,
          lifecycle,
          targetRequested: options.teardown !== undefined,
        }),
      };
      if (
        removedWasEnabled &&
        lifecycle === "dynamic" &&
        options.teardown !== undefined
      ) {
        try {
          mutation = applyTeardownResult(
            mutation,
            await options.teardown({
              id: options.id,
              identity: {
                version: selected.version,
                payloadSha256: selected.payloadSha256,
              },
              lifecycle: "dynamic",
            }),
          );
        } catch (error: unknown) {
          const message = error instanceof Error
            ? error.message
            : "Exact dynamic teardown failed.";
          mutation = {
            ...mutation,
            application: {
              status: "failed",
              lifecycle: "dynamic",
              target: null,
              boundary: "none",
              appliedIdentity: previousIntent,
              message,
              error: {
                code: "plugin.remove.teardown-failed",
                message,
                stage: "cleanup",
                possiblePartialEffects: true,
              },
            },
          };
        }
      }
      const artifactPath = resolve(home, selected.relativePath);
      try {
        await assertSafeArtifactDirectory({
          home,
          id: options.id,
          artifactPath,
        });
        await deleteArtifact(artifactPath);
      } catch (error: unknown) {
        return removeFailure({
          operationId,
          code: "plugin.remove.artifact-delete-failed",
          message: error instanceof Error
            ? error.message
            : "Immutable artifact deletion failed.",
          details: { orphanedDirectory: artifactPath },
          removed,
          stateCommitted: true,
          artifactDeleted: false,
          orphanedDirectory: artifactPath,
          mutation,
        });
      }
      if (stateWriteFailure !== null) {
        return removeFailure({
          operationId,
          code: "plugin.remove.state-write-failed",
          message: stateWriteFailure,
          removed,
          stateCommitted: true,
          artifactDeleted: true,
          mutation,
        });
      }
      return {
        ok: true,
        operationId,
        removed,
        stateCommitted: true,
        authorityChanged: true,
        artifactDeleted: true,
        orphanedDirectory: null,
        mutation,
      };
    },
  });
  return locked.ok ? locked.value : mapRemoveLockFailure(locked, operationId);
}

export type {
  PluginDisableOptions,
  PluginDisableResult,
  PluginMutationAdapters,
  PluginMutationIdentity,
  PluginRemoveOptions,
  PluginRemoveResult,
  PluginTeardownRequest,
  PluginTeardownResult,
} from "./mutation-types.ts";
