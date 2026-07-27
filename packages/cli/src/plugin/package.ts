/**
 * Package a validated dist/ into one canonical named-root .tar.gz archive.
 * Reports exact (id, opaque version, payloadSha256) plus archiveSha256.
 * Writes no archive on validation failure.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildNamedRootArchive,
  loadPayloadEntries,
  writeArchiveFile,
} from "./archive.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import { listInstallableFiles } from "./dist-files.ts";
import {
  readGenerationRecord,
  verifyDistGeneration,
} from "./generation.ts";
import type { NormalizedSourceReport } from "./types.ts";
import { validatePluginSource } from "./validate.ts";

export type PluginPackageSuccess = {
  ok: true;
  report: NormalizedSourceReport;
  payloadSha256: string;
  archiveSha256: string;
  generationId: string;
  /** Absolute path of the written .tar.gz archive. */
  outputPath: string;
  archiveRootName: string;
  archiveFileName: string;
  files: readonly string[];
};

export type PluginPackageFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type PluginPackageResult = PluginPackageSuccess | PluginPackageFailure;

/**
 * Validate generation binding, run source-free standalone validation, and
 * emit one named-root gzip archive under outputDir.
 * Failure leaves outputDir contents unchanged.
 */
export async function packagePluginWorkspace(options: {
  workspacePath: string;
  outputDir: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginPackageResult> {
  const workspacePath = resolve(options.workspacePath);
  const outputDir = resolve(options.outputDir);
  const recordedGeneration = await readGenerationRecord(
    join(workspacePath, "dist"),
  );
  if (recordedGeneration?.sdkInput?.kind === "local-source") {
    return {
      ok: false,
      code: "develop.local-sdk-not-publishable",
      message:
        "This generation was built with a local SDK source and is dev-only. Rebuild against publishable SDK inputs before packaging.",
    };
  }

  const verified = await verifyDistGeneration({
    workspacePath,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.code,
      message: verified.message,
      details: verified.details,
    };
  }
  if (verified.generation.sdkInput?.kind !== "publishable") {
    return {
      ok: false,
      code: "develop.local-sdk-not-publishable",
      message:
        "This generation was built with a local SDK source and is dev-only. Rebuild against publishable SDK inputs before packaging.",
    };
  }

  const source = await validatePluginSource({
    workspacePath,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (!source.ok) {
    return {
      ok: false,
      code: source.code,
      message: source.message,
      details: source.details,
    };
  }

  const distPath = join(workspacePath, "dist");
  const standalone = await validateInstallablePayloadDir(distPath, {
    source: "directory",
    expectedIdentity: {
      id: source.report.id,
      version: source.report.version,
      payloadSha256: verified.payloadSha256,
    },
  });
  if (!standalone.ok) {
    return {
      ok: false,
      code: standalone.code,
      message: standalone.message,
      details: standalone.details,
    };
  }

  const files = await listInstallableFiles(distPath);
  const entries = await loadPayloadEntries(distPath, files);

  let archive;
  try {
    archive = buildNamedRootArchive({
      id: source.report.id,
      version: source.report.version,
      payloadSha256: verified.payloadSha256,
      entries,
    });
  } catch (error: unknown) {
    return {
      ok: false,
      code: "plugin.package.failed",
      message: error instanceof Error ? error.message : "Archive construction failed",
    };
  }

  // Re-validate the archive payload topology by extracting in-memory.
  const { extractNamedRootArchive } = await import("./archive.ts");
  const extracted = extractNamedRootArchive(archive.archiveBytes);
  if (!extracted.ok) {
    return {
      ok: false,
      code: extracted.code,
      message: extracted.message,
      details: extracted.details,
    };
  }
  if (extracted.extracted.archiveRootName !== archive.archiveRootName) {
    return {
      ok: false,
      code: "plugin.package.failed",
      message: "Packaged archive root name mismatch.",
    };
  }
  if (extracted.extracted.archiveSha256 !== archive.archiveSha256) {
    return {
      ok: false,
      code: "plugin.package.failed",
      message: "Packaged archiveSha256 mismatch after round-trip.",
    };
  }

  await mkdir(outputDir, { recursive: true });
  const finalPath = join(outputDir, archive.archiveFileName);
  const stagingPath = join(
    outputDir,
    `.explodex-package-staging-${process.pid}-${archive.archiveFileName}`,
  );

  // Snapshot existing names so failure cannot leave partial final archives.
  let beforeNames: string[] = [];
  try {
    beforeNames = await readdir(outputDir);
  } catch {
    beforeNames = [];
  }

  try {
    await writeFile(stagingPath, archive.archiveBytes);
    // Atomic replace of the final archive name.
    await rm(finalPath, { force: true });
    await rename(stagingPath, finalPath);
  } catch (error: unknown) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    // Best-effort: if finalPath was not fully published, remove partials that
    // did not exist before this attempt.
    try {
      const afterNames = await readdir(outputDir);
      for (const name of afterNames) {
        if (!beforeNames.includes(name) && name !== archive.archiveFileName) {
          // only clean staging leftovers
          if (name.startsWith(".explodex-package-staging-")) {
            await rm(join(outputDir, name), { force: true }).catch(() => undefined);
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
    return {
      ok: false,
      code: "plugin.package.failed",
      message: error instanceof Error ? error.message : "Plugin package failed",
    };
  }

  return {
    ok: true,
    report: source.report,
    payloadSha256: verified.payloadSha256,
    archiveSha256: archive.archiveSha256,
    generationId: verified.generation.generationId,
    outputPath: finalPath,
    archiveRootName: archive.archiveRootName,
    archiveFileName: archive.archiveFileName,
    files,
  };
}

/** Exposed for tests that need the write helper without packaging. */
export { writeArchiveFile };
