import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { PluginPayloadIdentity } from "./approval-transaction.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";
import { ingestRemotePluginArchive } from "./installer.ts";
import { saveArtifactProvenanceOnce } from "./install-provenance.ts";
import type {
  InstalledArtifact,
  PluginsState,
} from "./install-state.ts";
import {
  installedUpdateArtifact,
  type PluginUpdateRecommendation,
} from "./update-recommendation.ts";

export type PluginUpdateAdapters = {
  beforeDownload?(recommendation: PluginUpdateRecommendation): void | Promise<void>;
  afterDownload?(recommendation: PluginUpdateRecommendation): void | Promise<void>;
  beforeArtifactCommit?(identity: PluginPayloadIdentity): void | Promise<void>;
  beforeStateCommit?(): void | Promise<void>;
  afterStateCommitBeforeSnapshot?(): void | Promise<void>;
  afterSnapshot?(): void | Promise<void>;
  readSnapshotFile?(path: string): Promise<Uint8Array>;
  writeState?(options: {
    explodexHome: string;
    state: PluginsState;
  }): Promise<void>;
  saveProvenance?(options: Parameters<typeof saveArtifactProvenanceOnce>[0]): Promise<void>;
};

export type PreparedUpdateArtifact = {
  identity: PluginPayloadIdentity;
  installed: InstalledArtifact;
  artifactPath: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  downloaded: boolean;
  committedNow: boolean;
};

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
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
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncTree(root: string, files: readonly string[]): Promise<void> {
  for (const relativePath of files) {
    const handle = await open(
      join(root, ...relativePath.split("/")),
      constants.O_RDONLY,
    );
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
  for (
    const directory of [...directories].sort((left, right) =>
      right.length - left.length
    )
  ) {
    await syncDirectory(directory);
  }
}

export async function prepareRecommendationArtifact(options: {
  home: string;
  state: PluginsState;
  recommendation: PluginUpdateRecommendation;
  signal?: AbortSignal;
  now: string;
  fetchArchive(
    recommendation: PluginUpdateRecommendation,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  adapters?: PluginUpdateAdapters;
}): Promise<
  | { ok: true; value: PreparedUpdateArtifact }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      downloaded: boolean;
      committedNow: boolean;
    }
> {
  const identity = {
    id: options.recommendation.artifact.id,
    version: options.recommendation.artifact.version,
    payloadSha256: options.recommendation.artifact.payloadSha256,
  };
  const existing = installedUpdateArtifact(options.state, identity);
  if (existing !== undefined) {
    const artifactPath = resolve(options.home, existing.relativePath);
    const validated = await validateInstallablePayloadDir(artifactPath, {
      source: "directory",
      signal: options.signal,
      expectedIdentity: identity,
    });
    if (!validated.ok) {
      return {
        ok: false,
        code: "plugin.update.installed-invalid",
        message: validated.message,
        details: { identity, artifactCode: validated.code },
        downloaded: false,
        committedNow: false,
      };
    }
    return {
      ok: true,
      value: {
        identity,
        installed: existing,
        artifactPath,
        lifecycle: validated.lifecycle,
        downloaded: false,
        committedNow: false,
      },
    };
  }

  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "operation.interrupted",
      message: "Plugin update was interrupted before download.",
      downloaded: false,
      committedNow: false,
    };
  }
  await options.adapters?.beforeDownload?.(options.recommendation);
  let downloadedBytes: Uint8Array;
  try {
    downloadedBytes = await options.fetchArchive(
      options.recommendation,
      options.signal,
    );
  } catch (error: unknown) {
    return {
      ok: false,
      code: options.signal?.aborted
        ? "operation.interrupted"
        : "plugin.update.download-failed",
      message: options.signal?.aborted
        ? "Plugin update was interrupted during download."
        : error instanceof Error
          ? error.message
          : "Plugin update archive download failed.",
      downloaded: false,
      committedNow: false,
    };
  }
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "operation.interrupted",
      message: "Plugin update was interrupted after download.",
      downloaded: true,
      committedNow: false,
    };
  }
  await options.adapters?.afterDownload?.(options.recommendation);
  const stagingParent = join(options.home, "plugins", ".staging");
  const ingested = await ingestRemotePluginArchive({
    archiveBytes: Buffer.from(downloadedBytes),
    expectedArchiveSha256: options.recommendation.archiveSha256,
    stagingParent,
    expectedIdentity: identity,
    signal: options.signal,
  });
  if (!ingested.ok) {
    return {
      ok: false,
      code: ingested.code,
      message: ingested.message,
      details: ingested.details,
      downloaded: true,
      committedNow: false,
    };
  }

  const encoded = encodeArtifactIdentity(identity);
  const pluginRoot = join(options.home, "plugins", identity.id);
  const finalPath = join(pluginRoot, encoded.installedDirectoryName);
  const relativePath = relative(options.home, finalPath).split("\\").join("/");
  let stagingPath: string | null = null;
  let committedNow = false;
  try {
    await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
    await chmod(pluginRoot, 0o700);
    stagingPath = join(
      pluginRoot,
      `.update-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    await rename(ingested.payloadDirectory, stagingPath);
    await syncTree(stagingPath, ingested.files);
    const destination = await pathKind(finalPath);
    if (destination === "other") {
      return {
        ok: false,
        code: "plugin.update.identity-conflict",
        message: "Immutable update destination is not a directory.",
        downloaded: true,
        committedNow: false,
      };
    }
    if (destination === "directory") {
      const winner = await validateInstallablePayloadDir(finalPath, {
        source: "directory",
        expectedIdentity: identity,
      });
      if (!winner.ok) {
        return {
          ok: false,
          code: "plugin.update.identity-conflict",
          message:
            "Existing immutable update destination does not match the exact selected identity.",
          details: { artifactCode: winner.code },
          downloaded: true,
          committedNow: false,
        };
      }
    } else {
      await (options.adapters?.saveProvenance ?? saveArtifactProvenanceOnce)({
        explodexHome: options.home,
        record: {
          schemaVersion: 1,
          ...identity,
          archiveSha256: options.recommendation.archiveSha256,
          installedDirectoryName: encoded.installedDirectoryName,
          source: options.recommendation.source,
          installedAt: options.now,
        },
      });
      if (options.signal?.aborted) {
        return {
          ok: false,
          code: "operation.interrupted",
          message: "Plugin update was interrupted before artifact commit.",
          downloaded: true,
          committedNow: false,
        };
      }
      await options.adapters?.beforeArtifactCommit?.(identity);
      if (options.signal?.aborted) {
        return {
          ok: false,
          code: "operation.interrupted",
          message: "Plugin update was interrupted before artifact commit.",
          downloaded: true,
          committedNow: false,
        };
      }
      await rename(stagingPath, finalPath);
      stagingPath = null;
      committedNow = true;
      await syncDirectory(pluginRoot);
    }
    const committed = await validateInstallablePayloadDir(finalPath, {
      source: "directory",
      expectedIdentity: identity,
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: "plugin.update.identity-conflict",
        message:
          "Committed immutable update artifact failed exact validation.",
        details: { artifactCode: committed.code },
        downloaded: true,
        committedNow,
      };
    }
    return {
      ok: true,
      value: {
        identity,
        installed: {
          version: identity.version,
          payloadSha256: identity.payloadSha256,
          archiveSha256: options.recommendation.archiveSha256,
          relativePath,
          source: options.recommendation.source,
          installedAt: options.now,
        },
        artifactPath: finalPath,
        lifecycle: committed.lifecycle,
        downloaded: true,
        committedNow,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      code: "plugin.update.install-failed",
      message: error instanceof Error
        ? error.message
        : "Plugin update artifact installation failed.",
      downloaded: true,
      committedNow,
    };
  } finally {
    if (stagingPath !== null) {
      await rm(stagingPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    await ingested.cleanup().catch(() => undefined);
  }
}
