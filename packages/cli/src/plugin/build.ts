/**
 * Plugin build: validate source, typecheck, bundle browser-safe IIFE.
 * Stages outputs and commits dist/ only on success; preserves prior dist on failure.
 * Full asset/manifest/checksum atomic pipeline is completed by later features.
 */

import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundlePluginIife,
  commitBundleDist,
  fingerprintDist,
  type BundleImportDiagnostic,
} from "./bundle.ts";
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
  // Walk from this package to monorepo root.
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
}): Promise<{ ok: true } | { ok: false; message: string; details?: Record<string, unknown> }> {
  const tsc = await resolveTsc(options.workspacePath);
  if (tsc === null) {
    // Typecheck is required when typescript is present; skip only if no tsc and no local tsconfig tooling.
    // Prefer failing closed when tsconfig exists (always true for valid workspaces).
    return {
      ok: false,
      message: "Unable to resolve tsc for plugin typecheck",
    };
  }

  const tsconfigPath = join(options.workspacePath, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return { ok: false, message: "tsconfig.json is missing" };
  }

  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(tsc, ["-p", tsconfigPath, "--noEmit"], {
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
      resolvePromise({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });

  if (result.exitCode !== 0) {
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

/**
 * Build a plugin workspace into dist/index.js (+ map).
 * Failure preserves prior dist byte-for-byte (or leaves no dist).
 */
export async function buildPluginWorkspace(options: {
  workspacePath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginBuildResult> {
  const workspacePath = resolve(options.workspacePath);
  const priorDistFingerprint = await fingerprintDist(workspacePath);
  const emptyDiagnostics: BundleImportDiagnostic[] = [];

  const validated = await validatePluginSource({
    workspacePath,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (!validated.ok) {
    const after = await fingerprintDist(workspacePath);
    return {
      ok: false,
      code: validated.code,
      message: validated.message,
      details: validated.details,
      priorDistFingerprint,
      distFingerprintAfter: after,
      diagnostics: emptyDiagnostics,
    };
  }

  const report = validated.report;

  // Typecheck against public SDK exports.
  const typechecked = await typecheckWorkspace({
    workspacePath,
    timeoutMs: options.timeoutMs,
  });
  if (!typechecked.ok) {
    const after = await fingerprintDist(workspacePath);
    const detailStdout =
      typechecked.details && typeof typechecked.details.stdout === "string"
        ? typechecked.details.stdout.trim()
        : "";
    const detailStderr =
      typechecked.details && typeof typechecked.details.stderr === "string"
        ? typechecked.details.stderr.trim()
        : "";
    const compilerText = [detailStdout, detailStderr].filter((part) => part.length > 0).join("\n");
    // Promote compiler paths into import-style diagnostics when present.
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
    return {
      ok: false,
      code: "plugin.source.invalid",
      message:
        compilerText.length > 0
          ? `${typechecked.message}: ${compilerText.split("\n")[0]}`
          : typechecked.message,
      details: typechecked.details,
      priorDistFingerprint,
      distFingerprintAfter: after,
      diagnostics: typeDiagnostics,
    };
  }

  // Stage on the same filesystem as the workspace so rename is atomic.
  const stagingDir = join(workspacePath, `.explodex-dist-staging-${process.pid}`);
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

    if (!bundled.ok) {
      await rm(stagingDir, { recursive: true, force: true });
      const after = await fingerprintDist(workspacePath);
      return {
        ok: false,
        code: bundled.code,
        message: bundled.message,
        details: bundled.details,
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      };
    }

    // Commit only after successful bundle. Staging becomes dist/.
    await commitBundleDist({ workspacePath, stagingDir });

    const after = await fingerprintDist(workspacePath);
    if (after === null) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Build failed to commit dist/index.js",
        priorDistFingerprint,
        distFingerprintAfter: after,
        diagnostics: bundled.diagnostics,
      };
    }

    return {
      ok: true,
      report,
      distPath: join(workspacePath, "dist"),
      entry: "index.js",
      map: "index.js.map",
      jsBytes: bundled.jsBytes,
      jsSha256: bundled.jsSha256,
      priorDistFingerprint,
      diagnostics: bundled.diagnostics,
    };
  } catch (error: unknown) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    const after = await fingerprintDist(workspacePath);
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: error instanceof Error ? error.message : "Plugin build failed",
      priorDistFingerprint,
      distFingerprintAfter: after,
      diagnostics: emptyDiagnostics,
    };
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
