/**
 * Plugin build: validate, typecheck, bundle, assets, manifest, map, checksums,
 * definition registration, generation binding; atomically replace dist/ only on success.
 */

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInertRegistrationHarness } from "@explodex/sdk/testing";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import { normalizeDeclaredAssets, stageDeclaredAssets } from "./assets.ts";
import {
  bundlePluginIife,
  commitBundleDist,
  type BundleImportDiagnostic,
} from "./bundle.ts";
import {
  buildChecksumsFromDir,
  computePayloadSha256,
  writeChecksums,
} from "./checksums.ts";
import {
  fingerprintDistTree,
  listInstallableFiles,
  sha256Hex,
} from "./dist-files.ts";
import {
  buildGenerationRecord,
  collectInputDigests,
  writeGenerationRecord,
} from "./generation.ts";
import { buildPluginManifest, writePluginManifest } from "./manifest.ts";
import { validatePluginSourceMapV3 } from "./source-map.ts";
import { validatePluginSource } from "./validate.ts";
import type { NormalizedSourceReport } from "./types.ts";

export type PluginBuildSuccess = {
  ok: true;
  report: NormalizedSourceReport;
  distPath: string;
  entry: "index.js";
  map: "index.js.map";
  jsBytes: number;
  jsSha256: string;
  payloadSha256: string;
  generationId: string;
  priorDistFingerprint: string | null;
  diagnostics: readonly BundleImportDiagnostic[];
};

export type PluginBuildFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  priorDistFingerprint: string | null;
  distFingerprintAfter: string | null;
  diagnostics: readonly BundleImportDiagnostic[];
};

export type PluginBuildResult = PluginBuildSuccess | PluginBuildFailure;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function localSdkInput(
  sdkSourcePath: string,
): Promise<NonNullable<Parameters<typeof buildGenerationRecord>[0]["sdkInput"]>> {
  const packageJson = JSON.parse(
    await readFile(join(sdkSourcePath, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    packageJson.name !== "@explodex/sdk" ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("Local SDK source identity is invalid.");
  }
  const runtime = await readFile(
    join(sdkSourcePath, "dist", "runtime", "explodex-runtime.iife.js"),
  );
  const declarations = await readFile(
    join(sdkSourcePath, "dist", "index.d.ts"),
  );
  return {
    kind: "local-source",
    version: packageJson.version,
    runtimeSha256: sha256Hex(runtime),
    declarationsSha256: sha256Hex(declarations),
  };
}

async function resolveTsc(workspacePath: string): Promise<string | null> {
  const fromEnv = process.env.EXPLODEX_TSC;
  if (fromEnv !== undefined && fromEnv.length > 0 && (await pathExists(fromEnv))) {
    return fromEnv;
  }
  const candidates = [
    join(workspacePath, "node_modules", ".bin", "tsc"),
    join(workspacePath, "..", "node_modules", ".bin", "tsc"),
    join(workspacePath, "..", "..", "node_modules", ".bin", "tsc"),
    join(workspacePath, "..", "..", "..", "node_modules", ".bin", "tsc"),
  ];
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(here, "..", "..", "..", "..", "node_modules", ".bin", "tsc"));
  candidates.push(join(here, "..", "..", "node_modules", ".bin", "tsc"));
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function typecheckWorkspace(options: {
  workspacePath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sdkSourcePath?: string;
}): Promise<
  { ok: true } |
  { ok: false; code?: string; message: string; details?: Record<string, unknown> }
> {
  if (options.signal?.aborted) {
    return { ok: false, code: "operation.interrupted", message: "Plugin typecheck was interrupted." };
  }
  const tsc = await resolveTsc(options.workspacePath);
  if (tsc === null) {
    return {
      ok: false,
      message: "Unable to resolve tsc for plugin typecheck",
    };
  }

  const tsconfigPath = join(options.workspacePath, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return { ok: false, message: "tsconfig.json is missing" };
  }

  let temporaryConfigRoot: string | null = null;
  let effectiveTsconfigPath = tsconfigPath;
  if (options.sdkSourcePath !== undefined) {
    temporaryConfigRoot = await mkdtemp(
      join(tmpdir(), "explodex-plugin-local-sdk-tsconfig-"),
    );
    effectiveTsconfigPath = join(temporaryConfigRoot, "tsconfig.json");
    await writeFile(
      effectiveTsconfigPath,
      `${JSON.stringify({
        extends: tsconfigPath,
        compilerOptions: {
          baseUrl: options.workspacePath,
          paths: {
            "@explodex/sdk": [
              join(options.sdkSourcePath, "dist", "index.d.ts"),
            ],
            "@explodex/sdk/*": [
              join(options.sdkSourcePath, "dist", "*"),
            ],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
  }

  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(tsc, ["-p", effectiveTsconfigPath, "--noEmit"], {
      cwd: options.workspacePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, options.timeoutMs);
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child close/error still determines settlement.
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });

  if (temporaryConfigRoot !== null) {
    await rm(temporaryConfigRoot, { recursive: true, force: true });
  }

  if (result.exitCode !== 0) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        code: "operation.interrupted",
        message: "Plugin typecheck was interrupted.",
      };
    }
    return {
      ok: false,
      message: "Plugin TypeScript typecheck failed",
      details: {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000),
      },
    };
  }
  return { ok: true };
}

function failResult(options: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  priorDistFingerprint: string | null;
  distFingerprintAfter: string | null;
  diagnostics?: readonly BundleImportDiagnostic[];
}): PluginBuildFailure {
  return {
    ok: false,
    code: options.code,
    message: options.message,
    details: options.details,
    priorDistFingerprint: options.priorDistFingerprint,
    distFingerprintAfter: options.distFingerprintAfter,
    diagnostics: options.diagnostics ?? [],
  };
}

/**
 * Build a plugin workspace into a complete dist/ payload.
 * Failure preserves prior dist byte-for-byte (or leaves no dist).
 */
export async function buildPluginWorkspace(options: {
  workspacePath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  shouldCommit?: () => boolean;
  sdkSourcePath?: string;
  sdkInput?: {
    kind: "publishable" | "local-source";
    version: string;
    runtimeSha256: string;
    declarationsSha256?: string;
  };
}): Promise<PluginBuildResult> {
  const workspacePath = resolve(options.workspacePath);
  const priorDistFingerprint = await fingerprintDistTree(workspacePath);
  const emptyDiagnostics: BundleImportDiagnostic[] = [];

  const validated = await validatePluginSource({
    workspacePath,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (!validated.ok) {
    const after = await fingerprintDistTree(workspacePath);
    return failResult({
      code: validated.code,
      message: validated.message,
      details: validated.details,
      priorDistFingerprint,
      distFingerprintAfter: after,
    });
  }

  const report = validated.report;

  const typechecked = await typecheckWorkspace({
    workspacePath,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    sdkSourcePath: options.sdkSourcePath,
  });
  if (!typechecked.ok) {
    const after = await fingerprintDistTree(workspacePath);
    const detailStdout =
      typechecked.details && typeof typechecked.details.stdout === "string"
        ? typechecked.details.stdout.trim()
        : "";
    const detailStderr =
      typechecked.details && typeof typechecked.details.stderr === "string"
        ? typechecked.details.stderr.trim()
        : "";
    const compilerText = [detailStdout, detailStderr].filter((part) => part.length > 0).join("\n");
    const typeDiagnostics: BundleImportDiagnostic[] = [];
    const moduleMatch = /Cannot find module '([^']+)'/g;
    for (const match of compilerText.matchAll(moduleMatch)) {
      typeDiagnostics.push({
        specifier: match[1]!,
        importer: report.entry,
        chain: [report.entry, match[1]!],
        reason: "TypeScript could not resolve module",
      });
    }
    return failResult({
      code: typechecked.code ?? "plugin.source.invalid",
      message:
        compilerText.length > 0
          ? `${typechecked.message}: ${compilerText.split("\n")[0]}`
          : typechecked.message,
      details: typechecked.details,
      priorDistFingerprint,
      distFingerprintAfter: after,
      diagnostics: typeDiagnostics,
    });
  }

  const assetsNormalized = await normalizeDeclaredAssets({
    workspacePath,
    declared: report.assets,
  });
  if (options.signal?.aborted) {
    const after = await fingerprintDistTree(workspacePath);
    return failResult({
      code: "operation.interrupted",
      message: "Plugin build was interrupted.",
      priorDistFingerprint,
      distFingerprintAfter: after,
    });
  }
  if (!assetsNormalized.ok) {
    const after = await fingerprintDistTree(workspacePath);
    return failResult({
      code: assetsNormalized.code,
      message: assetsNormalized.message,
      details: assetsNormalized.details,
      priorDistFingerprint,
      distFingerprintAfter: after,
    });
  }

  // Stage on the same filesystem as the workspace so rename is atomic.
  const stagingDir = join(
    workspacePath,
    `.explodex-dist-staging-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    const bundled = await bundlePluginIife({
      workspacePath,
      entryRelative: report.entry,
      pluginId: report.id,
      stagingDir,
      writeOutputs: true,
    });
    throwIfBuildAborted(options.signal);

    if (!bundled.ok) {
      await rm(stagingDir, { recursive: true, force: true });
      const after = await fingerprintDistTree(workspacePath);
      return failResult({
        code: bundled.code,
        message: bundled.message,
        details: bundled.details,
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      });
    }

    // Exact shared V3 map validation before any payload metadata is committed.
    const mapText = await readFile(join(stagingDir, "index.js.map"), "utf8");
    const stagedJsText = await readFile(join(stagingDir, "index.js"), "utf8");
    const mapValidation = validatePluginSourceMapV3({
      mapText,
      generatedSource: stagedJsText,
    });
    if (!mapValidation.ok) {
      await rm(stagingDir, { recursive: true, force: true });
      const after = await fingerprintDistTree(workspacePath);
      return failResult({
        code: "plugin.source.invalid",
        message: mapValidation.message,
        details: mapValidation.details,
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      });
    }

    const stagedAssets = await stageDeclaredAssets({
      stagingDir,
      assets: assetsNormalized.assets,
    });
    throwIfBuildAborted(options.signal);
    if (!stagedAssets.ok) {
      await rm(stagingDir, { recursive: true, force: true });
      const after = await fingerprintDistTree(workspacePath);
      return failResult({
        code: stagedAssets.code,
        message: stagedAssets.message,
        details: stagedAssets.details,
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      });
    }

    const manifest = buildPluginManifest({
      id: report.id,
      version: report.version,
      displayName: report.displayName,
      description: report.description,
      sdkRange: report.sdkRange,
      lifecycle: report.lifecycle,
      assets: assetsNormalized.installablePaths,
    });
    await writePluginManifest(stagingDir, manifest);
    throwIfBuildAborted(options.signal);

    // Definition registration must succeed before commit.
    const harness = createInertRegistrationHarness();
    const registration = await harness.evaluateSource({
      expectedPluginId: report.id,
      source: stagedJsText,
    });
    throwIfBuildAborted(options.signal);
    if (!registration.ok) {
      await rm(stagingDir, { recursive: true, force: true });
      const after = await fingerprintDistTree(workspacePath);
      return failResult({
        code: "plugin.source.invalid",
        message: `Plugin definition registration failed: ${registration.message}`,
        details: { registration },
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      });
    }

    const checksums = await buildChecksumsFromDir(stagingDir);
    await writeChecksums(stagingDir, checksums);
    const payloadSha256 = computePayloadSha256(checksums);

    const sdkInput = options.sdkInput ??
      (
        options.sdkSourcePath === undefined
          ? await resolveSdkRuntimeIdentityForCli().then((runtime) => ({
              kind: "publishable" as const,
              version: runtime.version,
              runtimeSha256: runtime.sha256,
            }))
          : await localSdkInput(options.sdkSourcePath)
      );
    const inputDigests = await collectInputDigests({
      workspacePath,
      report,
      sdkInput,
    });
    // Actual staged digests (includes true checksums.json bytes).
    const installable = await listInstallableFiles(stagingDir);
    const outputDigests: Record<string, string> = {};
    for (const relative of installable) {
      const bytes = await readFile(join(stagingDir, relative));
      outputDigests[relative] = sha256Hex(bytes);
    }
    const generation = buildGenerationRecord({
      report,
      inputDigests,
      checksums,
      outputDigests,
      sdkInput,
    });
    await writeGenerationRecord(stagingDir, generation);
    throwIfBuildAborted(options.signal);

    // Final staging inventory: installable set + generation record only.
    await commitBundleDist({
      workspacePath,
      stagingDir,
      signal: options.signal,
      shouldCommit: options.shouldCommit,
    });

    const after = await fingerprintDistTree(workspacePath);
    if (after === null) {
      return failResult({
        code: "plugin.source.invalid",
        message: "Build failed to commit dist/",
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      });
    }

    return {
      ok: true,
      report,
      distPath: join(workspacePath, "dist"),
      entry: "index.js",
      map: "index.js.map",
      jsBytes: bundled.jsBytes,
      jsSha256: bundled.jsSha256,
      payloadSha256,
      generationId: generation.generationId,
      priorDistFingerprint,
      diagnostics: bundled.diagnostics,
    };
  } catch (error: unknown) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    const after = await fingerprintDistTree(workspacePath);
    const coded = error as { code?: unknown };
    const interrupted =
      options.signal?.aborted ||
      coded.code === "operation.interrupted";
    return failResult({
      code: interrupted ? "operation.interrupted" : "plugin.source.invalid",
      message: interrupted
        ? "Plugin build was interrupted."
        : error instanceof Error
          ? error.message
          : "Plugin build failed",
      priorDistFingerprint,
      distFingerprintAfter: after,
    });
  }
}

function throwIfBuildAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Plugin build was interrupted.");
  }
}

/** Read committed dist/index.js for harness evaluation. */
export async function readBuiltPluginIndex(workspacePath: string): Promise<string> {
  return readFile(join(resolve(workspacePath), "dist", "index.js"), "utf8");
}

/** Ensure a staging marker file is not left as a valid-looking dist. */
export async function writeStagingMarker(dir: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), contents, "utf8");
}
