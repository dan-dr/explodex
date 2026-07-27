import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateInstallablePayloadDir,
  type StandaloneArtifactSuccess,
} from "../plugin/artifact-validate.ts";
import {
  captureExactPayloadSnapshot,
  type PluginPayloadSnapshot,
} from "../plugin/approval-transaction.ts";
import { extractNamedRootArchive } from "../plugin/archive.ts";

export type EphemeralPluginArtifactResult =
  | {
      ok: true;
      validation: StandaloneArtifactSuccess;
      snapshot: PluginPayloadSnapshot;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolvePayloadDirectory(path: string): Promise<
  | { ok: true; path: string; archiveRootName: string | null }
  | { ok: false; message: string }
> {
  if (!(await isDirectory(path))) {
    return { ok: false, message: "Artifact path is not a payload directory." };
  }
  try {
    const pluginJson = await stat(join(path, "plugin.json"));
    if (pluginJson.isFile()) {
      return { ok: true, path, archiveRootName: null };
    }
  } catch {
    // Continue with the named-root directory form.
  }
  const children = await readdir(path, { withFileTypes: true });
  if (
    children.length !== 1 ||
    !children[0]!.isDirectory() ||
    children[0]!.isSymbolicLink()
  ) {
    return {
      ok: false,
      message:
        "Artifact directory must be a payload or contain one named payload root.",
    };
  }
  return {
    ok: true,
    path: join(path, children[0]!.name),
    archiveRootName: children[0]!.name,
  };
}

async function capturePayload(options: {
  payloadPath: string;
  archiveSha256: string | null;
  archiveRootName: string | null;
  source: "directory" | "archive";
  signal?: AbortSignal;
}): Promise<EphemeralPluginArtifactResult> {
  const validation = await validateInstallablePayloadDir(
    options.payloadPath,
    {
      archiveSha256: options.archiveSha256,
      archiveRootName: options.archiveRootName,
      source: options.source,
    },
  );
  if (!validation.ok) return validation;
  const captured = await captureExactPayloadSnapshot({
    artifactPath: options.payloadPath,
    identity: {
      id: validation.id,
      version: validation.version,
      payloadSha256: validation.payloadSha256,
    },
    signal: options.signal,
    readSnapshotFile: async (path) =>
      new Uint8Array(await readFile(path, { signal: options.signal })),
  });
  if (!captured.ok) {
    return {
      ok: false,
      code: options.signal?.aborted
        ? "operation.interrupted"
        : "plugin.artifact.invalid",
      message: captured.message,
      details: captured.details,
    };
  }
  return {
    ok: true,
    validation,
    snapshot: captured.snapshot,
  };
}

export async function captureEphemeralPluginArtifact(options: {
  artifactPath: string;
  signal?: AbortSignal;
}): Promise<EphemeralPluginArtifactResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "operation.interrupted",
      message: "Ephemeral artifact capture was interrupted.",
    };
  }
  const artifactPath = resolve(options.artifactPath);
  if (await isDirectory(artifactPath)) {
    const payload = await resolvePayloadDirectory(artifactPath);
    if (!payload.ok) {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: payload.message,
      };
    }
    return capturePayload({
      payloadPath: payload.path,
      archiveSha256: null,
      archiveRootName: payload.archiveRootName,
      source: "directory",
      signal: options.signal,
    });
  }

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = new Uint8Array(
      await readFile(artifactPath, { signal: options.signal }),
    );
  } catch (error: unknown) {
    return {
      ok: false,
      code: options.signal?.aborted
        ? "operation.interrupted"
        : "plugin.artifact.invalid",
      message: options.signal?.aborted
        ? "Ephemeral artifact capture was interrupted."
        : error instanceof Error
          ? error.message
          : "Artifact path is unreadable.",
    };
  }
  const extracted = extractNamedRootArchive(Buffer.from(archiveBytes));
  if (!extracted.ok) return extracted;
  const tempRoot = await mkdtemp(join(tmpdir(), "explodex-dev-artifact-"));
  const payloadPath = join(tempRoot, "payload");
  try {
    for (const [relativePath, bytes] of extracted.extracted.files) {
      if (options.signal?.aborted) {
        return {
          ok: false,
          code: "operation.interrupted",
          message: "Ephemeral artifact capture was interrupted.",
        };
      }
      const destination = join(payloadPath, ...relativePath.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, bytes, { signal: options.signal });
    }
    return await capturePayload({
      payloadPath,
      archiveSha256: extracted.extracted.archiveSha256,
      archiveRootName: extracted.extracted.archiveRootName,
      source: "archive",
      signal: options.signal,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
