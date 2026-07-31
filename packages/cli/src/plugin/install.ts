import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { ResidualLockAuthority } from "../runtime/locks.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import { reconcileInstalledPluginsUnlocked } from "./discovery.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";
import {
  ingestLocalPluginArchive,
  ingestRemotePluginArchive,
  type ExpectedPluginIdentity,
  type PluginIngestionAdapters,
  type PluginIngestionResult,
} from "./installer.ts";
import {
  loadArtifactProvenance,
  saveArtifactProvenanceOnce,
} from "./install-provenance.ts";
import {
  loadPluginsState,
  safeLocalArtifactSource,
  sourceLabel,
  type ArtifactSource,
  type PluginsState,
} from "./install-state.ts";
import { withPluginStateLock } from "./state-lock.ts";

export type PluginInstallAdapters = PluginIngestionAdapters & {
  writeState?(options: { explodexHome: string; state: PluginsState }): Promise<void>;
  saveProvenance?(options: Parameters<typeof saveArtifactProvenanceOnce>[0]): Promise<void>;
  runtimeAdapters?: RuntimeAdapters;
};

export type PluginInstallOutcome = "installed" | "already-installed" | "rediscovered";

export type PluginInstallSuccess = {
  ok: true;
  id: string;
  version: string;
  displayName: string;
  description: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  sdkRange: string;
  payloadSha256: string;
  archiveSha256: string;
  archiveRootName: string;
  files: readonly string[];
  artifactPath: string;
  relativePath: string;
  source: ArtifactSource;
  sourceLabel: string;
  outcome: PluginInstallOutcome;
  artifactCommitted: boolean;
  stateCommitted: boolean;
  activationChanged: false;
  enabled: boolean;
  pendingReview: boolean;
};

export type PluginInstallFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  artifactCommitted: boolean;
  stateCommitted?: boolean;
  artifactPath?: string;
  residualLockAuthority?: ResidualLockAuthority;
  completedMutation?: {
    id?: string;
    version?: string;
    payloadSha256?: string;
    outcome?: PluginInstallOutcome;
    artifactCommitted: boolean;
    stateCommitted: boolean;
  };
};

export type PluginInstallResult = PluginInstallSuccess | PluginInstallFailure;

function failure(
  code: string,
  message: string,
  options: {
    details?: Record<string, unknown>;
    artifactCommitted?: boolean;
    stateCommitted?: boolean;
    artifactPath?: string;
    residualLockAuthority?: ResidualLockAuthority;
    completedMutation?: PluginInstallFailure["completedMutation"];
  } = {},
): PluginInstallFailure {
  return {
    ok: false,
    code,
    message,
    ...(options.details === undefined ? {} : { details: options.details }),
    artifactCommitted: options.artifactCommitted ?? false,
    ...(options.stateCommitted === undefined
      ? {}
      : { stateCommitted: options.stateCommitted }),
    ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
    ...(options.residualLockAuthority === undefined
      ? {}
      : { residualLockAuthority: options.residualLockAuthority }),
    ...(options.completedMutation === undefined
      ? {}
      : { completedMutation: options.completedMutation }),
  };
}

function interruptedFailure(options: {
  artifactCommitted?: boolean;
  artifactPath?: string;
} = {}): PluginInstallFailure {
  return failure(
    "operation.interrupted",
    "Plugin installation was interrupted before the next mutation boundary.",
    options,
  );
}

function identityEquals(
  left: { version: string; payloadSha256: string },
  right: { version: string; payloadSha256: string },
): boolean {
  return left.version === right.version && left.payloadSha256 === right.payloadSha256;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

async function pathKind(path: string): Promise<"missing" | "directory" | "other"> {
  try {
    const value = await stat(path);
    return value.isDirectory() ? "directory" : "other";
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle = null as Awaited<ReturnType<typeof open>> | null;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncTree(root: string, files: readonly string[]): Promise<void> {
  for (const relativePath of files) {
    const handle = await open(join(root, ...relativePath.split("/")), constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const directories = new Set<string>([root]);
  for (const file of files) {
    let current = dirname(join(root, ...file.split("/")));
    while (current.startsWith(root) && current !== root) {
      directories.add(current);
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
}

async function installPluginArchiveLocked(options: {
  explodexHome: string;
  ingest(): Promise<PluginIngestionResult>;
  source: ArtifactSource;
  signal?: AbortSignal;
  adapters?: PluginInstallAdapters;
  now?: () => string;
}): Promise<PluginInstallResult> {
  const home = resolve(options.explodexHome);
  const ingested = await options.ingest();
  if (!ingested.ok) {
    return failure(ingested.code, ingested.message, { details: ingested.details });
  }
  if (options.signal?.aborted) return interruptedFailure();

  const encoded = encodeArtifactIdentity({
    id: ingested.id,
    version: ingested.version,
    payloadSha256: ingested.payloadSha256,
  });
  const pluginRoot = join(home, "plugins", ingested.id);
  const finalPath = join(pluginRoot, encoded.installedDirectoryName);
  const relativePath = relative(home, finalPath).split("\\").join("/");
  let perIdStaging: string | null = null;
  let artifactCommitted = false;
  let publishedNow = false;
  try {
    if (options.signal?.aborted) return interruptedFailure();
    await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
    await chmod(pluginRoot, 0o700);
    perIdStaging = join(pluginRoot, `.install-${process.pid}-${randomBytes(8).toString("hex")}`);
    await rename(ingested.payloadDirectory, perIdStaging);
    await syncTree(perIdStaging, ingested.files);

    const destinationKind = await pathKind(finalPath);
    if (destinationKind === "other") {
      return failure("plugin.install.identity-conflict", "Immutable plugin destination is not a directory.", {
        artifactPath: finalPath,
      });
    }
    if (destinationKind === "directory") {
      const existing = await validateInstallablePayloadDir(finalPath, {
        source: "directory",
        expectedIdentity: {
          id: ingested.id,
          version: ingested.version,
          payloadSha256: ingested.payloadSha256,
        },
      });
      if (!existing.ok) {
        return failure("plugin.install.identity-conflict", "Existing immutable plugin destination does not match the exact payload identity.", {
          details: { validationCode: existing.code },
          artifactPath: finalPath,
        });
      }
    }

    const loaded = await loadPluginsState({ explodexHome: home });
    const now = options.now?.() ?? new Date().toISOString();
    const existingRecord = loaded.status === "valid"
      ? loaded.state.plugins[ingested.id]
      : undefined;
    const existingArtifact = existingRecord?.installed.find((item) => identityEquals(item, ingested));
    const persistedProvenance = await loadArtifactProvenance({
      explodexHome: home,
      id: ingested.id,
      installedDirectoryName: encoded.installedDirectoryName,
    });
    const source = existingArtifact?.source ?? persistedProvenance?.source ?? options.source;
    const provenanceArchiveSha256 = existingArtifact?.archiveSha256 ??
      persistedProvenance?.archiveSha256 ?? ingested.archiveSha256;
    const installedAt = existingArtifact?.installedAt ?? persistedProvenance?.installedAt ?? now;
    if (persistedProvenance === null) {
      if (options.signal?.aborted) return interruptedFailure();
      try {
        await (options.adapters?.saveProvenance ?? saveArtifactProvenanceOnce)({
          explodexHome: home,
          record: {
            schemaVersion: 1,
            id: ingested.id,
            version: ingested.version,
            payloadSha256: ingested.payloadSha256,
            archiveSha256: provenanceArchiveSha256,
            installedDirectoryName: encoded.installedDirectoryName,
            source,
            installedAt,
          },
        });
      } catch (error: unknown) {
        return failure("plugin.install.provenance-failed", error instanceof Error ? error.message : "Artifact provenance commit failed.", {
          artifactCommitted,
          artifactPath: finalPath,
        });
      }
    }

    if (destinationKind === "missing") {
      if (options.signal?.aborted) return interruptedFailure();
      await options.adapters?.beforeCommit?.();
      if (options.signal?.aborted) return interruptedFailure();
      try {
        await rename(perIdStaging, finalPath);
        perIdStaging = null;
        publishedNow = true;
        artifactCommitted = true;
        await syncDirectory(pluginRoot);
      } catch (error: unknown) {
        const racedKind = await pathKind(finalPath);
        if (racedKind !== "directory") {
          throw error;
        }
      }
    }

    const committed = await validateInstallablePayloadDir(finalPath, {
      source: "directory",
      expectedIdentity: {
        id: ingested.id,
        version: ingested.version,
        payloadSha256: ingested.payloadSha256,
      },
    });
    if (!committed.ok) {
      return failure("plugin.install.identity-conflict", "Existing immutable plugin destination does not match the exact payload identity.", {
        details: { validationCode: committed.code },
        artifactCommitted: publishedNow,
        artifactPath: finalPath,
      });
    }
    artifactCommitted = true;

    const alreadyRecorded = existingArtifact !== undefined;
    if (options.signal?.aborted) {
      return interruptedFailure({ artifactCommitted, artifactPath: finalPath });
    }
    const discovery = await reconcileInstalledPluginsUnlocked({
      explodexHome: home,
      trigger: "install",
      now: () => now,
      signal: options.signal,
      beforeStateMutation: options.adapters?.beforeStateMutation,
      writeState: options.adapters?.writeState,
    });
    if (!discovery.ok) {
      return failure(discovery.code, discovery.message, {
        details: discovery.details,
        artifactCommitted,
        artifactPath: finalPath,
      });
    }
    const effectiveRecord = discovery.state.plugins[ingested.id];
    const enabled = effectiveRecord?.enabled !== null && effectiveRecord?.enabled !== undefined &&
      identityEquals(effectiveRecord.enabled, ingested);
    const pendingReview = effectiveRecord?.pendingReview.some((item) => identityEquals(item, ingested)) ?? false;

    return {
      ok: true,
      id: ingested.id,
      version: ingested.version,
      displayName: ingested.displayName,
      description: ingested.description,
      lifecycle: ingested.lifecycle,
      sdkRange: ingested.sdkRange,
      payloadSha256: ingested.payloadSha256,
      archiveSha256: ingested.archiveSha256,
      archiveRootName: ingested.archiveRootName,
      files: ingested.files,
      artifactPath: finalPath,
      relativePath,
      source,
      sourceLabel: sourceLabel(source),
      outcome: alreadyRecorded ? "already-installed" : publishedNow ? "installed" : "rediscovered",
      artifactCommitted,
      stateCommitted: discovery.stateChanged,
      activationChanged: false,
      enabled,
      pendingReview,
    };
  } catch (error: unknown) {
    return failure("plugin.install.commit-failed", error instanceof Error ? error.message : "Immutable plugin commit failed.", {
      artifactCommitted,
      artifactPath: finalPath,
    });
  } finally {
    if (perIdStaging !== null) {
      await rm(perIdStaging, { recursive: true, force: true }).catch(() => undefined);
    }
    await ingested.cleanup().catch(() => undefined);
  }
}

export async function installLocalPluginArchive(options: {
  archivePath: string;
  explodexHome: string;
  signal?: AbortSignal;
  adapters?: PluginInstallAdapters;
  now?: () => string;
  lockWaitMs?: number;
  operationId?: string;
}): Promise<PluginInstallResult> {
  const home = resolve(options.explodexHome);
  return installPluginArchiveWithLock({
    explodexHome: home,
    signal: options.signal,
    adapters: options.adapters,
    now: options.now,
    lockWaitMs: options.lockWaitMs,
    operationId: options.operationId,
    source: safeLocalArtifactSource(options.archivePath),
    ingest: () => ingestLocalPluginArchive({
      archivePath: options.archivePath,
      stagingParent: join(home, "plugins", ".staging"),
      signal: options.signal,
      adapters: options.adapters,
    }),
  });
}

export async function installRemotePluginArchive(options: {
  archiveBytes: Buffer;
  expectedArchiveSha256: string;
  expectedIdentity?: ExpectedPluginIdentity;
  source: Exclude<ArtifactSource, { kind: "local" }>;
  explodexHome: string;
  signal?: AbortSignal;
  adapters?: PluginInstallAdapters;
  now?: () => string;
  lockWaitMs?: number;
  operationId?: string;
}): Promise<PluginInstallResult> {
  const home = resolve(options.explodexHome);
  return installPluginArchiveWithLock({
    explodexHome: home,
    signal: options.signal,
    adapters: options.adapters,
    now: options.now,
    lockWaitMs: options.lockWaitMs,
    operationId: options.operationId,
    source: options.source,
    ingest: () => ingestRemotePluginArchive({
      archiveBytes: options.archiveBytes,
      expectedArchiveSha256: options.expectedArchiveSha256,
      expectedIdentity: options.expectedIdentity,
      stagingParent: join(home, "plugins", ".staging"),
      signal: options.signal,
      adapters: options.adapters,
    }),
  });
}

async function installPluginArchiveWithLock(options: {
  explodexHome: string;
  ingest(): Promise<PluginIngestionResult>;
  source: ArtifactSource;
  signal?: AbortSignal;
  adapters?: PluginInstallAdapters;
  now?: () => string;
  lockWaitMs?: number;
  operationId?: string;
}): Promise<PluginInstallResult> {
  const locked = await withPluginStateLock({
    explodexHome: options.explodexHome,
    operation: "plugin.install",
    signal: options.signal,
    waitBoundMs: options.lockWaitMs,
    runtimeAdapters: options.adapters?.runtimeAdapters,
    operationId: options.operationId,
    work: () => installPluginArchiveLocked(options),
  });
  if (!locked.ok) {
    const completed = locked.completedValue;
    const completedMutation = completed === undefined
      ? undefined
      : {
          ...(completed.ok
            ? {
                id: completed.id,
                version: completed.version,
                payloadSha256: completed.payloadSha256,
                outcome: completed.outcome,
              }
            : {}),
          artifactCommitted: completed.artifactCommitted,
          stateCommitted: completed.ok
            ? completed.stateCommitted
            : completed.stateCommitted ?? false,
        };
    return failure(locked.code, locked.message, {
      details: locked.details,
      artifactCommitted: completedMutation?.artifactCommitted,
      stateCommitted: completedMutation?.stateCommitted,
      ...(completed?.ok === true ? { artifactPath: completed.artifactPath } : {}),
      residualLockAuthority: locked.residual,
      completedMutation,
    });
  }
  return locked.value;
}
