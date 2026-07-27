import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";
import { ingestLocalPluginArchive, type PluginIngestionAdapters } from "./installer.ts";
import {
  loadArtifactProvenance,
  saveArtifactProvenanceOnce,
} from "./install-provenance.ts";
import {
  createEmptyPluginsState,
  loadPluginsState,
  safeLocalArtifactSource,
  savePluginsStateAtomic,
  sourceLabel,
  type ArtifactSource,
  type InstalledArtifact,
  type PluginsState,
} from "./install-state.ts";

export type PluginInstallAdapters = PluginIngestionAdapters & {
  writeState?(options: { explodexHome: string; state: PluginsState }): Promise<void>;
  saveProvenance?(options: Parameters<typeof saveArtifactProvenanceOnce>[0]): Promise<void>;
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
  artifactPath?: string;
};

export type PluginInstallResult = PluginInstallSuccess | PluginInstallFailure;

function failure(
  code: string,
  message: string,
  options: {
    details?: Record<string, unknown>;
    artifactCommitted?: boolean;
    artifactPath?: string;
  } = {},
): PluginInstallFailure {
  return {
    ok: false,
    code,
    message,
    ...(options.details === undefined ? {} : { details: options.details }),
    artifactCommitted: options.artifactCommitted ?? false,
    ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
  };
}

function identityEquals(
  left: { version: string; payloadSha256: string },
  right: { version: string; payloadSha256: string },
): boolean {
  return left.version === right.version && left.payloadSha256 === right.payloadSha256;
}

function cloneState(state: PluginsState): PluginsState {
  return structuredClone(state);
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

function mergeInstalledState(options: {
  prior: PluginsState;
  id: string;
  artifact: InstalledArtifact;
  now: string;
}): PluginsState {
  const next = cloneState(options.prior);
  const record = next.plugins[options.id] ?? {
    installed: [],
    enabled: null,
    pendingReview: [],
  };
  if (!record.installed.some((item) => identityEquals(item, options.artifact))) {
    record.installed.push(options.artifact);
  }
  const identity = {
    version: options.artifact.version,
    payloadSha256: options.artifact.payloadSha256,
  };
  if (!record.pendingReview.some((item) => identityEquals(item, identity)) &&
    !identityEquals(record.enabled ?? { version: "", payloadSha256: "" }, identity)) {
    record.pendingReview.push(identity);
  }
  record.installed.sort((left, right) => left.version < right.version ? -1 :
    left.version > right.version ? 1 : left.payloadSha256.localeCompare(right.payloadSha256));
  record.pendingReview.sort((left, right) => left.version < right.version ? -1 :
    left.version > right.version ? 1 : left.payloadSha256.localeCompare(right.payloadSha256));
  next.plugins[options.id] = record;
  next.updatedAt = options.now;
  return next;
}

export async function installLocalPluginArchive(options: {
  archivePath: string;
  explodexHome: string;
  signal?: AbortSignal;
  adapters?: PluginInstallAdapters;
  now?: () => string;
}): Promise<PluginInstallResult> {
  const home = resolve(options.explodexHome);
  const genericStaging = join(home, "plugins", ".staging");
  const ingested = await ingestLocalPluginArchive({
    archivePath: options.archivePath,
    stagingParent: genericStaging,
    signal: options.signal,
    adapters: options.adapters,
  });
  if (!ingested.ok) {
    return failure(ingested.code, ingested.message, { details: ingested.details });
  }

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
    if (destinationKind === "missing") {
      await options.adapters?.beforeCommit?.();
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

    const loaded = await loadPluginsState({ explodexHome: home });
    if (loaded.status === "malformed") {
      return failure("plugin.state.invalid", "Existing plugins.json is malformed or unsupported; refusing to import consent or overwrite state.", {
        artifactCommitted,
        artifactPath: finalPath,
      });
    }
    const now = options.now?.() ?? new Date().toISOString();
    const prior = loaded.status === "valid" ? loaded.state : createEmptyPluginsState(now);
    const existingRecord = prior.plugins[ingested.id];
    const existingArtifact = existingRecord?.installed.find((item) => identityEquals(item, ingested));
    const persistedProvenance = await loadArtifactProvenance({
      explodexHome: home,
      id: ingested.id,
      installedDirectoryName: encoded.installedDirectoryName,
    });
    const source = existingArtifact?.source ?? persistedProvenance?.source ??
      safeLocalArtifactSource(options.archivePath);
    const provenanceArchiveSha256 = existingArtifact?.archiveSha256 ??
      persistedProvenance?.archiveSha256 ?? ingested.archiveSha256;
    const installedAt = existingArtifact?.installedAt ?? persistedProvenance?.installedAt ?? now;
    if (persistedProvenance === null) {
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
    const alreadyRecorded = existingArtifact !== undefined;
    if (!alreadyRecorded) {
      const installedArtifact: InstalledArtifact = {
        version: ingested.version,
        payloadSha256: ingested.payloadSha256,
        archiveSha256: provenanceArchiveSha256,
        relativePath,
        source,
        installedAt,
      };
      const next = mergeInstalledState({ prior, id: ingested.id, artifact: installedArtifact, now });
      try {
        await options.adapters?.beforeStateMutation?.();
        await (options.adapters?.writeState ?? savePluginsStateAtomic)({
          explodexHome: home,
          state: next,
        });
      } catch (error: unknown) {
        return failure("plugin.state.write-failed", error instanceof Error ? error.message : "Plugin state commit failed.", {
          artifactCommitted,
          artifactPath: finalPath,
        });
      }
    }

    const effectiveRecord = alreadyRecorded
      ? existingRecord
      : mergeInstalledState({
          prior,
          id: ingested.id,
          artifact: {
            version: ingested.version,
            payloadSha256: ingested.payloadSha256,
            archiveSha256: provenanceArchiveSha256,
            relativePath,
            source,
            installedAt,
          },
          now,
        }).plugins[ingested.id];
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
      stateCommitted: !alreadyRecorded,
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
