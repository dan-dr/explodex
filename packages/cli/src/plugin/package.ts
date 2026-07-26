/**
 * Package a validated dist/ after generation binding checks.
 * Rejects stale source generations and edited generated outputs without writing.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listInstallableFiles } from "./dist-files.ts";
import { verifyDistGeneration } from "./generation.ts";
import type { NormalizedSourceReport } from "./types.ts";
import { validatePluginSource } from "./validate.ts";

export type PluginPackageSuccess = {
  ok: true;
  report: NormalizedSourceReport;
  payloadSha256: string;
  generationId: string;
  outputPath: string;
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
 * Validate generation binding and write installable payload files under outputDir.
 * Does not claim archive-container reproducibility; F07 owns named-root archives.
 * Failure leaves outputDir contents unchanged (writes only into a private staging sibling).
 */
export async function packagePluginWorkspace(options: {
  workspacePath: string;
  outputDir: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginPackageResult> {
  const workspacePath = resolve(options.workspacePath);
  const outputDir = resolve(options.outputDir);

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
  const files = await listInstallableFiles(distPath);
  const payloadRootName = `${source.report.id}-${encodeURIComponent(source.report.version)}-${verified.payloadSha256.slice(0, 12)}`;
  const stagingRoot = join(outputDir, `.explodex-package-staging-${process.pid}`);
  const stagingPayload = join(stagingRoot, payloadRootName);
  const finalPayload = join(outputDir, payloadRootName);

  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await mkdir(stagingPayload, { recursive: true });
    for (const relative of files) {
      const bytes = await readFile(join(distPath, relative));
      const destination = join(stagingPayload, ...relative.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, bytes);
    }

    // Identity sidecar for package consumers (not part of installable plugin payload).
    await writeFile(
      join(stagingPayload, ".explodex-package-identity.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: source.report.id,
          version: source.report.version,
          payloadSha256: verified.payloadSha256,
          generationId: verified.generation.generationId,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await rm(finalPayload, { recursive: true, force: true });
    // Atomic-ish: rename staging payload into place, then drop staging root.
    await rename(stagingPayload, finalPayload);
    await rm(stagingRoot, { recursive: true, force: true });

    return {
      ok: true,
      report: source.report,
      payloadSha256: verified.payloadSha256,
      generationId: verified.generation.generationId,
      outputPath: finalPayload,
      files,
    };
  } catch (error: unknown) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      code: "plugin.package.failed",
      message: error instanceof Error ? error.message : "Plugin package failed",
    };
  }
}
