/**
 * Normalized plugin source validation.
 * Loads trusted config exactly once, derives ID/SDK range from sole authorities,
 * and never mutates dist/ on failure or success (validation is read-only).
 */

import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadExplodexConfigOnce } from "./config-load.ts";
import { deriveMatchingIdentity } from "./identity.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";
import { scanEntryImports } from "./imports.ts";
import { normalizeLifecycle } from "./lifecycle.ts";
import {
  comparePayloadPathsByUtf8Bytes,
  PayloadPathTopologyTracker,
  validateNormalizedPayloadPath,
} from "./payload-path.ts";
import { parsePluginPackageJson } from "./package-json.ts";
import type { SourceValidationResult } from "./types.ts";
import { REQUIRED_WORKSPACE_FILES } from "./types.ts";
import { validateOpaqueVersion } from "./version.ts";

const DEFAULT_ENTRY = "src/index.ts";

export async function validatePluginSource(options: {
  workspacePath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SourceValidationResult> {
  const workspacePath = resolve(options.workspacePath);

  let workspaceStats;
  try {
    workspaceStats = await stat(workspacePath);
  } catch {
    return fail("plugin.source.invalid", "Workspace path does not exist.", {
      workspacePath,
    });
  }
  if (!workspaceStats.isDirectory()) {
    return fail("plugin.source.invalid", "Workspace path is not a directory.", {
      workspacePath,
    });
  }

  // Capture dist fingerprint before any work so failure paths prove no mutation.
  const distBefore = await fingerprintDist(workspacePath);

  for (const relative of REQUIRED_WORKSPACE_FILES) {
    const present = await pathExists(join(workspacePath, relative));
    if (!present) {
      return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
        message: `Required workspace file is missing: ${relative}`,
        details: { missing: relative, workspacePath },
      });
    }
  }

  // Reject legacy root manifest authority if present as an authored source file.
  if (await pathExists(join(workspacePath, "plugin.json"))) {
    // plugin.json is generated under dist/ only; root-level is legacy.
    return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
      message: "Root plugin.json is not part of the source workspace contract.",
      details: { workspacePath },
    });
  }

  let packageRaw: unknown;
  try {
    const text = await readFile(join(workspacePath, "package.json"), "utf8");
    packageRaw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
      message:
        error instanceof Error
          ? `package.json is malformed: ${error.message}`
          : "package.json is malformed.",
    });
  }

  const packageParsed = parsePluginPackageJson(packageRaw);
  if (!packageParsed.ok) {
    return failUnchanged(distBefore, workspacePath, packageParsed.code, {
      message: packageParsed.message,
      details: packageParsed.details,
    });
  }

  const identity = deriveMatchingIdentity({
    workspacePath,
    packageName: packageParsed.value.name,
  });
  if (!identity.ok) {
    return failUnchanged(distBefore, workspacePath, identity.code, {
      message: identity.message,
      details: identity.details,
    });
  }

  const configLoaded = await loadExplodexConfigOnce({
    workspacePath,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (!configLoaded.ok) {
    return failUnchanged(distBefore, workspacePath, configLoaded.code, {
      message: configLoaded.message,
      details: configLoaded.details,
    });
  }

  const versionResult = validateOpaqueVersion(configLoaded.config.version);
  if (!versionResult.ok) {
    return failUnchanged(distBefore, workspacePath, versionResult.code, {
      message: versionResult.message,
      details: versionResult.details,
    });
  }
  try {
    encodeArtifactIdentity({
      id: identity.id,
      version: versionResult.version,
      payloadSha256: "0".repeat(64),
    });
  } catch (error: unknown) {
    return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
      message: error instanceof Error
        ? `Artifact identity cannot be represented safely: ${error.message}`
        : "Artifact identity cannot be represented safely.",
    });
  }

  const lifecycleResult = normalizeLifecycle(configLoaded.config.lifecycle);
  if (!lifecycleResult.ok) {
    return failUnchanged(distBefore, workspacePath, lifecycleResult.code, {
      message: lifecycleResult.message,
      details: lifecycleResult.details,
    });
  }

  const entry =
    typeof configLoaded.config.entry === "string" && configLoaded.config.entry.length > 0
      ? configLoaded.config.entry
      : DEFAULT_ENTRY;

  if (entry.includes("\0") || entry.includes("\\") || entry.startsWith("/") || entry.includes("..")) {
    return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
      message: "Config entry path is unsafe.",
      details: { entry },
    });
  }

  if (!(await pathExists(join(workspacePath, entry)))) {
    return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
      message: `Entry file is missing: ${entry}`,
      details: { entry },
    });
  }

  const assets = configLoaded.config.assets ?? [];
  const assetTopology = new PayloadPathTopologyTracker();
  for (const asset of assets) {
    if (typeof asset !== "string" || asset.length === 0) {
      return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
        message: "Asset paths must be non-empty strings.",
      });
    }
    const validatedAsset = validateNormalizedPayloadPath(`assets/${asset}`, {
      kind: "file",
    });
    if (!validatedAsset.ok) {
      return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
        message: validatedAsset.message,
        details: { asset, entryClass: validatedAsset.entryClass },
      });
    }
    const topologyFailure = assetTopology.addFileWithImplicitDirectories(
      validatedAsset.validated,
    );
    if (topologyFailure !== null) {
      return failUnchanged(distBefore, workspacePath, "plugin.source.invalid", {
        message: topologyFailure.message,
        details: { asset, entryClass: topologyFailure.entryClass },
      });
    }
  }

  const importScan = await scanEntryImports({ workspacePath, entryRelative: entry });
  if (!importScan.ok) {
    return failUnchanged(distBefore, workspacePath, importScan.code, {
      message: importScan.message,
      details: importScan.details,
    });
  }

  const distAfter = await fingerprintDist(workspacePath);
  if (distAfter !== distBefore) {
    return fail("plugin.source.invalid", "Validation mutated dist/; refusing result.", {
      workspacePath,
      distBefore,
      distAfter,
    });
  }

  return {
    ok: true,
    report: {
      id: identity.id,
      packageName: identity.packageName,
      workspacePath: identity.workspacePath,
      version: versionResult.version,
      displayName: configLoaded.config.displayName,
      description: configLoaded.config.description,
      entry,
      assets: [...assets],
      lifecycle: lifecycleResult.lifecycle,
      sdkRange: packageParsed.value.sdkRange,
      packageManagerVersion: packageParsed.value.packageManagerVersion,
      hotSetupAllowed: lifecycleResult.hotSetupAllowed,
      requiredBoundary: lifecycleResult.requiredBoundary,
      configExecutions: 1,
    },
  };
}

async function fingerprintDist(workspacePath: string): Promise<string> {
  const distPath = join(workspacePath, "dist");
  try {
    const stats = await stat(distPath);
    if (!stats.isDirectory()) {
      return `file:${stats.size}:${stats.mtimeMs}`;
    }
  } catch {
    return "missing";
  }

  const hash = createHash("sha256");
  const files = await listFilesRecursive(distPath);
  files.sort(comparePayloadPathsByUtf8Bytes);
  for (const relative of files) {
    const absolute = join(distPath, relative);
    const bytes = await readFile(absolute);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function listFilesRecursive(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(root, relative)));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fail(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): SourceValidationResult {
  return { ok: false, code, message, details };
}

async function failUnchanged(
  distBefore: string,
  workspacePath: string,
  code: string,
  options: { message: string; details?: Record<string, unknown> },
): Promise<SourceValidationResult> {
  const distAfter = await fingerprintDist(workspacePath);
  if (distAfter !== distBefore) {
    return fail("plugin.source.invalid", "Validation mutated dist/; refusing result.", {
      workspacePath,
      distBefore,
      distAfter,
      original: options.message,
    });
  }
  return fail(code, options.message, options.details);
}
