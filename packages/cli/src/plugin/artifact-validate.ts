/**
 * Source-free standalone artifact validation for a copied dist/ or archive payload.
 * Requires no authoring workspace, config, TypeScript, package scripts, or builders.
 */

import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInertRegistrationHarness } from "@explodex/sdk/testing";
import { evaluateSdkCompatibility, SDK_VERSION } from "../sdk/compatibility.ts";
import {
  extractNamedRootArchive,
  type ExtractedPluginArchive,
} from "./archive.ts";
import { scanBrowserSafeIife } from "./browser-scan.ts";
import {
  computePayloadSha256,
  readChecksums,
  type ChecksumsManifest,
  verifyDistAgainstChecksums,
} from "./checksums.ts";
import {
  compareBytewise,
  GENERATION_FILE,
  INSTALLABLE_ROOT_FILES,
  isInstallableRelativePath,
  listInstallableFiles,
  sha256Hex,
} from "./dist-files.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";
import { parsePluginManifest, type PluginManifestV1 } from "./manifest.ts";

export type StandaloneArtifactSuccess = {
  ok: true;
  id: string;
  version: string;
  displayName: string;
  description: string;
  lifecycle: PluginManifestV1["lifecycle"];
  sdkRange: string;
  payloadSha256: string;
  archiveSha256: string | null;
  archiveRootName: string | null;
  files: readonly string[];
  registrationCount: 1;
  source: "directory" | "archive";
};

export type StandaloneArtifactFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type StandaloneArtifactResult =
  | StandaloneArtifactSuccess
  | StandaloneArtifactFailure;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function fail(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): StandaloneArtifactFailure {
  return { ok: false, code, message, details };
}

/**
 * Validate an installable payload directory already on disk.
 * Ignores private generation metadata when present.
 */
export async function validateInstallablePayloadDir(
  payloadDir: string,
  options?: {
    archiveSha256?: string | null;
    archiveRootName?: string | null;
    source?: "directory" | "archive";
    expectedIdentity?: {
      id?: string;
      version?: string;
      payloadSha256?: string;
    };
  },
): Promise<StandaloneArtifactResult> {
  const root = resolve(payloadDir);
  if (!(await isDirectory(root))) {
    return fail("plugin.artifact.invalid", "Artifact path is not a directory.", {
      path: root,
    });
  }

  // Reject generation file as part of installable set (may exist beside dist/).
  let installable: string[];
  try {
    installable = await listInstallableFiles(root);
  } catch (error: unknown) {
    return fail(
      "plugin.artifact.invalid",
      error instanceof Error ? error.message : "Unable to list artifact files.",
    );
  }

  // Reject non-installable unexpected files other than the private generation record.
  const { readdir } = await import("node:fs/promises");
  async function listAll(prefix = ""): Promise<string[]> {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(...(await listAll(relative)));
      } else if (entry.isFile()) {
        out.push(relative);
      } else {
        return [`__special__:${relative}`];
      }
    }
    return out;
  }
  const allFiles = await listAll();
  for (const relative of allFiles) {
    if (relative.startsWith("__special__:")) {
      return fail("plugin.artifact.invalid", "Artifact contains a special filesystem entry.", {
        path: relative.slice("__special__:".length),
      });
    }
    if (relative === GENERATION_FILE && options?.source === "directory") continue;
    if (!isInstallableRelativePath(relative)) {
      return fail("plugin.artifact.invalid", `Unexpected non-installable file: ${relative}`, {
        path: relative,
      });
    }
  }

  for (const required of INSTALLABLE_ROOT_FILES) {
    if (!installable.includes(required)) {
      return fail("plugin.artifact.invalid", `Required installable file is missing: ${required}`, {
        path: required,
      });
    }
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(await readFile(join(root, "plugin.json"), "utf8")) as unknown;
  } catch (error: unknown) {
    return fail(
      "plugin.artifact.invalid",
      error instanceof Error
        ? `plugin.json is unreadable: ${error.message}`
        : "plugin.json is unreadable",
    );
  }
  const parsedManifest = parsePluginManifest(manifestRaw);
  if (!parsedManifest.ok) {
    return fail("plugin.artifact.invalid", parsedManifest.message);
  }
  const manifest = parsedManifest.manifest;

  // Assets must match manifest exactly.
  const actualAssets = installable
    .filter((path) => path.startsWith("assets/"))
    .sort(compareBytewise);
  const declaredAssets = [...manifest.assets].sort(compareBytewise);
  if (
    actualAssets.length !== declaredAssets.length ||
    actualAssets.some((path, index) => path !== declaredAssets[index])
  ) {
    return fail(
      "plugin.artifact.invalid",
      "Declared assets do not match installable assets under assets/**.",
      { declared: declaredAssets, actual: actualAssets },
    );
  }

  let checksums: ChecksumsManifest;
  try {
    checksums = await readChecksums(root);
  } catch (error: unknown) {
    return fail(
      "plugin.artifact.invalid",
      error instanceof Error
        ? `checksums.json is invalid: ${error.message}`
        : "checksums.json is invalid",
    );
  }

  // checksums.json must not list itself or generation metadata.
  if (Object.prototype.hasOwnProperty.call(checksums.files, "checksums.json")) {
    return fail(
      "plugin.artifact.invalid",
      "checksums.json must not include a record for itself.",
      { path: "checksums.json" },
    );
  }

  const verified = await verifyDistAgainstChecksums(root, checksums);
  if (!verified.ok) {
    return fail("plugin.artifact.invalid", verified.message, { path: verified.path });
  }

  // Every checksum path must be installable and present; no duplicates by construction of object keys.
  const checksumPaths = Object.keys(checksums.files).sort(compareBytewise);
  for (const path of checksumPaths) {
    if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
      return fail("plugin.artifact.invalid", `checksums.json path contains disallowed controls: ${JSON.stringify(path)}`, {
        path,
      });
    }
    if (!isInstallableRelativePath(path) || path === "checksums.json") {
      return fail("plugin.artifact.invalid", `checksums.json lists a non-installable path: ${path}`, {
        path,
      });
    }
  }

  let payloadSha256: string;
  try {
    payloadSha256 = computePayloadSha256(checksums);
  } catch (error: unknown) {
    return fail(
      "plugin.artifact.invalid",
      error instanceof Error ? error.message : "payloadSha256 computation failed",
    );
  }

  if (
    options?.expectedIdentity?.payloadSha256 !== undefined &&
    options.expectedIdentity.payloadSha256 !== payloadSha256
  ) {
    return fail("plugin.artifact.invalid", "payloadSha256 does not match the expected identity.", {
      expected: options.expectedIdentity.payloadSha256,
      actual: payloadSha256,
    });
  }
  if (
    options?.expectedIdentity?.id !== undefined &&
    options.expectedIdentity.id !== manifest.id
  ) {
    return fail("plugin.artifact.invalid", "plugin.json id does not match the expected identity.", {
      expected: options.expectedIdentity.id,
      actual: manifest.id,
    });
  }
  if (
    options?.expectedIdentity?.version !== undefined &&
    options.expectedIdentity.version !== manifest.version
  ) {
    return fail(
      "plugin.artifact.invalid",
      "plugin.json version does not match the expected identity.",
      {
        expected: options.expectedIdentity.version,
        actual: manifest.version,
      },
    );
  }

  // If this came from an archive, the named root must match the encoder.
  if (options?.archiveRootName) {
    let expectedRoot: string;
    try {
      expectedRoot = encodeArtifactIdentity({
        id: manifest.id,
        version: manifest.version,
        payloadSha256,
      }).archiveRootName;
    } catch (error: unknown) {
      return fail(
        "plugin.artifact.invalid",
        error instanceof Error ? error.message : "Identity encoding failed",
      );
    }
    if (options.archiveRootName !== expectedRoot) {
      return fail(
        "plugin.artifact.invalid",
        "Archive top-level directory name does not match the encoded identity.",
        {
          expected: expectedRoot,
          actual: options.archiveRootName,
        },
      );
    }
  }

  const compatibility = evaluateSdkCompatibility(SDK_VERSION, manifest.sdkRange);
  if (!compatibility.ok) {
    return fail(
      "plugin.artifact.incompatible",
      `Plugin sdkRange is incompatible with SDK ${SDK_VERSION}: ${compatibility.reason}`,
      {
        sdkRange: manifest.sdkRange,
        sdkVersion: SDK_VERSION,
        reason: compatibility.reason,
      },
    );
  }

  const jsText = await readFile(join(root, "index.js"), "utf8");
  const browser = scanBrowserSafeIife(jsText);
  if (!browser.ok) {
    return fail("plugin.artifact.invalid", browser.message, { browserSafety: browser });
  }

  // Map must be present, package-relative, and reference index.js.
  let mapRaw: unknown;
  try {
    mapRaw = JSON.parse(await readFile(join(root, "index.js.map"), "utf8")) as unknown;
  } catch (error: unknown) {
    return fail(
      "plugin.artifact.invalid",
      error instanceof Error
        ? `index.js.map is unreadable: ${error.message}`
        : "index.js.map is unreadable",
    );
  }
  if (mapRaw === null || typeof mapRaw !== "object" || Array.isArray(mapRaw)) {
    return fail("plugin.artifact.invalid", "index.js.map must be a JSON object.");
  }
  const map = mapRaw as { file?: unknown; sources?: unknown };
  if (map.file !== "index.js") {
    return fail("plugin.artifact.invalid", 'index.js.map file field must be "index.js".');
  }
  if (Array.isArray(map.sources)) {
    for (const source of map.sources) {
      if (typeof source !== "string") continue;
      if (source.startsWith("/") || source.includes("\\")) {
        return fail(
          "plugin.artifact.invalid",
          "index.js.map contains non-portable source paths.",
          { source },
        );
      }
    }
  }

  // Exactly one inert definition registration; no setup.
  const harness = createInertRegistrationHarness();
  const registration = await harness.evaluateSource({
    expectedPluginId: manifest.id,
    source: jsText,
  });
  if (!registration.ok) {
    return fail(
      "plugin.artifact.invalid",
      `Plugin definition registration failed: ${registration.message}`,
      { registration },
    );
  }

  return {
    ok: true,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    lifecycle: manifest.lifecycle,
    sdkRange: manifest.sdkRange,
    payloadSha256,
    archiveSha256: options?.archiveSha256 ?? null,
    archiveRootName: options?.archiveRootName ?? null,
    files: installable,
    registrationCount: 1,
    source: options?.source ?? "directory",
  };
}

/**
 * Validate a path that may be:
 * - a payload directory (dist/ or extracted root contents)
 * - a named-root extracted directory (one identity folder)
 * - a .tar.gz archive
 */
export async function validateStandaloneArtifact(
  artifactPath: string,
): Promise<StandaloneArtifactResult> {
  const absolute = resolve(artifactPath);
  if (!(await pathExists(absolute))) {
    return fail("plugin.artifact.invalid", "Artifact path does not exist.", {
      path: absolute,
    });
  }

  if (await isFile(absolute)) {
    if (!absolute.endsWith(".tar.gz") && !absolute.endsWith(".tgz")) {
      return fail(
        "plugin.artifact.invalid",
        "Standalone artifact file must be a .tar.gz archive or a payload directory.",
        { path: absolute },
      );
    }
    const archiveBytes = await readFile(absolute);
    const extracted = extractNamedRootArchive(archiveBytes);
    if (!extracted.ok) {
      return fail(extracted.code, extracted.message, extracted.details);
    }
    return validateExtractedArchive(extracted.extracted);
  }

  if (!(await isDirectory(absolute))) {
    return fail("plugin.artifact.invalid", "Artifact path is neither a file nor a directory.", {
      path: absolute,
    });
  }

  // Directory: either a payload root or a single named-root directory whose
  // children are the installable set.
  const hasPluginJson = await pathExists(join(absolute, "plugin.json"));
  if (hasPluginJson) {
    return validateInstallablePayloadDir(absolute, { source: "directory" });
  }

  // Maybe this is the parent containing one named root.
  const { readdir } = await import("node:fs/promises");
  const children = await readdir(absolute, { withFileTypes: true });
  const dirs = children.filter((entry) => entry.isDirectory());
  const files = children.filter((entry) => entry.isFile());
  if (files.length > 0) {
    return fail(
      "plugin.artifact.invalid",
      "Directory is not an installable payload and is not a single named-root container.",
      { path: absolute },
    );
  }
  if (dirs.length !== 1) {
    return fail(
      "plugin.artifact.invalid",
      "Directory must contain exactly one named top-level payload directory.",
      { path: absolute, count: dirs.length },
    );
  }
  const named = join(absolute, dirs[0]!.name);
  return validateInstallablePayloadDir(named, {
    source: "directory",
    archiveRootName: dirs[0]!.name,
  });
}

async function validateExtractedArchive(
  extracted: ExtractedPluginArchive,
): Promise<StandaloneArtifactResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), "explodex-artifact-"));
  // Never place an attacker-controlled archive root into a filesystem path.
  // The root name remains metadata and is validated against the payload identity.
  const payloadDir = join(tempRoot, "payload");
  try {
    // Materialize files for shared directory validation.
    const { mkdir } = await import("node:fs/promises");
    for (const [relative, bytes] of extracted.files) {
      const destination = join(payloadDir, ...relative.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, bytes);
    }
    return await validateInstallablePayloadDir(payloadDir, {
      archiveSha256: extracted.archiveSha256,
      archiveRootName: extracted.archiveRootName,
      source: "archive",
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Independent recomputation of payloadSha256 from raw file map (test helper surface). */
export function computePayloadSha256FromFiles(
  files: ReadonlyMap<string, Buffer>,
): string {
  const records: ChecksumsManifest = { schemaVersion: 1, files: {} };
  for (const path of [...files.keys()].sort(compareBytewise)) {
    if (path === "checksums.json") continue;
    const bytes = files.get(path)!;
    records.files[path] = {
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }
  return computePayloadSha256(records);
}

export function archiveBasename(path: string): string {
  return basename(path);
}
