import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  computeArchiveSha256,
  extractNamedRootArchive,
  type ExtractedPluginArchive,
} from "./archive.ts";
import {
  validateInstallablePayloadDir,
  type StandaloneArtifactFailure,
} from "./artifact-validate.ts";

export type PluginIngestionAdapters = {
  beforeExtract?(): Promise<void> | void;
  beforeCommit?(): Promise<void> | void;
  beforeStateMutation?(): Promise<void> | void;
  beforeRendererEvaluation?(): Promise<void> | void;
  beforeAssetDelivery?(): Promise<void> | void;
};

export type ExpectedPluginIdentity = {
  id?: string;
  version?: string;
  payloadSha256?: string;
};

export type PluginIngestionFailure = StandaloneArtifactFailure;

export type PluginIngestionSuccess = {
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
  registrationCount: 1;
  payloadDirectory: string;
  cleanup(): Promise<void>;
};

export type PluginIngestionResult = PluginIngestionSuccess | PluginIngestionFailure;

function fail(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): PluginIngestionFailure {
  return { ok: false, code, message, details };
}

function isArchivePath(path: string): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function interrupted(signal: AbortSignal | undefined): PluginIngestionFailure | null {
  if (signal?.aborted !== true) return null;
  return fail("operation.interrupted", "Plugin archive ingestion was interrupted.");
}

async function materializeExtractedArchive(options: {
  extracted: ExtractedPluginArchive;
  stagingParent: string;
  expectedIdentity?: ExpectedPluginIdentity;
  signal?: AbortSignal;
}): Promise<PluginIngestionResult> {
  const parent = resolve(options.stagingParent);
  let privateRoot: string | null = null;
  let payloadDirectory: string | null = null;
  let retained = false;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    privateRoot = await mkdtemp(join(parent, ".explodex-ingest-"));
    await chmod(privateRoot, 0o700);
    payloadDirectory = join(privateRoot, "payload");
    const aborted = interrupted(options.signal);
    if (aborted !== null) return aborted;
    await mkdir(payloadDirectory, { recursive: true, mode: 0o700 });
    for (const [relativePath, bytes] of options.extracted.files) {
      const destination = join(payloadDirectory, ...relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600 });
      const afterWriteAbort = interrupted(options.signal);
      if (afterWriteAbort !== null) return afterWriteAbort;
    }

    const validated = await validateInstallablePayloadDir(payloadDirectory, {
      archiveSha256: options.extracted.archiveSha256,
      archiveRootName: options.extracted.archiveRootName,
      source: "archive",
      expectedIdentity: options.expectedIdentity,
    });
    if (!validated.ok) return validated;
    if (validated.archiveSha256 === null || validated.archiveRootName === null) {
      return fail("plugin.artifact.invalid", "Archive validation lost archive identity.");
    }

    if (privateRoot === null || payloadDirectory === null) {
      return fail("plugin.install.precommit-failed", "Private staging was not initialized.");
    }
    retained = true;
    const retainedRoot = privateRoot;
    const retainedPayloadDirectory = payloadDirectory;
    let cleaned = false;
    return {
      ok: true,
      id: validated.id,
      version: validated.version,
      displayName: validated.displayName,
      description: validated.description,
      lifecycle: validated.lifecycle,
      sdkRange: validated.sdkRange,
      payloadSha256: validated.payloadSha256,
      archiveSha256: validated.archiveSha256,
      archiveRootName: validated.archiveRootName,
      files: validated.files,
      registrationCount: 1,
      payloadDirectory: retainedPayloadDirectory,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(retainedRoot, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    return fail(
      "plugin.install.precommit-failed",
      error instanceof Error ? error.message : "Plugin archive precommit validation failed.",
    );
  } finally {
    if (!retained && privateRoot !== null) {
      await rm(privateRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function ingestVerifiedArchiveBytes(options: {
  archiveBytes: Buffer;
  stagingParent: string;
  expectedIdentity?: ExpectedPluginIdentity;
  signal?: AbortSignal;
  adapters?: PluginIngestionAdapters;
}): Promise<PluginIngestionResult> {
  const aborted = interrupted(options.signal);
  if (aborted !== null) return aborted;
  await options.adapters?.beforeExtract?.();
  const extracted = extractNamedRootArchive(options.archiveBytes);
  if (!extracted.ok) return extracted;
  return materializeExtractedArchive({
    extracted: extracted.extracted,
    stagingParent: options.stagingParent,
    expectedIdentity: options.expectedIdentity,
    signal: options.signal,
  });
}

/**
 * Local archives have no independent transport trust anchor. The digest is
 * computed and returned, while every payload check remains source-free.
 */
export async function ingestLocalPluginArchive(options: {
  archivePath: string;
  stagingParent: string;
  expectedIdentity?: ExpectedPluginIdentity;
  signal?: AbortSignal;
  adapters?: PluginIngestionAdapters;
}): Promise<PluginIngestionResult> {
  const rawPath = options.archivePath;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(rawPath) || !isArchivePath(rawPath)) {
    return fail(
      "plugin.install.archive-required",
      "Plugin install accepts only a prebuilt .tar.gz or .tgz archive.",
      { input: basename(rawPath) },
    );
  }
  const absolute = resolve(rawPath);
  let archiveBytes: Buffer;
  try {
    archiveBytes = await readFile(absolute);
  } catch {
    return fail(
      "plugin.install.archive-required",
      "Plugin install requires a readable prebuilt archive file.",
      { input: basename(absolute) },
    );
  }
  return ingestVerifiedArchiveBytes({
    archiveBytes,
    stagingParent: options.stagingParent,
    expectedIdentity: options.expectedIdentity,
    signal: options.signal,
    adapters: options.adapters,
  });
}

/** Remote adapters must supply the expected transport digest before extraction. */
export async function ingestRemotePluginArchive(options: {
  archiveBytes: Buffer;
  expectedArchiveSha256: string | null;
  stagingParent: string;
  expectedIdentity?: ExpectedPluginIdentity;
  signal?: AbortSignal;
  adapters?: PluginIngestionAdapters;
}): Promise<PluginIngestionResult> {
  if (
    options.expectedArchiveSha256 === null ||
    !isSha256(options.expectedArchiveSha256)
  ) {
    return fail(
      "plugin.install.archive-digest-required",
      "Remote plugin archives require an independently supplied expected archiveSha256 before extraction.",
    );
  }
  const actualArchiveSha256 = computeArchiveSha256(options.archiveBytes);
  if (actualArchiveSha256 !== options.expectedArchiveSha256) {
    return fail(
      "plugin.install.archive-digest-mismatch",
      "Downloaded archiveSha256 does not match the independently supplied expected digest.",
      {
        expectedArchiveSha256: options.expectedArchiveSha256,
        actualArchiveSha256,
      },
    );
  }
  return ingestVerifiedArchiveBytes({
    archiveBytes: options.archiveBytes,
    stagingParent: options.stagingParent,
    expectedIdentity: options.expectedIdentity,
    signal: options.signal,
    adapters: options.adapters,
  });
}
